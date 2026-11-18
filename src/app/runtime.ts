import { fileURLToPath } from "node:url";

import { AdapterRegistry } from "../adapters/registry.js";
import { AIChatLinkBroker } from "../broker/broker.js";
import type { BrokerContextProvider, BrokerErrorContext } from "../broker/types.js";
import { assertActiveTransport, isBuiltinAgentId, type AIChatLinkConfig } from "../config.js";
import {
  ASSISTANT_ACTOR_ID,
  LOCAL_OPERATOR_BINDING_ID,
  LOCAL_OPERATOR_INSTANCE_ID,
  LOCAL_OPERATOR_PROTOCOL
} from "../core/assistant.js";
import {
  asTransientEnvelope,
  createCorrelationId,
  createId,
  DEFAULT_ROOM_ID
} from "../core/envelope.js";
import { AIChatLinkError } from "../core/errors.js";
import {
  createAIChatLinkRuntimeIdentity,
  type AIChatLinkRuntimeIdentity
} from "../core/runtime-instance.js";
import {
  RoomContextEngine,
  type RoomCompactionProgress,
  type RoomContextSummarizer
} from "../memory/context-engine.js";
import {
  AgentDatedMemoryEngine,
  type AgentDatedMemorySummarizer
} from "../memory/dated-memory-engine.js";
import { McpBindingRegistry } from "../mcp/binding-registry.js";
import {
  createAIChatLinkMcpHttpHandler,
  type AIChatLinkMcpHttpHandler
} from "../mcp/server/index.js";
import { SqliteAIChatLinkStore } from "../storage/sqlite-store.js";
import type { AIChatLinkStore } from "../storage/types.js";
import {
  createAIChatLinkHttpServer,
  type AIChatLinkHttpServer,
  type AIChatLinkHttpServerAddress,
  type SetupApi,
  type WorkspaceHubApi,
  type WorkspaceRouting
} from "../web/server/index.js";
import { SseRuntime } from "../web/sse/index.js";
import { createSetupWorkspaceApi } from "../web/setup/workspace.js";
import { createAdapterRegistry } from "./adapter-factory.js";
import {
  FirstAvailableAgentSummarizer,
  OwningAgentDatedMemorySummarizer
} from "./context-summarizer.js";
import { toDurableEnvelope } from "./record-mappers.js";
import { SequencedEventPublisher, SqliteSseEventReader } from "./event-stream.js";
import { RuntimeReadiness } from "./readiness.js";
import { RestartAgentCommandCoordinator } from "./restart-commands.js";
import {
  AgentSessionManager,
  type SessionProgress,
  type SessionResumePlan
} from "./session-manager.js";
import { AIChatLinkOperatorBrokerApi } from "./operator-broker-api.js";
import { AIChatLinkAssistantHost, type AssistantHost } from "./operator-runtime.js";
import { AIChatLinkToolBrokerApi } from "./tool-broker-api.js";
import { ActiveTurnCoordinator } from "./turn-lifecycle.js";
import { AIChatLinkWebBrokerApi } from "./web-broker-api.js";
import { createAIChatLinkOperatorMcpServer } from "../mcp/server/operator-tools.js";

export interface AIChatLinkRuntimeOptions {
  store?: AIChatLinkStore;
  adapters?: AdapterRegistry;
  /** Defaults to true only when the runtime created the store. */
  closeStore?: boolean;
  /** Zero is accepted for integration tests; persisted config remains 1..65535. */
  port?: number;
  staticRoot?: string;
  roomId?: string;
  setupApi?: SetupApi;
  onError?: (error: unknown, context: BrokerErrorContext) => void;
  /** Test/custom injection. Runtime defaults to the first healthy configured Agent. */
  contextSummarizer?: RoomContextSummarizer;
  /** Test/custom injection. Runtime otherwise uses the owning Agent only. */
  datedMemorySummarizer?: AgentDatedMemorySummarizer;
  /** CLI-supplied identity; embedded/test runtimes derive one from resolved config. */
  runtimeIdentity?: AIChatLinkRuntimeIdentity;
  /**
   * Extra environment for every native process this runtime spawns. The
   * workspace supervisor uses it to isolate pi role directories per workspace;
   * the primary runtime leaves it undefined so existing spawn behavior is kept.
   */
  agentEnv?: NodeJS.ProcessEnv;
  /**
   * Hub-only workspace registry/proxy surface. Children are constructed without
   * these options, so they cannot register or proxy other workspaces.
   */
  workspaceHub?: WorkspaceHubApi;
  workspaceRouting?: WorkspaceRouting;
  /** Runs after the hub stops accepting requests and before child sessions close. */
  beforeClose?: () => Promise<void>;
}

export interface AIChatLinkRuntimeStartResult {
  address: AIChatLinkHttpServerAddress;
  recovery: SessionResumePlan;
}

export const LOCAL_REST_WEB_INSTANCE_ID = "instance:web" as const;
export const LOCAL_REST_WEB_BINDING_ID = "binding:web" as const;
export { LOCAL_OPERATOR_INSTANCE_ID, LOCAL_OPERATOR_BINDING_ID };

function compactionEventType(progress: RoomCompactionProgress) {
  return `context.compaction.${progress.phase}` as const;
}

function publishCompactionProgress(
  publisher: SequencedEventPublisher,
  progress: RoomCompactionProgress
): Promise<void> {
  const correlationId = createCorrelationId();
  return publisher.publish(
    asTransientEnvelope({
      eventId: createId(`context_compaction_${progress.phase}`),
      roomId: progress.roomId,
      type: compactionEventType(progress),
      actor: { actorId: "system:aichatlink", kind: "system", displayName: "AIChatLink" },
      to: [],
      causationId: progress.operationId,
      correlationId,
      rootCorrelationId: correlationId,
      body: progress,
      provenance: { sourceKind: "system", labels: ["context-compaction"] }
    })
  );
}

function sessionEventType(progress: SessionProgress) {
  if (progress.phase === "retrying") return "session.retrying" as const;
  if (progress.phase === "starting") return "session.starting" as const;
  if (progress.phase === "ready") {
    return progress.continuity === "resumed" ? "session.resumed" as const : "session.ready" as const;
  }
  return "session.failed" as const;
}

/**
 * The room tells each native Agent which model the host pinned for it. Without
 * this line an Agent can only guess, which is how "what model are you" answers
 * drift. pi-backed Agents get a live line from the shim instead.
 */
function hostAgentFacts(
  agentId: string,
  configured: AIChatLinkConfig["agents"][string] | undefined
): string | undefined {
  if (configured === undefined) return undefined;
  const piBacked = configured.command.prefixArgs.some((argument) =>
    /(?:pi-driver|pi-shim)/u.test(argument)
  );
  if (piBacked) return undefined;
  const model = configured.model?.trim();
  const thinking = configured.thinking?.trim();
  return [
    "[host_agent]",
    `id=agent:${agentId}`,
    `driver=${configured.driver}`,
    `model=${model === undefined || model.length === 0 ? "(CLI / CC Switch default)" : model}`,
    `thinking=${thinking === undefined || thinking.length === 0 ? "(driver default)" : thinking}`,
    "被问到模型身份时以本段为准：这是宿主下发的配置事实。"
  ].join("\n");
}

function contextProvider(
  engine: RoomContextEngine,
  config: AIChatLinkConfig,
  store: Pick<AIChatLinkStore, "getSupervisionTurnRole">
): BrokerContextProvider {
  return {
    async prepare({ turn, sourceEvent }) {
      const agentId = turn.targetActorId.startsWith("agent:")
        ? turn.targetActorId.slice("agent:".length)
        : "";
      const configured = config.agents[agentId];
      const configuredIdentity = [configured?.identity?.trim(), hostAgentFacts(agentId, configured)]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n\n");
      const packetKind =
        store.getSupervisionTurnRole(turn.turnId) === "observer"
          ? ("supervision_watch" as const)
          : undefined;
      const packet = await engine.prepare({
        roomId: sourceEvent.roomId,
        targetActorId: turn.targetActorId,
        ...(configuredIdentity ? { configuredIdentity } : {}),
        throughSeq: sourceEvent.seq,
        currentEvent: sourceEvent,
        ...(packetKind === undefined ? {} : { packetKind })
      });
      return {
        contextPacket: packet.text,
        contextThroughSeq: packet.throughSeq,
        ...(packet.sections.generatedSummary[0]?.seq === undefined
          ? {}
          : { summaryThroughSeq: packet.sections.generatedSummary[0].seq })
      };
    }
  };
}

/** Owns the complete in-process composition and its reverse-order shutdown. */
export class AIChatLinkRuntime {
  readonly config: AIChatLinkConfig;
  readonly store: AIChatLinkStore;
  readonly adapters: AdapterRegistry;
  readonly bindings = new McpBindingRegistry();
  readonly readiness = new RuntimeReadiness();
  readonly sse: SseRuntime;
  readonly publisher: SequencedEventPublisher;
  readonly sessions: AgentSessionManager;
  readonly datedMemoryEngine: AgentDatedMemoryEngine;
  readonly contextEngine: RoomContextEngine;
  readonly roomId: string;
  readonly runtimeIdentity: AIChatLinkRuntimeIdentity;

  readonly #closeStore: boolean;
  readonly #port: number;
  readonly #staticRoot: string | undefined;
  readonly #onError: AIChatLinkRuntimeOptions["onError"];
  readonly #setupApi: SetupApi | undefined;
  readonly #agentEnv: NodeJS.ProcessEnv | undefined;
  readonly #workspaceHub: WorkspaceHubApi | undefined;
  readonly #workspaceRouting: WorkspaceRouting | undefined;
  readonly #beforeClose: (() => Promise<void>) | undefined;

  #broker: AIChatLinkBroker | undefined;
  #turns: ActiveTurnCoordinator | undefined;
  #webApi: AIChatLinkWebBrokerApi | undefined;
  #toolApi: AIChatLinkToolBrokerApi | undefined;
  #operatorApi: AIChatLinkOperatorBrokerApi | undefined;
  #assistantHost: AssistantHost | undefined;
  #mcpHandler: AIChatLinkMcpHttpHandler | undefined;
  #operatorMcpHandler: AIChatLinkMcpHttpHandler | undefined;
  #http: AIChatLinkHttpServer | undefined;
  #webBindingId: string | undefined;
  #operatorBindingId: string | undefined;
  #startPromise: Promise<AIChatLinkRuntimeStartResult> | undefined;
  #startResult: AIChatLinkRuntimeStartResult | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(config: AIChatLinkConfig, options: AIChatLinkRuntimeOptions = {}) {
    // Fail before opening SQLite or constructing adapters. Direct is retained
    // as historical code/data vocabulary, not as a runnable product entry.
    assertActiveTransport(config.transport);
    this.config = config;
    this.store = options.store ?? new SqliteAIChatLinkStore(config.storage.path);
    this.adapters = options.adapters ?? createAdapterRegistry(config);
    this.#closeStore = options.closeStore ?? options.store === undefined;
    this.#port = options.port ?? config.server.port;
    this.#staticRoot = options.staticRoot;
    this.#onError = options.onError;
    this.#setupApi = options.setupApi;
    this.#agentEnv = options.agentEnv;
    this.#workspaceHub = options.workspaceHub;
    this.#workspaceRouting = options.workspaceRouting;
    this.#beforeClose = options.beforeClose;
    this.roomId = options.roomId ?? DEFAULT_ROOM_ID;
    this.runtimeIdentity =
      options.runtimeIdentity ?? createAIChatLinkRuntimeIdentity({ embeddedConfig: config });

    const reader = new SqliteSseEventReader(this.store);
    this.sse = new SseRuntime(reader, {
      maxBufferedEvents: config.limits.sseEvents,
      maxBufferedBytes: config.limits.sseBytes
    });
    this.publisher = new SequencedEventPublisher(this.store, this.sse, {
      closeTimeoutMs: config.timeouts.closeMs
    });
    this.publisher.initialize([this.roomId]);
    this.sessions = new AgentSessionManager({
      config,
      store: this.store,
      adapters: this.adapters,
      mcpBindings: this.bindings,
      closeTimeoutMs: config.timeouts.closeMs,
      ...(this.#agentEnv === undefined ? {} : { launchEnv: this.#agentEnv }),
      onProgress: async (progress) => {
        if (!this.publisher) return;
        const correlationId = createCorrelationId();
        await this.publisher.publish(
          asTransientEnvelope({
            eventId: createId(`session_${progress.phase}`),
            roomId: this.roomId,
            type: sessionEventType(progress),
            actor: {
              actorId: progress.actorId,
              kind: "agent",
              displayName: config.agents[progress.agentId]?.name ?? progress.agentId
            },
            to: [],
            correlationId,
            rootCorrelationId: correlationId,
            body: progress,
            provenance: { sourceKind: "system", labels: ["session-lifecycle"] }
          })
        );
      }
    });
    this.datedMemoryEngine = new AgentDatedMemoryEngine({
      store: this.store,
      summarizer:
        options.datedMemorySummarizer ??
        new OwningAgentDatedMemorySummarizer({
          config,
          primaryAdapters: this.adapters,
          ...(this.#agentEnv === undefined ? {} : { env: this.#agentEnv })
        }),
      publish: async (event) => await this.publisher.publish(toDurableEnvelope(event)),
      onError: (error, context) => {
        this.#onError?.(error, {
          operation: "memory",
          actorId: context.actorId
        });
      }
    });
    this.contextEngine = new RoomContextEngine({
      store: this.store,
      summarizer:
        options.contextSummarizer ??
        new FirstAvailableAgentSummarizer({
          config,
          primaryAdapters: this.adapters,
          ...(this.#agentEnv === undefined ? {} : { env: this.#agentEnv })
        }),
      maxChars: config.limits.contextCharacters,
      beforeCompaction: async ({ roomId, throughSeq, signal }) =>
        await this.datedMemoryEngine.flushBeforeCompaction({ roomId, throughSeq, signal }),
      onProgress: async (progress) => await publishCompactionProgress(this.publisher, progress)
    });
    this.#registerConfiguredActors();
  }

  /**
   * Give every configured agent an actors row so durable events can reference
   * it and the UI can show the configured display name. Builtin agents are
   * already seeded by the store; they are only upserted when renamed.
   */
  #registerConfiguredActors(): void {
    for (const [agentId, agent] of Object.entries(this.config.agents)) {
      if (isBuiltinAgentId(agentId) && agent.name === undefined) continue;
      this.store.upsertActor({
        actorId: `agent:${agentId}`,
        kind: "agent",
        displayName: agent.name ?? agentId,
        enabled: agent.enabled
      });
    }
  }

  get address(): AIChatLinkHttpServerAddress | undefined {
    return this.#startResult?.address;
  }

  get broker(): AIChatLinkBroker {
    if (!this.#broker) throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "Runtime has not started");
    return this.#broker;
  }

  get webBindingId(): string | undefined {
    return this.#webBindingId;
  }

  get mcpMounted(): boolean {
    return this.#mcpHandler !== undefined;
  }

  start(): Promise<AIChatLinkRuntimeStartResult> {
    if (this.#startResult) return Promise.resolve(this.#startResult);
    if (this.#startPromise) return this.#startPromise;
    if (this.#closePromise) {
      return Promise.reject(new AIChatLinkError("SESSION_NOT_AVAILABLE", "Runtime is closing"));
    }
    const operation = this.#performStart();
    this.#startPromise = operation;
    return operation.finally(() => {
      if (this.#startPromise === operation) this.#startPromise = undefined;
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.readiness.markClosing();
    const starting = this.#startPromise;
    const operation = (async () => {
      if (starting) await starting.catch(() => undefined);
      await this.#performClose();
    })();
    this.#closePromise = operation;
    return operation;
  }

  async #performStart(): Promise<AIChatLinkRuntimeStartResult> {
    try {
      this.#createWebBinding();
      this.#createOperatorBinding();
      const turns = new ActiveTurnCoordinator({
        transport: this.config.transport,
        bindings: this.bindings,
        sessions: this.sessions
      });
      const broker = new AIChatLinkBroker({
        store: this.store,
        adapters: this.adapters,
        sessions: this.sessions,
        publisher: this.publisher,
        agentController: {
          restart: async (actorId) => {
            await this.sessions.restart(actorId);
          },
          restartFresh: async (actorId) => {
            await this.sessions.restartFresh(actorId);
          }
        },
        contextProvider: contextProvider(this.contextEngine, this.config, this.store),
        steerLimit: this.config.limits.steersPerSubjectTurn,
        watchTimeoutMs: this.config.timeouts.watchMs,
        contextController: this.contextEngine,
        datedMemoryController: this.datedMemoryEngine,
        turnLifecycle: turns,
        acceptMessageLimits: {
          rootTurns: this.config.limits.rootTurns,
          hopCount: this.config.limits.hopCount,
          actorCallsPerRoot: this.config.limits.actorCallsPerRoot,
          queuePerActor: this.config.limits.queuePerAgent
        },
        selectedTransport: this.config.transport,
        agentOrder: new Map(
          Object.entries(this.config.agents)
            .filter(([, agent]) => agent.order !== undefined)
            .map(([agentId, agent]) => [`agent:${agentId}`, agent.order as number])
        ),
        defaultRoomId: this.roomId,
        nativeCancelTimeoutMs: this.config.timeouts.cancelMs,
        closeTimeoutMs: this.config.timeouts.closeMs,
        ...(this.#onError === undefined ? {} : { onError: this.#onError })
      });
      const restartCommands = new RestartAgentCommandCoordinator({
        store: this.store,
        sessions: this.sessions,
        onSessionReady: (actorId) => broker.notifySessionReady(actorId)
      });
      const webApi = new AIChatLinkWebBrokerApi({
        broker,
        restartCommands,
        readiness: this.readiness,
        config: this.config,
        roomId: this.roomId,
        bindingId: this.#webBindingId!
      });

      let toolApi: AIChatLinkToolBrokerApi | undefined;
      let mcpHandler: AIChatLinkMcpHttpHandler | undefined;
      let operatorApi: AIChatLinkOperatorBrokerApi | undefined;
      let operatorMcpHandler: AIChatLinkMcpHttpHandler | undefined;
      const knownTargets = this.adapters.list().map((adapter) => adapter.actorId);
      if (this.config.transport === "structured") {
        toolApi = new AIChatLinkToolBrokerApi({
          broker,
          turns,
          roomId: this.roomId,
          askTimeoutMs: this.config.timeouts.askMs
        });
        mcpHandler = createAIChatLinkMcpHttpHandler({
          broker: toolApi,
          bindings: this.bindings,
          knownTargets
        });
        operatorApi = new AIChatLinkOperatorBrokerApi({
          broker,
          restartCommands,
          config: this.config,
          roomId: this.roomId,
          bindingId: this.#operatorBindingId!,
          store: this.store,
          askTimeoutMs: this.config.timeouts.askMs,
          ...(this.#setupApi === undefined ? {} : { setupApi: this.#setupApi })
        });
        this.bindings.register({
          bindingId: this.#operatorBindingId!,
          actorId: ASSISTANT_ACTOR_ID,
          instanceId: LOCAL_OPERATOR_INSTANCE_ID
        });
        this.bindings.markReady(this.#operatorBindingId!);
        operatorMcpHandler = createAIChatLinkMcpHttpHandler({
          bindings: this.bindings,
          knownTargets,
          createServer: ({ binding, knownTargets: targets }) =>
            createAIChatLinkOperatorMcpServer({
              broker: operatorApi!,
              binding,
              ...(targets === undefined ? {} : { knownTargets: targets })
            })
        });
      }
      const assistantHost = new AIChatLinkAssistantHost({
        config: this.config,
        store: this.store,
        ...(this.#agentEnv === undefined ? {} : { env: this.#agentEnv })
      });

      const http = createAIChatLinkHttpServer({
        broker: webApi,
        sse: this.sse,
        host: this.config.server.host,
        port: this.#port,
        gracefulCloseTimeoutMs: this.config.timeouts.closeMs,
        ...(this.#staticRoot === undefined
          ? { staticRoot: fileURLToPath(new URL("../../web/", import.meta.url)) }
          : { staticRoot: this.#staticRoot }),
        ...(mcpHandler === undefined ? {} : { mcpHandler }),
        ...(operatorMcpHandler === undefined ? {} : { operatorMcpHandler }),
        ...(this.#setupApi === undefined ? {} : { setupApi: this.#setupApi }),
        ...(this.#setupApi === undefined ? {} : { workspaceApi: createSetupWorkspaceApi() }),
        ...(this.#workspaceHub === undefined ? {} : { workspaceHub: this.#workspaceHub }),
        ...(this.#workspaceRouting === undefined
          ? {}
          : { workspaceRouting: this.#workspaceRouting }),
        // The REST contract defaults to the built-in driver list, which cannot
        // know about extra agent ids such as `pi-architect` or `claude-builder`.
        // Pass the registered adapter ids so those room members stay addressable.
        knownTargets,
        assistantApi: {
          snapshot: (signal) => {
            signal.throwIfAborted();
            return assistantHost.snapshot();
          },
          listMessages: (signal) => {
            signal.throwIfAborted();
            return { messages: assistantHost.listMessages() };
          },
          postMessage: async (request, signal) => await assistantHost.postMessage(request, signal),
          cancel: async (request, signal) => {
            signal.throwIfAborted();
            return await assistantHost.cancel(request.clientCommandId);
          }
        },
        runtimeIdentity: this.runtimeIdentity,
        runtimeControl: {
          requestShutdown: async () => await this.close(),
          ...(this.#onError === undefined
            ? {}
            : {
                onShutdownError: (error: unknown) =>
                  this.#onError?.(error, { operation: "restart" })
              })
        }
      });
      this.#broker = broker;
      this.#turns = turns;
      this.#webApi = webApi;
      this.#toolApi = toolApi;
      this.#operatorApi = operatorApi;
      this.#assistantHost = assistantHost;
      this.#mcpHandler = mcpHandler;
      this.#operatorMcpHandler = operatorMcpHandler;
      this.#http = http;

      // Structured sessions need the actual bound origin. HTTP therefore
      // listens first, while readiness keeps all write commands closed. The
      // loopback listener is also the single-runtime lease: stale process
      // recovery must not mutate a live runtime's bindings before this process
      // has successfully claimed the configured port.
      const address = await http.start();
      const recovery = this.sessions.prepareRecovery();
      if (this.config.transport === "structured") {
        this.sessions.setStructuredMcpUrl(`${address.origin}/mcp`);
      }
      await this.sessions.startAll({ nativeSessionIds: recovery.nativeSessionIds });
      await broker.recoverAfterRestart();
      this.datedMemoryEngine.recover(this.roomId);
      await assistantHost.start(address.origin);
      this.readiness.markReady();
      const result = { address, recovery };
      this.#startResult = result;
      return result;
    } catch (error) {
      this.readiness.markFailed(error);
      // If close() is already waiting for startup, do not await it here: that
      // would create a cycle. Otherwise register startup cleanup as the single
      // close promise so later callers cannot close the store twice.
      if (this.#closePromise === undefined) {
        const cleanup = this.#performClose();
        this.#closePromise = cleanup;
        await cleanup.catch(() => undefined);
      }
      throw error;
    }
  }

  #createWebBinding(): void {
    const existingInstance = this.store.getAgentInstance(LOCAL_REST_WEB_INSTANCE_ID);
    const existingBinding = this.store.getSessionBinding(LOCAL_REST_WEB_BINDING_ID);
    if (existingInstance === undefined && existingBinding === undefined) {
      this.store.createAgentInstance({
        instanceId: LOCAL_REST_WEB_INSTANCE_ID,
        actorId: "user:web",
        adapterId: "web",
        status: "ready"
      });
      this.store.createSessionBinding({
        bindingId: LOCAL_REST_WEB_BINDING_ID,
        instanceId: LOCAL_REST_WEB_INSTANCE_ID,
        actorId: "user:web",
        protocol: "local-rest",
        status: "ready",
        capabilities: {
          transport: "loopback-http",
          access: "unrestricted"
        }
      });
    } else if (
      existingInstance?.actorId !== "user:web" ||
      existingInstance.adapterId !== "web" ||
      existingInstance.processEndedAt !== undefined ||
      existingBinding?.instanceId !== LOCAL_REST_WEB_INSTANCE_ID ||
      existingBinding.actorId !== "user:web" ||
      existingBinding.protocol !== "local-rest" ||
      existingBinding.status !== "ready" ||
      existingBinding.closedAt !== undefined
    ) {
      throw new AIChatLinkError(
        "STORE_CONFLICT",
        "Stable local-rest Web binding is missing or incompatible"
      );
    }
    this.#webBindingId = LOCAL_REST_WEB_BINDING_ID;
  }

  #createOperatorBinding(): void {
    const existingInstance = this.store.getAgentInstance(LOCAL_OPERATOR_INSTANCE_ID);
    const existingBinding = this.store.getSessionBinding(LOCAL_OPERATOR_BINDING_ID);
    if (existingInstance === undefined && existingBinding === undefined) {
      this.store.createAgentInstance({
        instanceId: LOCAL_OPERATOR_INSTANCE_ID,
        actorId: ASSISTANT_ACTOR_ID,
        adapterId: "operator",
        status: "ready"
      });
      this.store.createSessionBinding({
        bindingId: LOCAL_OPERATOR_BINDING_ID,
        instanceId: LOCAL_OPERATOR_INSTANCE_ID,
        actorId: ASSISTANT_ACTOR_ID,
        protocol: LOCAL_OPERATOR_PROTOCOL,
        status: "ready",
        capabilities: {
          transport: "loopback-http",
          access: "unrestricted",
          facet: "operator"
        }
      });
    } else if (
      existingInstance?.actorId !== ASSISTANT_ACTOR_ID ||
      existingInstance.adapterId !== "operator" ||
      existingInstance.processEndedAt !== undefined ||
      existingBinding?.instanceId !== LOCAL_OPERATOR_INSTANCE_ID ||
      existingBinding.actorId !== ASSISTANT_ACTOR_ID ||
      existingBinding.protocol !== LOCAL_OPERATOR_PROTOCOL ||
      existingBinding.status !== "ready" ||
      existingBinding.closedAt !== undefined
    ) {
      throw new AIChatLinkError(
        "STORE_CONFLICT",
        "Stable local-operator assistant binding is missing or incompatible"
      );
    }
    this.#operatorBindingId = LOCAL_OPERATOR_BINDING_ID;
  }

  async #performClose(): Promise<void> {
    const failures: unknown[] = [];
    const settle = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };

    // Stop product work immediately, but retain the loopback listener as the
    // single-runtime lease until sessions and the Store have fully closed.
    await settle(() => this.#http?.beginClose());
    await settle(async () => await this.#beforeClose?.());
    await settle(async () => await this.#http?.drain());
    await settle(async () => await this.#assistantHost?.close());
    await settle(async () => await this.#operatorMcpHandler?.close());
    await settle(async () => await this.#mcpHandler?.close());
    await settle(() => this.contextEngine.close());
    await settle(async () => await this.datedMemoryEngine.close());
    await settle(async () => await this.#broker?.close());
    await settle(async () => await this.sessions.close());
    await settle(async () => await this.publisher.close());
    await settle(() => this.sse.close());
    if (this.#closeStore) await settle(() => this.store.close());
    await settle(async () => await this.#http?.close());

    if (failures.length > 0) {
      throw new AggregateError(failures, "AIChatLink runtime did not close cleanly");
    }
  }

}

export async function startAIChatLinkRuntime(
  config: AIChatLinkConfig,
  options: AIChatLinkRuntimeOptions = {}
): Promise<AIChatLinkRuntime> {
  const runtime = new AIChatLinkRuntime(config, options);
  await runtime.start();
  return runtime;
}
