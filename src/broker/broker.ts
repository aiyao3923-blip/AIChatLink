import type {
  CancelResult,
  CliAdapter,
  NativeEvent,
  NativeSession
} from "../adapters/types.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { ConversationSummary } from "../contracts/rest.js";
import {
  asTransientEnvelope,
  BUILTIN_ACTORS,
  createCorrelationId,
  createId,
  DEFAULT_ROOM_ID,
  AICHATLINK_SCHEMA,
  type AIChatLinkEnvelope,
  type AIChatLinkEventType
} from "../core/envelope.js";
import { AIChatLinkError, toAIChatLinkError, type AIChatLinkErrorCode } from "../core/errors.js";
import {
  DEFAULT_STEERS_PER_SUBJECT_TURN,
  SUPERVISION_CONTENT_FLUSH_CHARS,
  SUPERVISION_SNAPSHOT_MESSAGE_LIMIT,
  excerptText,
  isSupervisionWatchMessage,
  toolNameFromDetails,
  type SupervisionMilestone,
  type SupervisionSnapshot,
  type SupervisionSnapshotTool
} from "../core/supervision.js";
import type {
  AcceptMessageResult,
  ClaimedTurn,
  AIChatLinkStore,
  IdentityQuery,
  IdentityRecord,
  MemoryQuery,
  MemoryRecord,
  RecoveryResult,
  StoredEventRecord,
  TerminalToolProgressInput,
  TerminalTurnStatus,
  TurnRecord,
  TurnStatus
} from "../storage/types.js";
import type {
  ActiveBrokerTurnContext,
  AcceptBrokerMessageInput,
  BrokerBootstrap,
  BrokerDependencies,
  BrokerErrorContext,
  BrokerHealth,
  CancelTurnFromBindingInput,
  CancelTurnOutcome,
  CompactContextFromBindingInput,
  DeleteConversationFromBindingInput,
  DeleteConversationFromBindingResult,
  ResetContextFromBindingInput,
  ResumeConversationFromBindingInput,
  SupervisionStatusQuery,
  CorrelationWaitResult,
  CorrelationReadResult,
  DispatchPreparation,
  ReadCorrelationInput,
  SteerSubjectInput,
  SteerSubjectResult,
  WatchSubjectInput,
  WatchSubjectResult,
  RememberIdentityFromBindingInput,
  RememberMemoryFromBindingInput,
  RetractRecordFromBindingInput,
  SupersedeIdentityFromBindingInput,
  SupersedeMemoryFromBindingInput,
  TurnQueueSnapshot,
  WaitForCorrelationInput
} from "./types.js";

const TERMINAL_TURN_STATUSES = new Set<TurnStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

/**
 * Statuses that still occupy work in a room. A finish-last Turn waits for all
 * of them; `queued` counts because a peer that has not been claimed yet is
 * still ahead of the closing Turn, not behind it.
 */
const RUNNING_TURN_STATUSES: readonly TurnStatus[] = [
  "queued",
  "dispatching",
  "running",
  "cancelling"
];
const DEFAULT_FINISH_LAST_WAIT_MS = 1_800_000;
/** How often a held finish-last Turn re-checks its room while nothing else moves. */
const FINISH_LAST_RECHECK_MS = 30_000;

const DEFAULT_PARTIAL_CHECKPOINT_CHARS = 4_096;
const DEFAULT_NATIVE_CANCEL_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_EVENT_PAGE = 500;

interface ActiveDispatch {
  preparation: DispatchPreparation;
  controller: AbortController;
  partialText: string;
  reasoningText: string;
  toolProgress: TerminalToolProgressInput[];
  checkpointedLength: number;
  lastFlushedLength: number;
  chunkIndex: number;
  started: boolean;
  terminal: boolean;
  durableStatus?: TurnStatus;
  cancelRequested: boolean;
  cancelResult?: CancelResult;
  nativeCancelPromise?: Promise<CancelResult>;
  nativeTerminalInFlight: boolean;
  nativeTurnId?: string;
  lifecycleContext: ActiveBrokerTurnContext;
  lifecycleActive: boolean;
  automaticRecoveryRequested: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringProperty(value: unknown, ...names: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function messageContent(event: StoredEventRecord): string {
  const content = stringProperty(event.body, "content");
  if (content === undefined) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Persisted source message has no text content");
  }
  return content;
}

function nativeErrorCode(event: NativeEvent, fallback: AIChatLinkErrorCode): string {
  return stringProperty(event.payload, "errorCode", "code") ?? fallback;
}

function terminalContent(event: NativeEvent, accumulated: string): string {
  return stringProperty(event.payload, "content", "text", "message") ?? accumulated;
}

function toEnvelope(event: StoredEventRecord): AIChatLinkEnvelope {
  return {
    schema: AICHATLINK_SCHEMA,
    eventId: event.eventId,
    seq: event.seq,
    roomId: event.roomId,
    type: event.eventType as AIChatLinkEventType,
    actor: {
      actorId: event.actorId,
      kind: event.actorKind,
      displayName: event.actorDisplayName,
      ...(event.instanceId === undefined ? {} : { instanceId: event.instanceId })
    },
    to: [...event.targets],
    ...(event.replyToEventId === undefined ? {} : { replyToEventId: event.replyToEventId }),
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    correlationId: event.correlationId,
    rootCorrelationId: event.correlationId,
    ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
    occurredAt: event.occurredAt,
    durability: "durable",
    body: event.body,
    ...(event.provenance === undefined ? {} : { provenance: event.provenance })
  };
}

/**
 * Durable Broker application core. HTTP, MCP, process startup, and SQLite
 * ownership are composed outside this class.
 */
export class AIChatLinkBroker {
  readonly #store: AIChatLinkStore;
  readonly #adapters: AdapterRegistry;
  readonly #sessions: BrokerDependencies["sessions"];
  readonly #publisher: BrokerDependencies["publisher"];
  readonly #agentController: BrokerDependencies["agentController"];
  readonly #contextProvider: BrokerDependencies["contextProvider"];
  readonly #contextController: BrokerDependencies["contextController"];
  readonly #datedMemoryController: BrokerDependencies["datedMemoryController"];
  readonly #turnLifecycle: BrokerDependencies["turnLifecycle"];
  readonly #acceptMessageLimits: BrokerDependencies["acceptMessageLimits"];
  readonly #steerLimit: number;
  readonly #watchTimeoutMs: number;
  readonly #selectedTransport: BrokerDependencies["selectedTransport"];
  readonly #clock: NonNullable<BrokerDependencies["clock"]>;
  readonly #idFactory: NonNullable<BrokerDependencies["idFactory"]>;
  readonly #defaultRoomId: string;
  readonly #agentOrder: BrokerDependencies["agentOrder"];
  readonly #finishLastActors: ReadonlySet<string>;
  readonly #finishLastWaitMs: number;
  readonly #finishLastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #partialCheckpointChars: number;
  readonly #nativeCancelTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #onError: BrokerDependencies["onError"];
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #dirtyActors = new Set<string>();
  readonly #active = new Map<string, ActiveDispatch>();
  readonly #cancelFlights = new Map<string, Promise<CancelTurnOutcome>>();
  readonly #cancelCommandFlights = new Map<string, Promise<CancelTurnOutcome>>();
  readonly #contextCommandFlights = new Map<
    string,
    Promise<import("../memory/types.js").RoomContextCompactionResult>
  >();
  readonly #resetCommandFlights = new Map<
    string,
    Promise<import("../memory/types.js").RoomContextResetResult>
  >();
  readonly #deleteCommandFlights = new Map<
    string,
    Promise<DeleteConversationFromBindingResult>
  >();
  readonly #turnWaiters = new Map<string, Set<() => void>>();
  readonly #milestoneWaiters = new Map<string, Set<(milestone: SupervisionMilestone) => void>>();
  readonly #watchCursors = new Map<string, number>();
  readonly #closingController = new AbortController();
  #closePromise?: Promise<void>;
  #closed = false;
  #storeWritesFenced = false;

  constructor(dependencies: BrokerDependencies) {
    this.#store = dependencies.store;
    this.#adapters = dependencies.adapters;
    this.#sessions = dependencies.sessions;
    this.#publisher = dependencies.publisher;
    this.#agentController = dependencies.agentController;
    this.#contextProvider = dependencies.contextProvider;
    this.#contextController = dependencies.contextController;
    this.#datedMemoryController = dependencies.datedMemoryController;
    this.#turnLifecycle = dependencies.turnLifecycle;
    this.#acceptMessageLimits = dependencies.acceptMessageLimits;
    this.#steerLimit = dependencies.steerLimit ?? DEFAULT_STEERS_PER_SUBJECT_TURN;
    this.#watchTimeoutMs = dependencies.watchTimeoutMs ?? 120_000;
    this.#selectedTransport = dependencies.selectedTransport;
    this.#clock = dependencies.clock ?? { now: nowIso };
    this.#idFactory = dependencies.idFactory ?? createId;
    this.#defaultRoomId = dependencies.defaultRoomId ?? DEFAULT_ROOM_ID;
    this.#agentOrder = dependencies.agentOrder;
    this.#finishLastActors = dependencies.finishLastActors ?? new Set();
    this.#finishLastWaitMs = dependencies.finishLastWaitMs ?? DEFAULT_FINISH_LAST_WAIT_MS;
    this.#partialCheckpointChars =
      dependencies.partialCheckpointChars ?? DEFAULT_PARTIAL_CHECKPOINT_CHARS;
    this.#nativeCancelTimeoutMs =
      dependencies.nativeCancelTimeoutMs ?? DEFAULT_NATIVE_CANCEL_TIMEOUT_MS;
    this.#closeTimeoutMs = dependencies.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#onError = dependencies.onError;

    if (!Number.isSafeInteger(this.#partialCheckpointChars) || this.#partialCheckpointChars < 1) {
      throw new RangeError("partialCheckpointChars must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#nativeCancelTimeoutMs) || this.#nativeCancelTimeoutMs < 1) {
      throw new RangeError("nativeCancelTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#closeTimeoutMs) || this.#closeTimeoutMs < 1) {
      throw new RangeError("closeTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#steerLimit) || this.#steerLimit < 1) {
      throw new RangeError("steerLimit must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#finishLastWaitMs) || this.#finishLastWaitMs < 1) {
      throw new RangeError("finishLastWaitMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#watchTimeoutMs) || this.#watchTimeoutMs < 1) {
      throw new RangeError("watchTimeoutMs must be a positive integer");
    }
    if (this.#selectedTransport !== "direct" && this.#selectedTransport !== "structured") {
      throw new RangeError("selectedTransport must be direct or structured");
    }
  }

  async acceptMessage(input: AcceptBrokerMessageInput): Promise<AcceptMessageResult> {
    this.#assertOpen();
    const toTarget = (actorId: string) => {
      const adapter = this.#adapters.getByActor(actorId);
      return {
        actorId,
        adapterId: adapter.adapterId,
        transport: this.#selectedTransport,
        ...(input.parentTurnId === undefined ? {} : { parentTurnId: input.parentTurnId }),
        ...(input.hopCount === undefined ? {} : { hopCount: input.hopCount })
      };
    };
    const targets = input.request.to.map(toTarget);
    const supervision =
      input.request.supervision === undefined
        ? undefined
        : {
            mode: input.request.supervision.mode,
            observers: input.request.supervision.observers.map(toTarget)
          };
    const binding = this.#store.getSessionBinding(input.bindingId);
    const sourceKind =
      binding?.protocol === "local-rest"
        ? "web"
        : binding?.protocol === "local-operator"
          ? "operator"
          : "mcp";
    const outcome = this.#store.acceptMessageWithDisposition({
      sourceBindingId: input.bindingId,
      clientCommandId: input.request.clientCommandId,
      commandType: input.commandType ?? "message.send",
      roomId: input.roomId ?? this.#defaultRoomId,
      targets,
      content: input.request.content,
      ...(input.request.replyToEventId === undefined
        ? {}
        : { replyToEventId: input.request.replyToEventId }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      occurredAt: this.#clock.now(),
      provenance: { sourceKind },
      ...(this.#acceptMessageLimits === undefined
        ? {}
        : { limits: this.#acceptMessageLimits }),
      ...(supervision === undefined ? {} : { supervision }),
      ...(input.sourceEventType === undefined ? {} : { sourceEventType: input.sourceEventType }),
      ...(input.operation === undefined ? {} : { operation: input.operation }),
      ...(input.existingSourceEventId === undefined
        ? {}
        : { existingSourceEventId: input.existingSourceEventId })
    });

    if (outcome.disposition === "accepted") {
      const source = this.#store.getEvent(outcome.result.messageEventId);
      if (!source) {
        throw new AIChatLinkError("STORE_UNAVAILABLE", "Accepted source event is missing");
      }
      await this.#publishStored(source);
      if (this.#closed) return outcome.result;
      const publishQueued = async (result: { turnId: string }): Promise<void> => {
        const turn = this.#store.getTurn(result.turnId);
        const queued = turn ? this.#store.getEvent(turn.queuedEventId) : undefined;
        if (!turn || !queued) {
          throw new AIChatLinkError("STORE_UNAVAILABLE", "Accepted queued Turn evidence is missing");
        }
        await this.#publishStored(queued);
        if (this.#closed) return;
        this.#scheduleActor(turn.targetActorId);
      };
      for (const result of outcome.result.turns) {
        await publishQueued(result);
        if (this.#closed) return outcome.result;
      }
      if (outcome.result.watchEventId !== undefined) {
        const watchEvent = this.#store.getEvent(outcome.result.watchEventId);
        if (!watchEvent) {
          throw new AIChatLinkError("STORE_UNAVAILABLE", "Accepted watch event is missing");
        }
        await this.#publishStored(watchEvent);
        if (this.#closed) return outcome.result;
      }
      for (const result of outcome.result.watchTurns ?? []) {
        await publishQueued(result);
        if (this.#closed) return outcome.result;
      }
      if (outcome.result.pairEventId !== undefined) {
        const pairEvent = this.#store.getEvent(outcome.result.pairEventId);
        if (!pairEvent) {
          throw new AIChatLinkError("STORE_UNAVAILABLE", "Accepted supervision pair event is missing");
        }
        await this.#publishStored(pairEvent);
      }
    }
    return outcome.result;
  }

  contextUsage(roomId = this.#defaultRoomId): import("../memory/types.js").RoomContextUsage {
    this.#assertOpen();
    if (!this.#contextController) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "Room context controller is unavailable");
    }
    return this.#contextController.inspectUsage(roomId);
  }

  /**
   * Conversation epochs are the context resets the operator can create. Reading
   * them is a pure projection: the transcript is never rewritten or split.
   */
  listConversations(roomId = this.#defaultRoomId): ConversationSummary[] {
    this.#assertOpen();
    const resets = this.#store.listContextResets(roomId);
    const ends = resets.map((reset) => reset.throughSeq);
    const starts = [1, ...ends.map((end) => end + 1)];
    const conversations: ConversationSummary[] = [];
    const titles = new Map<string, string>();
    for (const [index, startSeq] of starts.entries()) {
      const endSeq = ends[index] ?? null;
      // A second boundary at the same high-water mark (a resume of an epoch
      // that never received a message) supersedes the earlier projection.
      if (endSeq !== null && endSeq < startSeq) continue;
      const resume = index === 0 ? undefined : resets[index - 1]?.resume;
      const first = this.#store.firstUserMessage(
        roomId,
        startSeq - 1,
        endSeq === null ? undefined : endSeq
      );
      const hasMessages =
        first !== undefined ||
        this.#store.hasRoomContextMessage(
          roomId,
          startSeq - 1,
          endSeq === null ? undefined : endSeq
        );
      // A closed epoch with no room-context message is a boundary artifact:
      // two resets in a row, or a reset immediately followed by a resume. There
      // is no transcript to show, so it does not become a conversation. The
      // open epoch stays in the list (it carries the live epoch start) but is
      // flagged `empty`, so the sidebar only shows it once it has content.
      if (endSeq !== null && !hasMessages) {
        continue;
      }
      const sourceTitle =
        resume === undefined ? undefined : titles.get(resume.conversationId);
      const title =
        first === undefined
          ? sourceTitle === undefined
            ? conversationTitle(undefined, conversations.length + 1)
            : `${sourceTitle} · 续`
          : conversationTitle(first.content, conversations.length + 1);
      const startedAt =
        first?.occurredAt ??
        resets[index - 1]?.createdAt ??
        new Date(0).toISOString();
      const conversationId = `conv:${startSeq}`;
      titles.set(conversationId, title);
      conversations.push({
        conversationId,
        title,
        startSeq,
        endSeq,
        startedAt,
        active: endSeq === null,
        empty: !hasMessages,
        resumedFrom:
          resume === undefined
            ? null
            : {
                conversationId: resume.conversationId,
                title: titles.get(resume.conversationId) ?? sourceTitle ?? resume.conversationId,
                fromSeq: resume.fromSeq,
                throughSeq: resume.throughSeq
              }
      });
    }
    return conversations.reverse();
  }

  async compactContextFromBinding(
    input: CompactContextFromBindingInput
  ): Promise<import("../memory/types.js").RoomContextCompactionResult> {
    this.#assertOpen();
    if (!this.#contextController) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "Room context controller is unavailable");
    }
    const roomId = input.roomId ?? this.#defaultRoomId;
    const command = this.#store.beginClientCommand<
      import("../memory/types.js").RoomContextCompactionResult
    >({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      commandType: "context.compact",
      canonicalPayload: { roomId },
      acceptedAt: this.#clock.now()
    });
    if (command.disposition === "replayed") return command.result;

    const commandKey = JSON.stringify([input.bindingId, input.clientCommandId]);
    const existingFlight = this.#contextCommandFlights.get(commandKey);
    if (existingFlight) return existingFlight;
    const flight = this.#completeContextCommand({ ...input, roomId });
    this.#contextCommandFlights.set(commandKey, flight);
    try {
      return await flight;
    } finally {
      if (this.#contextCommandFlights.get(commandKey) === flight) {
        this.#contextCommandFlights.delete(commandKey);
      }
    }
  }

  async resetContextFromBinding(
    input: ResetContextFromBindingInput
  ): Promise<import("../memory/types.js").RoomContextResetResult> {
    this.#assertOpen();
    if (!this.#contextController) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "Room context controller is unavailable");
    }
    const roomId = input.roomId ?? this.#defaultRoomId;
    const resetNativeSessions = input.resetNativeSessions === true;
    const command = this.#store.beginClientCommand<
      import("../memory/types.js").RoomContextResetResult
    >({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      commandType: "context.reset",
      canonicalPayload: { roomId, resetNativeSessions },
      acceptedAt: this.#clock.now()
    });
    if (command.disposition === "replayed") return command.result;

    const commandKey = JSON.stringify([input.bindingId, input.clientCommandId]);
    const existingFlight = this.#resetCommandFlights.get(commandKey);
    if (existingFlight) return existingFlight;
    const flight = this.#completeResetCommand({
      ...input,
      roomId,
      resetNativeSessions
    });
    this.#resetCommandFlights.set(commandKey, flight);
    try {
      return await flight;
    } finally {
      if (this.#resetCommandFlights.get(commandKey) === flight) {
        this.#resetCommandFlights.delete(commandKey);
      }
    }
  }

  /**
   * Reopen a closed conversation as the seed of a new epoch. The transcript is
   * never rewritten: the resumed range is recorded on the new reset boundary
   * and replayed verbatim into later Context Packets.
   */
  async resumeConversationFromBinding(
    input: ResumeConversationFromBindingInput
  ): Promise<import("../memory/types.js").RoomContextResetResult> {
    this.#assertOpen();
    if (!this.#contextController) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "Room context controller is unavailable");
    }
    const roomId = input.roomId ?? this.#defaultRoomId;
    const target = this.listConversations(roomId).find(
      (conversation) => conversation.conversationId === input.conversationId
    );
    if (!target) {
      throw new AIChatLinkError("UNKNOWN_TARGET", "Conversation does not exist", {
        conversationId: input.conversationId
      });
    }
    if (target.endSeq === null) {
      throw new AIChatLinkError(
        "INVALID_ENVELOPE",
        "The open conversation cannot be resumed; keep talking in it instead",
        { conversationId: input.conversationId }
      );
    }
    // Resuming an epoch that was itself resumed must keep the history it was
    // seeded with, otherwise the second hop silently drops the original
    // conversation. Its own seed already starts at the origin, so one hop is
    // enough to reach it.
    const resume = {
      conversationId: target.conversationId,
      fromSeq: target.resumedFrom?.fromSeq ?? target.startSeq,
      throughSeq: target.endSeq
    };
    const resetNativeSessions = input.resetNativeSessions === true;
    const command = this.#store.beginClientCommand<
      import("../memory/types.js").RoomContextResetResult
    >({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      commandType: "conversation.resume",
      canonicalPayload: { roomId, ...resume, resetNativeSessions },
      acceptedAt: this.#clock.now()
    });
    if (command.disposition === "replayed") return command.result;

    const commandKey = JSON.stringify([input.bindingId, input.clientCommandId]);
    const existingFlight = this.#resetCommandFlights.get(commandKey);
    if (existingFlight) return existingFlight;
    const flight = this.#completeResumeCommand({
      ...input,
      roomId,
      resume,
      resetNativeSessions
    });
    this.#resetCommandFlights.set(commandKey, flight);
    try {
      return await flight;
    } finally {
      if (this.#resetCommandFlights.get(commandKey) === flight) {
        this.#resetCommandFlights.delete(commandKey);
      }
    }
  }

  /**
   * Permanently deletes one conversation. The open epoch is closed with a
   * normal reset first, so the agents' native sessions restart fresh and the
   * room keeps exactly one (empty) open epoch afterwards.
   */
  async deleteConversationFromBinding(
    input: DeleteConversationFromBindingInput
  ): Promise<DeleteConversationFromBindingResult> {
    this.#assertOpen();
    if (!this.#contextController) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "Room context controller is unavailable");
    }
    const roomId = input.roomId ?? this.#defaultRoomId;
    const resetNativeSessions = input.resetNativeSessions !== false;
    // The receipt is looked up first: once a delete completed, its conversation
    // no longer exists, and a retry must still replay the stored result.
    const command = this.#store.beginClientCommand<DeleteConversationFromBindingResult>({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      commandType: "conversation.delete",
      canonicalPayload: {
        roomId,
        conversationId: input.conversationId,
        resetNativeSessions
      },
      acceptedAt: this.#clock.now()
    });
    if (command.disposition === "replayed") return command.result;

    const target = this.listConversations(roomId).find(
      (conversation) => conversation.conversationId === input.conversationId
    );
    if (!target) {
      throw new AIChatLinkError("UNKNOWN_TARGET", "Conversation does not exist", {
        conversationId: input.conversationId
      });
    }
    const inFlight = this.#store
      .listTurns()
      .filter((turn) => !TERMINAL_TURN_STATUSES.has(turn.status));
    if (inFlight.length > 0) {
      throw new AIChatLinkError(
        "INVALID_ENVELOPE",
        "A conversation cannot be deleted while turns are queued or running",
        { conversationId: input.conversationId, pendingTurns: inFlight.length }
      );
    }

    const commandKey = JSON.stringify([input.bindingId, input.clientCommandId]);
    const existingFlight = this.#deleteCommandFlights.get(commandKey);
    if (existingFlight) return existingFlight;
    const flight = this.#completeDeleteCommand({
      ...input,
      roomId,
      target,
      resetNativeSessions
    });
    this.#deleteCommandFlights.set(commandKey, flight);
    try {
      return await flight;
    } finally {
      if (this.#deleteCommandFlights.get(commandKey) === flight) {
        this.#deleteCommandFlights.delete(commandKey);
      }
    }
  }

  async #completeDeleteCommand(
    input: DeleteConversationFromBindingInput & {
      roomId: string;
      target: ConversationSummary;
      resetNativeSessions: boolean;
    }
  ): Promise<DeleteConversationFromBindingResult> {
    try {
      let throughSeq = input.target.endSeq;
      if (throughSeq === null) {
        // Closing the open epoch keeps the native-session contract: a deleted
        // conversation must not stay alive inside an agent's process.
        const reset = this.#contextController!.resetNow(input.roomId, input.resetNativeSessions);
        if (reset.reset) {
          const event = this.#store.appendDurableEvent({
            roomId: input.roomId,
            eventType: "context.reset",
            actorId: BUILTIN_ACTORS.system.actorId,
            targets: [],
            correlationId: createCorrelationId(),
            occurredAt: this.#clock.now(),
            body: {
              throughSeq: reset.throughSeq,
              resetNativeSessions: input.resetNativeSessions
            },
            provenance: {
              sourceKind: "operator",
              labels: ["context-reset", "conversation-delete"]
            }
          });
          await this.#publishStored(event);
          if (input.resetNativeSessions && this.#agentController) {
            for (const adapter of this.#adapters.list()) {
              const controller = this.#agentController;
              if (controller.restartFresh !== undefined) {
                await controller.restartFresh(adapter.actorId);
              } else {
                await controller.restart(adapter.actorId);
              }
            }
          }
        }
        throughSeq = reset.throughSeq;
      }
      const purged = this.#store.purgeConversationRange({
        roomId: input.roomId,
        fromSeq: input.target.startSeq,
        throughSeq
      });
      if (this.#storeWritesFenced) {
        throw new AIChatLinkError(
          "SESSION_NOT_AVAILABLE",
          "Broker closed before the delete receipt was persisted"
        );
      }
      return this.#store.completeClientCommand({
        sourceBindingId: input.bindingId,
        clientCommandId: input.clientCommandId,
        result: {
          conversationId: input.target.conversationId,
          deletedEvents: purged.deletedEvents,
          deletedTurns: purged.deletedTurns
        }
      });
    } catch (error) {
      this.#report(error, { operation: "context" });
      throw error;
    }
  }

  supervisionStatus(input: SupervisionStatusQuery): {
    pairId: string;
    correlationId: string;
    mode: "live_steer";
    workers: import("../core/supervision.js").SupervisionSnapshot[];
    observers: Array<{ actorId: string; turnId: string; status: string }>;
  } {
    this.#assertOpen();
    const pair =
      input.pairId !== undefined
        ? this.#store.getSupervisionPair(input.pairId)
        : input.correlationId !== undefined
          ? this.#store.getSupervisionPairByCorrelation(input.correlationId)
          : undefined;
    if (!pair) {
      throw new AIChatLinkError("SUPERVISION_PAIR_INVALID", "The supervision pair was not found");
    }
    const members = this.#store.listSupervisionPairTurns(pair.pairId);
    const workers = members
      .filter((member) => member.role === "worker")
      .map((member) => {
        const turn = this.#store.getTurn(member.turnId);
        if (!turn) {
          throw new AIChatLinkError("STORE_UNAVAILABLE", "A supervision worker Turn is missing");
        }
        return this.#buildSupervisionSnapshot(turn);
      });
    const observers = members
      .filter((member) => member.role === "observer")
      .map((member) => {
        const turn = this.#store.getTurn(member.turnId);
        return {
          actorId: member.actorId,
          turnId: member.turnId,
          status: turn?.status ?? "unknown"
        };
      });
    return {
      pairId: pair.pairId,
      correlationId: pair.correlationId,
      mode: pair.mode,
      workers,
      observers
    };
  }

  async #completeResetCommand(
    input: ResetContextFromBindingInput & { roomId: string; resetNativeSessions: boolean }
  ): Promise<import("../memory/types.js").RoomContextResetResult> {
    try {
      const result = this.#contextController!.resetNow(input.roomId, input.resetNativeSessions);
      if (result.reset) {
        const event = this.#store.appendDurableEvent({
          roomId: input.roomId,
          eventType: "context.reset",
          actorId: BUILTIN_ACTORS.system.actorId,
          targets: [],
          correlationId: createCorrelationId(),
          occurredAt: this.#clock.now(),
          body: {
            throughSeq: result.throughSeq,
            resetNativeSessions: input.resetNativeSessions
          },
          provenance: { sourceKind: "operator", labels: ["context-reset"] }
        });
        await this.#publishStored(event);
        if (input.resetNativeSessions && this.#agentController) {
          for (const adapter of this.#adapters.list()) {
            const controller = this.#agentController;
            if (controller.restartFresh !== undefined) await controller.restartFresh(adapter.actorId);
            else await controller.restart(adapter.actorId);
          }
        }
      }
      if (this.#storeWritesFenced) {
        throw new AIChatLinkError(
          "SESSION_NOT_AVAILABLE",
          "Broker closed before the context command receipt was persisted"
        );
      }
      return this.#store.completeClientCommand({
        sourceBindingId: input.bindingId,
        clientCommandId: input.clientCommandId,
        result
      });
    } catch (error) {
      this.#report(error, { operation: "context" });
      throw error;
    }
  }

  async #completeResumeCommand(
    input: ResumeConversationFromBindingInput & {
      roomId: string;
      resume: { conversationId: string; fromSeq: number; throughSeq: number };
      resetNativeSessions: boolean;
    }
  ): Promise<import("../memory/types.js").RoomContextResetResult> {
    try {
      const result = this.#contextController!.resumeNow(
        input.roomId,
        input.resume,
        input.resetNativeSessions
      );
      const event = this.#store.appendDurableEvent({
        roomId: input.roomId,
        eventType: "context.reset",
        actorId: BUILTIN_ACTORS.system.actorId,
        targets: [],
        correlationId: createCorrelationId(),
        occurredAt: this.#clock.now(),
        body: {
          throughSeq: result.throughSeq,
          resetNativeSessions: input.resetNativeSessions,
          resumedConversationId: input.resume.conversationId,
          resumeFromSeq: input.resume.fromSeq,
          resumeThroughSeq: input.resume.throughSeq
        },
        provenance: { sourceKind: "operator", labels: ["conversation-resume"] }
      });
      await this.#publishStored(event);
      if (input.resetNativeSessions && this.#agentController) {
        for (const adapter of this.#adapters.list()) {
          const controller = this.#agentController;
          if (controller.restartFresh !== undefined) await controller.restartFresh(adapter.actorId);
          else await controller.restart(adapter.actorId);
        }
      }
      if (this.#storeWritesFenced) {
        throw new AIChatLinkError(
          "SESSION_NOT_AVAILABLE",
          "Broker closed before the resume receipt was persisted"
        );
      }
      return this.#store.completeClientCommand({
        sourceBindingId: input.bindingId,
        clientCommandId: input.clientCommandId,
        result
      });
    } catch (error) {
      this.#report(error, { operation: "context" });
      throw error;
    }
  }

  async #completeContextCommand(
    input: CompactContextFromBindingInput & { roomId: string }
  ): Promise<import("../memory/types.js").RoomContextCompactionResult> {
    try {
      const result = await this.#contextController!.compactNow(input.roomId);
      if (this.#storeWritesFenced) {
        throw new AIChatLinkError(
          "SESSION_NOT_AVAILABLE",
          "Broker closed before the context command receipt was persisted"
        );
      }
      return this.#store.completeClientCommand({
        sourceBindingId: input.bindingId,
        clientCommandId: input.clientCommandId,
        result
      });
    } catch (error) {
      this.#report(error, { operation: "context" });
      throw error;
    }
  }

  async cancelTurn(turnId: string): Promise<CancelTurnOutcome> {
    this.#assertOpen();
    const existingFlight = this.#cancelFlights.get(turnId);
    if (existingFlight) return existingFlight;
    const flight = this.#cancelTurnOnce(turnId);
    this.#cancelFlights.set(turnId, flight);
    try {
      return await flight;
    } finally {
      if (this.#cancelFlights.get(turnId) === flight) this.#cancelFlights.delete(turnId);
    }
  }

  async #cancelTurnOnce(turnId: string): Promise<CancelTurnOutcome> {
    let turn = this.#store.getTurn(turnId);
    if (!turn) {
      throw new AIChatLinkError("UNKNOWN_TARGET", "Turn does not exist");
    }
    if (TERMINAL_TURN_STATUSES.has(turn.status)) {
      return {
        turnId,
        accepted: false,
        status: turn.status
      };
    }
    if (turn.status === "queued") {
      let terminal;
      try {
        terminal = this.#store.cancelQueuedTurn(turnId, this.#clock.now());
      } catch (error) {
        const after = this.#store.getTurn(turnId);
        if (after && TERMINAL_TURN_STATUSES.has(after.status)) {
          return { turnId, accepted: false, status: after.status };
        }
        if (!after || (after.status !== "dispatching" && after.status !== "running" && after.status !== "cancelling")) {
          throw error;
        }
        // The FIFO pump can claim the queued Turn between our read and the
        // queued cancellation CAS. Continue against the freshly persisted
        // state instead of losing the cancellation intent to that race.
        turn = after;
      }
      if (terminal) {
        this.#notifyTurnTerminal(turnId);
        this.#scheduleActor(turn.targetActorId);
        await this.#publishStored(terminal.terminalEvent);
        return { turnId, accepted: true, status: terminal.turn.status };
      }
    }
    if (turn.status !== "cancelling") {
      try {
        turn = this.#store.requestTurnCancellation(turnId);
      } catch (error) {
        const after = this.#store.getTurn(turnId);
        if (after && TERMINAL_TURN_STATUSES.has(after.status)) {
          return { turnId, accepted: false, status: after.status };
        }
        if (after?.status === "cancelling") {
          turn = after;
        } else {
          throw error;
        }
      }
    }

    const active = this.#active.get(turnId);
    if (!active) {
      return this.#cancelOutcomeFromStore(turnId);
    }
    active.cancelRequested = true;
    if (!active.nativeTurnId) {
      active.controller.abort(
        new AIChatLinkError("TURN_INTERRUPTED", "Cancellation arrived before a native Turn id")
      );
      return this.#cancelOutcomeFromStore(turnId);
    }

    try {
      const result = await this.#awaitNativeCancel(active);
      if (result.terminalObserved && !active.terminal) {
        await this.#terminalOnce(active, "cancelled");
        active.controller.abort(new AIChatLinkError("TURN_INTERRUPTED", "Native cancellation completed"));
      }
      if (this.#storeWritesFenced) {
        return { turnId, accepted: true, status: active.durableStatus ?? "cancelling" };
      }
      return this.#cancelOutcomeFromStore(turnId);
    } catch (error) {
      this.#report(error, { operation: "dispatch", actorId: turn.targetActorId, turnId });
      if (this.#storeWritesFenced) {
        return { turnId, accepted: true, status: active.durableStatus ?? "cancelling" };
      }
      return this.#cancelOutcomeFromStore(turnId);
    }
  }

  async cancelFromBinding(input: CancelTurnFromBindingInput): Promise<CancelTurnOutcome> {
    this.#assertOpen();
    const command = this.#store.beginClientCommand<CancelTurnOutcome>({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      commandType: "turn.cancel",
      canonicalPayload: { turnId: input.turnId },
      acceptedAt: this.#clock.now()
    });
    if (command.disposition === "replayed") return command.result;

    const commandKey = JSON.stringify([input.bindingId, input.clientCommandId]);
    const existingFlight = this.#cancelCommandFlights.get(commandKey);
    if (existingFlight) return existingFlight;

    const flight = this.#completeCancelCommand(input);
    this.#cancelCommandFlights.set(commandKey, flight);
    try {
      return await flight;
    } finally {
      if (this.#cancelCommandFlights.get(commandKey) === flight) {
        this.#cancelCommandFlights.delete(commandKey);
      }
    }
  }

  async #completeCancelCommand(
    input: CancelTurnFromBindingInput
  ): Promise<CancelTurnOutcome> {
    const result = await this.cancelTurn(input.turnId);
    if (this.#storeWritesFenced) {
      throw new AIChatLinkError(
        "SESSION_NOT_AVAILABLE",
        "Broker closed before the cancel command receipt was persisted"
      );
    }
    return this.#store.completeClientCommand({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      result
    });
  }

  readCorrelation(input: ReadCorrelationInput = {}): CorrelationReadResult {
    return this.#readCorrelation(input, true);
  }

  #readCorrelation(input: ReadCorrelationInput, assertOpen: boolean): CorrelationReadResult {
    if (assertOpen) this.#assertOpen();
    const roomId = input.roomId ?? this.#defaultRoomId;
    const afterSeq = input.afterSeq ?? 0;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), MAX_EVENT_PAGE);
    const events: AIChatLinkEnvelope[] = [];
    let cursor = afterSeq;
    let exhausted = false;

    while (events.length < limit && !exhausted) {
      const page = this.#store.listEvents({ roomId, afterSeq: cursor, limit: MAX_EVENT_PAGE });
      if (page.events.length === 0) {
        exhausted = true;
        break;
      }
      for (const event of page.events) {
        cursor = event.seq;
        if (input.correlationId === undefined || event.correlationId === input.correlationId) {
          events.push(toEnvelope(event));
          if (events.length >= limit) break;
        }
      }
      if (!page.hasMore) exhausted = true;
    }

    const turns = (input.correlationId
      ? this.#store.listTurns({ rootCorrelationId: input.correlationId })
      : []
    ).map((turn) => ({
      target: turn.targetActorId,
      turnId: turn.turnId,
      status: turn.status,
      ...(turn.responseEventId === undefined ? {} : { responseEventId: turn.responseEventId }),
      ...(turn.errorCode === undefined ? {} : { errorCode: turn.errorCode })
    }));
    return {
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      events,
      turns,
      ...(cursor <= afterSeq ? {} : { nextAfterSeq: cursor })
    };
  }

  async waitForCorrelation(input: WaitForCorrelationInput): Promise<CorrelationWaitResult> {
    this.#assertOpen();
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    if (input.childTurnIds !== undefined && input.sourceEventId !== undefined) {
      throw new AIChatLinkError(
        "INVALID_ENVELOPE",
        "Specify either childTurnIds or sourceEventId, not both"
      );
    }
    if (input.sourceEventId !== undefined) {
      const source = this.#store.getEvent(input.sourceEventId);
      if (
        source === undefined ||
        source.roomId !== (input.roomId ?? this.#defaultRoomId) ||
        source.correlationId !== input.correlationId
      ) {
        throw new AIChatLinkError(
          "UNKNOWN_TARGET",
          "The requested source message does not belong to this room and correlation"
        );
      }
    }
    const initialTurns = input.childTurnIds
      ? input.childTurnIds.map((turnId) => {
          const turn = this.#store.getTurn(turnId);
          if (!turn || turn.rootCorrelationId !== input.correlationId) {
            throw new AIChatLinkError(
              "UNKNOWN_TARGET",
              "A requested child Turn does not belong to the correlation"
            );
          }
          return turn;
        })
      : input.sourceEventId !== undefined
        ? this.#store.listTurns({ sourceEventId: input.sourceEventId })
        : this.#store.listTurns({ rootCorrelationId: input.correlationId });
    const turnIds = [...new Set(initialTurns.map((turn) => turn.turnId))];
    if (turnIds.length === 0) {
      throw new AIChatLinkError("UNKNOWN_TARGET", "The correlation has no child Turns to wait for");
    }

    const allTerminal = (): boolean =>
      turnIds.every((turnId) => {
        const turn = this.#store.getTurn(turnId);
        return turn !== undefined && TERMINAL_TURN_STATUSES.has(turn.status);
      });

    let state: CorrelationWaitResult["state"] = "terminal";
    if (!allTerminal()) {
      state = await new Promise<CorrelationWaitResult["state"]>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const subscribed = new Set<string>();

        const cleanup = (): void => {
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          this.#closingController.signal.removeEventListener("abort", onBrokerClose);
          for (const turnId of subscribed) {
            const listeners = this.#turnWaiters.get(turnId);
            listeners?.delete(onTerminal);
            if (listeners?.size === 0) this.#turnWaiters.delete(turnId);
          }
        };
        const finish = (result: CorrelationWaitResult["state"]): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const onTerminal = (): void => {
          if (allTerminal()) finish("terminal");
        };
        const onAbort = (): void => finish("aborted");
        const onBrokerClose = (): void => finish("aborted");

        for (const turnId of turnIds) {
          const turn = this.#store.getTurn(turnId);
          if (turn && !TERMINAL_TURN_STATUSES.has(turn.status)) {
            const listeners = this.#turnWaiters.get(turnId) ?? new Set<() => void>();
            listeners.add(onTerminal);
            this.#turnWaiters.set(turnId, listeners);
            subscribed.add(turnId);
          }
        }
        // Close the check/subscribe race before arming the timeout.
        if (allTerminal()) {
          finish("terminal");
          return;
        }
        if (input.signal?.aborted || this.#closingController.signal.aborted) {
          finish("aborted");
          return;
        }
        input.signal?.addEventListener("abort", onAbort, { once: true });
        this.#closingController.signal.addEventListener("abort", onBrokerClose, { once: true });
        timer = setTimeout(() => finish("timeout"), timeoutMs);
      });
    }

    const turns = turnIds
      .map((turnId) => this.#store.getTurn(turnId))
      .filter((turn): turn is TurnRecord => turn !== undefined);
    const responseEvents = turns.flatMap((turn) => {
      if (turn.responseEventId === undefined) return [];
      const event = this.#store.getEvent(turn.responseEventId);
      if (
        event === undefined ||
        event.roomId !== (input.roomId ?? this.#defaultRoomId) ||
        event.correlationId !== input.correlationId
      ) {
        return [];
      }
      return [toEnvelope(event)];
    });
    return {
      state,
      correlationId: input.correlationId,
      turns,
      read: this.#readCorrelation({
        correlationId: input.correlationId,
        ...(input.roomId === undefined ? {} : { roomId: input.roomId })
      }, false),
      responseEvents
    };
  }

  inspectTurnQueue(turnId: string): TurnQueueSnapshot {
    this.#assertOpen();
    const turn = this.#store.getTurn(turnId);
    if (turn === undefined) {
      throw new AIChatLinkError("UNKNOWN_TARGET", "The requested Turn does not exist");
    }
    const actorTurns = this.#store.listTurns({ targetActorId: turn.targetActorId });
    const ahead = actorTurns.filter(
      (candidate) =>
        candidate.enqueueSeq < turn.enqueueSeq && !TERMINAL_TURN_STATUSES.has(candidate.status)
    );
    const active = actorTurns.find(
      (candidate) =>
        candidate.enqueueSeq <= turn.enqueueSeq &&
        (candidate.status === "dispatching" ||
          candidate.status === "running" ||
          candidate.status === "cancelling")
    );
    return {
      turnId,
      queuePosition: ahead.length,
      ...(active === undefined ? {} : { activeTurnId: active.turnId })
    };
  }

  async recoverAfterRestart(): Promise<RecoveryResult> {
    this.#assertOpen();
    try {
      const recovered = this.#store.recoverAfterRestart(this.#clock.now());
      for (const turn of recovered.interruptedTurns) {
        if (turn.terminalEventId) {
          const event = this.#store.getEvent(turn.terminalEventId);
          if (event) await this.#publishStored(event);
        }
        this.#notifyTurnTerminal(turn.turnId);
      }
      for (const actorId of new Set(recovered.queuedTurns.map((turn) => turn.targetActorId))) {
        this.#scheduleActor(actorId);
      }
      return recovered;
    } catch (error) {
      this.#report(error, { operation: "recovery" });
      throw error;
    }
  }

  notifySessionReady(actorId: string): void {
    this.#assertOpen();
    this.#adapters.getByActor(actorId);
    this.#scheduleActor(actorId);
  }

  async restartAgent(actorId: string): Promise<void> {
    this.#assertOpen();
    this.#adapters.getByActor(actorId);
    if (!this.#agentController) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "No Agent restart controller is attached");
    }
    try {
      await this.#agentController.restart(actorId);
      this.#scheduleActor(actorId);
    } catch (error) {
      this.#report(error, { operation: "restart", actorId });
      throw error;
    }
  }

  health(): BrokerHealth {
    this.#assertOpen();
    try {
      const integrity = this.#store.integrityCheck();
      return {
        store: {
          available: true,
          integrityOk: integrity.ok,
          schemaVersion: this.#store.getSchemaVersion(),
          journalMode: this.#store.getJournalMode()
        },
        agents: this.#adapters.health(),
        activeTurns: this.#active.size,
        queuedTurns: this.#store.listTurns({ status: "queued" }).length
      };
    } catch {
      return {
        store: { available: false, integrityOk: false, schemaVersion: 0, journalMode: "unknown" },
        agents: this.#adapters.health(),
        activeTurns: this.#active.size,
        queuedTurns: 0
      };
    }
  }

  bootstrap(input: { roomId?: string; recentLimit?: number } = {}): BrokerBootstrap {
    this.#assertOpen();
    const roomId = input.roomId ?? this.#defaultRoomId;
    const recentLimit = Math.min(Math.max(input.recentLimit ?? 100, 1), MAX_EVENT_PAGE);
    const snapshot = this.#store.readRoomBootstrapSnapshot({ roomId, recentLimit });
    const healthByActor = new Map(
      this.#adapters.list().map((adapter) => [adapter.actorId, adapter.health()] as const)
    );
    return {
      schema: "aichatlink.bootstrap/0.1",
      room: { roomId, throughSeq: snapshot.throughSeq },
      agents: this.#adapters.list().map((adapter) => {
        const actor = this.#store.getActor(adapter.actorId);
        const health = healthByActor.get(adapter.actorId)!;
        const order = this.#agentOrder?.get(adapter.actorId);
        return {
          actorId: adapter.actorId,
          displayName: actor?.displayName ?? adapter.actorId,
          status: health.status,
          ...(health.instanceId === undefined ? {} : { instanceId: health.instanceId }),
          ...(order === undefined ? {} : { order })
        };
      }),
      recentEvents: snapshot.recentEvents.map(toEnvelope),
      activeTurns: snapshot.activeTurns.map((turn) => ({
        turnId: turn.turnId,
        targetActorId: turn.targetActorId,
        status: turn.status,
        sourceEventId: turn.sourceEventId
      }))
    };
  }

  queryMemory(input: MemoryQuery = {}): MemoryRecord[] {
    this.#assertOpen();
    return this.#store.searchMemory(input);
  }

  queryIdentity(input: IdentityQuery = {}): IdentityRecord[] {
    this.#assertOpen();
    return this.#store.readIdentity(input);
  }

  async rememberMemory(input: RememberMemoryFromBindingInput): Promise<MemoryRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId,
      ...record
    } = input;
    const binding = this.#requireBinding(bindingId);
    const outcome = this.#store.mutateMemoryWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: {
        kind: "remember",
        record: {
          ...record,
          ...(record.scopeType === "agent"
            ? { agentMemoryType: record.agentMemoryType ?? "core" }
            : {}),
          authorActorId: binding.actorId,
          sourceKind: this.#sourceKindForBinding(binding)
        }
      }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async supersedeMemory(
    memoryId: string,
    input: SupersedeMemoryFromBindingInput
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId,
      kind,
      content,
      sourceEventId
    } = input;
    const binding = this.#requireBinding(bindingId);
    const previous = this.#store.getMemory(memoryId);
    if (!previous) throw new AIChatLinkError("UNKNOWN_TARGET", "Memory does not exist");
    const outcome = this.#store.mutateMemoryWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: {
        kind: "supersede",
        memoryId,
        replacement: {
          scopeType: previous.scopeType,
          scopeId: previous.scopeId,
          ...(previous.agentMemoryType === undefined
            ? {}
            : { agentMemoryType: previous.agentMemoryType }),
          kind: kind ?? previous.kind,
          content,
          ...(previous.subjectActorId === undefined
            ? {}
            : { subjectActorId: previous.subjectActorId }),
          ...(sourceEventId === undefined ? {} : { sourceEventId }),
          authorActorId: binding.actorId,
          sourceKind: this.#sourceKindForBinding(binding)
        }
      }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async retractMemory(
    memoryId: string,
    input: RetractRecordFromBindingInput
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId
    } = input;
    this.#requireBinding(bindingId);
    const outcome = this.#store.mutateMemoryWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: { kind: "retract", memoryId }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async rememberIdentity(input: RememberIdentityFromBindingInput): Promise<IdentityRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId,
      ...record
    } = input;
    const binding = this.#requireBinding(bindingId);
    const identityRecord = this.#identityRecordForBinding(binding, record);
    const outcome = this.#store.mutateIdentityWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: {
        kind: "remember",
        record: identityRecord
      }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async supersedeIdentity(
    identityId: string,
    input: SupersedeIdentityFromBindingInput
  ): Promise<IdentityRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId,
      kind,
      content,
      sourceEventId
    } = input;
    const binding = this.#requireBinding(bindingId);
    const previous = this.#store.getIdentity(identityId);
    if (!previous) throw new AIChatLinkError("UNKNOWN_TARGET", "Identity does not exist");
    const identityRecord = this.#identityRecordForBinding(binding, {
      subjectActorId: previous.subjectActorId,
      kind: kind ?? previous.kind,
      content,
      ...(sourceEventId === undefined ? {} : { sourceEventId })
    });
    const outcome = this.#store.mutateIdentityWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: {
        kind: "supersede",
        identityId,
        replacement: identityRecord
      }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async retractIdentity(
    identityId: string,
    input: RetractRecordFromBindingInput
  ): Promise<IdentityRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId
    } = input;
    this.#requireBinding(bindingId);
    const outcome = this.#store.mutateIdentityWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: { kind: "retract", identityId }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async waitForIdle(): Promise<void> {
    while (this.#pumps.size > 0) {
      await Promise.allSettled([...this.#pumps.values()]);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#finishLastTimers.values()) clearTimeout(timer);
    this.#finishLastTimers.clear();
    this.#closingController.abort(new AIChatLinkError("TURN_INTERRUPTED", "Broker is closing"));
    for (const active of this.#active.values()) {
      active.controller.abort(new AIChatLinkError("TURN_INTERRUPTED", "Broker is closing"));
      this.#deactivateTurnLifecycle(active);
    }
    const settled = Promise.allSettled([
      ...this.#pumps.values(),
      ...this.#cancelFlights.values(),
      ...this.#cancelCommandFlights.values(),
      ...this.#contextCommandFlights.values(),
      ...this.#resetCommandFlights.values()
    ]).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#closeTimeoutMs);
    });
    const completed = await Promise.race([settled, timedOut]);
    if (timer) clearTimeout(timer);
    if (!completed) {
      this.#report(new AIChatLinkError("TURN_INTERRUPTED", "Broker close deadline elapsed"), {
        operation: "dispatch"
      });
    }
    // From this point callers may close the Store. Any ignored/late native or
    // composition continuation must unwind without touching durable state.
    this.#storeWritesFenced = true;
    for (const active of this.#active.values()) active.terminal = true;
  }

  #scheduleActor(actorId: string): void {
    if (this.#closed) return;
    this.#dirtyActors.add(actorId);
    if (this.#pumps.has(actorId)) return;

    const pump = this.#runActorPump(actorId)
      .catch((error: unknown) => {
        this.#report(error, { operation: "dispatch", actorId });
      })
      .finally(() => {
        this.#pumps.delete(actorId);
        if (!this.#closed && this.#dirtyActors.has(actorId)) {
          queueMicrotask(() => this.#scheduleActor(actorId));
        }
      });
    this.#pumps.set(actorId, pump);
  }

  async #runActorPump(actorId: string): Promise<void> {
    while (!this.#closed) {
      this.#dirtyActors.delete(actorId);
      while (!this.#closed) {
        const preparation = await this.#prepareNext(actorId);
        if (!preparation) break;
        if (this.#closed) return;
        await this.#execute(preparation);
      }
      if (!this.#dirtyActors.has(actorId)) return;
    }
  }

  /**
   * Finish-last gate (config: `finishLast`). A closing role must not answer
   * before the review Turns it reports on have settled, so its Turn is held
   * while the same room still has other in-flight Turns. The hold is a queue
   * property, not a client-side courtesy: `send`/`ask` still accept the message
   * and the Turn stays durable, it simply is not claimed yet.
   */
  #deferFinishLastTurn(head: TurnRecord): boolean {
    if (this.#finishLastActors.size === 0) return false;
    if (!this.#finishLastActors.has(head.targetActorId)) return false;
    const blockers = this.#finishLastBlockers(head);
    if (blockers.length === 0) {
      this.#clearFinishLastTimer(head.targetActorId);
      return false;
    }
    // Elapsed uses the injected clock so a test (and a replay) sees the same
    // hold duration the room saw, not the wall clock.
    const queuedAt = Date.parse(head.queuedAt);
    const observedAt = Date.parse(this.#clock.now());
    const elapsed =
      Number.isFinite(queuedAt) && Number.isFinite(observedAt) ? observedAt - queuedAt : 0;
    if (elapsed >= this.#finishLastWaitMs) {
      // Deadlock release: a peer that never settles must not park the closing
      // Turn forever. Reaching this bound is abnormal and is reported.
      this.#clearFinishLastTimer(head.targetActorId);
      this.#report(
        new AIChatLinkError(
          "TURN_INTERRUPTED",
          "Finish-last release bound reached; dispatching while room peers are still running",
          {
            turnId: head.turnId,
            waitedMs: elapsed,
            blockers: blockers.map((turn) => turn.turnId)
          }
        ),
        { operation: "dispatch", actorId: head.targetActorId, turnId: head.turnId }
      );
      return false;
    }
    this.#armFinishLastRecheck(head.targetActorId);
    return true;
  }

  /** In-flight Turns that a finish-last Turn must wait for. */
  #finishLastBlockers(head: TurnRecord): TurnRecord[] {
    const source = this.#store.getEvent(head.sourceEventId);
    if (!source) return [];
    const callerChain = this.#callerChain(head);
    const blockers: TurnRecord[] = [];
    for (const status of RUNNING_TURN_STATUSES) {
      for (const turn of this.#store.listTurns({ roomId: source.roomId, status })) {
        if (turn.turnId === head.turnId) continue;
        if (turn.targetActorId === head.targetActorId) continue;
        // The dispatcher is inside its own tool call waiting for this Turn;
        // waiting on it would deadlock the room.
        if (callerChain.has(turn.turnId)) continue;
        blockers.push(turn);
      }
    }
    return blockers;
  }

  /** `head` plus the `parent_turn_id` chain that dispatched it. */
  #callerChain(head: TurnRecord): Set<string> {
    const chain = new Set<string>([head.turnId]);
    let cursor = head.parentTurnId;
    for (let hops = 0; cursor !== undefined && hops < 64; hops += 1) {
      if (chain.has(cursor)) break;
      chain.add(cursor);
      cursor = this.#store.getTurn(cursor)?.parentTurnId;
    }
    return chain;
  }

  /** Re-check a held lane even when no peer Turn settles (bounded by the wait). */
  #armFinishLastRecheck(actorId: string): void {
    if (this.#closed || this.#finishLastTimers.has(actorId)) return;
    const timer = setTimeout(() => {
      this.#finishLastTimers.delete(actorId);
      if (!this.#closed) this.#scheduleActor(actorId);
    }, Math.min(FINISH_LAST_RECHECK_MS, this.#finishLastWaitMs));
    timer.unref?.();
    this.#finishLastTimers.set(actorId, timer);
  }

  #clearFinishLastTimer(actorId: string): void {
    const timer = this.#finishLastTimers.get(actorId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#finishLastTimers.delete(actorId);
  }

  /**
   * A settled Turn can release a held finish-last Turn in the same room. Only
   * finish-last lanes are re-scheduled here; ordinary lanes keep their own
   * per-Actor FIFO pacing.
   */
  #wakeFinishLastActors(terminalTurnId: string): void {
    if (this.#finishLastActors.size === 0 || this.#closed) return;
    try {
      const turn = this.#store.getTurn(terminalTurnId);
      if (!turn) return;
      const source = this.#store.getEvent(turn.sourceEventId);
      const roomId = source?.roomId ?? this.#defaultRoomId;
      for (const queued of this.#store.listTurns({ roomId, status: "queued" })) {
        if (!this.#finishLastActors.has(queued.targetActorId)) continue;
        this.#scheduleActor(queued.targetActorId);
      }
    } catch (error) {
      this.#report(error, { operation: "dispatch" });
    }
  }

  async #prepareNext(actorId: string): Promise<DispatchPreparation | undefined> {
    while (!this.#closed) {
      const head = this.#store.listTurns({ status: "queued", targetActorId: actorId })[0];
      if (!head) return undefined;
      if (head.transport !== this.#selectedTransport) {
        await this.#failQueuedTransportMismatch(head, "persisted_transport_mismatch");
        continue;
      }
      // Finish-last seats are held until the room's other in-flight Turns are
      // terminal. Returning undefined parks just this lane: the deposit stays
      // durable and a peer's terminal event (or the bounded re-check) wakes it.
      if (this.#deferFinishLastTurn(head)) return undefined;
      const adapter = this.#adapters.getByActor(actorId);
      let session: NativeSession;
      try {
        session = await this.#sessions.resolve({ actorId, adapterId: adapter.adapterId });
      } catch (error) {
        this.#report(error, { operation: "dispatch", actorId, turnId: head.turnId });
        return undefined;
      }
      if (this.#closed) return undefined;
      this.#assertSession(adapter, session, actorId);

      const sourceEvent = this.#store.getEvent(head.sourceEventId);
      if (!sourceEvent) {
        throw new AIChatLinkError("STORE_UNAVAILABLE", "Queued Turn source event is missing");
      }
      const cursor = this.#store.getDeliveryCursor(actorId, sourceEvent.roomId);
      const lastDeliveredSeq = cursor?.lastDeliveredSeq ?? 0;
      let contextThroughSeq = Math.max(sourceEvent.seq, lastDeliveredSeq);
      let summaryThroughSeq: number | undefined;
      let contextPacket: string | undefined;
      if (this.#contextProvider) {
        try {
          const prepared = await this.#contextProvider.prepare({
            turn: head,
            sourceEvent,
            lastDeliveredSeq
          });
          if (
            !Number.isSafeInteger(prepared.contextThroughSeq) ||
            prepared.contextThroughSeq < sourceEvent.seq
          ) {
            throw new AIChatLinkError(
              "INVALID_ENVELOPE",
              "Context provider cursor must include the source message"
            );
          }
          // A previous confirmed attempt may already have delivered beyond
          // this queued source. Preserve that durable watermark without
          // requiring the provider to rebuild already-delivered context.
          contextThroughSeq = Math.max(prepared.contextThroughSeq, lastDeliveredSeq);
          if (prepared.summaryThroughSeq !== undefined) {
            if (
              !Number.isSafeInteger(prepared.summaryThroughSeq) ||
              prepared.summaryThroughSeq < 0 ||
              prepared.summaryThroughSeq > prepared.contextThroughSeq
            ) {
              throw new AIChatLinkError(
                "INVALID_ENVELOPE",
                "Context summary cursor must be within the prepared context boundary"
              );
            }
            summaryThroughSeq = prepared.summaryThroughSeq;
          }
          contextPacket = prepared.contextPacket;
        } catch (error) {
          this.#report(error, { operation: "context", actorId, turnId: head.turnId });
          await this.#failQueuedContext(head, error);
          continue;
        }
      } else if (!this.#canDeliverCurrentMessageOnly(sourceEvent, lastDeliveredSeq)) {
        this.#report(
          new AIChatLinkError(
            "SESSION_NOT_AVAILABLE",
            "A Context provider is required before advancing across undelivered room events"
          ),
          { operation: "context", actorId, turnId: head.turnId }
        );
        return undefined;
      }
      if (this.#closed) return undefined;

      let claim: ClaimedTurn | undefined;
      try {
        claim = this.#store.claimNextQueuedTurn({
          targetActorId: actorId,
          bindingId: session.bindingId,
          instanceId: session.instanceId,
          contextThroughSeq,
          ...(summaryThroughSeq === undefined ? {} : { summaryThroughSeq }),
          expectedTurnId: head.turnId,
          expectedTransport: this.#selectedTransport,
          claimedAt: this.#clock.now()
        });
      } catch (error) {
        if (error instanceof AIChatLinkError && error.code === "TRANSPORT_MODE_MISMATCH") {
          await this.#failQueuedTransportMismatch(head, "runtime_binding_mismatch");
          continue;
        }
        if (
          error instanceof AIChatLinkError &&
          error.code === "STORE_CONFLICT" &&
          error.details?.reason === "summary_checkpoint_changed"
        ) {
          // Another lane advanced the room checkpoint after this lane built
          // its packet. Rebuild against the new active summary; never dispatch
          // a packet whose durable summary watermark was superseded.
          continue;
        }
        throw error;
      }
      if (!claim) {
        const currentHead = this.#store.listTurns({
          status: "queued",
          targetActorId: actorId
        })[0];
        // Preparation is asynchronous. If its observed head changed, prepare
        // the new head; if it did not, the lane is blocked by another active
        // claimant and must not hot-loop.
        if (currentHead && currentHead.turnId !== head.turnId) continue;
        return undefined;
      }
      if (claim.turn.turnId !== head.turnId) {
        throw new AIChatLinkError("STORE_CONFLICT", "Claimed Turn did not match the observed FIFO head");
      }
      return {
        claim,
        adapter,
        session,
        sourceEvent,
        promptContent: messageContent(sourceEvent),
        ...(contextPacket === undefined ? {} : { contextPacket })
      };
    }
    return undefined;
  }

  async #failQueuedTransportMismatch(
    turn: TurnRecord,
    reason: "persisted_transport_mismatch" | "runtime_binding_mismatch"
  ): Promise<void> {
    try {
      const terminal = this.#store.failQueuedTurn(
        turn.turnId,
        "TRANSPORT_MODE_MISMATCH",
        this.#clock.now(),
        {
          reason,
          persistedTransport: turn.transport,
          selectedTransport: this.#selectedTransport
        }
      );
      await this.#publishStored(terminal.terminalEvent);
    } catch (error) {
      const after = this.#store.getTurn(turn.turnId);
      if (!after || !TERMINAL_TURN_STATUSES.has(after.status)) throw error;
    }
    this.#notifyTurnTerminal(turn.turnId);
  }

  async #failQueuedContext(turn: TurnRecord, error: unknown): Promise<void> {
    const normalized = toAIChatLinkError(error, "CONTEXT_BUDGET_EXCEEDED");
    const errorCode: AIChatLinkErrorCode =
      normalized.code === "STORE_UNAVAILABLE" ||
      normalized.code === "CONTEXT_BUDGET_EXCEEDED" ||
      normalized.code === "SESSION_NOT_AVAILABLE" ||
      normalized.code === "TURN_INTERRUPTED"
        ? normalized.code
        : "CONTEXT_BUDGET_EXCEEDED";
    try {
      const terminal = this.#store.failQueuedTurn(
        turn.turnId,
        errorCode,
        this.#clock.now(),
        { reason: "context_preparation_failed" }
      );
      await this.#publishStored(terminal.terminalEvent);
    } catch (caught) {
      const after = this.#store.getTurn(turn.turnId);
      if (!after || !TERMINAL_TURN_STATUSES.has(after.status)) throw caught;
    }
    this.#notifyTurnTerminal(turn.turnId);
  }

  async #execute(preparation: DispatchPreparation): Promise<void> {
    if (this.#storeWritesFenced) return;
    const { claim, adapter, session, sourceEvent } = preparation;
    const lifecycleContext: ActiveBrokerTurnContext = {
      bindingId: claim.attempt.bindingId,
      turnId: claim.turn.turnId,
      sourceEventId: claim.turn.sourceEventId,
      rootCorrelationId: claim.turn.rootCorrelationId,
      hopCount: claim.turn.hopCount
    };
    const active: ActiveDispatch = {
      preparation,
      controller: new AbortController(),
      partialText: "",
      reasoningText: "",
      toolProgress: [],
      checkpointedLength: 0,
      lastFlushedLength: 0,
      chunkIndex: 0,
      started: false,
      terminal: false,
      cancelRequested: false,
      nativeTerminalInFlight: false,
      lifecycleContext,
      lifecycleActive: false,
      automaticRecoveryRequested: false
    };
    this.#active.set(claim.turn.turnId, active);

    try {
      if (this.#closingController.signal.aborted) {
        active.controller.abort(
          new AIChatLinkError("TURN_INTERRUPTED", "Broker closed before prompt invocation")
        );
      }
      if (this.#turnLifecycle) {
        active.lifecycleActive = true;
        this.#turnLifecycle.activate(lifecycleContext);
      }
      if (await this.#finishBeforePromptIfStopped(active)) return;

      const dispatched = this.#store.appendDurableEvent({
        roomId: sourceEvent.roomId,
        eventType: "turn.dispatched",
        actorId: BUILTIN_ACTORS.system.actorId,
        targets: [claim.turn.targetActorId],
        replyToEventId: claim.turn.sourceEventId,
        causationId: claim.turn.turnId,
        correlationId: claim.turn.rootCorrelationId,
        occurredAt: this.#clock.now(),
        body: {
          turnId: claim.turn.turnId,
          attemptId: claim.attempt.attemptId,
          targetActorId: claim.turn.targetActorId
        },
        provenance: { sourceKind: "system", sourceEventId: claim.turn.sourceEventId }
      });
      await this.#publishStored(dispatched);
      if (this.#storeWritesFenced) return;
      if (await this.#finishBeforePromptIfStopped(active)) return;

      this.#store.markPromptInvoked(claim.attempt.attemptId, this.#clock.now());
      const stream = adapter.prompt(session, {
        turnId: claim.turn.turnId,
        content: preparation.promptContent,
        ...(preparation.contextPacket === undefined
          ? {}
          : { contextPacket: preparation.contextPacket }),
        correlationId: claim.turn.rootCorrelationId,
        signal: active.controller.signal
      });
      for await (const event of stream) {
        await this.#handleNativeEvent(active, event);
        if (active.terminal || this.#storeWritesFenced) break;
      }

      if (this.#storeWritesFenced) return;
      if (!active.terminal) {
        if (active.cancelRequested) {
          let result = active.cancelResult;
          if (!result && active.nativeCancelPromise) {
            try {
              result = await this.#awaitNativeCancel(active);
            } catch (error) {
              this.#report(error, {
                operation: "dispatch",
                actorId: claim.turn.targetActorId,
                turnId: claim.turn.turnId
              });
            }
          }
          if (this.#storeWritesFenced) return;
          if (result?.terminalObserved) {
            await this.#terminalOnce(active, "cancelled");
          } else {
            await this.#terminalOnce(active, "interrupted", {
              errorCode: "TURN_INTERRUPTED"
            });
          }
        } else if (active.controller.signal.aborted) {
          await this.#terminalOnce(active, "interrupted", { errorCode: "TURN_INTERRUPTED" });
        } else {
          await this.#terminalOnce(active, "failed", {
            errorCode: "PROTOCOL_INVALID_MESSAGE"
          });
        }
      }
    } catch (error) {
      if (!active.terminal) {
        const interrupted = active.cancelRequested || active.controller.signal.aborted;
        try {
          await this.#terminalOnce(active, interrupted ? "interrupted" : "failed", {
            errorCode: interrupted ? "TURN_INTERRUPTED" : this.#errorCode(error)
          });
        } catch (terminalError) {
          this.#report(terminalError, {
            operation: "dispatch",
            actorId: claim.turn.targetActorId,
            turnId: claim.turn.turnId
          });
        }
      }
      this.#report(error, {
        operation: "dispatch",
        actorId: claim.turn.targetActorId,
        turnId: claim.turn.turnId
      });
    } finally {
      this.#deactivateTurnLifecycle(active);
      this.#active.delete(claim.turn.turnId);
      if (active.automaticRecoveryRequested && !this.#closed) {
        await this.#recoverAgentAfterProtocolFailure(active);
      }
    }
  }

  async #recoverAgentAfterProtocolFailure(active: ActiveDispatch): Promise<void> {
    if (!this.#agentController) return;
    const actorId = active.preparation.claim.turn.targetActorId;
    try {
      // The failed Turn is already terminal and is never replayed. Restarting
      // only replaces the poisoned process/session for subsequent queued work.
      await this.#agentController.restart(actorId);
    } catch (error) {
      this.#report(error, {
        operation: "recovery",
        actorId,
        turnId: active.preparation.claim.turn.turnId
      });
    }
  }

  #requestAutomaticRecovery(
    active: ActiveDispatch,
    status: TurnStatus,
    errorCode: string | undefined
  ): void {
    if (
      status === "failed" &&
      errorCode === "PROTOCOL_INVALID_MESSAGE" &&
      this.#selectedTransport === "structured" &&
      this.#agentController !== undefined
    ) {
      active.automaticRecoveryRequested = true;
    }
  }

  #deactivateTurnLifecycle(active: ActiveDispatch): void {
    if (!active.lifecycleActive || !this.#turnLifecycle) return;
    active.lifecycleActive = false;
    try {
      this.#turnLifecycle.deactivate(active.lifecycleContext);
    } catch (error) {
      this.#report(error, {
        operation: "dispatch",
        actorId: active.preparation.claim.turn.targetActorId,
        turnId: active.preparation.claim.turn.turnId
      });
    }
  }

  async #finishBeforePromptIfStopped(active: ActiveDispatch): Promise<boolean> {
    if (this.#storeWritesFenced) {
      active.terminal = true;
      this.#deactivateTurnLifecycle(active);
      return true;
    }
    const turnId = active.preparation.claim.turn.turnId;
    const current = this.#store.getTurn(turnId);
    if (!current) {
      throw new AIChatLinkError("STORE_UNAVAILABLE", "Claimed Turn disappeared before prompt");
    }
    if (TERMINAL_TURN_STATUSES.has(current.status)) {
      active.terminal = true;
      this.#deactivateTurnLifecycle(active);
      this.#notifyTurnTerminal(turnId);
      return true;
    }
    if (current.status === "cancelling") {
      active.cancelRequested = true;
      await this.#terminalOnce(active, "cancelled");
      return true;
    }
    if (active.controller.signal.aborted) {
      await this.#terminalOnce(active, "interrupted", { errorCode: "TURN_INTERRUPTED" });
      return true;
    }
    if (current.status !== "dispatching") {
      throw new AIChatLinkError(
        "STORE_CONFLICT",
        `Turn cannot invoke a native prompt from status ${current.status}`
      );
    }
    return false;
  }

  async #handleNativeEvent(active: ActiveDispatch, event: NativeEvent): Promise<void> {
    const { adapter, session, claim, sourceEvent } = active.preparation;
    if (active.terminal || this.#storeWritesFenced) return;
    if (event.adapterId !== adapter.adapterId || event.instanceId !== session.instanceId) {
      throw new AIChatLinkError(
        "PROTOCOL_INVALID_MESSAGE",
        "Native event did not belong to the active Adapter instance"
      );
    }
    if (
      event.nativeSessionId !== undefined &&
      session.nativeSessionId !== undefined &&
      event.nativeSessionId !== session.nativeSessionId
    ) {
      throw new AIChatLinkError(
        "PROTOCOL_INVALID_MESSAGE",
        "Native event did not belong to the active session"
      );
    }

    if (event.type === "session.started") return;
    if (event.nativeTurnId !== undefined) {
      this.#bindNativeTurnId(active, event.nativeTurnId);
    }
    if (event.type === "transport.error") {
      await this.#terminalOnce(active, "failed", {
        errorCode: nativeErrorCode(event, "PROTOCOL_INVALID_MESSAGE")
      });
      return;
    }

    await this.#markStarted(active, event.nativeTurnId, event.occurredAt);
    if (active.terminal || this.#storeWritesFenced) return;
    switch (event.type) {
      case "turn.started":
        return;
      case "content.delta": {
        const text = stringProperty(event.payload, "text", "content") ?? "";
        if (text !== "") {
          active.partialText += text;
          active.chunkIndex += 1;
          if (
            active.partialText.length - active.checkpointedLength >=
            this.#partialCheckpointChars
          ) {
            this.#store.saveTurnPartialText(claim.turn.turnId, active.partialText);
            active.checkpointedLength = active.partialText.length;
          }
          await this.#publishTransient(active, "turn.content.delta", event.occurredAt, {
            turnId: claim.turn.turnId,
            chunkIndex: active.chunkIndex,
            text
          });
          if (
            active.partialText.length - active.lastFlushedLength >=
            SUPERVISION_CONTENT_FLUSH_CHARS
          ) {
            active.lastFlushedLength = active.partialText.length;
            this.#emitMilestone({
              kind: "content.flushed",
              turnId: claim.turn.turnId,
              watchCursor: this.#nextWatchCursor(claim.turn.turnId),
              seq: null,
              excerpt: excerptText(active.partialText.slice(-SUPERVISION_CONTENT_FLUSH_CHARS))
            });
          }
        }
        return;
      }
      case "reasoning.delta": {
        const text = stringProperty(event.payload, "text", "content") ?? "";
        if (text !== "") {
          active.reasoningText += text;
          await this.#publishTransient(active, "turn.reasoning.delta", event.occurredAt, {
            turnId: claim.turn.turnId,
            text
          });
        }
        return;
      }
      case "tool.started":
      case "tool.completed": {
        const progress: TerminalToolProgressInput = {
          occurredAt: event.occurredAt,
          nativeType: event.type,
          ...(event.nativeEventId === undefined
            ? {}
            : { toolCallId: event.nativeEventId }),
          details: event.payload
        };
        active.toolProgress.push(progress);
        await this.#publishTransient(active, "tool.progress", event.occurredAt, {
          turnId: claim.turn.turnId,
          nativeType: progress.nativeType,
          ...(progress.toolCallId === undefined
            ? {}
            : { toolCallId: progress.toolCallId }),
          details: progress.details
        });
        this.#emitMilestone({
          kind: event.type,
          turnId: claim.turn.turnId,
          watchCursor: this.#nextWatchCursor(claim.turn.turnId),
          seq: null,
          tool: {
            name: toolNameFromDetails(progress.details),
            status: event.type === "tool.started" ? "started" : "completed",
            ...(progress.toolCallId === undefined ? {} : { toolCallId: progress.toolCallId })
          }
        });
        return;
      }
      case "turn.completed":
        await this.#terminalOnce(active, "completed", {
          content: terminalContent(event, active.partialText)
        });
        return;
      case "turn.cancelled":
        await this.#terminalOnce(active, "cancelled");
        return;
      case "turn.failed":
        await this.#terminalOnce(active, "failed", {
          errorCode: nativeErrorCode(event, "PROTOCOL_INVALID_MESSAGE")
        });
        return;
    }

    throw new AIChatLinkError(
      "UNEXPECTED_NATIVE_INTERACTION",
      `Unsupported native interaction: ${String(event.type)}`
    );
  }

  async #markStarted(
    active: ActiveDispatch,
    nativeTurnId: string | undefined,
    occurredAt: string
  ): Promise<void> {
    if (active.started) return;
    const { claim, session, sourceEvent } = active.preparation;
    const running = this.#store.markAttemptRunning(
      claim.attempt.attemptId,
      nativeTurnId,
      occurredAt
    );
    active.started = true;
    if (running.attempt.nativeTurnId !== undefined) {
      active.nativeTurnId = running.attempt.nativeTurnId;
    }
    const event = this.#store.appendDurableEvent({
      roomId: sourceEvent.roomId,
      eventType: "turn.started",
      actorId: claim.turn.targetActorId,
      instanceId: session.instanceId,
      targets: [],
      replyToEventId: claim.turn.sourceEventId,
      causationId: claim.turn.turnId,
      correlationId: claim.turn.rootCorrelationId,
      occurredAt,
      body: {
        turnId: claim.turn.turnId,
        attemptId: claim.attempt.attemptId,
        ...(nativeTurnId === undefined ? {} : { nativeTurnId })
      },
      provenance: {
        sourceKind: "adapter",
        authorActorId: claim.turn.targetActorId,
        sourceEventId: claim.turn.sourceEventId
      }
    });
    await this.#publishStored(event);
    this.#emitMilestone({
      kind: "turn.started",
      turnId: claim.turn.turnId,
      watchCursor: this.#nextWatchCursor(claim.turn.turnId),
      seq: event.seq,
      status: "running"
    });
  }

  #bindNativeTurnId(active: ActiveDispatch, nativeTurnId: string): void {
    if (active.nativeTurnId !== undefined) {
      if (active.nativeTurnId !== nativeTurnId) {
        throw new AIChatLinkError(
          "PROTOCOL_INVALID_MESSAGE",
          "Native Turn id changed during one AIChatLink Turn attempt"
        );
      }
      return;
    }
    const bound = this.#store.bindAttemptNativeTurnId(
      active.preparation.claim.attempt.attemptId,
      nativeTurnId
    );
    if (bound.attempt.nativeTurnId !== nativeTurnId) {
      throw new AIChatLinkError("STORE_CONFLICT", "Native Turn id binding was not persisted");
    }
    active.nativeTurnId = nativeTurnId;
    if (active.cancelRequested) this.#triggerNativeCancel(active);
  }

  #triggerNativeCancel(active: ActiveDispatch): void {
    void this.#sendNativeCancel(active).catch(() => undefined);
  }

  async #terminalOnce(
    active: ActiveDispatch,
    status: TerminalTurnStatus,
    input: {
      content?: string;
      errorCode?: string;
      eventBody?: Readonly<Record<string, unknown>>;
    } = {}
  ): Promise<void> {
    if (active.terminal) return;
    if (this.#storeWritesFenced) {
      active.terminal = true;
      this.#deactivateTurnLifecycle(active);
      return;
    }
    const current = this.#store.getTurn(active.preparation.claim.turn.turnId);
    if (current && TERMINAL_TURN_STATUSES.has(current.status)) {
      this.#requestAutomaticRecovery(active, current.status, current.errorCode);
      active.terminal = true;
      active.durableStatus = current.status;
      this.#deactivateTurnLifecycle(active);
      this.#notifyTurnTerminal(current.turnId);
      return;
    }
    active.terminal = true;
    try {
      if (
        status !== "completed" &&
        active.partialText !== "" &&
        active.checkpointedLength < active.partialText.length
      ) {
        this.#store.saveTurnPartialText(
          active.preparation.claim.turn.turnId,
          active.partialText
        );
        active.checkpointedLength = active.partialText.length;
      }
      const terminal = this.#store.terminalizeTurn({
        turnId: active.preparation.claim.turn.turnId,
        attemptId: active.preparation.claim.attempt.attemptId,
        status,
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(active.reasoningText === "" ? {} : { reasoning: active.reasoningText }),
        ...(active.toolProgress.length === 0
          ? {}
          : { toolProgress: active.toolProgress }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.eventBody === undefined ? {} : { eventBody: input.eventBody }),
        occurredAt: this.#clock.now()
      });
      this.#requestAutomaticRecovery(active, terminal.turn.status, terminal.turn.errorCode);
      active.durableStatus = terminal.turn.status;
      this.#deactivateTurnLifecycle(active);
      this.#notifyTurnTerminal(terminal.turn.turnId);
      if (terminal.reasoningEvent) await this.#publishStored(terminal.reasoningEvent);
      for (const toolProgressEvent of terminal.toolProgressEvents ?? []) {
        await this.#publishStored(toolProgressEvent);
      }
      if (terminal.responseEvent) await this.#publishStored(terminal.responseEvent);
      await this.#publishStored(terminal.terminalEvent);
      if (terminal.datedMemoryRollup !== undefined) {
        try {
          this.#datedMemoryController?.noteCompleted(terminal.datedMemoryRollup);
        } catch (error) {
          this.#report(error, {
            operation: "memory",
            actorId: terminal.turn.targetActorId,
            turnId: terminal.turn.turnId
          });
        }
      }
    } catch (error) {
      const after = this.#store.getTurn(active.preparation.claim.turn.turnId);
      if (after && TERMINAL_TURN_STATUSES.has(after.status)) {
        this.#requestAutomaticRecovery(active, after.status, after.errorCode);
      }
      if (!after || !TERMINAL_TURN_STATUSES.has(after.status)) {
        active.terminal = false;
      }
      throw error;
    }
  }

  async #publishTransient(
    active: ActiveDispatch,
    type: Extract<
      AIChatLinkEventType,
      "turn.content.delta" | "turn.reasoning.delta" | "tool.progress"
    >,
    occurredAt: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const { claim, session, sourceEvent } = active.preparation;
    const actor = this.#store.getActor(claim.turn.targetActorId);
    const envelope = asTransientEnvelope({
      eventId: this.#idFactory("evt"),
      roomId: sourceEvent.roomId,
      type,
      actor: {
        actorId: claim.turn.targetActorId,
        kind: actor?.kind ?? "agent",
        displayName: actor?.displayName ?? claim.turn.targetActorId,
        instanceId: session.instanceId
      },
      to: [],
      causationId: claim.turn.turnId,
      correlationId: claim.turn.rootCorrelationId,
      rootCorrelationId: claim.turn.rootCorrelationId,
      body,
      occurredAt
    });
    await this.#safePublish(envelope, {
      operation: "publish",
      actorId: claim.turn.targetActorId,
      turnId: claim.turn.turnId
    });
  }

  #sendNativeCancel(active: ActiveDispatch): Promise<CancelResult> {
    if (active.nativeCancelPromise) return active.nativeCancelPromise;
    if (!active.nativeTurnId) {
      throw new AIChatLinkError("TURN_INTERRUPTED", "Native Turn id is not available for cancellation");
    }
    const nativeTurnId = active.nativeTurnId;
    const promise = Promise.resolve().then(() =>
      active.preparation.adapter.cancel(active.preparation.session, nativeTurnId)
    );
    active.nativeCancelPromise = promise;
    void promise
      .then(async (result) => {
        active.cancelResult = result;
        if (result.terminalObserved && !active.terminal) {
          await this.#terminalOnce(active, "cancelled");
          active.controller.abort(
            new AIChatLinkError("TURN_INTERRUPTED", "Native cancellation completed")
          );
        }
      })
      .catch((error: unknown) => {
        if (active.nativeCancelPromise === promise) {
          // A failed native cancellation attempt is not a durable receipt.
          // Let a later explicit cancellation retry instead of pinning the
          // rejected promise for the lifetime of the active Turn.
          delete active.nativeCancelPromise;
        }
        this.#report(error, {
          operation: "dispatch",
          actorId: active.preparation.claim.turn.targetActorId,
          turnId: active.preparation.claim.turn.turnId
        });
      });
    return promise;
  }

  async #awaitNativeCancel(active: ActiveDispatch): Promise<CancelResult> {
    const cancel = this.#sendNativeCancel(active);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        cancel,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AIChatLinkError("TURN_INTERRUPTED", "Native cancellation deadline elapsed")
              ),
            this.#nativeCancelTimeoutMs
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #cancelOutcomeFromStore(turnId: string): CancelTurnOutcome {
    const current = this.#store.getTurn(turnId);
    if (!current) throw new AIChatLinkError("STORE_UNAVAILABLE", "Cancelled Turn disappeared");
    return {
      turnId,
      accepted: true,
      status: current.status
    };
  }

  async #publishStored(event: StoredEventRecord): Promise<void> {
    await this.#safePublish(toEnvelope(event), { operation: "publish" });
  }

  async #safePublish(envelope: AIChatLinkEnvelope, context: BrokerErrorContext): Promise<void> {
    try {
      await this.#publisher.publish(envelope);
    } catch (error) {
      this.#report(error, context);
    }
  }

  #assertSession(adapter: CliAdapter, session: NativeSession, actorId: string): void {
    if (
      session.adapterId !== adapter.adapterId ||
      session.actorId !== actorId ||
      session.bindingId === "" ||
      session.instanceId === ""
    ) {
      throw new AIChatLinkError(
        "MCP_BINDING_MISMATCH",
        "Resolved native session does not match the target Adapter binding"
      );
    }
  }

  #requireBinding(bindingId: string) {
    const binding = this.#store.getSessionBinding(bindingId);
    if (!binding || binding.closedAt !== undefined || binding.status === "closed") {
      throw new AIChatLinkError("MCP_BINDING_MISMATCH", "Binding is missing or closed");
    }
    return binding;
  }

  #sourceKindForBinding(binding: { protocol: string }): "web" | "mcp" | "operator" {
    if (binding.protocol === "local-rest") return "web";
    if (binding.protocol === "local-operator") return "operator";
    return "mcp";
  }

  #identityRecordForBinding(
    binding: { actorId: string; protocol: string },
    record: Omit<RememberIdentityFromBindingInput, "bindingId" | "clientCommandId" | "roomId" | "correlationId">
  ) {
    if (binding.actorId.startsWith("agent:") && record.subjectActorId !== binding.actorId) {
      return {
        ...record,
        authorActorId: binding.actorId,
        kind: "note",
        sourceKind: "adapter"
      };
    }
    return {
      ...record,
      authorActorId: binding.actorId,
      sourceKind: this.#sourceKindForBinding(binding)
    };
  }

  #canDeliverCurrentMessageOnly(
    sourceEvent: StoredEventRecord,
    lastDeliveredSeq: number
  ): boolean {
    if (lastDeliveredSeq >= sourceEvent.seq) return true;
    const next = this.#store.listEvents({
      roomId: sourceEvent.roomId,
      afterSeq: lastDeliveredSeq,
      limit: 1
    }).events[0];
    return next?.eventId === sourceEvent.eventId;
  }

  #errorCode(error: unknown): string {
    return error instanceof AIChatLinkError ? error.code : "PROTOCOL_INVALID_MESSAGE";
  }

  #report(error: unknown, context: BrokerErrorContext): void {
    try {
      this.#onError?.(error, context);
    } catch {
      // Error reporting is observational and cannot alter Broker state.
    }
  }

  #notifyTurnTerminal(turnId: string): void {
    const turn = this.#store.getTurn(turnId);
    this.#emitMilestone({
      kind: "turn.terminal",
      turnId,
      watchCursor: this.#nextWatchCursor(turnId),
      seq: null,
      ...(turn === undefined ? {} : { status: turn.status })
    });
    const listeners = this.#turnWaiters.get(turnId);
    this.#wakeFinishLastActors(turnId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }

  #nextWatchCursor(turnId: string): number {
    const next = (this.#watchCursors.get(turnId) ?? 0) + 1;
    this.#watchCursors.set(turnId, next);
    return next;
  }

  #emitMilestone(milestone: SupervisionMilestone): void {
    const listeners = this.#milestoneWaiters.get(milestone.turnId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(milestone);
  }

  #requireWatchTurn(watchTurnId: string): {
    watch: TurnRecord;
    pair: NonNullable<ReturnType<AIChatLinkStore["getSupervisionPairByTurn"]>>;
  } {
    const watch = this.#store.getTurn(watchTurnId);
    if (!watch) {
      throw new AIChatLinkError("UNKNOWN_TARGET", "The watch Turn does not exist");
    }
    if (this.#store.getSupervisionTurnRole(watchTurnId) !== "observer") {
      throw new AIChatLinkError(
        "SUPERVISION_WATCH_REQUIRED",
        "watch and steer are only available on a supervision watch turn"
      );
    }
    const pair = this.#store.getSupervisionPairByTurn(watchTurnId);
    if (!pair) {
      throw new AIChatLinkError("SUPERVISION_PAIR_INVALID", "The watch Turn has no supervision pair");
    }
    return { watch, pair };
  }

  #resolveWatchedWorker(pairId: string, watch: TurnRecord, subjectTurnId?: string): TurnRecord {
    const members = this.#store.listSupervisionPairTurns(pairId).filter(
      (member) => member.role === "worker"
    );
    if (members.length === 0) {
      throw new AIChatLinkError("SUPERVISION_PAIR_INVALID", "The supervision pair has no worker");
    }
    const chosen =
      subjectTurnId === undefined
        ? members.length === 1
          ? members[0]
          : this.#preferredWatchedWorker(members)
        : members.find((member) => member.turnId === subjectTurnId);
    if (chosen === undefined) {
      throw new AIChatLinkError(
        "SUPERVISION_PAIR_INVALID",
        "The requested subject is not a worker in this supervision pair"
      );
    }
    const turn = this.#store.getTurn(chosen.turnId);
    if (!turn || turn.rootCorrelationId !== watch.rootCorrelationId) {
      throw new AIChatLinkError(
        "SUPERVISION_PAIR_INVALID",
        "The watched worker is not in the same correlation"
      );
    }
    return turn;
  }

  #preferredWatchedWorker(
    members: readonly { turnId: string }[]
  ): { turnId: string } | undefined {
    const rank = (status: TurnStatus | undefined): number => {
      switch (status) {
        case "running":
        case "cancelling":
          return 0;
        case "dispatching":
          return 1;
        case "queued":
          return 2;
        default:
          return 3;
      }
    };
    return [...members]
      .map((member) => ({ member, turn: this.#store.getTurn(member.turnId) }))
      .sort((left, right) => rank(left.turn?.status) - rank(right.turn?.status))
      .find((entry) => entry.turn !== undefined && !TERMINAL_TURN_STATUSES.has(entry.turn.status))
      ?.member ?? members.at(-1);
  }

  #buildSupervisionSnapshot(subject: TurnRecord, afterSeq = 0): SupervisionSnapshot {
    const source = this.#store.getEvent(subject.sourceEventId);
    if (!source) {
      throw new AIChatLinkError("STORE_UNAVAILABLE", "The watched Turn source event is missing");
    }
    const attempt = this.#store.listTurnAttempts(subject.turnId).at(-1);
    const active = this.#active.get(subject.turnId);
    const tools = new Map<string, SupervisionSnapshotTool>();
    for (const progress of active?.toolProgress ?? []) {
      const key = progress.toolCallId ?? `${progress.nativeType}:${progress.occurredAt}`;
      tools.set(key, {
        name: toolNameFromDetails(progress.details),
        status: progress.nativeType === "tool.started" ? "started" : "completed",
        ...(progress.toolCallId === undefined ? {} : { toolCallId: progress.toolCallId })
      });
    }
    for (const event of this.#store.listEvents({
      roomId: source.roomId,
      afterSeq,
      limit: 200
    }).events) {
      if (event.eventType !== "tool.progress.recorded") continue;
      if (!isRecord(event.body) || event.body.turnId !== subject.turnId) continue;
      const toolCallId =
        typeof event.body.toolCallId === "string" ? event.body.toolCallId : undefined;
      const nativeType = event.body.nativeType === "tool.completed" ? "completed" : "started";
      tools.set(toolCallId ?? event.eventId, {
        name: toolNameFromDetails(event.body.details),
        status: nativeType,
        ...(toolCallId === undefined ? {} : { toolCallId })
      });
    }
    const messages: SupervisionSnapshot["messages"] = [];
    for (const event of this.#store.listEvents({
      roomId: source.roomId,
      afterSeq,
      limit: 200
    }).events) {
      if (event.eventType !== "message.created" || isSupervisionWatchMessage(event.body)) {
        continue;
      }
      if (event.correlationId !== subject.rootCorrelationId) continue;
      const content = stringProperty(event.body, "content");
      if (content === undefined) continue;
      messages.push({ eventId: event.eventId, excerpt: excerptText(content) });
      if (messages.length >= SUPERVISION_SNAPSHOT_MESSAGE_LIMIT) break;
    }
    let lastSteerReason: string | undefined;
    for (const event of this.#store.listEvents({
      roomId: source.roomId,
      afterSeq: 0,
      limit: 200
    }).events) {
      if (event.eventType !== "supervision.steered" || !isRecord(event.body)) continue;
      if (event.body.subjectTurnId !== subject.turnId) continue;
      const reason = stringProperty(event.body, "reason");
      if (reason !== undefined) lastSteerReason = excerptText(reason, 500);
    }
    return {
      turnId: subject.turnId,
      status: subject.status,
      ...(attempt === undefined ? {} : { deliveryCertainty: attempt.deliveryCertainty }),
      lastSeq: this.#store.getRoomHighWaterSeq(source.roomId),
      watchCursor: this.#watchCursors.get(subject.turnId) ?? 0,
      terminal: TERMINAL_TURN_STATUSES.has(subject.status),
      subjectCancelled: subject.status === "cancelled" || subject.status === "interrupted",
      task: {
        eventId: source.eventId,
        excerpt: excerptText(stringProperty(source.body, "content") ?? "")
      },
      messages,
      tools: [...tools.values()],
      steerCount: this.#store.getSteerCount(subject.turnId),
      ...(lastSteerReason === undefined ? {} : { lastSteerReason })
    };
  }

  assertObserverRouting(watchTurnId: string, targets: readonly string[]): void {
    if (this.#store.getSupervisionTurnRole(watchTurnId) !== "observer") return;
    const pair = this.#store.getSupervisionPairByTurn(watchTurnId);
    if (!pair) return;
    const workers = new Set(
      this.#store
        .listSupervisionPairTurns(pair.pairId)
        .filter((member) => member.role === "worker")
        .map((member) => member.actorId)
    );
    const blocked = targets.find((target) => workers.has(target));
    if (blocked !== undefined) {
      throw new AIChatLinkError(
        "SUPERVISION_STEER_REQUIRED",
        "Redirect a watched worker with steer, not send or ask",
        { actorId: blocked }
      );
    }
  }

  async watchSubject(input: WatchSubjectInput): Promise<WatchSubjectResult> {
    this.#assertOpen();
    const timeoutMs = input.timeoutMs ?? this.#watchTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    const { watch, pair } = this.#requireWatchTurn(input.watchTurnId);
    const subject = this.#resolveWatchedWorker(pair.pairId, watch, input.subjectTurnId);
    const afterSeq = input.afterSeq ?? 0;
    const startCursor = this.#watchCursors.get(subject.turnId) ?? 0;
    const alreadyTerminal = TERMINAL_TURN_STATUSES.has(subject.status);
    const readyNow = (): boolean => {
      const current = this.#store.getTurn(subject.turnId);
      if (!current) return true;
      if (input.until === "terminal") return TERMINAL_TURN_STATUSES.has(current.status);
      return (this.#watchCursors.get(subject.turnId) ?? 0) > startCursor ||
        TERMINAL_TURN_STATUSES.has(current.status);
    };

    let timedOut = false;
    if (!alreadyTerminal && !readyNow()) {
      const state = await new Promise<"milestone" | "timeout" | "aborted">((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: "milestone" | "timeout" | "aborted"): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          this.#closingController.signal.removeEventListener("abort", onAbort);
          const listeners = this.#milestoneWaiters.get(subject.turnId);
          listeners?.delete(onMilestone);
          if (listeners?.size === 0) this.#milestoneWaiters.delete(subject.turnId);
          resolve(result);
        };
        const onMilestone = (): void => finish("milestone");
        const onAbort = (): void => finish("aborted");
        const listeners = this.#milestoneWaiters.get(subject.turnId) ?? new Set();
        listeners.add(onMilestone);
        this.#milestoneWaiters.set(subject.turnId, listeners);
        if (readyNow()) {
          finish("milestone");
          return;
        }
        if (input.signal?.aborted || this.#closingController.signal.aborted) {
          finish("aborted");
          return;
        }
        input.signal?.addEventListener("abort", onAbort, { once: true });
        this.#closingController.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => finish("timeout"), timeoutMs);
      });
      if (state === "aborted") {
        throw new AIChatLinkError("TURN_INTERRUPTED", "AIChatLink watch was aborted");
      }
      timedOut = state === "timeout";
    }

    const snapshot = this.#buildSupervisionSnapshot(subject, afterSeq);
    const observed = this.#store.appendDurableEvent({
      roomId: this.#defaultRoomId,
      eventType: "supervision.observed",
      actorId: watch.targetActorId,
      targets: [subject.targetActorId],
      causationId: watch.turnId,
      correlationId: watch.rootCorrelationId,
      occurredAt: this.#clock.now(),
      body: {
        watchTurnId: watch.turnId,
        subjectTurnId: subject.turnId,
        until: input.until,
        timedOut,
        snapshot
      },
      provenance: {
        sourceKind: "supervision",
        authorActorId: watch.targetActorId,
        subjectActorId: subject.targetActorId,
        sourceEventId: subject.sourceEventId
      }
    });
    await this.#publishStored(observed);
    return { snapshot, until: input.until, timedOut };
  }

  async steerSubject(input: SteerSubjectInput): Promise<SteerSubjectResult> {
    this.#assertOpen();
    const { watch, pair } = this.#requireWatchTurn(input.watchTurnId);
    const subject = this.#resolveWatchedWorker(pair.pairId, watch, input.subjectTurnId);
    if (input.action === "interrupt" && TERMINAL_TURN_STATUSES.has(subject.status)) {
      throw new AIChatLinkError(
        "SUPERVISION_PAIR_INVALID",
        "interrupt requires a still-running worker turn; use nudge for a follow-up"
      );
    }
    this.#store.incrementSteerCount(subject.turnId, this.#steerLimit);
    if (input.action === "interrupt") {
      await this.cancelTurn(subject.turnId);
    }
    const accepted = await this.acceptMessage({
      bindingId: input.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: [subject.targetActorId],
        content: input.content
      },
      roomId: this.#defaultRoomId,
      commandType: "supervision.steer",
      causationId: watch.turnId,
      correlationId: watch.rootCorrelationId,
      parentTurnId: watch.turnId,
      hopCount: watch.hopCount + 1
    });
    const nextTurn = accepted.turns[0];
    if (nextTurn !== undefined) {
      this.#store.attachSupervisionWorkerTurn({
        pairId: pair.pairId,
        turnId: nextTurn.turnId,
        actorId: nextTurn.target
      });
    }
    const steered = this.#store.appendDurableEvent({
      roomId: this.#defaultRoomId,
      eventType: "supervision.steered",
      actorId: watch.targetActorId,
      targets: [subject.targetActorId],
      causationId: watch.turnId,
      correlationId: watch.rootCorrelationId,
      occurredAt: this.#clock.now(),
      body: {
        action: input.action,
        reason: input.reason,
        subjectTurnId: subject.turnId,
        nextTurnId: nextTurn?.turnId,
        pairId: pair.pairId
      },
      provenance: {
        sourceKind: "supervision",
        authorActorId: watch.targetActorId,
        subjectActorId: subject.targetActorId,
        sourceEventId: accepted.messageEventId
      }
    });
    await this.#publishStored(steered);
    return {
      action: input.action,
      reason: input.reason,
      subjectTurnId: subject.turnId,
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      ...(nextTurn === undefined ? {} : { nextTurnId: nextTurn.turnId }),
      steeredEventId: steered.eventId
    };
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "Broker is closed");
    }
  }
}

function conversationTitle(content: string | undefined, index: number): string {
  const text = (content ?? "").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return `对话 ${index}`;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
