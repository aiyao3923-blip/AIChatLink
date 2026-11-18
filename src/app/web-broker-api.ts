import type { AIChatLinkBroker } from "../broker/broker.js";
import type {
  BootstrapResponse,
  CancelTurnRequest,
  CancelTurnResult,
  CompactContextRequest,
  CompactContextResult,
  CreateMessageAccepted,
  CreateMessageRequest,
  IdentityQuery,
  RememberIdentityRequest,
  RememberMemoryRequest,
  ResumeConversationRequest,
  DeleteConversationRequest,
  DeleteConversationResult,
  RestartAgentAccepted,
  RestartAgentRequest,
  RoomContextUsage,
  RetractIdentityRequest,
  RetractMemoryRequest,
  SupersedeIdentityRequest,
  SupersedeMemoryRequest,
  MemoryQuery
} from "../contracts/rest.js";
import {
  parseBootstrapResponse,
  parseCancelTurnResult,
  parseCompactContextResult,
  parseConversationList,
  parseCreateMessageAccepted,
  parseDeleteConversationResult,
  parseRoomContextResetResult,
  parseRoomContextUsage
} from "../contracts/rest.js";
import { TRANSPORT_LIFECYCLE, type AIChatLinkConfig } from "../config.js";
import type { CommandSpec } from "../launch/command-spec.js";
import type { BrokerApi, BrokerHealth, IdentityMutationAccepted, IdentityPage, MemoryMutationAccepted, MemoryPage } from "../web/server/types.js";
import {
  toIdentityRecordContract,
  toMemoryRecordContract
} from "./record-mappers.js";
import type { RuntimeReadiness } from "./readiness.js";
import type { RestartAgentCommandCoordinator } from "./restart-commands.js";

const DEFAULT_PAGE_LIMIT = 100;

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function nextCursor(cursor: number, limit: number, count: number): number | undefined {
  return count === limit ? cursor + count : undefined;
}

/**
 * A native pi driver reports itself. The legacy `tools/pi-driver` shim still
 * runs as driver "claude"; keep surfacing that so the roster does not label a
 * pi role as plain Claude Code.
 */
function isPiDriver(driver: string | undefined, command: CommandSpec | undefined): boolean {
  if (driver === "pi") return true;
  if (command === undefined) return false;
  return [command.executable, ...command.prefixArgs].some((part) => /[\\/]pi-driver[\\/]/u.test(part));
}

type WebBrokerSurface = Pick<
  AIChatLinkBroker,
  | "health"
  | "bootstrap"
  | "acceptMessage"
  | "cancelFromBinding"
  | "contextUsage"
  | "listConversations"
  | "compactContextFromBinding"
  | "resetContextFromBinding"
  | "resumeConversationFromBinding"
  | "deleteConversationFromBinding"
  | "queryMemory"
  | "queryIdentity"
  | "rememberMemory"
  | "rememberIdentity"
  | "supersedeMemory"
  | "retractMemory"
  | "supersedeIdentity"
  | "retractIdentity"
>;

export interface AIChatLinkWebBrokerApiOptions {
  broker: WebBrokerSurface;
  restartCommands: Pick<RestartAgentCommandCoordinator, "restart">;
  readiness: Pick<RuntimeReadiness, "state" | "isReady" | "requireReady">;
  config: Pick<AIChatLinkConfig, "transport" | "agents">;
  roomId: string;
  bindingId: string;
}

/** REST facade: all writes use one persisted local-rest binding. */
export class AIChatLinkWebBrokerApi implements BrokerApi {
  readonly roomId: string;
  readonly #broker: WebBrokerSurface;
  readonly #restartCommands: AIChatLinkWebBrokerApiOptions["restartCommands"];
  readonly #readiness: AIChatLinkWebBrokerApiOptions["readiness"];
  readonly #config: AIChatLinkWebBrokerApiOptions["config"];
  readonly #bindingId: string;

  constructor(options: AIChatLinkWebBrokerApiOptions) {
    this.#broker = options.broker;
    this.#restartCommands = options.restartCommands;
    this.#readiness = options.readiness;
    this.#config = options.config;
    this.roomId = options.roomId;
    this.#bindingId = options.bindingId;
  }

  health(signal: AbortSignal): BrokerHealth {
    throwIfAborted(signal);
    const broker = this.#broker.health();
    return {
      status:
        this.#readiness.isReady && broker.store.available && broker.store.integrityOk
          ? "ok"
          : "degraded",
      readiness: this.#readiness.state,
      transport: this.#config.transport,
      transportLifecycle: TRANSPORT_LIFECYCLE[this.#config.transport],
      access: "unrestricted",
      ...broker
    };
  }

  bootstrap(signal: AbortSignal): BootstrapResponse {
    throwIfAborted(signal);
    const bootstrap = this.#broker.bootstrap({ roomId: this.roomId });
    return parseBootstrapResponse({
      ...bootstrap,
      agents: bootstrap.agents.map((agent) => {
        const agentId = agent.actorId.slice("agent:".length) as keyof AIChatLinkConfig["agents"];
        const configured = this.#config.agents[agentId];
        return {
          ...agent,
          ...(configured === undefined
            ? {}
            : {
                cwd: configured.cwd,
                driver: configured.driver,
                enabled: configured.enabled,
                capabilities: {
                  transport: this.#config.transport,
                  transportLifecycle: TRANSPORT_LIFECYCLE[this.#config.transport],
                  access: "unrestricted",
                  currentTurnMcp: this.#config.transport === "structured",
                  ...(isPiDriver(configured.driver, configured.command) ? { piDriver: true } : {})
                }
              })
        };
      })
    });
  }

  contextUsage(signal: AbortSignal): RoomContextUsage {
    throwIfAborted(signal);
    return parseRoomContextUsage(this.#broker.contextUsage(this.roomId));
  }

  listConversations(signal: AbortSignal): import("../contracts/rest.js").ConversationList {
    throwIfAborted(signal);
    return parseConversationList({ conversations: this.#broker.listConversations(this.roomId) });
  }

  async resetContext(
    request: import("../contracts/rest.js").ResetContextRequest,
    signal: AbortSignal
  ): Promise<import("../contracts/rest.js").RoomContextResetResult> {
    this.#requireWritable(signal);
    return parseRoomContextResetResult(
      await this.#broker.resetContextFromBinding({
        bindingId: this.#bindingId,
        clientCommandId: request.clientCommandId,
        roomId: this.roomId,
        resetNativeSessions: request.resetNativeSessions === true
      })
    );
  }

  async resumeConversation(
    request: ResumeConversationRequest,
    signal: AbortSignal
  ): Promise<import("../contracts/rest.js").RoomContextResetResult> {
    this.#requireWritable(signal);
    return parseRoomContextResetResult(
      await this.#broker.resumeConversationFromBinding({
        bindingId: this.#bindingId,
        clientCommandId: request.clientCommandId,
        conversationId: request.conversationId,
        roomId: this.roomId,
        resetNativeSessions: request.resetNativeSessions !== false
      })
    );
  }

  async deleteConversation(
    request: DeleteConversationRequest,
    signal: AbortSignal
  ): Promise<DeleteConversationResult> {
    this.#requireWritable(signal);
    return parseDeleteConversationResult(
      await this.#broker.deleteConversationFromBinding({
        bindingId: this.#bindingId,
        clientCommandId: request.clientCommandId,
        conversationId: request.conversationId,
        roomId: this.roomId,
        resetNativeSessions: request.resetNativeSessions !== false
      })
    );
  }

  async compactContext(
    request: CompactContextRequest,
    signal: AbortSignal
  ): Promise<CompactContextResult> {
    this.#requireWritable(signal);
    return parseCompactContextResult(
      await this.#broker.compactContextFromBinding({
        bindingId: this.#bindingId,
        clientCommandId: request.clientCommandId,
        roomId: this.roomId
      })
    );
  }

  async createMessage(
    request: CreateMessageRequest,
    signal: AbortSignal
  ): Promise<CreateMessageAccepted> {
    throwIfAborted(signal);
    this.#readiness.requireReady();
    const accepted = await this.#broker.acceptMessage({
      bindingId: this.#bindingId,
      request: {
        clientCommandId: request.clientCommandId,
        to: request.to,
        content: request.content,
        ...(request.replyToEventId === undefined
          ? {}
          : { replyToEventId: request.replyToEventId }),
        ...(request.supervision === undefined ? {} : { supervision: request.supervision })
      },
      roomId: this.roomId,
      commandType: "message.send"
    });
    return parseCreateMessageAccepted({
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      turns: accepted.turns.map((turn) => ({
        target: turn.target,
        turnId: turn.turnId,
        status: turn.status
      })),
      ...(accepted.watchTurns === undefined
        ? {}
        : {
            watchTurns: accepted.watchTurns.map((turn) => ({
              target: turn.target,
              turnId: turn.turnId,
              status: turn.status
            }))
          }),
      ...(accepted.watchEventId === undefined ? {} : { watchEventId: accepted.watchEventId }),
      ...(accepted.pairEventId === undefined ? {} : { pairEventId: accepted.pairEventId })
    });
  }

  async cancelTurn(
    turnId: string,
    request: CancelTurnRequest,
    signal: AbortSignal
  ): Promise<CancelTurnResult> {
    throwIfAborted(signal);
    this.#readiness.requireReady();
    const result = await this.#broker.cancelFromBinding({
      turnId,
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId
    });
    return parseCancelTurnResult({
      turnId: result.turnId,
      accepted: result.accepted,
      status: result.status
    });
  }

  queryMemory(query: MemoryQuery, signal: AbortSignal): MemoryPage {
    throwIfAborted(signal);
    const cursor = query.cursor ?? 0;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const items = this.#broker.queryMemory({
      ...(query.scopeType === undefined ? {} : { scopeType: query.scopeType }),
      ...(query.scopeId === undefined ? {} : { scopeId: query.scopeId }),
      ...(query.agentMemoryType === undefined
        ? {}
        : { agentMemoryType: query.agentMemoryType }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.authorActorId === undefined ? {} : { authorActorId: query.authorActorId }),
      ...(query.subjectActorId === undefined ? {} : { subjectActorId: query.subjectActorId }),
      ...(query.includeHistory === undefined ? {} : { includeHistory: query.includeHistory }),
      cursor,
      limit
    }).map(toMemoryRecordContract);
    const next = nextCursor(cursor, limit, items.length);
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  queryIdentity(query: IdentityQuery, signal: AbortSignal): IdentityPage {
    throwIfAborted(signal);
    const cursor = query.cursor ?? 0;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const items = this.#broker.queryIdentity({
      ...(query.subjectActorId === undefined ? {} : { subjectActorId: query.subjectActorId }),
      ...(query.authorActorId === undefined ? {} : { authorActorId: query.authorActorId }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.includeHistory === undefined ? {} : { includeHistory: query.includeHistory }),
      cursor,
      limit
    }).map(toIdentityRecordContract);
    const next = nextCursor(cursor, limit, items.length);
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  async rememberMemory(
    request: RememberMemoryRequest,
    signal: AbortSignal
  ): Promise<MemoryMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.rememberMemory({
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      scopeType: request.scope.type,
      scopeId: request.scope.id,
      kind: request.kind,
      content: request.content,
      ...(request.subjectActorId === undefined ? {} : { subjectActorId: request.subjectActorId }),
      ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
      roomId: this.roomId
    });
    return { memory: toMemoryRecordContract(record) };
  }

  async supersedeMemory(
    memoryId: string,
    request: SupersedeMemoryRequest,
    signal: AbortSignal
  ): Promise<MemoryMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.supersedeMemory(memoryId, {
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      content: request.content,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
      roomId: this.roomId
    });
    return { memory: toMemoryRecordContract(record) };
  }

  async retractMemory(
    memoryId: string,
    request: RetractMemoryRequest,
    signal: AbortSignal
  ): Promise<MemoryMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.retractMemory(memoryId, {
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      roomId: this.roomId
    });
    return { memory: toMemoryRecordContract(record) };
  }

  async rememberIdentity(
    request: RememberIdentityRequest,
    signal: AbortSignal
  ): Promise<IdentityMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.rememberIdentity({
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      subjectActorId: request.subjectActorId,
      kind: request.kind,
      content: request.content,
      ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
      roomId: this.roomId
    });
    return { identity: toIdentityRecordContract(record) };
  }

  async supersedeIdentity(
    identityId: string,
    request: SupersedeIdentityRequest,
    signal: AbortSignal
  ): Promise<IdentityMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.supersedeIdentity(identityId, {
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      content: request.content,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
      roomId: this.roomId
    });
    return { identity: toIdentityRecordContract(record) };
  }

  async retractIdentity(
    identityId: string,
    request: RetractIdentityRequest,
    signal: AbortSignal
  ): Promise<IdentityMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.retractIdentity(identityId, {
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      roomId: this.roomId
    });
    return { identity: toIdentityRecordContract(record) };
  }

  async restartAgent(
    actorId: string,
    request: RestartAgentRequest,
    signal: AbortSignal
  ): Promise<RestartAgentAccepted> {
    this.#requireWritable(signal);
    return await this.#restartCommands.restart({
      actorId,
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId
    });
  }

  #requireWritable(signal: AbortSignal): void {
    throwIfAborted(signal);
    this.#readiness.requireReady();
  }
}
