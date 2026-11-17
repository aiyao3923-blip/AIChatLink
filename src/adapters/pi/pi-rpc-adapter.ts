import { randomUUID } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { AIChatLinkError, type AIChatLinkErrorCode } from "../../core/errors.js";
import { boundDiagnosticText } from "../../observability/diagnostics.js";
import { JsonLineProcess, type JsonLineProcessExit } from "../../supervisor/jsonline-process.js";
import { AsyncQueue } from "../../utils/async-queue.js";
import type {
  AdapterHealth,
  AdapterHealthStatus,
  CancelResult,
  CapabilityFinding,
  CapabilityReport,
  CliAdapter,
  LaunchProfile,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../types.js";
import {
  classifyPiSettle,
  buildPiLaunchArgv,
  isRecord,
  PI_MAX_STDOUT_LINE_BYTES,
  PI_PROTOCOL,
  parsePiAssistantMessage,
  parsePiGetState,
  parsePiResponse,
  parsePiToolEnd,
  parsePiToolStart,
  piThinkingLevel,
  projectPiMessageUpdate,
  type PiAssistantMessage,
  type PiResponseRecord
} from "./protocol.js";
import {
  clearPiAgentSecrets,
  piAgentDirectoryPath,
  piSessionFileExists,
  preparePiAgentDirectory,
  type PiAgentDirectory,
  type PiConfigMode
} from "./agent-dir.js";

export interface PiAdapterTimeouts {
  handshakeMs: number;
  requestMs: number;
  firstEventMs: number;
  idleMs: number;
  cancelMs: number;
  closeMs: number;
}

export interface PiRpcAdapterOptions {
  timeouts?: Partial<PiAdapterTimeouts>;
  now?: () => Date;
  /** Room-local agent key; defaults to the builtin `pi`. */
  agentId?: string;
  idFactory?: (kind: "instance" | "binding" | "session" | "control") => string;
  /** Overrides the user's pi agent directory (tests). */
  userAgentDirectory?: string;
  /** Reported CLI version; omitted until a real probe supplies one. */
  targetCliVersion?: string;
  /** `shared` mounts the user's own pi config; defaults to `AICHATLINK_PI_CONFIG`. */
  configMode?: PiConfigMode;
}

const DEFAULT_TIMEOUTS: PiAdapterTimeouts = {
  handshakeMs: 15_000,
  requestMs: 10_000,
  firstEventMs: 180_000,
  idleMs: 300_000,
  cancelMs: 10_000,
  closeMs: 5_000
};

const KILL_GRACE_CEILING_MS = 2_000;

/** pi extension UI methods that block the agent until the client answers. */
const PI_BLOCKING_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  // A pending response that loses its runtime must not surface as an
  // unhandled rejection when nobody is awaiting it.
  promise.catch(() => undefined);
  return { promise, resolve: resolveValue, reject: rejectValue };
}

interface ActiveTurn {
  turnId: string;
  correlationId: string;
  queue: AsyncQueue<NativeEvent>;
  terminalDone: Deferred<void>;
  /** Resolves when the native run settles, even if the Turn was already failed. */
  nativeSettled: Deferred<void>;
  terminal: boolean;
  cancelRequested: boolean;
  cancelDispatched: boolean;
  timedOut: boolean;
  /** True once this Turn observed its own native run event (agent_start or later). */
  sawNativeRun: boolean;
  activityObserved: boolean;
  chunkIndex: number;
  streamedText: boolean;
  streamedThinking: boolean;
  lastAssistant: PiAssistantMessage | undefined;
  seenToolCallIds: Set<string>;
  firstEventTimer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  abortSignal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
}

interface PiRuntime {
  process: JsonLineProcess;
  profile: Pick<LaunchProfile, "command" | "prefixArgs" | "cwd" | "instanceId" | "bindingId" | "mcp">;
  instanceId: string;
  bindingId: string;
  nativeSessionId: string | undefined;
  session: NativeSession | undefined;
  agentDirectory: PiAgentDirectory;
  pending: Map<string, Deferred<PiResponseRecord>>;
  activeTurn: ActiveTurn | undefined;
  requestSeq: number;
  disposers: Array<() => void>;
  closing: boolean;
  poisoned: boolean;
  teardownPromise: Promise<void> | undefined;
}

interface MutableHealth {
  status: AdapterHealthStatus;
  instanceId: string | undefined;
  nativeSessionAvailable: boolean;
  lastError: string | undefined;
  updatedAt: string;
}

/**
 * Native adapter for pi's first-party RPC mode (`pi --mode rpc`).
 *
 * The adapter owns an isolated `PI_CODING_AGENT_DIR` per room agent: the user's
 * provider catalog is copied (trimmed to the selected provider), settings are
 * generated, and the AIChatLink MCP entry is written there. `~/.pi/agent` is
 * never written and the user's extensions/skills are not loaded.
 *
 * Terminal semantics follow pi's own contract:
 * - `agent_end` is not terminal: pi may still retry, compact, or continue.
 * - `agent_settled` is the single authoritative terminal for one submitted run.
 * - an assistant message with `stopReason: "error"` is a failed Turn, never an
 *   empty successful reply.
 */
export class PiRpcAdapter implements CliAdapter {
  readonly adapterId: string;
  readonly actorId: string;

  readonly #timeouts: PiAdapterTimeouts;
  readonly #now: () => Date;
  readonly #idFactory: (kind: "instance" | "binding" | "session" | "control") => string;
  readonly #userAgentDirectory: string | undefined;
  readonly #targetCliVersion: string | undefined;
  readonly #configMode: PiConfigMode | undefined;
  readonly #observed = new Set<string>();

  #runtime: PiRuntime | undefined;
  #lastCommand: string | undefined;
  #lastPrefixArgs: readonly string[] = [];
  #health: MutableHealth;

  constructor(options: PiRpcAdapterOptions = {}) {
    const agentId = options.agentId ?? "pi";
    this.adapterId = agentId;
    this.actorId = `agent:${agentId}`;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    validateTimeouts(this.#timeouts);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ??
      ((kind) => (kind === "session" ? randomUUID() : `${kind}:${agentId}:${randomUUID()}`));
    this.#userAgentDirectory = options.userAgentDirectory;
    this.#targetCliVersion = options.targetCliVersion;
    this.#configMode = options.configMode;
    this.#health = {
      status: "stopped",
      instanceId: undefined,
      nativeSessionAvailable: false,
      lastError: undefined,
      updatedAt: this.#now().toISOString()
    };
  }

  async probe(): Promise<CapabilityReport> {
    const findings: CapabilityFinding[] = [
      finding(
        "rpc.get_state",
        this.#observed.has("rpc.get_state") ? "verified" : "documented",
        "RPC `get_state` proves the process is alive and reports the native session id without a model turn"
      ),
      finding(
        "session.prompt",
        this.#observed.has("session.prompt") ? "verified" : "documented",
        "Terminal state is `agent_settled` on the same stdio process; `agent_end` does not finish a Turn"
      ),
      finding(
        "session.resume",
        this.#observed.has("session.resume") ? "verified" : "documented",
        "`--session-id <id>` reopens an existing pi session file"
      ),
      finding(
        "session.cancel",
        this.#observed.has("session.cancel") ? "verified" : "documented",
        "RPC `abort` settles the active run; a cancellation is reported from `agent_settled`"
      ),
      finding(
        "mcp.http",
        this.#observed.has("mcp.http.descriptor") ? "probed" : "documented",
        "`mcp.json` accepts a streamable-HTTP descriptor with direct exposure"
      ),
      finding(
        "context.isolation",
        this.#observed.has("context.isolation") ? "probed" : "documented",
        "Per-agent `PI_CODING_AGENT_DIR`: copied provider catalog, generated settings, AIChatLink MCP only; `~/.pi/agent` is not written"
      ),
      finding(
        "access.unrestricted",
        "documented",
        "pi has no approval/permission layer in RPC mode; tools execute with the room process's OS permissions"
      ),
      finding(
        "native.interaction",
        this.#observed.has("native.interaction") ? "probed" : "documented",
        "An extension-ui request is denied at the wire boundary and fails the Turn"
      )
    ];

    return {
      adapterId: this.adapterId,
      ...(this.#lastCommand === undefined ? {} : { executablePath: this.#lastCommand }),
      ...(this.#targetCliVersion === undefined ? {} : { version: this.#targetCliVersion }),
      protocol: PI_PROTOCOL,
      protocolVersion: "rpc",
      launchArgvShape: [this.#lastCommand ?? "<command>", ...this.#lastPrefixArgs, "--mode", "rpc", "--session-id", "<id>"],
      findings,
      generatedAt: this.#nowIso()
    };
  }

  async start(input: LaunchProfile): Promise<NativeSession> {
    return await this.#launch(input, undefined);
  }

  async resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
    if (input.nativeSessionId.length === 0) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "nativeSessionId must be non-empty");
    }
    const directory = piAgentDirectoryPath(input.cwd, this.adapterId);
    if (!(await piSessionFileExists(directory, input.nativeSessionId))) {
      throw new AIChatLinkError(
        "SESSION_NOT_AVAILABLE",
        `pi has no session file for ${input.nativeSessionId} under the isolated agent directory`
      );
    }
    return await this.#launch(input, input.nativeSessionId);
  }

  async *prompt(session: NativeSession, input: PromptInput): AsyncIterable<NativeEvent> {
    const runtime = this.#requireRuntime(session);
    if (runtime.poisoned) {
      throw new AIChatLinkError(
        "SESSION_NOT_AVAILABLE",
        "pi native session requires restart after a transport failure"
      );
    }
    if (runtime.activeTurn !== undefined && !runtime.activeTurn.terminal) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "pi is already streaming a Turn");
    }

    const turn = createTurn(input.turnId, input.correlationId);
    runtime.activeTurn = turn;
    this.#emit(runtime, turn, "turn.started", {
      turnId: input.turnId,
      correlationId: input.correlationId
    });

    if (input.signal?.aborted === true) {
      this.#emitTerminal(runtime, turn, "turn.cancelled", {
        stopReason: "cancelled",
        reason: "Prompt was aborted before native dispatch"
      });
    } else {
      if (input.signal !== undefined) {
        turn.abortSignal = input.signal;
        turn.abortListener = () => {
          void this.cancel(session, input.turnId).catch(() => undefined);
        };
        input.signal.addEventListener("abort", turn.abortListener, { once: true });
      }
      void this.#dispatchPrompt(runtime, turn, input);
    }

    try {
      for await (const event of turn.queue) {
        yield event;
      }
    } finally {
      if (turn.abortSignal !== undefined && turn.abortListener !== undefined) {
        turn.abortSignal.removeEventListener("abort", turn.abortListener);
      }
      if (!turn.terminal) {
        void this.cancel(session, input.turnId).catch(() => undefined);
      }
    }
  }

  async cancel(session: NativeSession, nativeTurnId: string): Promise<CancelResult> {
    const runtime = this.#runtime;
    if (runtime === undefined || runtime.nativeSessionId !== session.nativeSessionId) {
      return { requested: false, supported: true, terminalObserved: false, detail: "No active pi runtime" };
    }
    const turn = runtime.activeTurn;
    if (turn === undefined || turn.terminal) {
      return { requested: false, supported: true, terminalObserved: true, detail: "No active pi Turn" };
    }
    if (turn.turnId !== nativeTurnId) {
      return { requested: false, supported: true, terminalObserved: false, detail: "no matching active Turn" };
    }

    turn.cancelRequested = true;
    if (!turn.cancelDispatched) {
      turn.cancelDispatched = true;
      this.#observed.add("session.cancel");
      const id = this.#nextRequestId(runtime, "abort");
      runtime.pending.set(id, deferred<PiResponseRecord>());
      void runtime.process
        .send({ id, type: "abort" })
        .catch((error: unknown) => {
          this.#settlePending(runtime, id, new AIChatLinkError("TURN_INTERRUPTED", errorMessage(error)));
        });
    }

    const settled = await Promise.race([
      turn.terminalDone.promise.then(() => true),
      delay(this.#timeouts.cancelMs).then(() => false)
    ]);
    if (!settled) {
      this.#failTurn(runtime, turn, "TURN_INTERRUPTED", "pi did not settle within the cancellation window");
      this.#scheduleTeardown(runtime);
    }
    return {
      requested: true,
      supported: true,
      terminalObserved: settled,
      ...(settled ? {} : { detail: "pi did not emit agent_settled before the cancellation timeout" })
    };
  }

  async close(session: NativeSession): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined || runtime.nativeSessionId !== session.nativeSessionId) {
      return;
    }
    runtime.closing = true;
    const turn = runtime.activeTurn;
    if (turn !== undefined && !turn.terminal) {
      this.#emitTerminal(runtime, turn, "turn.cancelled", {
        stopReason: "cancelled",
        reason: "Session is closing"
      });
    }
    if (runtime.teardownPromise === undefined) {
      runtime.teardownPromise = this.#shutdown(runtime);
    }
    await runtime.teardownPromise;
  }

  health(): AdapterHealth {
    return {
      adapterId: this.adapterId,
      status: this.#health.status,
      ...(this.#health.instanceId === undefined ? {} : { instanceId: this.#health.instanceId }),
      nativeSessionAvailable: this.#health.nativeSessionAvailable,
      ...(this.#health.lastError === undefined ? {} : { lastError: this.#health.lastError }),
      updatedAt: this.#health.updatedAt
    };
  }

  async #launch(input: LaunchProfile, resumeSessionId: string | undefined): Promise<NativeSession> {
    if (this.#runtime !== undefined) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", `${this.adapterId} pi adapter is already running`);
    }
    validateLaunchProfile(input);

    const instanceId = input.instanceId ?? this.#idFactory("instance");
    const bindingId = input.bindingId ?? this.#idFactory("binding");
    const requestedSessionId = resumeSessionId ?? this.#idFactory("session");
    this.#lastCommand = input.command;
    this.#lastPrefixArgs = [...(input.prefixArgs ?? [])];
    this.#setHealth("starting", instanceId);

    let agentDirectory: PiAgentDirectory;
    let argv: readonly [string, ...string[]];
    const expectedAgentDirectory = piAgentDirectoryPath(input.cwd, this.adapterId);
    try {
      agentDirectory = await preparePiAgentDirectory({
        workDirectory: input.cwd,
        agentId: this.adapterId,
        mcp: input.mcp,
        bindingId,
        model: input.model,
        thinking: piThinkingLevel(input.thinking),
        ...(this.#userAgentDirectory === undefined
          ? {}
          : { userAgentDirectory: this.#userAgentDirectory }),
        ...(this.#configMode === undefined ? {} : { configMode: this.#configMode })
      });
      argv = buildPiLaunchArgv(input.command, input.prefixArgs ?? [], {
        sessionId: requestedSessionId,
        provider: agentDirectory.selection.provider,
        model: agentDirectory.selection.model,
        thinking: agentDirectory.thinking
      });
    } catch (error) {
      const linkError =
        error instanceof AIChatLinkError
          ? error
          : new AIChatLinkError(
              "ADAPTER_START_FAILED",
              `Unable to prepare the pi launch: ${errorMessage(error)}`
            );
      this.#setHealth("failed", instanceId, linkError.message);
      await clearPiAgentSecrets(expectedAgentDirectory).catch(() => undefined);
      throw linkError;
    }

    let child: JsonLineProcess;
    try {
      child = JsonLineProcess.spawn({
        argv,
        cwd: input.cwd,
        env: { ...process.env, ...input.env, ...agentDirectory.environment },
        closeGraceMs: this.#timeouts.closeMs,
        killGraceMs: Math.min(this.#timeouts.closeMs, KILL_GRACE_CEILING_MS),
        maxStdoutLineBytes: PI_MAX_STDOUT_LINE_BYTES
      });
    } catch (error) {
      await clearPiAgentSecrets(expectedAgentDirectory).catch(() => undefined);
      const linkError = new AIChatLinkError(
        "ADAPTER_START_FAILED",
        `Unable to spawn pi: ${errorMessage(error)}`
      );
      this.#setHealth("failed", instanceId, linkError.message);
      throw linkError;
    }

    const runtime: PiRuntime = {
      process: child,
      profile: launchProfileFields(input),
      instanceId,
      bindingId,
      nativeSessionId: undefined,
      session: undefined,
      agentDirectory,
      pending: new Map(),
      activeTurn: undefined,
      requestSeq: 0,
      disposers: [],
      closing: false,
      poisoned: false,
      teardownPromise: undefined
    };
    this.#runtime = runtime;
    this.#attachRuntimeListeners(runtime);

    try {
      const state = await this.#getState(runtime);
      if (state.sessionId !== requestedSessionId) {
        throw new AIChatLinkError(
          "SESSION_NOT_AVAILABLE",
          `pi reported session ${state.sessionId} instead of ${requestedSessionId}`
        );
      }
      if (resumeSessionId !== undefined) {
        if (state.messageCount !== undefined && state.messageCount === 0) {
          throw new AIChatLinkError(
            "SESSION_NOT_AVAILABLE",
            `pi did not load history for ${resumeSessionId}`
          );
        }
        this.#observed.add("session.resume");
      }
      this.#observed.add("rpc.get_state");
      if (input.mcp?.transport === "stdio") {
        this.#observed.add("mcp.stdio.descriptor");
      } else if (input.mcp?.transport === "streamable-http") {
        this.#observed.add("mcp.http.descriptor");
      }
      this.#observed.add("context.isolation");

      runtime.nativeSessionId = state.sessionId;
      const session: NativeSession = {
        adapterId: this.adapterId,
        instanceId,
        bindingId,
        actorId: this.actorId,
        nativeSessionId: state.sessionId,
        protocol: PI_PROTOCOL,
        startedAt: this.#nowIso()
      };
      runtime.session = session;
      this.#setHealth("ready", instanceId);
      return { ...session };
    } catch (error) {
      runtime.closing = true;
      for (const dispose of runtime.disposers.splice(0)) {
        dispose();
      }
      this.#failPending(runtime, error);
      await child.close().catch(() => undefined);
      await clearPiAgentSecrets(agentDirectory.directory).catch(() => undefined);
      this.#runtime = undefined;
      const linkError =
        error instanceof AIChatLinkError
          ? error
          : new AIChatLinkError(
              "ADAPTER_START_FAILED",
              `pi did not establish its RPC session: ${errorMessage(error)}`
            );
      this.#setHealth("failed", instanceId, linkError.message);
      throw linkError;
    }
  }

  async #dispatchPrompt(runtime: PiRuntime, turn: ActiveTurn, input: PromptInput): Promise<void> {
    this.#armFirstEvent(runtime, turn);
    this.#armIdle(runtime, turn);
    const message = composeUserMessage(input.content, input.contextPacket);
    const id = this.#nextRequestId(runtime, "prompt");
    const pending = deferred<PiResponseRecord>();
    runtime.pending.set(id, pending);
    try {
      await runtime.process.send({ id, type: "prompt", message });
    } catch (error) {
      runtime.pending.delete(id);
      this.#failTurnAndTeardown(
        runtime,
        turn,
        "TURN_INTERRUPTED",
        `Unable to write the pi prompt: ${errorMessage(error)}`
      );
      return;
    }
    void pending.promise
      .then((response) => {
        runtime.pending.delete(id);
        if (turn.terminal) return;
        if (!response.success) {
          this.#failTurnAndTeardown(
            runtime,
            turn,
            "TURN_INTERRUPTED",
            `pi rejected the prompt: ${response.error ?? "unknown error"}`
          );
          return;
        }
        const disposition = response.data?.disposition;
        if (disposition === "handled") {
          // No native run started; the session is idle and owes no agent_settled.
          this.#emitTerminal(runtime, turn, "turn.completed", { stopReason: "handled" });
        }
      })
      .catch(() => undefined);
  }

  #attachRuntimeListeners(runtime: PiRuntime): void {
    runtime.disposers.push(
      runtime.process.onMessage((value) => this.#handleRecord(runtime, value)),
      runtime.process.onProtocolError((error) => {
        this.#failRuntime(runtime, "PROTOCOL_INVALID_MESSAGE", `pi stdout is not JSONL: ${error.message}`);
      }),
      runtime.process.onExit((exit) => this.#handleExit(runtime, exit))
    );
  }

  #handleRecord(runtime: PiRuntime, value: unknown): void {
    if (!isRecord(value)) return;
    const type = value.type;

    if (type === "response") {
      this.#handleResponse(runtime, value);
      return;
    }
    if (type === "extension_ui_request") {
      this.#handleExtensionUi(runtime, value);
      return;
    }
    if (type === "extension_error" || type === "bash_execution_update") {
      return;
    }

    const turn = runtime.activeTurn;
    if (turn === undefined || turn.terminal) return;

    switch (type) {
      case "agent_start":
        turn.sawNativeRun = true;
        this.#observeActivity(runtime, turn);
        return;
      case "message_update": {
        this.#observeActivity(runtime, turn);
        const projection = projectPiMessageUpdate(value);
        if (projection === undefined) return;
        if (projection.type === "content.delta") turn.streamedText = true;
        if (projection.type === "reasoning.delta") turn.streamedThinking = true;
        turn.chunkIndex += 1;
        this.#emit(runtime, turn, projection.type, {
          ...projection.payload,
          chunkIndex: turn.chunkIndex
        });
        return;
      }
      case "tool_execution_start": {
        const tool = parsePiToolStart(value);
        if (tool === undefined) return;
        this.#observeActivity(runtime, turn);
        if (turn.seenToolCallIds.has(tool.toolCallId)) return;
        turn.seenToolCallIds.add(tool.toolCallId);
        this.#emit(
          runtime,
          turn,
          "tool.started",
          {
            toolUseId: tool.toolCallId,
            ...(tool.toolName === undefined ? {} : { toolName: tool.toolName }),
            ...(tool.args === undefined ? {} : { args: tool.args })
          },
          tool.toolCallId
        );
        return;
      }
      case "tool_execution_end": {
        const tool = parsePiToolEnd(value);
        if (tool === undefined) return;
        this.#observeActivity(runtime, turn);
        this.#emit(
          runtime,
          turn,
          "tool.completed",
          {
            toolUseId: tool.toolCallId,
            ...(tool.toolName === undefined ? {} : { toolName: tool.toolName }),
            status: tool.isError ? "failed" : "completed"
          },
          tool.toolCallId
        );
        return;
      }
      case "message_end": {
        const message = parsePiAssistantMessage(value);
        if (message === undefined) return;
        this.#observeActivity(runtime, turn);
        turn.lastAssistant = message;
        // Streaming deltas are authoritative; the final message is the
        // fallback for providers that did not stream text/thinking.
        if (!turn.streamedText && message.text.length > 0) {
          turn.streamedText = true;
          turn.chunkIndex += 1;
          this.#emit(runtime, turn, "content.delta", {
            text: message.text,
            chunkIndex: turn.chunkIndex,
            finalMessageFallback: true
          });
        }
        if (!turn.streamedThinking && message.thinking.length > 0) {
          turn.streamedThinking = true;
          turn.chunkIndex += 1;
          this.#emit(runtime, turn, "reasoning.delta", {
            text: message.thinking,
            chunkIndex: turn.chunkIndex,
            finalMessageFallback: true
          });
        }
        return;
      }
      case "agent_end": {
        // Not terminal: retries, compaction recovery, steering, or queued
        // follow-ups may still continue this run.
        this.#observeActivity(runtime, turn);
        return;
      }
      case "agent_settled":
        // Do not mark run evidence from the settle itself; otherwise a late
        // settle from an earlier run would pass the attribution gate.
        this.#settleTurn(runtime, turn);
        return;
      default:
        // compaction/retry/queue/state events prove liveness but not that a
        // model run belongs to this Turn; they must not open the settle gate.
        this.#observeActivity(runtime, turn, false);
    }
  }

  #settleTurn(runtime: PiRuntime, turn: ActiveTurn): void {
    if (turn.timedOut) {
      // The Turn was already failed by a bounded timeout; this settle only
      // confirms the native run stopped. Resolve even without run evidence:
      // an abort may be answered by a settle alone.
      clearTurnTimers(turn);
      turn.nativeSettled.resolve();
      if (runtime.activeTurn === turn) runtime.activeTurn = undefined;
      return;
    }
    if (!turn.sawNativeRun) {
      // A settle with no observable run belongs to an earlier aborted run.
      // Terminating this Turn here would turn the next reply into an empty
      // "completed" Turn and swallow its real output.
      return;
    }
    const kind = classifyPiSettle(turn.lastAssistant, turn.cancelRequested);
    if (kind === "cancelled") {
      this.#emitTerminal(runtime, turn, "turn.cancelled", {
        stopReason: turn.lastAssistant?.stopReason ?? "cancelled"
      });
      return;
    }
    if (kind === "failed") {
      const message = turn.lastAssistant?.errorMessage ?? "pi assistant message ended with stopReason=error";
      this.#emit(runtime, turn, "transport.error", {
        errorCode: "TURN_INTERRUPTED",
        message: boundDiagnosticText(message, 2_000)
      });
      this.#emitTerminal(runtime, turn, "turn.failed", {
        errorCode: "TURN_INTERRUPTED",
        stopReason: turn.lastAssistant?.stopReason ?? "error"
      });
      return;
    }
    this.#emitTerminal(runtime, turn, "turn.completed", {
      stopReason: turn.lastAssistant?.stopReason ?? "completed",
      ...(turn.lastAssistant?.usage === undefined ? {} : { usage: turn.lastAssistant.usage })
    });
  }

  #handleResponse(runtime: PiRuntime, value: Record<string, unknown>): void {
    const response = parsePiResponse(value);
    if (response === undefined) {
      // The documented malformed-JSON reply has no request id and no command.
      this.#failRuntime(runtime, "PROTOCOL_INVALID_MESSAGE", "pi sent an unparseable response record");
      return;
    }
    const pending = response.id === undefined ? undefined : runtime.pending.get(response.id);
    if (pending !== undefined && response.id !== undefined) {
      runtime.pending.delete(response.id);
      pending.resolve(response);
      if (response.command === "get_state" && !response.success) {
        this.#failRuntime(runtime, "ADAPTER_START_FAILED", `pi get_state failed: ${response.error ?? "unknown"}`);
      }
      return;
    }
    if (response.success) return;
    const turn = runtime.activeTurn;
    if (turn !== undefined && !turn.terminal) {
      this.#failTurnAndTeardown(
        runtime,
        turn,
        "TURN_INTERRUPTED",
        `pi ${response.command} failed: ${response.error ?? "unknown error"}`
      );
    }
  }

  /**
   * pi distinguishes blocking dialogs (select/confirm/input/editor) from
   * fire-and-forget notifications (notify/setStatus/setWidget/setTitle/
   * set_editor_text). AIChatLink has no approval UI, so a dialog fails the Turn
   * closed; a notification is simply not rendered.
   */
  #handleExtensionUi(runtime: PiRuntime, value: Record<string, unknown>): void {
    const method = typeof value.method === "string" ? value.method : "unknown";
    if (!PI_BLOCKING_UI_METHODS.has(method)) {
      return;
    }
    this.#observed.add("native.interaction");
    const id = typeof value.id === "string" ? value.id : undefined;
    if (id !== undefined) {
      void runtime.process
        .send({
          type: "extension_ui_response",
          id,
          cancelled: true,
          reason: "AIChatLink has no interactive UI for native extension requests"
        })
        .catch(() => undefined);
    }
    const turn = runtime.activeTurn;
    if (turn !== undefined && !turn.terminal) {
      this.#failTurnAndTeardown(
        runtime,
        turn,
        "UNEXPECTED_NATIVE_INTERACTION",
        `pi requested an interactive ${method} UI response`
      );
    }
  }

  async #getState(runtime: PiRuntime): Promise<ReturnType<typeof parsePiGetState>> {
    const response = await this.#request(runtime, { type: "get_state" }, this.#timeouts.handshakeMs);
    if (!response.success) {
      throw new AIChatLinkError(
        "ADAPTER_START_FAILED",
        `pi get_state failed: ${response.error ?? "unknown error"}`
      );
    }
    return parsePiGetState(response.data);
  }

  async #request(
    runtime: PiRuntime,
    command: Record<string, unknown> & { type: string },
    timeoutMs: number
  ): Promise<PiResponseRecord> {
    const id = this.#nextRequestId(runtime, command.type);
    const pending = deferred<PiResponseRecord>();
    runtime.pending.set(id, pending);
    const timer = setTimeout(() => {
      if (!runtime.pending.delete(id)) return;
      pending.reject(
        new AIChatLinkError(
          "ADAPTER_START_FAILED",
          `pi did not answer ${command.type} within ${timeoutMs} ms`
        )
      );
    }, timeoutMs);
    try {
      await runtime.process.send({ ...command, id });
      return await pending.promise;
    } finally {
      clearTimeout(timer);
      runtime.pending.delete(id);
    }
  }

  #handleExit(runtime: PiRuntime, exit: JsonLineProcessExit): void {
    const turn = runtime.activeTurn;
    turn?.nativeSettled.resolve();
    if (turn !== undefined && !turn.terminal) {
      const detail = exit.stderr.trim().length > 0 ? `: ${boundDiagnosticText(exit.stderr.trim(), 1_000)}` : "";
      this.#failTurn(
        runtime,
        turn,
        "TURN_INTERRUPTED",
        `pi exited before agent_settled (code ${String(exit.code)}${detail})`
      );
    }
    this.#failPending(runtime, new AIChatLinkError("SESSION_NOT_AVAILABLE", "pi process exited"));
    void clearPiAgentSecrets(runtime.agentDirectory.directory).catch(() => undefined);
    this.#runtime = undefined;
    if (runtime.closing) {
      this.#setHealth("stopped");
      return;
    }
    runtime.poisoned = true;
    this.#setHealth(
      "failed",
      runtime.instanceId,
      exit.error ?? (exit.stderr.trim().length > 0 ? boundDiagnosticText(exit.stderr.trim(), 500) : `pi exited with code ${String(exit.code)}`)
    );
  }

  #failRuntime(runtime: PiRuntime, errorCode: AIChatLinkErrorCode, message: string): void {
    const turn = runtime.activeTurn;
    if (turn !== undefined && !turn.terminal) {
      this.#failTurnAndTeardown(runtime, turn, errorCode, message);
      return;
    }
    runtime.poisoned = true;
    this.#failPending(runtime, new AIChatLinkError(errorCode, message));
    this.#setHealth("failed", runtime.instanceId, message);
    // An idle protocol violation leaves a live child whose state is unknown.
    // Tear it down so the next start is not blocked by "already running" and
    // the generated credential copy is removed.
    this.#scheduleTeardown(runtime);
  }

  #failTurn(runtime: PiRuntime, turn: ActiveTurn, errorCode: AIChatLinkErrorCode, message: string): void {
    const bounded = boundDiagnosticText(message, 4_000);
    this.#emit(runtime, turn, "transport.error", { errorCode, message: bounded });
    this.#emitTerminal(runtime, turn, "turn.failed", { errorCode, message: bounded });
  }

  /**
   * Fail a Turn whose native run state is unknown (protocol violation, prompt
   * rejection, malformed frame, blocking UI). The process is never reused:
   * a still-running native run could otherwise emit frames into the next Turn.
   */
  #failTurnAndTeardown(
    runtime: PiRuntime,
    turn: ActiveTurn,
    errorCode: AIChatLinkErrorCode,
    message: string
  ): void {
    if (turn.terminal) return;
    turn.timedOut = true;
    clearTurnTimers(turn);
    void this.#abortQuietly(runtime);
    this.#failTurn(runtime, turn, errorCode, message);
    runtime.poisoned = true;
    this.#setHealth("failed", runtime.instanceId, boundDiagnosticText(message, 500));
    this.#scheduleTeardown(runtime);
  }

  #emitTerminal(
    runtime: PiRuntime,
    turn: ActiveTurn,
    type: "turn.completed" | "turn.cancelled" | "turn.failed",
    payload: unknown
  ): void {
    if (turn.terminal) return;
    clearTurnTimers(turn);
    turn.terminal = true;
    turn.queue.push(this.#event(runtime, turn, type, payload));
    turn.queue.end();
    turn.terminalDone.resolve();
    if (runtime.activeTurn === turn) {
      runtime.activeTurn = undefined;
    }
  }

  #emit(
    runtime: PiRuntime,
    turn: ActiveTurn,
    type: NativeEvent["type"],
    payload: unknown,
    nativeEventId?: string
  ): void {
    if (turn.terminal) return;
    turn.queue.push(this.#event(runtime, turn, type, payload, nativeEventId));
  }

  #event(
    runtime: PiRuntime,
    turn: ActiveTurn,
    type: NativeEvent["type"],
    payload: unknown,
    nativeEventId?: string
  ): NativeEvent {
    return {
      adapterId: this.adapterId,
      instanceId: runtime.instanceId,
      ...(runtime.nativeSessionId === undefined ? {} : { nativeSessionId: runtime.nativeSessionId }),
      nativeTurnId: turn.turnId,
      ...(nativeEventId === undefined ? {} : { nativeEventId }),
      type,
      payload,
      occurredAt: this.#nowIso()
    };
  }

  #observeActivity(runtime: PiRuntime, turn: ActiveTurn, run = true): void {
    if (turn.terminal) return;
    turn.activityObserved = true;
    if (run) turn.sawNativeRun = true;
    if (turn.firstEventTimer !== undefined) {
      clearTimeout(turn.firstEventTimer);
      turn.firstEventTimer = undefined;
    }
    this.#armIdle(runtime, turn);
  }

  #armFirstEvent(runtime: PiRuntime, turn: ActiveTurn): void {
    turn.firstEventTimer = setTimeout(() => {
      turn.firstEventTimer = undefined;
      if (turn.terminal || turn.activityObserved) return;
      void this.#failAfterAbort(
        runtime,
        turn,
        `pi produced no event within ${this.#timeouts.firstEventMs} ms`
      );
    }, this.#timeouts.firstEventMs);
  }

  #armIdle(runtime: PiRuntime, turn: ActiveTurn): void {
    if (turn.idleTimer !== undefined) clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      turn.idleTimer = undefined;
      if (turn.terminal || turn.timedOut) return;
      void this.#failAfterAbort(
        runtime,
        turn,
        `pi was idle for ${this.#timeouts.idleMs} ms`
      );
    }, this.#timeouts.idleMs);
  }

  /**
   * Fail a stalled Turn only after the run is ordered to stop and pi settles
   * (or the cancellation window expires). Failing first and aborting later lets
   * the broker dispatch the next queued prompt while the old run is still
   * streaming, and the old run's late `agent_settled` would then terminate the
   * new Turn with no content.
   */
  async #failAfterAbort(runtime: PiRuntime, turn: ActiveTurn, message: string): Promise<void> {
    if (turn.terminal || turn.timedOut) return;
    turn.timedOut = true;
    clearTurnTimers(turn);
    const id = this.#nextRequestId(runtime, "abort");
    runtime.pending.set(id, deferred<PiResponseRecord>());
    const write = runtime.process.send({ id, type: "abort" }).catch(() => undefined);
    await Promise.race([write, delay(this.#timeouts.requestMs)]);
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      turn.nativeSettled.promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#timeouts.cancelMs);
      })
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (turn.terminal) return;
    this.#failTurn(runtime, turn, "TURN_INTERRUPTED", message);
    if (!settled) {
      // The native run could not be stopped: never reuse this process.
      runtime.poisoned = true;
      this.#scheduleTeardown(runtime);
    }
  }

  async #abortQuietly(runtime: PiRuntime): Promise<void> {
    if (runtime.closing) return;
    const id = this.#nextRequestId(runtime, "abort");
    runtime.pending.set(id, deferred<PiResponseRecord>());
    try {
      await runtime.process.send({ id, type: "abort" });
    } catch {
      // The process may already be gone; teardown owns the final state.
    }
  }

  #scheduleTeardown(runtime: PiRuntime): void {
    if (runtime.teardownPromise !== undefined) return;
    runtime.teardownPromise = this.#shutdown(runtime);
  }

  async #shutdown(runtime: PiRuntime): Promise<void> {
    runtime.closing = true;
    for (const dispose of runtime.disposers.splice(0)) {
      dispose();
    }
    for (const pending of runtime.pending.values()) {
      pending.reject(new AIChatLinkError("SESSION_NOT_AVAILABLE", "pi session closed"));
    }
    runtime.pending.clear();
    await runtime.process.close({
      graceMs: this.#timeouts.closeMs,
      killGraceMs: Math.min(this.#timeouts.closeMs, KILL_GRACE_CEILING_MS)
    }).catch(() => undefined);
    // Do not leave the provider credential copy on disk after the session ends.
    await clearPiAgentSecrets(runtime.agentDirectory.directory).catch(() => undefined);
    if (this.#runtime === runtime) {
      this.#runtime = undefined;
    }
    this.#setHealth("stopped");
  }

  #failPending(runtime: PiRuntime, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of runtime.pending.values()) {
      pending.reject(failure);
    }
    runtime.pending.clear();
  }

  #settlePending(runtime: PiRuntime, id: string, error: unknown): void {
    const pending = runtime.pending.get(id);
    if (pending === undefined) return;
    runtime.pending.delete(id);
    pending.reject(error);
  }

  #requireRuntime(session: NativeSession): PiRuntime {
    const runtime = this.#runtime;
    if (
      runtime === undefined ||
      runtime.nativeSessionId !== session.nativeSessionId ||
      runtime.poisoned ||
      runtime.closing ||
      runtime.teardownPromise !== undefined
    ) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", `No matching active ${this.adapterId} pi session`);
    }
    return runtime;
  }

  #nextRequestId(runtime: PiRuntime, kind: string): string {
    runtime.requestSeq += 1;
    return `${kind}:${runtime.instanceId}:${runtime.requestSeq}`;
  }

  #setHealth(status: AdapterHealthStatus, instanceId?: string, lastError?: string): void {
    this.#health = {
      status,
      instanceId: instanceId ?? this.#health.instanceId,
      nativeSessionAvailable: status === "ready",
      lastError: lastError ?? (status === "ready" ? undefined : this.#health.lastError),
      updatedAt: this.#nowIso()
    };
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }
}

function createTurn(turnId: string, correlationId: string): ActiveTurn {
  return {
    turnId,
    correlationId,
    queue: new AsyncQueue<NativeEvent>(),
    terminalDone: deferred<void>(),
    nativeSettled: deferred<void>(),
    terminal: false,
    cancelRequested: false,
    cancelDispatched: false,
    timedOut: false,
    sawNativeRun: false,
    activityObserved: false,
    chunkIndex: 0,
    streamedText: false,
    streamedThinking: false,
    lastAssistant: undefined,
    seenToolCallIds: new Set(),
    firstEventTimer: undefined,
    idleTimer: undefined,
    abortSignal: undefined,
    abortListener: undefined
  };
}

function clearTurnTimers(turn: ActiveTurn): void {
  if (turn.firstEventTimer !== undefined) clearTimeout(turn.firstEventTimer);
  if (turn.idleTimer !== undefined) clearTimeout(turn.idleTimer);
  turn.firstEventTimer = undefined;
  turn.idleTimer = undefined;
}

function composeUserMessage(content: string, contextPacket: string | undefined): string {
  return contextPacket === undefined || contextPacket.length === 0
    ? content
    : `${contextPacket}\n\n[current_message]\n${content}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateTimeouts(timeouts: PiAdapterTimeouts): void {
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`pi adapter timeout ${name} must be a positive integer`);
    }
  }
}

function validateLaunchProfile(input: LaunchProfile): void {
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new TypeError("LaunchProfile.command must be non-empty");
  }
  if (
    input.prefixArgs !== undefined &&
    (!Array.isArray(input.prefixArgs) || input.prefixArgs.some((argument) => typeof argument !== "string"))
  ) {
    throw new TypeError("LaunchProfile.prefixArgs must contain only strings");
  }
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) {
    throw new TypeError("LaunchProfile.cwd must be an absolute path");
  }
  if (input.bindingId !== undefined && input.bindingId.length === 0) {
    throw new TypeError("LaunchProfile.bindingId must be non-empty when provided");
  }
  if (input.instanceId !== undefined && input.instanceId.length === 0) {
    throw new TypeError("LaunchProfile.instanceId must be non-empty when provided");
  }
  if (input.mcp !== undefined && (input.instanceId === undefined || input.bindingId === undefined)) {
    throw new AIChatLinkError(
      "MCP_BINDING_MISMATCH",
      "MCP-enabled pi sessions require Broker-preassigned instanceId and bindingId provenance"
    );
  }
}

function launchProfileFields(input: LaunchProfile): PiRuntime["profile"] {
  return {
    command: resolvePath(input.command),
    ...(input.prefixArgs === undefined ? {} : { prefixArgs: [...input.prefixArgs] }),
    cwd: resolvePath(input.cwd),
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    ...(input.bindingId === undefined ? {} : { bindingId: input.bindingId }),
    ...(input.mcp === undefined ? {} : { mcp: input.mcp })
  };
}

function finding(
  capability: string,
  level: CapabilityFinding["level"],
  detail: string
): CapabilityFinding {
  return { capability, level, detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
