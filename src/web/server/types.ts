import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  BootstrapResponse,
  CancelTurnRequest,
  CancelTurnResult,
  CompactContextRequest,
  CompactContextResult,
  ConversationList,
  CreateMessageAccepted,
  CreateMessageRequest,
  IdentityQuery,
  IdentityRecordContract,
  MemoryQuery,
  MemoryRecordContract,
  RememberIdentityRequest,
  RememberMemoryRequest,
  RestartAgentAccepted,
  RestartAgentRequest,
  ResetContextRequest,
  ResumeConversationRequest,
  RoomContextResetResult,
  RoomContextUsage,
  RetractIdentityRequest,
  RetractMemoryRequest,
  SupersedeIdentityRequest,
  SupersedeMemoryRequest,
  SetupSaveRequest,
  SetupSaveResponse,
  SetupSnapshot,
  AssistantCancelRequest,
  AssistantCancelResult,
  AssistantConversationPage,
  AssistantMessageAccepted,
  AssistantMessageRequest,
  AssistantSnapshot,
  WorkspaceListing,
  WorkspaceRevealResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  RemoveWorkspaceResponse,
  RestartWorkspaceResponse,
  WorkspaceList
} from "../../contracts/index.js";
import type { SseRuntime } from "../sse/index.js";
import type { AIChatLinkRuntimeIdentity } from "../../core/runtime-instance.js";

export type Awaitable<T> = T | Promise<T>;

export interface BrokerHealth {
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface MemoryPage {
  readonly items: readonly MemoryRecordContract[];
  readonly nextCursor?: number;
}

export interface MemoryMutationAccepted {
  readonly memory: MemoryRecordContract;
}

export interface IdentityPage {
  readonly items: readonly IdentityRecordContract[];
  readonly nextCursor?: number;
}

export interface IdentityMutationAccepted {
  readonly identity: IdentityRecordContract;
}

export interface McpHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close?(): Promise<void>;
}

export interface SetupApi {
  snapshot(signal: AbortSignal): Awaitable<SetupSnapshot>;
  save(request: SetupSaveRequest, signal: AbortSignal): Awaitable<SetupSaveResponse>;
}

/**
 * Local folder browsing for the room workspace. Read-only listing plus a
 * best-effort "reveal in file manager"; it never reads file contents.
 */
export interface SetupWorkspaceApi {
  list(path: string | undefined, signal: AbortSignal): Awaitable<WorkspaceListing>;
  reveal(path: string, signal: AbortSignal): Awaitable<WorkspaceRevealResponse>;
}

/**
 * Workspace registry surface owned by the hub runtime. Children never expose
 * it: one process is the single registry writer.
 */
export interface WorkspaceHubApi {
  list(signal: AbortSignal): Awaitable<WorkspaceList>;
  create(request: CreateWorkspaceRequest, signal: AbortSignal): Awaitable<CreateWorkspaceResponse>;
  remove(workspaceId: string, signal: AbortSignal): Awaitable<RemoveWorkspaceResponse>;
  restart(workspaceId: string, signal: AbortSignal): Awaitable<RestartWorkspaceResponse>;
}

export type WorkspaceRouteTarget =
  | { readonly kind: "primary" }
  | { readonly kind: "child"; readonly origin: string }
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly errorCode?: string };

/**
 * Read-only routing table used by the hub HTTP layer. A child origin is an
 * in-memory loopback address and is never written to the browser.
 */
export interface WorkspaceRouting {
  readonly primaryWorkspaceId: string;
  resolve(workspaceId: string): WorkspaceRouteTarget | undefined;
}

/** Streams one hub request (including SSE) to a child runtime's loopback origin. */
export interface WorkspaceProxy {
  forward(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    targetOrigin: string
  ): Promise<void>;
  closeAll(): void;
}

export interface AssistantApi {
  snapshot(signal: AbortSignal): Awaitable<AssistantSnapshot>;
  listMessages(signal: AbortSignal): Awaitable<AssistantConversationPage>;
  postMessage(
    request: AssistantMessageRequest,
    signal: AbortSignal
  ): Awaitable<AssistantMessageAccepted>;
  cancel(request: AssistantCancelRequest, signal: AbortSignal): Awaitable<AssistantCancelResult>;
}

export interface RuntimeControl {
  requestShutdown(): Awaitable<void>;
  onShutdownError?(error: unknown): void;
}

/**
 * The HTTP layer deliberately knows only this command/query surface. Turn
 * state, idempotency, actor assignment and persistence remain Broker concerns.
 */
export interface BrokerApi {
  readonly roomId: string;

  health(signal: AbortSignal): Awaitable<BrokerHealth>;
  bootstrap(signal: AbortSignal): Awaitable<BootstrapResponse>;
  contextUsage(signal: AbortSignal): Awaitable<RoomContextUsage>;
  listConversations(signal: AbortSignal): Awaitable<ConversationList>;
  resetContext(
    request: ResetContextRequest,
    signal: AbortSignal
  ): Awaitable<RoomContextResetResult>;
  resumeConversation(
    request: ResumeConversationRequest,
    signal: AbortSignal
  ): Awaitable<RoomContextResetResult>;
  compactContext(
    request: CompactContextRequest,
    signal: AbortSignal
  ): Awaitable<CompactContextResult>;
  createMessage(
    request: CreateMessageRequest,
    signal: AbortSignal
  ): Awaitable<CreateMessageAccepted>;
  cancelTurn(
    turnId: string,
    request: CancelTurnRequest,
    signal: AbortSignal
  ): Awaitable<CancelTurnResult>;
  queryMemory(query: MemoryQuery, signal: AbortSignal): Awaitable<MemoryPage>;
  queryIdentity(query: IdentityQuery, signal: AbortSignal): Awaitable<IdentityPage>;
  rememberMemory(
    request: RememberMemoryRequest,
    signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted>;
  rememberIdentity(
    request: RememberIdentityRequest,
    signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted>;
  supersedeIdentity(
    identityId: string,
    request: SupersedeIdentityRequest,
    signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted>;
  retractIdentity(
    identityId: string,
    request: RetractIdentityRequest,
    signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted>;
  supersedeMemory(
    memoryId: string,
    request: SupersedeMemoryRequest,
    signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted>;
  retractMemory(
    memoryId: string,
    request: RetractMemoryRequest,
    signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted>;
  restartAgent(
    actorId: string,
    request: RestartAgentRequest,
    signal: AbortSignal
  ): Awaitable<RestartAgentAccepted>;
}

export interface AIChatLinkHttpServerOptions {
  readonly broker: BrokerApi;
  readonly sse: SseRuntime;
  readonly host?: "127.0.0.1";
  /** Use zero only when the operating system should choose a test port. */
  readonly port?: number;
  readonly staticRoot?: string;
  readonly maxRequestBodyBytes?: number;
  readonly gracefulCloseTimeoutMs?: number;
  readonly mcpHandler?: McpHttpHandler;
  readonly operatorMcpHandler?: McpHttpHandler;
  readonly setupApi?: SetupApi;
  readonly workspaceApi?: SetupWorkspaceApi;
  readonly workspaceHub?: WorkspaceHubApi;
  readonly workspaceRouting?: WorkspaceRouting;
  readonly assistantApi?: AssistantApi;
  /** Present on the product runtime; optional only for embedded/test servers. */
  readonly runtimeIdentity?: AIChatLinkRuntimeIdentity;
  /** Product-runtime lifecycle control used by local `aichatlink stop` / `aichatlink restart`. */
  readonly runtimeControl?: RuntimeControl;
  /**
   * Actor ids the REST contract may accept as dispatch targets. Defaults to the
   * built-in driver list, which cannot know about extra agent ids configured in
   * aichatlink.json; the product runtime passes the registered adapter ids instead.
   */
  readonly knownTargets?: readonly string[];
}

export interface AIChatLinkHttpServerAddress {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
}
