import { collectCursorPages } from "./pagination.js";
import {
  FIRST_EPOCH_START_SEQ,
  activeEpochStartSeq,
  epochStartAfterReset,
  eventInEpoch,
  turnActivityState,
  visibleConversations
} from "./conversation-epoch.js";
import { compareRosterOrder, disabledConfiguredActorIds, pendingConfiguredAgents } from "./agent-roster.js";
import { DISABLED_NOTE, ROOM_VOICE, emptyVoiceFor, type EmptyVoice } from "./empty-voice.js";
import {
  TERMINAL_TURN_STATUSES,
  activeTurnActorIds,
  cancellableTurnIds,
  isFinishedTransition
} from "./agent-activity.js";
import {
  planResumeAfterStop,
  sendButtonState,
  type ResumeAfterStopPlan
} from "./composer-state.js";
import { draftScopeFrom, readDraft, writeDraft, type DraftScope } from "./draft-scope.js";
import { parseReasoningRecord } from "./reasoning-record.js";
import { copyPlainText, flashButtonLabel, renderRichContent } from "./rich-text.js";
import { describeToolProgress, mergeToolProgressSnapshot } from "./tool-progress.js";
import { formatCharacterEstimate } from "./usage-format.js";
import {
  MAX_PANES,
  PANE_TRACKS,
  defaultPanes,
  formatPaneLens,
  lensAccepts,
  normalizePanes,
  paneSpans,
  parsePaneLens,
  roomLens,
  type PaneLens
} from "./pane-lens.js";
import { createPaneShell, fillPaneLensOptions, type PaneShell } from "./pane-view.js";

type JsonRecord = Record<string, unknown>;
type ConnectionState = "bootstrapping" | "connecting" | "live" | "reconnecting" | "offline";
type ActorKind = "user" | "agent" | "system";

interface ActorRef {
  actorId: string;
  kind: ActorKind;
  instanceId: string | null;
  displayName: string;
}

interface AIChatLinkEnvelope {
  schema: string;
  eventId: string;
  seq: number | null;
  roomId: string;
  type: string;
  actor: ActorRef;
  to: string[];
  replyToEventId: string | null;
  causationId: string | null;
  correlationId: string;
  occurredAt: string;
  durability: "durable" | "transient";
  body: unknown;
}

interface AgentView {
  actorId: string;
  displayName: string;
  status: string;
  driver: string;
  /** pi roles run through tools/pi-driver; pending agents may not know yet. */
  piDriver?: boolean;
  cwd: string;
  enabled: boolean;
  capabilities: string[];
  /** Explicit roster position from `aichatlink.json`; absent means actorId order. */
  order?: number;
}

interface TurnView {
  turnId: string;
  targetActorId: string;
  status: string;
  correlationId: string;
  error: string;
  /** Bounded text an unfinished Turn has already produced (bootstrap only). */
  partialText?: string;
  partialTextTruncated?: boolean;
}

/** A live Turn that just reached a terminal status, kept until the operator looks. */
interface FinishedAgent {
  status: string;
  turnId: string;
}

interface RenderTurnOptions {
  /** POST 202 and bootstrap snapshots may describe a Turn the SSE already advanced. */
  seedOnly?: boolean;
}

interface RecordView {
  id: string;
  scopeType: "room" | "agent" | "global";
  scopeId: string;
  kind: string;
  content: string;
  authorActorId: string;
  subjectActorId: string;
  createdAt: string;
  status: string;
}

interface MessageDraft {
  clientCommandId: string;
  to: string[];
  content: string;
  replyToEventId: string | null;
}

interface PendingSubmission {
  signature: string;
  draft: MessageDraft;
}

interface ContextUsageView {
  roomId: string;
  throughSeq: number;
  estimatedCharacters: number;
  maxCharacters: number;
  compactionTriggerCharacters: number;
  utilizationPercent: number;
  uncompactedMessageCount: number;
  summaryThroughSeq: number | null;
  compactable: boolean;
}

interface DeltaState {
  text: string;
  seenChunkIndexes: Set<number>;
}

interface DeltaPiece {
  chunkIndex: number | null;
  text: string;
}

interface DeltaBucket {
  envelope: AIChatLinkEnvelope;
  key: string;
  pieces: DeltaPiece[];
  mode: "content" | "reasoning";
  /** Resolved once at acceptance; lane filtering must not guess it again. */
  targetActorId: string | null;
}

interface PaneLogEntry {
  envelope: AIChatLinkEnvelope;
  targetActorId: string | null;
}

interface AppState {
  connection: ConnectionState;
  roomId: string;
  lastDurableSeq: number;
  agents: Map<string, AgentView>;
  messages: Map<string, AIChatLinkEnvelope>;
  turns: Map<string, TurnView>;
  memories: Map<string, RecordView>;
  seenEventIds: Set<string>;
  transientText: Map<string, DeltaState>;
  replyToEventId: string | null;
  pendingSubmission: PendingSubmission | null;
  replacing: { id: string } | null;
  submitting: boolean;
  /** Recent visible envelopes, used to refill a pane created mid-conversation. */
  paneLog: PaneLogEntry[];
}

interface ApiFailureShape {
  code: string;
  message: string;
  status: number;
}

class ApiFailure extends Error implements ApiFailureShape {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
  }
}

const MESSAGE_MAX_LENGTH = 131_072;
const DELTA_BATCH_MS = 32;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const DEFAULT_ROOM_ID = "room:main";
/** A turn in one of these states may still emit events after a conversation reset. */
const IN_FLIGHT_TURN_STATUSES = new Set(["dispatching", "running", "cancelling", "cancel_requested"]);
/**
 * Drafts belong to the view the cursor is in, not to the browser tab. The scope
 * is derived from the URL because that is what both a reload and a workspace
 * switch preserve: no view can inherit another view's unsent text.
 */
const THEME_STORAGE_KEY = "aichatlink:theme";
const SIDEBAR_STORAGE_KEY = "aichatlink:sidebar";
const PANES_STORAGE_KEY = "aichatlink:panes";
/** Enough to refill a new pane in the same order; deltas are never logged. */
const PANE_LOG_MAX = 300;
const COLLAPSED_WORKSPACES_KEY = "aichatlink:collapsed-workspaces";
const TIMELINE_MAX_ITEMS = 500;
const TIMELINE_TRIM_BATCH = 100;
const HEALTH_POLL_MS = 60_000;
const BASE_TITLE = document.title;

const DOCUMENTED_EVENT_TYPES = [
  "aichatlink.event",
  "aichatlink",
  "message.created",
  "turn.queued",
  "turn.dispatched",
  "turn.started",
  "turn.streaming",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.interrupted",
  "turn.content.delta",
  "turn.reasoning.delta",
  "turn.reasoning.recorded",
  "turn.progress",
  "tool.progress",
  "tool.progress.recorded",
  "context.compaction.started",
  "context.compaction.retrying",
  "context.compaction.completed",
  "context.compaction.failed",
  "session.starting",
  "session.retrying",
  "session.ready",
  "session.resumed",
  "session.stopped",
  "session.failed",
  "memory.remembered",
  "memory.superseded",
  "memory.retracted",
  "identity.remembered",
  "identity.superseded",
  "identity.retracted",
  "routing.loop_stopped",
  "supervision.paired",
  "supervision.observed",
  "supervision.steered",
  "operator.dispatch",
  "context.reset",
  "system.error",
  "adapter.heartbeat",
] as const;

const state: AppState = {
  connection: "bootstrapping",
  roomId: DEFAULT_ROOM_ID,
  lastDurableSeq: 0,
  agents: new Map(),
  messages: new Map(),
  turns: new Map(),
  memories: new Map(),
  seenEventIds: new Set(),
  transientText: new Map(),
  replyToEventId: null,
  pendingSubmission: null,
  replacing: null,
  submitting: false,
  paneLog: [],
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}

const connectionDot = byId<HTMLSpanElement>("connection-dot");
const composerWorkspace = byId<HTMLButtonElement>("composer-workspace");
const composerWorkspacePath = byId<HTMLSpanElement>("composer-workspace-path");
const globalError = byId<HTMLDivElement>("global-error");
const agentList = byId<HTMLUListElement>("agent-list");
const agentCount = byId<HTMLSpanElement>("agent-count");
/** Assigned by usePaneContext(); every pane owns its own reading controls. */
let timeline!: HTMLOListElement;
let timelineEmpty!: HTMLLIElement;
let jumpLatest!: HTMLButtonElement;
let jumpLatestCount!: HTMLSpanElement;
const composer = byId<HTMLFormElement>("composer");
const composerDock = byId<HTMLDivElement>("composer-dock");
const composerAgents = byId<HTMLElement>("composer-agents");
const agentActivityLive = byId<HTMLElement>("agent-activity-live");
const messageInput = byId<HTMLTextAreaElement>("message-input");
const sendButton = byId<HTMLButtonElement>("send-button");
const sendLabel = byId<HTMLSpanElement>("send-label");
const composerStatus = byId<HTMLSpanElement>("composer-status");
const characterCount = byId<HTMLSpanElement>("character-count");
const targetAll = byId<HTMLInputElement>("target-all");
const replyContext = byId<HTMLDivElement>("reply-context");
const replyDescription = byId<HTMLSpanElement>("reply-description");
const clearReplyButton = byId<HTMLButtonElement>("clear-reply");
const memoryList = byId<HTMLUListElement>("memory-list");
const memoryForm = byId<HTMLFormElement>("memory-form");
const memoryKind = byId<HTMLSelectElement>("memory-kind");
const memoryInput = byId<HTMLTextAreaElement>("memory-input");
const memoryReplaceBanner = byId<HTMLDivElement>("memory-replace-banner");
const memorySubmit = byId<HTMLButtonElement>("memory-submit");
const publicMemoryCount = byId<HTMLSpanElement>("public-memory-count");
const publicMemorySection = byId<HTMLDetailsElement>("public-memory-section");
const memoryToggle = byId<HTMLButtonElement>("memory-toggle");
const memoryDialog = byId<HTMLDialogElement>("memory-dialog");
const memoryClose = byId<HTMLButtonElement>("memory-close");
const themeToggle = byId<HTMLButtonElement>("theme-toggle");
const sidebarToggle = byId<HTMLButtonElement>("sidebar-toggle");
const conversationGroups = byId<HTMLDivElement>("conversation-groups");
const newConversationButton = byId<HTMLButtonElement>("new-conversation");
const newRoomButton = byId<HTMLButtonElement>("new-room");
const viewingBanner = byId<HTMLElement>("viewing-banner");
const viewingBannerTitle = byId<HTMLElement>("viewing-banner-title");
const viewingBannerNote = byId<HTMLElement>("viewing-banner-note");
const viewingBannerExit = byId<HTMLButtonElement>("viewing-banner-exit");
const assistantToggle = byId<HTMLButtonElement>("assistant-toggle");
const assistantDrawer = byId<HTMLElement>("assistant-drawer");
const assistantClose = byId<HTMLButtonElement>("assistant-close");
const assistantStatus = byId<HTMLParagraphElement>("assistant-status");
const assistantGuide = byId<HTMLDivElement>("assistant-guide");
const assistantTimeline = byId<HTMLOListElement>("assistant-timeline");
const assistantForm = byId<HTMLFormElement>("assistant-form");
const assistantInput = byId<HTMLTextAreaElement>("assistant-input");
const assistantFormStatus = byId<HTMLElement>("assistant-form-status");
const assistantSend = byId<HTMLButtonElement>("assistant-send");
const assistantCancel = byId<HTMLButtonElement>("assistant-cancel");
const ASSISTANT_DRAWER_KEY = "aichatlink-assistant-open";
const targetPicker = byId<HTMLFieldSetElement>("target-picker");
const targetToggle = byId<HTMLButtonElement>("target-toggle");
const targetSummary = byId<HTMLElement>("target-summary");
const targetSelectAll = byId<HTMLButtonElement>("target-select-all");
const targetClear = byId<HTMLButtonElement>("target-clear");
const targetCluster = targetToggle.closest<HTMLElement>(".target-cluster");
const runtimeProgress = byId<HTMLElement>("runtime-progress");
const runtimeProgressTitle = byId<HTMLElement>("runtime-progress-title");
const runtimeProgressDetail = byId<HTMLElement>("runtime-progress-detail");
const runtimeProgressAttempt = byId<HTMLElement>("runtime-progress-attempt");
const contextUsage = byId<HTMLElement>("context-usage");
const contextUsageValue = byId<HTMLElement>("context-usage-value");
const contextUsageFill = byId<HTMLElement>("context-usage-fill");
const compactContextButton = byId<HTMLButtonElement>("compact-context");
const workspaceDialog = byId<HTMLDialogElement>("workspace-dialog");
const workspaceClose = byId<HTMLButtonElement>("workspace-close");
const workspaceList = byId<HTMLUListElement>("workspace-list");
const workspaceUp = byId<HTMLButtonElement>("workspace-up");
const workspaceDialogPath = byId<HTMLSpanElement>("workspace-dialog-path");
const workspaceShortcuts = byId<HTMLDivElement>("workspace-shortcuts");
const workspaceEntries = byId<HTMLUListElement>("workspace-entries");
const workspaceDialogStatus = byId<HTMLSpanElement>("workspace-dialog-status");
const workspaceUse = byId<HTMLButtonElement>("workspace-use");
const paneGrid = byId<HTMLDivElement>("pane-grid");
const panesToggle = byId<HTMLButtonElement>("panes-toggle");
const panesDialog = byId<HTMLDialogElement>("panes-dialog");
const panesClose = byId<HTMLButtonElement>("panes-close");
const panesLayouts = byId<HTMLDivElement>("panes-layouts");
const panesStatus = byId<HTMLParagraphElement>("panes-status");
const panesAssignments = byId<HTMLOListElement>("panes-assignments");
const panesFillAgents = byId<HTMLButtonElement>("panes-fill-agents");
const panesReset = byId<HTMLButtonElement>("panes-reset");
const panesOpenWindow = byId<HTMLButtonElement>("panes-open-window");

function targetInputs(): HTMLInputElement[] {
  return Array.from(targetPicker.querySelectorAll<HTMLInputElement>('input[name="target"]'));
}

/** Assigned by usePaneContext(); each pane owns its own node tables. */
let eventNodes!: Map<string, HTMLElement>;
let turnNodes!: Map<string, HTMLElement>;
let streamNodes!: Map<string, HTMLElement>;
let toolProgressNodes!: Map<string, { node: HTMLElement; snapshot: unknown }>;
const deltaBuckets = new Map<string, DeltaBucket>();
const registeredEventTypes = new Set<string>(DOCUMENTED_EVENT_TYPES);
const retryCommandIds = new Map<string, string>();
const closedStreamKeys = new Set<string>();
const finishedAgents = new Map<string, FinishedAgent>();
/**
 * Turns whose cancellation the Broker accepted. They stay non-terminal in the store until
 * the native side settles, but the operator has ended them, so they must stop holding the
 * send button and the activity rail. Otherwise a slow native cancel leaves a spinner and a
 * locked composer on a room the operator already stopped (D-053).
 */
const releasedTurnIds = new Set<string>();
let composerRailSignature = "";

let eventSource: EventSource | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let deltaFlushTimer: number | null = null;
let globalErrorTimer: number | null = null;
let healthTimer: number | null = null;
let unreadCount = 0;
let newWhileScrolledUp = 0;
let lastTimelineDate = "";
let trimmedItemCount = 0;
let trimNoticeNode: HTMLLIElement | null = null;
let runtimeProgressHideTimer: number | null = null;
let contextUsageRefreshTimer: number | null = null;
let contextUsageRefreshInFlight = false;
let contextCompacting = false;
let latestContextUsage: ContextUsageView | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readStringField(record: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function readNumberField(record: JsonRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readBooleanField(record: JsonRecord, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return fallback;
}

function normalizeContextUsage(value: unknown): ContextUsageView | null {
  if (!isRecord(value)) return null;
  const roomId = readStringField(value, "roomId");
  const throughSeq = readNumberField(value, "throughSeq");
  const estimatedCharacters = readNumberField(value, "estimatedCharacters");
  const maxCharacters = readNumberField(value, "maxCharacters");
  const compactionTriggerCharacters = readNumberField(value, "compactionTriggerCharacters");
  const utilizationPercent = readNumberField(value, "utilizationPercent");
  const uncompactedMessageCount = readNumberField(value, "uncompactedMessageCount");
  const summaryThroughSeq = readNumberField(value, "summaryThroughSeq");
  if (
    !roomId ||
    throughSeq === null ||
    estimatedCharacters === null ||
    maxCharacters === null ||
    maxCharacters <= 0 ||
    compactionTriggerCharacters === null ||
    utilizationPercent === null ||
    uncompactedMessageCount === null
  ) {
    return null;
  }
  return {
    roomId,
    throughSeq,
    estimatedCharacters,
    maxCharacters,
    compactionTriggerCharacters,
    utilizationPercent: Math.min(100, Math.max(0, Math.round(utilizationPercent))),
    uncompactedMessageCount,
    summaryThroughSeq,
    compactable: readBooleanField(value, false, "compactable")
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeStringify(value: unknown, maxLength = 4_000): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length <= maxLength) {
    return rendered;
  }
  return `${rendered.slice(0, maxLength)}\n…`;
}

function makeClientCommandId(prefix: string): string {
  const random = globalThis.crypto.randomUUID();
  return `${prefix}-${random}`;
}

function retryableCommandId(key: string, prefix: string): string {
  const existing = retryCommandIds.get(key);
  if (existing) {
    return existing;
  }
  const created = makeClientCommandId(prefix);
  retryCommandIds.set(key, created);
  return created;
}

function actorKind(value: unknown): ActorKind {
  return value === "user" || value === "agent" || value === "system" ? value : "system";
}

function normalizeActor(value: unknown): ActorRef {
  if (!isRecord(value)) {
    return {
      actorId: "system:unknown",
      kind: "system",
      instanceId: null,
      displayName: "Envelope actor 缺失",
    };
  }
  const actorId = readStringField(value, "actorId");
  const instanceIdValue = value.instanceId;
  return {
    actorId: actorId || "system:unknown",
    kind: actorKind(value.kind),
    instanceId: typeof instanceIdValue === "string" ? instanceIdValue : null,
    displayName: readStringField(value, "displayName") || actorId || "未知来源",
  };
}

function normalizeEnvelope(value: unknown): AIChatLinkEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }
  const eventId = readStringField(value, "eventId");
  const type = readStringField(value, "type");
  if (!eventId || !type) {
    return null;
  }
  const seqValue = value.seq;
  const seq = typeof seqValue === "number" && Number.isSafeInteger(seqValue) && seqValue >= 0 ? seqValue : null;
  const to = asArray(value.to).filter((entry): entry is string => typeof entry === "string");
  const durabilityValue = value.durability;
  const durability = durabilityValue === "transient" ? "transient" : "durable";
  return {
    schema: readStringField(value, "schema") || "aichatlink.event/unknown",
    eventId,
    seq,
    roomId: readStringField(value, "roomId") || state.roomId,
    type,
    actor: normalizeActor(value.actor),
    to,
    replyToEventId: typeof value.replyToEventId === "string" ? value.replyToEventId : null,
    causationId: typeof value.causationId === "string" ? value.causationId : null,
    correlationId: readStringField(value, "correlationId") || eventId,
    occurredAt: readStringField(value, "occurredAt"),
    durability,
    body: value.body,
  };
}

function normalizeCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(([, enabled]) => enabled === true || enabled === "verified" || enabled === "supported")
    .map(([name]) => name);
}

function normalizeAgent(value: unknown): AgentView | null {
  if (!isRecord(value)) {
    return null;
  }
  const actorRecord = isRecord(value.actor) ? value.actor : null;
  const actorId = readStringField(value, "actorId") || (actorRecord ? readStringField(actorRecord, "actorId") : "");
  if (!actorId) {
    return null;
  }
  const displayName =
    readStringField(value, "displayName", "name") ||
    (actorRecord ? readStringField(actorRecord, "displayName") : "") ||
    actorId;
  const capabilityRecord = isRecord(value.capabilities) ? value.capabilities : null;
  const order =
    typeof value.order === "number" && Number.isFinite(value.order) ? value.order : undefined;
  return {
    actorId,
    displayName,
    status: readStringField(value, "status", "sessionStatus", "health") || "unknown",
    driver: readStringField(value, "driver"),
    piDriver: capabilityRecord?.piDriver === true,
    cwd: readStringField(value, "cwd", "workingDirectory"),
    enabled: readBooleanField(value, true, "enabled"),
    capabilities: normalizeCapabilities(value.capabilities).filter((name) => name !== "piDriver"),
    ...(order === undefined ? {} : { order })
  };
}

function normalizeTurn(value: unknown): TurnView | null {
  if (!isRecord(value)) {
    return null;
  }
  const turnId = readStringField(value, "turnId", "id");
  if (!turnId) {
    return null;
  }
  const partialText = readStringField(value, "partialText");
  return {
    turnId,
    targetActorId: readStringField(value, "targetActorId", "target"),
    status: readStringField(value, "status") || "queued",
    correlationId: readStringField(value, "correlationId", "rootCorrelationId"),
    error: readStringField(value, "error", "errorCode", "message"),
    ...(partialText.length === 0 ? {} : { partialText }),
    ...(readBooleanField(value, false, "partialTextTruncated")
      ? { partialTextTruncated: true }
      : {})
  };
}

function normalizeRecord(value: unknown, identity: boolean): RecordView | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = identity
    ? readStringField(value, "identityId", "id", "eventId")
    : readStringField(value, "memoryId", "id", "eventId");
  const content = readStringField(value, "content", "text");
  if (!id || !content) {
    return null;
  }
  const scope = isRecord(value.scope) ? value.scope : {};
  const scopeType =
    readStringField(scope, "type") ||
    readStringField(value, "scopeType") ||
    (identity ? "agent" : "room");
  const scopeId = readStringField(scope, "id") || readStringField(value, "scopeId");
  return {
    id,
    scopeType:
      scopeType === "agent" || scopeType === "global" ? scopeType : "room",
    scopeId,
    kind: readStringField(value, "kind") || "note",
    content,
    authorActorId: readStringField(value, "authorActorId", "author") || "user:web",
    subjectActorId: readStringField(value, "subjectActorId", "subject"),
    createdAt: readStringField(value, "createdAt", "occurredAt"),
    status: readStringField(value, "status") || "active",
  };
}

const DYNAMIC_TONE_COUNT = 6;

function actorToneClass(actorId: string): string {
  if (actorId.startsWith("agent:codex")) {
    return "actor-codex";
  }
  if (actorId.startsWith("agent:grok")) {
    return "actor-grok";
  }
  if (actorId.startsWith("agent:kimi")) {
    return "actor-kimi";
  }
  if (actorId.startsWith("agent:hermes")) {
    return "actor-hermes";
  }
  if (actorId.startsWith("agent:claude")) {
    return "actor-claude";
  }
  if (actorId.startsWith("user:")) {
    return "actor-user";
  }
  if (actorId.startsWith("agent:")) {
    let hash = 0;
    for (const char of actorId) {
      hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
    }
    return `actor-dynamic-${hash % DYNAMIC_TONE_COUNT}`;
  }
  return "actor-system";
}

function actorInitial(actor: ActorRef): string {
  const label = actor.displayName || actor.actorId;
  return label.slice(0, 2).toUpperCase();
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatTime(value: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const sameDay = localDateKey(date) === localDateKey(new Date());
  return new Intl.DateTimeFormat(
    "zh-CN",
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}

function formatFullTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function dateDividerLabel(date: Date): string {
  const now = new Date();
  const key = localDateKey(date);
  if (key === localDateKey(now)) {
    return "今天";
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === localDateKey(yesterday)) {
    return "昨天";
  }
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`;
}

const DRIVER_LABELS: Record<string, string> = {
  codex: "Codex App Server",
  claude: "Claude Code",
  grok: "Grok ACP",
  pi: "pi RPC",
  workbuddy: "WorkBuddy",
  kimi: "Kimi ACP (legacy)",
  hermes: "Hermes ACP (legacy)"
};

function driverLabel(driver: string, piDriver = false): string {
  const base = DRIVER_LABELS[driver] ?? (driver || "driver 未报告");
  // The legacy shim reports driver "claude"; a native pi agent already says pi.
  return piDriver && driver !== "pi" ? `${base} · pi` : base;
}

function humanStatus(status: string): string {
  const names: Record<string, string> = {
    unknown: "状态未知",
    starting: "正在启动",
    retrying: "正在重试",
    ready: "已就绪",
    resumed: "已恢复",
    online: "在线",
    offline: "离线",
    restarting: "正在重启",
    pending_restart: "等待重启",
    stopped: "已停止",
    failed: "失败",
    queued: "排队中",
    dispatched: "已派发",
    dispatching: "派发中",
    running: "运行中",
    streaming: "回复中",
    cancel_requested: "正在取消",
    cancelling: "正在取消",
    completed: "已完成",
    cancelled: "已取消",
    interrupted: "已中断",
    error: "错误",
    native_policy_blocked: "原生策略阻止",
  };
  return names[status] ?? status;
}

function humanCapability(capability: string): string {
  const names: Record<string, string> = {
    currentTurnMcp: "回合内 MCP",
    loadSession: "会话恢复",
    semanticCancel: "语义取消",
    streaming: "流式输出",
  };
  return names[capability] ?? capability.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}

function setConnection(next: ConnectionState, detail = ""): void {
  state.connection = next;
  const labels: Record<ConnectionState, string> = {
    bootstrapping: "正在载入",
    connecting: "正在连接",
    live: "实时连接",
    reconnecting: "正在重连",
    offline: "连接离线",
  };
  const label = detail ? `${labels[next]} · ${detail}` : labels[next];
  connectionDot.dataset.state = next;
  connectionDot.title = label;
  connectionDot.setAttribute("aria-label", label);
}

function showGlobalError(message: string): void {
  globalError.textContent = message;
  globalError.hidden = false;
  if (globalErrorTimer !== null) {
    window.clearTimeout(globalErrorTimer);
  }
  globalErrorTimer = window.setTimeout(() => {
    globalError.hidden = true;
    globalError.textContent = "";
    globalErrorTimer = null;
  }, 8_000);
}

const DELIVERY_ACK_STATUS = "已接受，等待 Agent 事件";
const BUSY_SEND_STATUS = "Agent 仍在工作；本轮结束后才能发送";
/**
 * The delivery acknowledgement is the only status that outlives its own call:
 * it waits for the first turn/message event of that submission and then clears
 * itself. Every other status is either an error (stays until the input changes)
 * or in-flight feedback that the caller overwrites.
 */
let deliveryAcknowledgementPending = false;

function setComposerStatus(message: string, error = false): void {
  composerStatus.textContent = message;
  composerStatus.classList.toggle("is-error", error);
  deliveryAcknowledgementPending = !error && message === DELIVERY_ACK_STATUS;
}

/** Whether every accepted turn already produced a live event in this view. */
function acceptedTurnsSeen(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.turns) || payload.turns.length === 0) return false;
  return payload.turns.every(
    (turn) => isRecord(turn) && state.turns.has(readStringField(turn, "turnId"))
  );
}

/** True once the room answers the submission we just got a 202 for. */
function answersDeliveryAcknowledgement(envelope: AIChatLinkEnvelope): boolean {
  if (envelope.type.startsWith("turn.")) return true;
  return envelope.type === "message.created" && envelope.actor.kind !== "user";
}

/**
 * One "design pixel" in device-independent CSS px. The stylesheet scales the
 * whole shell from the root font size (see tokens.css `--px`), so any geometry
 * the browser computes in JavaScript has to use the same multiplier or it would
 * keep the input at laptop height on a 27" screen.
 */
function designPx(value: number): number {
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Math.round(value * ((Number.isFinite(root) ? root : 16) / 16));
}

function autoresizeComposer(): void {
  const cap = designPx(180);
  messageInput.style.height = "auto";
  const next = Math.min(messageInput.scrollHeight, cap);
  messageInput.style.height = `${next}px`;
  messageInput.style.overflowY = messageInput.scrollHeight > cap ? "auto" : "hidden";
}

function draftScope(): DraftScope {
  return draftScopeFrom(window.location.search);
}

function saveDraft(): void {
  writeDraft(sessionStorage, draftScope(), messageInput.value);
}

function clearDraft(): void {
  writeDraft(sessionStorage, draftScope(), "");
}

function setComposerText(value: string): void {
  messageInput.value = value;
  updateCharacterCount();
  autoresizeComposer();
  syncSendButton();
}

function restoreDraft(): void {
  setComposerText(readDraft(sessionStorage, draftScope()));
}

function updateCharacterCount(): void {
  const length = messageInput.value.length;
  // This is the draft length against limits.messageCharacters. It shares the
  // row with the room context figure, so it leads with 本条 and stays hidden
  // until there is a draft — otherwise "0 / 131072" reads as a second, frozen
  // context number.
  characterCount.hidden = length === 0;
  characterCount.textContent = `本条 ${length} / ${MESSAGE_MAX_LENGTH} 字符`;
  characterCount.classList.toggle(
    "is-warning",
    length > MESSAGE_MAX_LENGTH * 0.9 && length < MESSAGE_MAX_LENGTH
  );
  characterCount.classList.toggle("is-error", length >= MESSAGE_MAX_LENGTH);
}

type JsonRequestInit = RequestInit & { workspace?: boolean };

async function requestJson<T>(path: string, options: JsonRequestInit = {}): Promise<T> {
  const { workspace = true, ...init } = options;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(workspace ? withWorkspace(path) : path, {
    ...init,
    headers,
  });
  const text = await response.text();
  let decoded: unknown = null;
  if (text) {
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      decoded = null;
    }
  }
  if (!response.ok) {
    const errorRecord = isRecord(decoded) && isRecord(decoded.error) ? decoded.error : null;
    const code = errorRecord ? readStringField(errorRecord, "code") : "HTTP_ERROR";
    const message = errorRecord ? readStringField(errorRecord, "message") : "";
    throw new ApiFailure(code || "HTTP_ERROR", message || `请求失败（HTTP ${response.status}）`, response.status);
  }
  return decoded as T;
}

function renderContextUsage(usage: ContextUsageView | null): void {
  latestContextUsage = usage;
  if (!usage) {
    contextUsageValue.textContent = "暂不可用";
    contextUsageFill.style.width = "0%";
    contextUsage.dataset.level = "normal";
    compactContextButton.disabled = true;
    return;
  }
  contextUsageValue.textContent = `约 ${formatCharacterEstimate(usage.estimatedCharacters)} / ${formatCharacterEstimate(usage.maxCharacters)} 字符`;
  contextUsageFill.style.width = `${usage.utilizationPercent}%`;
  contextUsage.dataset.level =
    usage.utilizationPercent >= 95
      ? "critical"
      : usage.utilizationPercent >= 75
        ? "warning"
        : "normal";
  contextUsage.title = [
    `AIChatLink 房间上下文估算：${Math.round(usage.estimatedCharacters).toLocaleString()} / ${Math.round(usage.maxCharacters).toLocaleString()} 字符`,
    `自动压缩软阈值：${Math.round(usage.compactionTriggerCharacters).toLocaleString()} 字符`,
    "这不是模型 token 数；目标 Agent 的身份、记忆和原生 instructions 会另占空间。"
  ].join("\n");
  compactContextButton.disabled = contextCompacting || !usage.compactable;
  compactContextButton.title = usage.compactable
    ? "把较早消息滚动整理为摘要；完整聊天记录仍保留"
    : "近期未压缩消息较少，当前无需手动压缩";
}

async function refreshContextUsage(): Promise<void> {
  if (contextUsageRefreshInFlight) return;
  contextUsageRefreshInFlight = true;
  try {
    const decoded = await requestJson<unknown>("/api/context");
    const usage = normalizeContextUsage(decoded);
    if (!usage) throw new ApiFailure("INVALID_CONTEXT_USAGE", "上下文用量响应无效", 500);
    renderContextUsage(usage);
  } catch (error) {
    renderContextUsage(null);
    if (!(error instanceof ApiFailure) || error.status !== 404) {
      contextUsage.title = errorMessage(error);
    }
  } finally {
    contextUsageRefreshInFlight = false;
  }
}

function scheduleContextUsageRefresh(delayMs = 120): void {
  if (contextUsageRefreshTimer !== null) {
    window.clearTimeout(contextUsageRefreshTimer);
  }
  contextUsageRefreshTimer = window.setTimeout(() => {
    contextUsageRefreshTimer = null;
    void refreshContextUsage();
  }, delayMs);
}

async function compactCurrentContext(): Promise<void> {
  if (contextCompacting || !latestContextUsage?.compactable) return;
  if (runtimeProgressHideTimer !== null) {
    window.clearTimeout(runtimeProgressHideTimer);
    runtimeProgressHideTimer = null;
  }
  contextCompacting = true;
  compactContextButton.disabled = true;
  compactContextButton.textContent = "压缩中…";
  compactContextButton.setAttribute("aria-busy", "true");
  runtimeProgress.hidden = false;
  runtimeProgress.dataset.phase = "started";
  runtimeProgressTitle.textContent = "正在请求压缩会话";
  runtimeProgressDetail.textContent = "较早消息会整理为摘要，完整记录不会删除";
  runtimeProgressAttempt.textContent = "手动";
  const retryKey = `context-compact:${state.roomId}`;
  try {
    const decoded = await requestJson<unknown>("/api/context/compact", {
      method: "POST",
      body: JSON.stringify({
        clientCommandId: retryableCommandId(retryKey, "web-context-compact")
      })
    });
    if (!isRecord(decoded)) {
      throw new ApiFailure("INVALID_CONTEXT_RESULT", "压缩响应无效", 500);
    }
    const usage = normalizeContextUsage(decoded.usage);
    if (!usage) throw new ApiFailure("INVALID_CONTEXT_USAGE", "压缩后的用量响应无效", 500);
    retryCommandIds.delete(retryKey);
    renderContextUsage(usage);
    if (!readBooleanField(decoded, false, "compacted")) {
      runtimeProgress.dataset.phase = "completed";
      runtimeProgressTitle.textContent = "当前无需压缩";
      runtimeProgressDetail.textContent = "近期消息会继续保留原文";
      runtimeProgressAttempt.textContent = "";
      runtimeProgressHideTimer = window.setTimeout(() => {
        runtimeProgress.hidden = true;
      }, 3_000);
    } else if (runtimeProgress.dataset.phase !== "completed") {
      runtimeProgress.dataset.phase = "completed";
      runtimeProgressTitle.textContent = "房间上下文已压缩";
      runtimeProgressDetail.textContent = "较早消息已整理为摘要，近期消息仍保留原文";
      runtimeProgressAttempt.textContent = "";
      runtimeProgressHideTimer = window.setTimeout(() => {
        runtimeProgress.hidden = true;
      }, 4_000);
    }
  } catch (error) {
    runtimeProgress.dataset.phase = "failed";
    runtimeProgressTitle.textContent = "会话压缩失败";
    runtimeProgressDetail.textContent = `${errorMessage(error)} · 原聊天记录未丢失`;
    runtimeProgressAttempt.textContent = "";
    showGlobalError(errorMessage(error));
  } finally {
    contextCompacting = false;
    compactContextButton.textContent = "压缩会话";
    compactContextButton.removeAttribute("aria-busy");
    renderContextUsage(latestContextUsage);
  }
}

function createActorAvatar(actor: ActorRef): HTMLSpanElement {
  const avatar = document.createElement("span");
  avatar.className = `actor-avatar ${actorToneClass(actor.actorId)}`;
  avatar.textContent = actorInitial(actor);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function createActorMeta(envelope: AIChatLinkEnvelope): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "event-meta";
  wrapper.title = envelope.actor.actorId;

  const name = document.createElement("span");
  name.className = "actor-name";
  name.textContent = envelope.actor.displayName;

  const actorId = document.createElement("span");
  actorId.className = "actor-id";
  actorId.textContent = envelope.actor.actorId;

  const time = document.createElement("time");
  time.className = "event-time";
  time.dateTime = envelope.occurredAt;
  time.textContent = formatTime(envelope.occurredAt);
  time.title = formatFullTime(envelope.occurredAt);

  wrapper.append(name, actorId, time);
  return wrapper;
}

const LATEST_FOLLOW_NEAR_PX = 120;

function createLatestFollower(
  scroller: HTMLElement,
  options: { onResume?: () => void } = {}
) {
  let paused = false;
  let ignoreScrollUntil = 0;

  function now(): number {
    return Date.now();
  }

  function isNearBottom(): boolean {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < LATEST_FOLLOW_NEAR_PX;
  }

  function isPaused(): boolean {
    return paused;
  }

  function markProgrammatic(): void {
    ignoreScrollUntil = now() + 120;
  }

  function scrollToLatest(smooth = false): void {
    markProgrammatic();
    const top = scroller.scrollHeight;
    if (smooth) {
      scroller.scrollTo({ top, behavior: "smooth" });
      return;
    }
    // `.timeline` sets `scroll-behavior: smooth`; letting growth following run
    // through it would animate on every streamed chunk and fall behind content.
    const previousBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = "auto";
    scroller.scrollTop = top;
    scroller.style.scrollBehavior = previousBehavior;
  }

  function resume(scroll = true): void {
    paused = false;
    options.onResume?.();
    if (scroll) scrollToLatest(false);
  }

  /**
   * Reading wins over streaming: once the reader scrolls, selects, or points
   * into the transcript, following stops until they resume it themselves.
   */
  function pause(): void {
    paused = true;
  }

  function followIfAllowed(): boolean {
    if (paused) return false;
    scrollToLatest(false);
    return true;
  }

  function restorePinnedFromBottom(fromBottom: number): void {
    markProgrammatic();
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - fromBottom);
  }

  function onUserOperation(): void {
    pause();
  }

  scroller.addEventListener("wheel", onUserOperation, { passive: true });
  scroller.addEventListener("touchstart", onUserOperation, { passive: true });
  scroller.addEventListener("pointerdown", onUserOperation);
  scroller.addEventListener("keydown", (event) => {
    if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "PageUp" ||
      event.key === "PageDown" ||
      event.key === "Home" ||
      event.key === "End" ||
      event.key === " "
    ) {
      onUserOperation();
    }
  });
  // Deliberately no "scrolled back to the bottom -> resume" handler. With
  // several panes, a delayed programmatic scroll event (from followIfAllowed)
  // can arrive after the reader paused a pane and silently re-enable follow;
  // measured on the 4-pane grid. Reading only resumes through the pane's arrow
  // or by sending a message.

  return {
    isNearBottom,
    isPaused,
    markProgrammatic,
    scrollToLatest,
    followIfAllowed,
    restorePinnedFromBottom,
    pause,
    resume
  };
}

/**
 * Text deltas and tool progress grow the card that is already on screen, so no
 * new timeline item is appended and nothing would re-follow the bottom. Watch
 * the subtree and coalesce bursts into one frame.
 */
function observeTimelineGrowth(target: HTMLElement, onChange: () => void): void {
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      onChange();
    });
  });
  observer.observe(target, { childList: true, subtree: true, characterData: true });
}

function resetJumpLatest(): void {
  newWhileScrolledUp = 0;
  jumpLatestCount.textContent = "";
  jumpLatestCount.hidden = true;
  jumpLatest.title = "回到最新进度";
  jumpLatest.hidden = true;
}

function noteJumpLatest(countsAsNew: boolean): void {
  if (countsAsNew) {
    newWhileScrolledUp += 1;
    jumpLatestCount.textContent = newWhileScrolledUp > 99 ? "99+" : String(newWhileScrolledUp);
    jumpLatestCount.hidden = false;
    jumpLatest.title = `回到最新进度 · ${newWhileScrolledUp} 条新消息`;
  }
  jumpLatest.hidden = false;
}

/** Assigned by usePaneContext(); the primary pane owns the legacy follower. */
let roomFollow: ReturnType<typeof createLatestFollower>;
const assistantFollow = createLatestFollower(assistantTimeline);

const conversationPanel = document.querySelector<HTMLElement>(".conversation-panel");

/**
 * Float the button just above the composer dock's right edge: the composer height
 * varies with the reply strip and progress card, and the column narrows when
 * the assistant drawer takes its own grid column. The dock, not the card, owns
 * the right edge now that the agent rail sits beside the composer.
 */
function syncJumpLatestGeometry(): void {
  if (!conversationPanel) return;
  const panel = conversationPanel.getBoundingClientRect();
  const box = composerDock.getBoundingClientRect();
  if (box.height <= 0) return;
  conversationPanel.style.setProperty(
    "--jump-latest-bottom",
    `${Math.max(designPx(12), Math.round(panel.bottom - box.top + designPx(12)))}px`
  );
  conversationPanel.style.setProperty(
    "--jump-latest-right",
    `${Math.max(designPx(12), Math.round(panel.right - box.right + designPx(12)))}px`
  );
}

/**
 * One clearance per pane: the stack parks just above the composer when the pane
 * runs under it, and at its own bottom edge when the pane ends higher up. That
 * keeps a short top-row lane from floating its controls mid-air, and keeps a
 * bottom-row lane clear of the dock.
 */
function syncPaneActionGeometry(): void {
  if (!conversationPanel) return;
  const dock = composerDock.getBoundingClientRect();
  if (dock.height <= 0) return;
  const dockTop = dock.top;
  const inset = designPx(12);
  for (const pane of panes) {
    const box = pane.shell.section.getBoundingClientRect();
    if (box.height <= 0) continue;
    const clearance = Math.round(box.bottom - dockTop + inset);
    const bottom = Math.max(inset, Math.min(clearance, Math.round(box.height - inset)));
    pane.shell.toc.stack.style.setProperty("--jump-latest-bottom", `${bottom}px`);
  }
}

const jumpGeometryObserver =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(() => {
        syncJumpLatestGeometry();
        syncPaneActionGeometry();
      });
jumpGeometryObserver?.observe(composerDock);
window.addEventListener("resize", () => {
  syncJumpLatestGeometry();
  syncPaneActionGeometry();
});

observeTimelineGrowth(assistantTimeline, () => {
  if (!assistantFollow.isPaused()) assistantFollow.followIfAllowed();
});

function cleanupRemovedItem(node: Element): void {
  const card = node.querySelector<HTMLElement>("[data-event-id], [data-turn-id], [data-stream-key]");
  if (!card) {
    return;
  }
  const { eventId, turnId, streamKey } = card.dataset;
  if (eventId) {
    eventNodes.delete(eventId);
  }
  if (turnId) {
    turnNodes.delete(turnId);
  }
  if (streamKey) {
    streamNodes.delete(streamKey);
  }
  for (const progress of node.querySelectorAll<HTMLElement>("[data-tool-progress-key]")) {
    const key = progress.dataset.toolProgressKey;
    if (key) {
      toolProgressNodes.delete(key);
    }
  }
}

function trimTimelineIfNeeded(): void {
  const overflow = timeline.children.length - TIMELINE_MAX_ITEMS;
  if (overflow <= 0) {
    return;
  }
  const target = overflow + TIMELINE_TRIM_BATCH;
  let removed = 0;
  let node = timeline.firstElementChild;
  while (removed < target && node) {
    if (node === timelineEmpty) {
      break;
    }
    const next = node.nextElementSibling;
    if (node !== trimNoticeNode) {
      cleanupRemovedItem(node);
      node.remove();
      removed += 1;
    }
    node = next;
  }
  if (removed === 0) {
    return;
  }
  trimmedItemCount += removed;
  if (!trimNoticeNode) {
    trimNoticeNode = document.createElement("li");
    trimNoticeNode.className = "trim-notice";
    timeline.prepend(trimNoticeNode);
  }
  trimNoticeNode.textContent = `已收起 ${trimmedItemCount} 条较早消息`;
  if (activePane?.tocOpen === true) renderConversationToc(activePane);
}

function appendTimeline(node: HTMLLIElement, countsAsNew = true): void {
  const shouldFollow = !roomFollow.isPaused() || timeline.children.length <= 1;
  if (timelineEmpty.isConnected) {
    timelineEmpty.remove();
  }
  timeline.append(node);
  if (shouldFollow) {
    roomFollow.followIfAllowed();
    resetJumpLatest();
  } else {
    noteJumpLatest(countsAsNew);
  }
  trimTimelineIfNeeded();
}

function maybeInsertDateDivider(occurredAt: string): void {
  if (!occurredAt) {
    return;
  }
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return;
  }
  const key = localDateKey(date);
  if (key === lastTimelineDate) {
    return;
  }
  lastTimelineDate = key;
  const item = document.createElement("li");
  item.className = "date-divider";
  const label = document.createElement("span");
  label.textContent = dateDividerLabel(date);
  item.append(label);
  appendTimeline(item, false);
}

function messageContent(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (!isRecord(body)) {
    return safeStringify(body);
  }
  const direct = readStringField(body, "content", "text");
  if (direct) {
    return direct;
  }
  if (isRecord(body.message)) {
    const nested = readStringField(body.message, "content", "text");
    if (nested) {
      return nested;
    }
  }
  return safeStringify(body);
}

function turnIdFromBody(body: unknown): string {
  return isRecord(body) ? readStringField(body, "turnId", "id") : "";
}

function streamKey(envelope: AIChatLinkEnvelope, mode: "content" | "reasoning" = "content"): string {
  const turnId = turnIdFromBody(envelope.body);
  const base = turnId ? `turn:${turnId}` : `correlation:${envelope.correlationId}:actor:${envelope.actor.actorId}`;
  return mode === "reasoning" ? `${base}:reasoning` : base;
}

function replyPreview(eventId: string): string {
  const referenced = state.messages.get(eventId);
  if (!referenced) {
    return eventId;
  }
  const preview = messageContent(referenced.body).replace(/\s+/g, " ").trim();
  const clipped = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
  return `${referenced.actor.displayName}: ${clipped}`;
}

function setReply(eventId: string): void {
  state.replyToEventId = eventId;
  state.pendingSubmission = null;
  replyDescription.textContent = replyPreview(eventId);
  replyContext.hidden = false;
  messageInput.focus();
}

function clearReply(): void {
  state.replyToEventId = null;
  state.pendingSubmission = null;
  replyDescription.textContent = "";
  replyContext.hidden = true;
}

function cardToneClass(actorId: string): string {
  return actorToneClass(actorId).replace("actor-", "tone-");
}

function isSupervisionWatchBody(body: unknown): boolean {
  return isRecord(body) && body.kind === "supervision.watch";
}

function renderMessage(envelope: AIChatLinkEnvelope): void {
  if (eventNodes.has(envelope.eventId)) {
    return;
  }
  // A click handler must jump inside the pane that drew this card, not whichever
  // pane happened to be active when the user clicked.
  const ownerPane = activePane;
  if (isSupervisionWatchBody(envelope.body)) {
    return;
  }
  const key = streamKey(envelope);
  closedStreamKeys.add(key);
  closedStreamKeys.add(`${key}:reasoning`);
  deltaBuckets.delete(key);
  deltaBuckets.delete(`${key}:reasoning`);
  const existingArticle = streamNodes.get(key);
  let item: HTMLLIElement;
  let article: HTMLElement;
  if (existingArticle && existingArticle.parentElement instanceof HTMLLIElement) {
    article = existingArticle;
    item = existingArticle.parentElement;
    const retainedToolProgress = article.querySelector<HTMLElement>(".tool-progress-list");
    article.replaceChildren();
    streamNodes.delete(key);
    state.transientText.delete(key);
    delete article.dataset.streamKey;
    if (retainedToolProgress) {
      article.dataset.retainedToolProgress = "true";
      article.append(retainedToolProgress);
    }
  } else {
    item = document.createElement("li");
    item.className = "timeline-item";
    article = document.createElement("article");
    item.append(article);
  }

  article.className = `event-card ${cardToneClass(envelope.actor.actorId)}`;
  if (envelope.actor.kind === "user") {
    article.classList.add("actor-user-card");
  }
  article.dataset.eventId = envelope.eventId;

  const body = document.createElement("div");
  body.className = "event-body";
  body.append(createActorMeta(envelope));

  const retainedToolProgress = article.querySelector<HTMLElement>(".tool-progress-list");
  if (retainedToolProgress) {
    retainedToolProgress.remove();
    body.append(retainedToolProgress);
    delete article.dataset.retainedToolProgress;
  }

  if (envelope.replyToEventId) {
    const sourceId = envelope.replyToEventId;
    const reply = document.createElement("div");
    reply.className = "reply-reference is-linked";
    reply.textContent = replyPreview(sourceId);
    reply.setAttribute("role", "button");
    reply.tabIndex = 0;
    const scrollToSource = (): void => jumpToEvent(sourceId, ownerPane ?? undefined);
    reply.addEventListener("click", scrollToSource);
    reply.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        scrollToSource();
      }
    });
    body.append(reply);
  }

  // blocks (lists, tables, code) live here, so this must not be a paragraph
  const content = document.createElement("div");
  content.className = "event-content";
  renderRichContent(content, messageContent(envelope.body));
  body.append(content);

  const actions = document.createElement("div");
  actions.className = "event-actions";
  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.className = "text-button";
  replyButton.textContent = "回复";
  replyButton.addEventListener("click", () => setReply(envelope.eventId));
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "text-button";
  copyButton.textContent = "复制";
  copyButton.addEventListener("click", () => {
    void copyPlainText(messageContent(envelope.body)).then((ok) => {
      flashButtonLabel(copyButton, ok ? "已复制" : "复制失败");
    });
  });
  actions.append(replyButton, copyButton);

  // A lane shows the operator's prompt as one collapsible line: six full copies
  // of a long brief would push every Agent's answer below the fold. Room keeps
  // the original bubble.
  const lanePrompt =
    activePane !== null && activePane.lens.kind === "agent" && envelope.actor.kind === "user";
  if (lanePrompt) {
    const meta = body.querySelector(".event-meta");
    meta?.remove();
    const details = document.createElement("details");
    details.className = "lane-prompt";
    const summary = document.createElement("summary");
    const kicker = document.createElement("span");
    kicker.className = "lane-prompt-kicker";
    kicker.textContent = "你";
    const time = document.createElement("span");
    time.className = "lane-prompt-time";
    time.textContent = formatTime(envelope.occurredAt);
    const excerpt = document.createElement("span");
    excerpt.className = "lane-prompt-excerpt";
    const flat = messageContent(envelope.body).replace(/\s+/gu, " ").trim();
    excerpt.textContent = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat || "（空消息）";
    summary.append(kicker, time, excerpt);
    const wrapper = document.createElement("div");
    wrapper.className = "lane-prompt-body";
    wrapper.append(...Array.from(body.children), actions);
    details.append(summary, wrapper);
    body.append(details);
  } else {
    body.append(actions);
  }
  article.append(createActorAvatar(envelope.actor), body);

  state.messages.set(envelope.eventId, envelope);
  eventNodes.set(envelope.eventId, article);
  if (envelope.actor.kind === "user") {
    syncConversationToc(activePane);
  }
  if (!item.isConnected) {
    maybeInsertDateDivider(envelope.occurredAt);
    appendTimeline(item);
  }
}

/** A live delta supersedes the bootstrap checkpoint of the same Turn. */
function clearTurnPartial(turnId: string): void {
  turnNodes.get(turnId)?.querySelector(".turn-partial")?.remove();
}

function ensureStreamingNode(
  envelope: AIChatLinkEnvelope,
  key: string,
  mode: "content" | "reasoning"
): HTMLElement {
  let article = streamNodes.get(key);
  if (!article) {
    const item = document.createElement("li");
    item.className = "timeline-item";
    article = document.createElement("article");
    article.className = `event-card is-streaming ${cardToneClass(envelope.actor.actorId)}`;
    article.dataset.streamKey = key;

    const body = document.createElement("div");
    body.className = "event-body";
    body.append(createActorMeta(envelope));

    if (mode === "reasoning") {
      const label = document.createElement("div");
      label.className = "reply-reference";
      label.textContent = "推理流";
      body.append(label);
    }

    // blocks (lists, tables, code) live here, so this must not be a paragraph
    const content = document.createElement("div");
    content.className = "event-content";
    content.hidden = true;
    body.append(content);
    article.append(createActorAvatar(envelope.actor), body);
    item.append(article);
    streamNodes.set(key, article);
    // The live stream is now the authoritative view of this Turn's text.
    const streamedTurnId = turnIdFromBody(envelope.body);
    if (streamedTurnId !== "") clearTurnPartial(streamedTurnId);
    maybeInsertDateDivider(envelope.occurredAt);
    appendTimeline(item);
  }
  return article;
}

function updateStreamingNode(bucket: DeltaBucket, text: string): void {
  const article = ensureStreamingNode(bucket.envelope, bucket.key, bucket.mode);
  const content = article.querySelector<HTMLElement>(".event-content");
  if (content) {
    content.hidden = false;
    renderRichContent(content, text);
  }
}

function renderReasoningRecord(envelope: AIChatLinkEnvelope): void {
  if (eventNodes.has(envelope.eventId)) return;
  const record = parseReasoningRecord(envelope.body);
  if (!record) {
    renderGeneric(envelope);
    return;
  }
  const key = `turn:${record.turnId}:reasoning`;
  deltaBuckets.delete(key);
  state.transientText.delete(key);
  closedStreamKeys.add(key);

  const article = ensureStreamingNode(envelope, key, "reasoning");
  article.classList.remove("is-streaming");
  article.dataset.eventId = envelope.eventId;
  article.classList.add("is-reasoning");
  const label = article.querySelector<HTMLElement>(".reply-reference");
  if (label) {
    label.textContent = "推理记录";
    label.setAttribute("role", "button");
    label.tabIndex = 0;
    const toggle = (): void => {
      article.classList.toggle("is-reasoning-open");
    };
    label.addEventListener("click", toggle);
    label.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  }
  const content = article.querySelector<HTMLElement>(".event-content");
  if (content) {
    content.hidden = false;
    renderRichContent(content, record.content);
  }
  eventNodes.set(envelope.eventId, article);
}

function toolProgressList(article: HTMLElement): HTMLElement {
  const existing = article.querySelector<HTMLElement>(".tool-progress-list");
  if (existing) {
    return existing;
  }
  const list = document.createElement("div");
  list.className = "tool-progress-list";
  const content = article.querySelector<HTMLElement>(".event-content");
  content?.before(list);
  return list;
}

function updateToolProgressNode(node: HTMLElement, snapshot: unknown): void {
  const presentation = describeToolProgress(snapshot);
  node.dataset.tone = presentation.tone;
  const label = node.querySelector<HTMLElement>(".tool-progress-label");
  const status = node.querySelector<HTMLElement>(".tool-progress-status");
  const details = node.querySelector<HTMLElement>(".tool-progress-details");
  if (label) label.textContent = presentation.label;
  if (status) status.textContent = presentation.status;
  if (details) details.textContent = safeStringify(snapshot);
}

/** Render one tool call inside its Agent conversation bubble, collapsed by default. */
export function renderToolProgress(envelope: AIChatLinkEnvelope): void {
  if (!isRecord(envelope.body)) {
    renderGeneric(envelope);
    return;
  }
  const turnId = turnIdFromBody(envelope.body);
  if (!turnId) {
    renderGeneric(envelope);
    return;
  }
  const key = `turn:${turnId}`;
  if (closedStreamKeys.has(key)) {
    return;
  }
  const initialPresentation = describeToolProgress(envelope.body);
  const progressKey = `${key}:tool:${initialPresentation.keyPart}`;
  const existing = toolProgressNodes.get(progressKey);
  if (existing) {
    existing.snapshot = mergeToolProgressSnapshot(existing.snapshot, envelope.body);
    updateToolProgressNode(existing.node, existing.snapshot);
    return;
  }

  const article = ensureStreamingNode(envelope, key, "content");
  const list = toolProgressList(article);
  const row = document.createElement("section");
  row.className = "tool-progress";
  row.dataset.toolProgressKey = progressKey;

  const summary = document.createElement("div");
  summary.className = "tool-progress-summary";
  const indicator = document.createElement("span");
  indicator.className = "tool-progress-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "tool-progress-label";
  const status = document.createElement("span");
  status.className = "tool-progress-status";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tool-progress-toggle";
  toggle.textContent = "展开";
  toggle.setAttribute("aria-expanded", "false");

  const details = document.createElement("pre");
  details.className = "tool-progress-details";
  details.hidden = true;
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.textContent = expanded ? "展开" : "收起";
    details.hidden = expanded;
  });

  summary.append(indicator, label, status, toggle);
  row.append(summary, details);
  list.append(row);
  const entry = { node: row, snapshot: envelope.body };
  toolProgressNodes.set(progressKey, entry);
  updateToolProgressNode(row, entry.snapshot);
}

function flushDeltaBuckets(): void {
  deltaFlushTimer = null;
  const ready: Array<{ bucket: DeltaBucket; text: string }> = [];
  for (const bucket of deltaBuckets.values()) {
    let deltaState = state.transientText.get(bucket.key);
    if (!deltaState) {
      deltaState = { text: "", seenChunkIndexes: new Set() };
      state.transientText.set(bucket.key, deltaState);
    }

    const indexed = bucket.pieces
      .filter((piece): piece is DeltaPiece & { chunkIndex: number } => piece.chunkIndex !== null)
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
    const unindexed = bucket.pieces.filter((piece) => piece.chunkIndex === null);

    for (const piece of indexed) {
      if (deltaState.seenChunkIndexes.has(piece.chunkIndex)) {
        continue;
      }
      deltaState.seenChunkIndexes.add(piece.chunkIndex);
      deltaState.text += piece.text;
    }
    for (const piece of unindexed) {
      deltaState.text += piece.text;
    }
    ready.push({ bucket, text: deltaState.text });
  }
  deltaBuckets.clear();

  // Accumulate once (one truth), then project into every pane that owns the turn.
  for (const pane of panes) {
    usePaneContext(pane);
    for (const { bucket, text } of ready) {
      if (!lensAccepts(pane.lens, bucket.envelope, bucket.targetActorId)) {
        continue;
      }
      updateStreamingNode(bucket, text);
    }
  }
  if (panes.length > 0) usePaneContext(panes[0]!);
}

function queueDelta(
  envelope: AIChatLinkEnvelope,
  mode: "content" | "reasoning",
  targetActorId: string | null
): void {
  if (!isRecord(envelope.body)) {
    renderGeneric(envelope);
    return;
  }
  const text = readStringField(envelope.body, "text", "delta", "content");
  if (!text) {
    return;
  }
  const key = streamKey(envelope, mode);
  if (closedStreamKeys.has(key)) {
    return;
  }
  const chunkIndexValue = readNumberField(envelope.body, "chunkIndex", "index");
  const chunkIndex = chunkIndexValue !== null && Number.isSafeInteger(chunkIndexValue) ? chunkIndexValue : null;
  let bucket = deltaBuckets.get(key);
  if (!bucket) {
    bucket = { envelope, key, pieces: [], mode, targetActorId };
    deltaBuckets.set(key, bucket);
  }
  bucket.pieces.push({ chunkIndex, text });
  if (deltaFlushTimer === null) {
    deltaFlushTimer = window.setTimeout(flushDeltaBuckets, DELTA_BATCH_MS);
  }
}

function turnStatusFromType(type: string): string {
  const segment = type.split(".").at(-1) ?? "unknown";
  if (segment === "started") {
    return "running";
  }
  return segment;
}

function finalizeStreamsForTurn(turnId: string, status: string): void {
  if (!TERMINAL_TURN_STATUSES.has(status)) {
    return;
  }
  for (const key of [`turn:${turnId}`, `turn:${turnId}:reasoning`]) {
    closedStreamKeys.add(key);
    deltaBuckets.delete(key);
    const stream = streamNodes.get(key);
    if (!stream) {
      continue;
    }
    stream.classList.remove("is-streaming");
    // A completed turn keeps its streamed text as the answer; only an abnormal
    // ending needs to say the text never became a message.
    if (status === "completed") {
      continue;
    }
    if (!stream.querySelector(".reply-reference")) {
      const label = document.createElement("div");
      label.className = "reply-reference";
      label.textContent = `未完成内容 · ${humanStatus(status)}`;
      // `.event-content` lives inside `.event-body`, so the label must be inserted
      // into its parent instead of the stream card itself.
      const content = stream.querySelector(".event-content");
      const parent = content?.parentElement ?? stream;
      parent.insertBefore(label, content);
    }
  }
}

/**
 * Shared Turn bookkeeping. Runs once per envelope, before pane projection, so a
 * Turn still enters `state.turns` when no pane happens to watch its Agent
 * (otherwise the busy lock and the activity rail would miss it), and so the
 * "just finished" dot can only fire once no matter how many panes paint.
 */
function trackTurnEnvelope(envelope: AIChatLinkEnvelope, live: boolean): void {
  const body = isRecord(envelope.body) ? envelope.body : {};
  const turnId = readStringField(body, "turnId", "id");
  if (!turnId) {
    return;
  }
  const previous = state.turns.get(turnId);
  const status = readStringField(body, "status") || turnStatusFromType(envelope.type);
  // Terminal events carry no targetActorId. Keep the target learned from the
  // queued/started events instead of falling back to the system actor that
  // records an interrupted turn.
  const targetActorId =
    readStringField(body, "targetActorId", "target") ||
    previous?.targetActorId ||
    envelope.to.find((id) => id.startsWith("agent:")) ||
    envelope.to[0] ||
    envelope.actor.actorId;
  const error = readStringField(body, "error", "errorCode", "message");
  state.turns.set(turnId, {
    turnId,
    targetActorId,
    status,
    correlationId: envelope.correlationId,
    error,
    // A later lifecycle frame (dispatched/streaming) must not erase the
    // checkpoint a reloaded page is using to show what this Turn already wrote.
    ...(previous?.partialText === undefined ? {} : { partialText: previous.partialText }),
    ...(previous?.partialTextTruncated === true ? { partialTextTruncated: true } : {})
  });
  if (
    live &&
    previous !== undefined &&
    targetActorId.startsWith("agent:") &&
    isFinishedTransition(previous.status, status)
  ) {
    finishedAgents.set(targetActorId, { status, turnId });
    announceAgentActivity(targetActorId, status);
  }
  // The rail and the busy lock read `state.turns`, so they are projected here —
  // in the shared bookkeeping — and not from `renderTurn()`. A pane whose lens
  // rejects this Agent never paints the Turn, and a rail that only updated while
  // painting would silently stop spinning for exactly those Agents.
  syncAgentActivity();
  if (TERMINAL_TURN_STATUSES.has(status)) {
    releasedTurnIds.delete(turnId);
    // A Turn that no pane watches must not keep accumulating delta buffers.
    for (const key of [`turn:${turnId}`, `turn:${turnId}:reasoning`]) {
      closedStreamKeys.add(key);
      deltaBuckets.delete(key);
    }
  }
}

function renderTurn(turn: TurnView, options: RenderTurnOptions = {}): void {
  if (options.seedOnly === true) {
    // The POST snapshot may arrive before the user's own message does. Seed the
    // lock into state without painting a card, so SSE still controls DOM order;
    // the turn.queued frame creates the card right after message.created.
    if (!state.turns.has(turn.turnId)) {
      state.turns.set(turn.turnId, turn);
      syncAgentActivity();
    }
    return;
  }
  state.turns.set(turn.turnId, turn);
  finalizeStreamsForTurn(turn.turnId, turn.status);
  let article = turnNodes.get(turn.turnId);
  let item: HTMLLIElement | null = null;
  if (!article) {
    item = document.createElement("li");
    item.className = "timeline-item";
    article = document.createElement("article");
    article.className = "turn-card";
    item.append(article);
    turnNodes.set(turn.turnId, article);
  }
  article.replaceChildren();
  article.dataset.turnId = turn.turnId;
  article.dataset.status = turn.status;

  const header = document.createElement("div");
  header.className = "turn-card-header";
  const status = document.createElement("span");
  status.className = "turn-state";
  const targetLabel = (state.agents.get(turn.targetActorId)?.displayName ?? turn.targetActorId) || "Agent";
  status.textContent = `${targetLabel} · ${humanStatus(turn.status)}`;
  header.append(status);

  if (!TERMINAL_TURN_STATUSES.has(turn.status) && turn.status !== "cancel_requested") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel-button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      void cancelTurn(turn.turnId);
    });
    header.append(cancel);
  }
  article.append(header);

  if (turn.error) {
    const error = document.createElement("p");
    error.className = "turn-error";
    error.textContent = turn.error;
    article.append(error);
  }
  // A reloaded page gets the checkpointed text instead of an empty "running"
  // card. The live delta stream supersedes it once it arrives (see
  // clearTurnPartial), so this never doubles the answer.
  if (
    turn.partialText !== undefined &&
    !TERMINAL_TURN_STATUSES.has(turn.status) &&
    !streamNodes.has(`turn:${turn.turnId}`)
  ) {
    const partial = document.createElement("div");
    partial.className = "turn-partial";
    const note = document.createElement("p");
    note.className = "turn-partial-note";
    note.textContent = turn.partialTextTruncated
      ? "已产出（前段省略）· 仍在运行"
      : "已产出 · 仍在运行";
    const body = document.createElement("div");
    body.className = "event-content";
    renderRichContent(body, turn.partialText);
    partial.append(note, body);
    article.append(partial);
  }
  if (item) {
    appendTimeline(item);
  }
  syncAgentActivity();
}

function renderTurnEnvelope(envelope: AIChatLinkEnvelope): void {
  const body = isRecord(envelope.body) ? envelope.body : {};
  const turnId = readStringField(body, "turnId", "id");
  if (!turnId) {
    renderGeneric(envelope);
    return;
  }
  // trackTurnEnvelope() already wrote the resolved target/status; painting must
  // not recompute it from the current event alone.
  const tracked = state.turns.get(turnId);
  if (tracked !== undefined) {
    renderTurn(tracked);
    return;
  }
  const status = readStringField(body, "status") || turnStatusFromType(envelope.type);
  const targetActorId =
    readStringField(body, "targetActorId", "target") ||
    envelope.to.find((id) => id.startsWith("agent:")) ||
    envelope.to[0] ||
    envelope.actor.actorId;
  renderTurn({
    turnId,
    targetActorId,
    status,
    correlationId: envelope.correlationId,
    error: readStringField(body, "error", "errorCode", "message")
  });
}

/**
 * Ask the Broker to cancel one Turn. Returns the failure instead of reporting it,
 * because the bulk stop path has to fold N failures into one status line rather
 * than stack N global error banners (D-050).
 */
async function requestTurnCancel(turnId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const turn = state.turns.get(turnId);
  if (!turn || TERMINAL_TURN_STATUSES.has(turn.status) || turn.status === "cancel_requested") {
    return { ok: true };
  }
  const retryKey = `cancel:${turnId}`;
  renderTurn({ ...turn, status: "cancel_requested" });
  try {
    await requestJson<unknown>(`/api/turns/${encodeURIComponent(turnId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ clientCommandId: retryableCommandId(retryKey, "web-cancel") }),
    });
    retryCommandIds.delete(retryKey);
    // Accepted: the Broker will enforce the stop. The Turn may stay
    // `cancel_requested` until the native side settles, so release the composer
    // and the rail now instead of spinning on a stop the operator already gave.
    releasedTurnIds.add(turnId);
    return { ok: true };
  } catch (error) {
    renderTurn(turn);
    return { ok: false, message: errorMessage(error) };
  }
}

async function cancelTurn(turnId: string): Promise<void> {
  const result = await requestTurnCancel(turnId);
  if (!result.ok) showGlobalError(result.message);
}

/**
 * The busy send button. One click asks every in-flight Turn to stop, which is
 * the operator's "end this task now" — not a second approval layer and not a
 * rollback: each Turn still terminates through its own native cancel and the
 * Broker's own lifecycle. Turns already asked are skipped by
 * cancellableTurnIds().
 */
let stopInFlight = false;
const STOP_ACK_STATUS = "已请求终止本轮所有 Agent，等待收尾";
/** Re-clicking a stop whose Turns are all `cancel_requested` says this instead. */
const STOP_RETRY_STATUS = "已请求终止，等待 Agent 收尾";
/** Stopping is a correction loop: the prompt comes back so it can be amended. */
const STOP_RESUME_STATUS = "已终止；原任务已放回输入框，补充后可直接发送";
const STOP_KEPT_DRAFT_STATUS = "已终止；你的草稿已保留";

/** The operator's own prompts in the open epoch, oldest first. */
function userMessagesInView(): { eventId: string; correlationId: string; content: string }[] {
  const epochStart = activeEpochStartSeq(conversations);
  return Array.from(state.messages.values())
    .filter((envelope) => envelope.actor.kind === "user" && eventInEpoch(envelope.seq, epochStart))
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
    .map((envelope) => ({
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      content: messageContent(envelope.body)
    }));
}

/**
 * Put the stopped prompt back so the operator can finish the sentence instead of
 * retyping it. The follow-up is threaded under the original message, which is
 * also how the Agents see that this is a correction and not a new task; the
 * reply chip stays clearable if they would rather send something unrelated.
 */
function restoreStoppedPrompt(plan: ResumeAfterStopPlan): boolean {
  if (plan.content === null) return false;
  messageInput.value = plan.content;
  saveDraft();
  updateCharacterCount();
  autoresizeComposer();
  if (plan.replyToEventId !== null) setReply(plan.replyToEventId);
  invalidatePendingSubmission();
  syncTargetAvailability();
  syncSendButton();
  messageInput.focus();
  messageInput.setSelectionRange(plan.content.length, plan.content.length);
  return true;
}

async function stopAllAgentWork(): Promise<void> {
  if (stopInFlight) return;
  const turnIds = cancellableTurnIds(state.turns.values());
  if (turnIds.length === 0) {
    setComposerStatus(isRoomWorking() ? STOP_RETRY_STATUS : "本轮已结束");
    return;
  }
  stopInFlight = true;
  syncSendButton();
  setComposerStatus(`正在终止 ${turnIds.length} 个 Agent 的工作…`);
  const results = await Promise.all(turnIds.map(async (turnId) => await requestTurnCancel(turnId)));
  stopInFlight = false;
  const failures = results.filter((result): result is { ok: false; message: string } => !result.ok);
  if (failures.length === 0) {
    const resumed = restoreStoppedPrompt(
      planResumeAfterStop({
        cancelledCorrelationIds: turnIds.map(
          (turnId) => state.turns.get(turnId)?.correlationId ?? ""
        ),
        messages: userMessagesInView(),
        draftLength: messageInput.value.trim().length
      })
    );
    setComposerStatus(
      resumed
        ? STOP_RESUME_STATUS
        : messageInput.value.trim().length > 0
          ? STOP_KEPT_DRAFT_STATUS
          : STOP_ACK_STATUS
    );
  } else {
    setComposerStatus(
      `${failures.length} 个取消失败：${failures[0]?.message ?? "未知错误"}；可再次点击重试`,
      true
    );
  }
  // The rail and the button read `releasedTurnIds`, so both need a repaint once
  // the fan-out settles: a confirmed stop must clear the rings immediately.
  syncAgentActivity();
}

function renderSupervisionEvent(envelope: AIChatLinkEnvelope): void {
  if (eventNodes.has(envelope.eventId)) {
    return;
  }
  const item = document.createElement("li");
  item.className = "timeline-item";
  const article = document.createElement("article");
  article.className = "supervision-card";
  article.dataset.eventId = envelope.eventId;
  article.append(createActorMeta(envelope));
  const title = document.createElement("div");
  title.className = "supervision-title";
  const body = isRecord(envelope.body) ? envelope.body : {};
  if (envelope.type === "supervision.paired") {
    title.textContent = "监督配对已建立：worker 执行，观察者同步看整轮";
    const workers = Array.isArray(body.workers)
      ? body.workers
          .map((item) => (isRecord(item) ? String(item.actorId ?? "") : ""))
          .filter(Boolean)
          .join("、")
      : "";
    const observers = Array.isArray(body.observers)
      ? body.observers
          .map((item) => (isRecord(item) ? String(item.actorId ?? "") : ""))
          .filter(Boolean)
          .join("、")
      : "";
    if (workers || observers) {
      const detail = document.createElement("p");
      detail.className = "supervision-reason";
      detail.textContent = `Worker ${workers || "—"} · 观察者 ${observers || "—"}`;
      article.append(title, detail);
    } else {
      article.append(title);
    }
  } else if (envelope.type === "supervision.steered") {
    const action = readStringField(body, "action") ?? "steer";
    title.textContent =
      action === "interrupt"
        ? "观察者打断了当前整轮并改道，不是单次工具审批"
        : "观察者排队了一条改道指导，等当前整轮结束后再生效";
    article.append(title);
  } else {
    title.textContent = "观察里程碑（有界快照，不是逐字转发）";
    const snapshot = isRecord(body.snapshot) ? body.snapshot : undefined;
    const status = snapshot ? readStringField(snapshot, "status") : undefined;
    if (status) {
      const detail = document.createElement("p");
      detail.className = "supervision-reason";
      detail.textContent = `被观察回合 ${status}`;
      article.append(title, detail);
    } else {
      article.append(title);
    }
  }
  const reason = readStringField(body, "reason");
  if (reason) {
    const reasonEl = document.createElement("p");
    reasonEl.className = "supervision-reason";
    reasonEl.textContent = reason;
    article.append(reasonEl);
  }
  item.append(article);
  eventNodes.set(envelope.eventId, article);
  appendTimeline(item);
}

function renderGeneric(envelope: AIChatLinkEnvelope): void {
  if (eventNodes.has(envelope.eventId)) {
    return;
  }
  const item = document.createElement("li");
  item.className = "timeline-item";
  const article = document.createElement("article");
  article.className = "generic-card";
  article.dataset.eventId = envelope.eventId;
  article.append(createActorMeta(envelope));

  const type = document.createElement("div");
  type.className = "generic-type";
  type.textContent = envelope.type;
  article.append(type);

  const body = document.createElement("pre");
  body.className = "generic-body";
  body.textContent = safeStringify(envelope.body);
  article.append(body);

  item.append(article);
  eventNodes.set(envelope.eventId, article);
  appendTimeline(item);
}

function renderRuntimeProgress(envelope: AIChatLinkEnvelope): void {
  const body = isRecord(envelope.body) ? envelope.body : {};
  const attempt = readNumberField(body, "attempt") ?? 1;
  const maxAttempts = readNumberField(body, "maxAttempts") ?? 1;
  const nextDelayMs = readNumberField(body, "nextDelayMs") ?? 0;
  const errorCode = readStringField(body, "errorCode");
  if (runtimeProgressHideTimer !== null) {
    window.clearTimeout(runtimeProgressHideTimer);
    runtimeProgressHideTimer = null;
  }
  runtimeProgress.hidden = false;
  runtimeProgress.dataset.phase = envelope.type.split(".").at(-1) ?? "started";
  runtimeProgressAttempt.textContent = `${attempt} / ${maxAttempts}`;
  if (envelope.type.startsWith("context.compaction.")) {
    if (envelope.type.endsWith("retrying")) {
      runtimeProgressTitle.textContent = "会话压缩暂时失败，正在重试";
      runtimeProgressDetail.textContent = `${errorCode || "临时故障"} · ${Math.max(1, Math.ceil(nextDelayMs / 1000))} 秒后重试`;
    } else if (envelope.type.endsWith("completed")) {
      runtimeProgressTitle.textContent = "房间上下文已压缩";
      runtimeProgressDetail.textContent = `已整理 ${readNumberField(body, "messageCount") ?? 0} 条较早消息，近期消息仍保留原文`;
      runtimeProgressHideTimer = window.setTimeout(() => {
        runtimeProgress.hidden = true;
      }, 4_000);
    } else if (envelope.type.endsWith("failed")) {
      runtimeProgressTitle.textContent = "会话压缩失败";
      runtimeProgressDetail.textContent = `${errorCode || "压缩器不可用"} · 原聊天记录未丢失`;
    } else {
      runtimeProgressTitle.textContent = "正在压缩较早的会话记录";
      runtimeProgressDetail.textContent = `处理 ${readNumberField(body, "messageCount") ?? 0} 条消息，期间当前回复会等待`;
    }
    return;
  }
  const actor = state.agents.get(envelope.actor.actorId)?.displayName ?? envelope.actor.displayName;
  if (envelope.type === "session.retrying") {
    runtimeProgressTitle.textContent = `${actor} 会话连接失败，正在重试`;
    runtimeProgressDetail.textContent = `${errorCode || "临时故障"} · ${Math.max(1, Math.ceil(nextDelayMs / 1000))} 秒后重试`;
  } else if (envelope.type === "session.failed") {
    runtimeProgressTitle.textContent = `${actor} 会话启动失败`;
    runtimeProgressDetail.textContent = errorCode || "请检查本机 CLI 状态";
  } else if (envelope.type === "session.ready" || envelope.type === "session.resumed") {
    runtimeProgressTitle.textContent = `${actor} 会话已就绪`;
    runtimeProgressDetail.textContent = "可以继续接收新的消息";
    runtimeProgressHideTimer = window.setTimeout(() => {
      runtimeProgress.hidden = true;
    }, 2_500);
  } else {
    runtimeProgressTitle.textContent = `${actor} 正在建立会话`;
    runtimeProgressDetail.textContent = "正在连接本机 CLI";
  }
}

function updateAgentFromSessionEvent(envelope: AIChatLinkEnvelope): void {
  if (envelope.actor.kind !== "agent") {
    return;
  }
  const current = state.agents.get(envelope.actor.actorId) ?? {
    actorId: envelope.actor.actorId,
    displayName: envelope.actor.displayName,
    status: "unknown",
    driver: "",
    piDriver: false,
    cwd: "",
    enabled: true,
    capabilities: [],
  };
  const suffix = envelope.type.split(".").at(-1) ?? "unknown";
  const status = suffix === "resumed" ? "ready" : suffix;
  state.agents.set(current.actorId, { ...current, displayName: envelope.actor.displayName, status });
  renderAgents();
}

function recordEventPayload(body: unknown): unknown {
  return isRecord(body) && isRecord(body.record) ? body.record : body;
}

function renderRecordActivity(envelope: AIChatLinkEnvelope, record: RecordView, identity: boolean): void {
  if (eventNodes.has(envelope.eventId)) {
    return;
  }
  const item = document.createElement("li");
  item.className = "timeline-item";
  const article = document.createElement("article");
  article.className = "activity-card";
  article.dataset.eventId = envelope.eventId;
  article.append(createActorMeta(envelope));

  const memoryLabel = record.scopeType === "agent" ? "Agent 记忆" : "公共记忆";
  const verb = identity
    ? envelope.type.endsWith(".retracted")
      ? "移除了一条兼容身份记录"
      : envelope.type.endsWith(".superseded")
        ? "替换了一条兼容身份记录"
        : "更新了一条兼容身份记录"
    : envelope.type.endsWith(".retracted")
      ? `移除了一条${memoryLabel}`
      : envelope.type.endsWith(".superseded")
        ? `替换了一条${memoryLabel}`
        : `保存了一条${memoryLabel}`;
  const line = document.createElement("p");
  line.className = "activity-line";
  line.textContent = verb;
  const preview = document.createElement("p");
  preview.className = "activity-preview";
  preview.textContent =
    record.content.length > 160 ? `${record.content.slice(0, 160)}…` : record.content;
  article.append(line, preview);

  item.append(article);
  eventNodes.set(envelope.eventId, article);
  appendTimeline(item);
}

/** Apply a memory record to the shared state; the timeline card is painted per pane. */
function applyMemoryRecord(envelope: AIChatLinkEnvelope): void {
  const payload = recordEventPayload(envelope.body);
  const record = normalizeRecord(payload, false);
  if (!record) {
    return;
  }
  const target = state.memories;
  if (envelope.type.endsWith(".retracted")) {
    target.delete(record.id);
  } else {
    if (envelope.type.endsWith(".superseded") && isRecord(payload)) {
      const previousId = readStringField(payload, "supersedesMemoryId");
      if (previousId) {
        target.delete(previousId);
      }
    }
    target.set(record.id, record);
  }
  renderPublicMemoryRecords();
}

/**
 * The Agent a turn belongs to. Terminal frames carry neither targetActorId
 * nor an agent actor (D-044), so the durable state is consulted before the
 * envelope sender: a lane must still see its own failure.
 */
function resolveTurnTarget(envelope: AIChatLinkEnvelope): string | null {
  if (envelope.type === "message.created") {
    return envelope.actor.actorId;
  }
  const turnId = turnIdFromBody(envelope.body);
  if (turnId !== "") {
    const body = isRecord(envelope.body) ? envelope.body : {};
    const bodyTarget = readStringField(body, "targetActorId", "target");
    if (bodyTarget !== "") return bodyTarget;
    const known = state.turns.get(turnId)?.targetActorId;
    if (known) return known;
  }
  const addressed = envelope.to.find((id) => id.startsWith("agent:")) ?? envelope.to[0];
  if (addressed !== undefined && addressed !== "") return addressed;
  return envelope.actor.kind === "agent" ? envelope.actor.actorId : null;
}

function trimPaneLog(): void {
  const overflow = state.paneLog.length - PANE_LOG_MAX;
  if (overflow > 0) {
    state.paneLog.splice(0, overflow);
  }
}

/** While a closed conversation is open, only its own ranges are rendered. */
function envelopeInView(envelope: AIChatLinkEnvelope): boolean {
  const view = conversationView;
  if (view === null) return envelopeInOpenEpoch(envelope);
  const seq = envelope.seq;
  if (seq === null) return false;
  return view.ranges.some((range) => seq >= range.fromSeq && seq <= range.throughSeq);
}

function dispatchEnvelope(envelope: AIChatLinkEnvelope, live: boolean): void {
  if (!envelopeInView(envelope)) {
    // A reset that lands while history is open still changes the sidebar.
    if (envelope.type === "context.reset") void refreshConversations();
    return;
  }

  const targetActorId = resolveTurnTarget(envelope);

  // 1) Global effects. These own shared state and singleton chrome (the agent
  //    rail, the composer status, the sidebar memory list) and must run once,
  //    no matter how many panes are watching.
  switch (envelope.type) {
    case "context.reset": {
      const throughSeq = isRecord(envelope.body) ? readNumberField(envelope.body, "throughSeq") : null;
      if (throughSeq !== null) {
        openConversationEpoch(epochStartAfterReset(throughSeq));
      }
      void refreshConversations();
      return;
    }
    case "adapter.heartbeat":
      return;
    case "message.created": {
      state.messages.set(envelope.eventId, envelope);
      if (document.hidden && envelope.actor.kind !== "user") {
        unreadCount += 1;
        document.title = `(${unreadCount}) ${BASE_TITLE}`;
      }
      break;
    }
    case "context.compaction.started":
    case "context.compaction.retrying":
    case "context.compaction.completed":
    case "context.compaction.failed":
      renderRuntimeProgress(envelope);
      return;
    case "session.starting":
    case "session.retrying":
    case "session.ready":
    case "session.resumed":
    case "session.stopped":
    case "session.failed":
      updateAgentFromSessionEvent(envelope);
      renderRuntimeProgress(envelope);
      return;
    case "memory.remembered":
    case "memory.superseded":
    case "memory.retracted":
      applyMemoryRecord(envelope);
      break;
    default:
      break;
  }

  // 2) Turn lifecycle is shared state, not a pane effect: track it even when no
  //    pane watches this Agent, then let each pane paint what it accepts.
  if (
    envelope.type === "turn.queued" ||
    envelope.type === "turn.dispatched" ||
    envelope.type === "turn.started" ||
    envelope.type === "turn.streaming" ||
    envelope.type === "turn.completed" ||
    envelope.type === "turn.failed" ||
    envelope.type === "turn.cancelled" ||
    envelope.type === "turn.interrupted"
  ) {
    trackTurnEnvelope(envelope, live);
  }

  // 3) Deltas accumulate once here; flushDeltaBuckets() projects the shared text
  //    into every pane whose lane owns the turn. Queueing per pane would append
  //    the same chunk N times.
  if (envelope.type === "turn.content.delta" || envelope.type === "turn.reasoning.delta") {
    if (isRecord(envelope.body)) {
      queueDelta(
        envelope,
        envelope.type === "turn.content.delta" ? "content" : "reasoning",
        targetActorId
      );
      return;
    }
  }

  // 4) Bounded replay log: lets a pane created mid-conversation (or re-lensed)
  //    repaint in the same order the room timeline saw. Deltas are excluded.
  if (!envelope.type.endsWith(".delta")) {
    const singletonOnly =
      envelope.type.startsWith("session.") ||
      envelope.type.startsWith("context.compaction.") ||
      envelope.type === "adapter.heartbeat";
    if (!singletonOnly) {
      state.paneLog.push({ envelope, targetActorId });
      trimPaneLog();
    }
  }

  // 5) Per-pane projection. Room panes take everything; agent panes take the
  //    operator's prompts and the turn/delta/tool records of their own Agent.
  for (const pane of panes) {
    if (!lensAccepts(pane.lens, envelope, targetActorId)) {
      continue;
    }
    usePaneContext(pane);
    paintEnvelope(envelope);
  }
  if (panes.length > 0) {
    usePaneContext(panes[0]!);
  }
}

/** Paint one envelope into the pane selected by usePaneContext(). */
function paintEnvelope(envelope: AIChatLinkEnvelope): void {
  switch (envelope.type) {
    case "message.created":
      renderMessage(envelope);
      return;
    case "turn.reasoning.recorded":
      renderReasoningRecord(envelope);
      return;
    case "tool.progress":
    case "tool.progress.recorded":
      renderToolProgress(envelope);
      return;
    case "turn.queued":
    case "turn.dispatched":
    case "turn.started":
    case "turn.streaming":
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled":
    case "turn.interrupted":
      renderTurnEnvelope(envelope);
      return;
    case "memory.remembered":
    case "memory.superseded":
    case "memory.retracted": {
      const record = normalizeRecord(recordEventPayload(envelope.body), false);
      if (record) renderRecordActivity(envelope, record, false);
      else renderGeneric(envelope);
      return;
    }
    case "identity.remembered":
    case "identity.superseded":
    case "identity.retracted": {
      const record = normalizeRecord(recordEventPayload(envelope.body), true);
      if (record) renderRecordActivity(envelope, record, true);
      else renderGeneric(envelope);
      return;
    }
    case "supervision.paired":
    case "supervision.observed":
    case "supervision.steered":
      renderSupervisionEvent(envelope);
      return;
    case "operator.dispatch":
      renderOperatorDispatch(envelope);
      return;
    default:
      renderGeneric(envelope);
  }
}

function renderOperatorDispatch(envelope: AIChatLinkEnvelope): void {
  if (eventNodes.has(envelope.eventId)) return;
  const item = document.createElement("li");
  item.className = "timeline-item";
  const article = document.createElement("article");
  article.className = "event-card operator-dispatch-card";
  article.dataset.eventId = envelope.eventId;
  const body = isRecord(envelope.body) ? envelope.body : {};
  const targets = Array.isArray(body.targets)
    ? body.targets.filter((value): value is string => typeof value === "string").join(", ")
    : envelope.to.join(", ");
  const length = typeof body.promptLength === "number" ? body.promptLength : 0;
  const operation = typeof body.operation === "string" ? body.operation : "worker_dispatch";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `助理派活 · ${operation} · ${targets || "workers"} · ${length} 字`;
  const pre = document.createElement("pre");
  pre.textContent = typeof body.content === "string" ? body.content : "";
  details.append(summary, pre);
  article.append(details);
  item.append(article);
  timeline.append(item);
  eventNodes.set(envelope.eventId, article);
  timelineEmpty.hidden = true;
}

function acceptEnvelope(
  envelope: AIChatLinkEnvelope,
  source: "bootstrap" | "live" | "replay"
): boolean {
  if (state.seenEventIds.has(envelope.eventId)) {
    return true;
  }
  if (envelope.seq !== null) {
    if (source === "live" && envelope.seq <= state.lastDurableSeq) {
      state.seenEventIds.add(envelope.eventId);
      return true;
    }
    if (source === "live" && envelope.seq > state.lastDurableSeq + 1) {
      reconnectForGap(envelope.seq);
      return false;
    }
    // A replayed conversation is read-only history: it must never move the
    // live cursor, or the SSE reconnect would skip the current epoch.
    if (source !== "replay") {
      state.lastDurableSeq = Math.max(state.lastDurableSeq, envelope.seq);
    }
  }
  state.seenEventIds.add(envelope.eventId);
  if (source === "live" && deliveryAcknowledgementPending && answersDeliveryAcknowledgement(envelope)) {
    setComposerStatus("");
  }
  dispatchEnvelope(envelope, source === "live");
  if (envelope.type === "message.created" || envelope.type === "context.compaction.completed") {
    scheduleContextUsageRefresh();
  }
  return true;
}

function orderedAgents(): AgentView[] {
  return Array.from(state.agents.values()).sort(compareRosterOrder);
}

interface ResumedConversationRef {
  conversationId: string;
  title: string;
  fromSeq: number;
  throughSeq: number;
}

interface ConversationSummary {
  conversationId: string;
  title: string;
  startSeq: number;
  endSeq: number | null;
  startedAt: string;
  active: boolean;
  /** The open epoch has no room-context message yet; the sidebar keeps it out. */
  empty: boolean;
  /** Closed conversation this epoch was resumed from; its range is the seed. */
  resumedFrom: ResumedConversationRef | null;
  /**
   * The seq ranges this conversation occupies. Continuing a conversation adds a
   * range, so its own segments may be separated by another conversation's
   * events; replaying only these keeps the two apart.
   */
  ranges: Array<{ fromSeq: number; throughSeq: number }>;
}

/**
 * A closed conversation opened in the main timeline. Its ranges are replayed
 * read-only; the first send resumes it into a new epoch through the Broker.
 */
interface ConversationView {
  conversation: ConversationSummary;
  ranges: Array<{ fromSeq: number; throughSeq: number }>;
}

type WorkspaceStatusView = "starting" | "ready" | "failed" | "stopped";

interface WorkspaceView {
  workspaceId: string;
  label: string;
  path: string;
  kind: "primary" | "added";
  status: WorkspaceStatusView;
  agentCount: number;
  errorCode?: string;
  errorMessage?: string;
}

interface WorkspaceDirectoryView {
  name: string;
  path: string;
  isRepository: boolean;
}

interface WorkspaceListingView {
  path: string;
  parent: string | null;
  shortcuts: WorkspaceDirectoryView[];
  entries: WorkspaceDirectoryView[];
  truncated: boolean;
}

let workspaces: WorkspaceView[] = [];
let primaryWorkspaceId = "";
let activeWorkspaceId = "";
const conversationsByWorkspace = new Map<string, ConversationSummary[]>();
let workspacePollTimer: number | null = null;
let workspaceListing: WorkspaceListingView | null = null;
let workspaceDialogBusy = false;

function normalizeWorkspace(value: unknown): WorkspaceView | null {
  if (!isRecord(value)) return null;
  const workspaceId = readStringField(value, "workspaceId");
  const label = readStringField(value, "label");
  const workspacePath = readStringField(value, "path");
  const kind = value.kind;
  const status = value.status;
  const agentCount = readNumberField(value, "agentCount") ?? 0;
  if (!workspaceId || !label || !workspacePath) return null;
  if (kind !== "primary" && kind !== "added") return null;
  if (status !== "starting" && status !== "ready" && status !== "failed" && status !== "stopped") {
    return null;
  }
  const errorCode = readStringField(value, "errorCode");
  const errorMessage = readStringField(value, "errorMessage");
  return {
    workspaceId,
    label,
    path: workspacePath,
    kind,
    status,
    agentCount,
    ...(errorCode.length === 0 ? {} : { errorCode }),
    ...(errorMessage.length === 0 ? {} : { errorMessage })
  };
}

function normalizeWorkspaceDirectory(value: unknown): WorkspaceDirectoryView | null {
  if (!isRecord(value)) return null;
  const name = readStringField(value, "name");
  const directoryPath = readStringField(value, "path");
  if (!name || !directoryPath) return null;
  return { name, path: directoryPath, isRepository: value.isRepository === true };
}

function normalizeWorkspaceListing(value: unknown): WorkspaceListingView | null {
  if (!isRecord(value)) return null;
  const listingPath = readStringField(value, "path");
  if (!listingPath) return null;
  const parentRaw = value.parent;
  const shortcuts = Array.isArray(value.shortcuts)
    ? value.shortcuts.map(normalizeWorkspaceDirectory).filter((item): item is WorkspaceDirectoryView => item !== null)
    : [];
  const entries = Array.isArray(value.entries)
    ? value.entries.map(normalizeWorkspaceDirectory).filter((item): item is WorkspaceDirectoryView => item !== null)
    : [];
  return {
    path: listingPath,
    parent: typeof parentRaw === "string" ? parentRaw : null,
    shortcuts,
    entries,
    truncated: value.truncated === true
  };
}

function currentWorkspace(): WorkspaceView | undefined {
  return workspaces.find((workspace) => workspace.workspaceId === activeWorkspaceId);
}

function isPrimaryWorkspace(workspaceId = activeWorkspaceId): boolean {
  return workspaceId.length === 0 || workspaceId === primaryWorkspaceId;
}

/** Room API calls carry the active workspace unless the caller is hub-scoped. */
function withWorkspace(path: string, workspaceId = activeWorkspaceId): string {
  if (workspaceId.length === 0 || workspaceId === primaryWorkspaceId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}ws=${encodeURIComponent(workspaceId)}`;
}

function navigateToWorkspace(workspaceId: string, conversationId?: string): void {
  if (workspaceId === activeWorkspaceId && conversationId === undefined) {
    closeWorkspaceDialog();
    return;
  }
  const url = new URL(window.location.href);
  if (workspaceId.length === 0 || workspaceId === primaryWorkspaceId) {
    url.searchParams.delete("ws");
  } else {
    url.searchParams.set("ws", workspaceId);
  }
  if (conversationId === undefined) url.searchParams.delete("conv");
  else url.searchParams.set("conv", conversationId);
  // Save under the old `?ws=` before the URL moves: drafts are keyed by view.
  saveDraft();
  window.history.pushState(null, "", url);
  void switchWorkspace();
}

/**
 * Switch the active working directory in place. A reload does the same, but it
 * blanks the shell and re-fetches every static asset for a swap the SPA can do
 * itself. Everything workspace-scoped is reset here; `bootstrap()` refills it
 * from `?ws=`, so the two paths can never disagree about what a load means.
 */
async function switchWorkspace(): Promise<void> {
  conversationView = null;
  conversationViewToken += 1;
  viewingBanner.hidden = true;
  liveEnvelopeBuffer = null;
  // Different runtimes do not share a seq space: a cursor from the old room
  // would make the new stream look like a gap and force a reconnect loop.
  closeEventSource();
  state.lastDurableSeq = 0;
  state.seenEventIds.clear();
  openEpochStartSeq = FIRST_EPOCH_START_SEQ;
  retiredTurnIds.clear();
  // Public memory is per working directory; merging would leak the old room's
  // records into the new one (loadMemoryRecords only ever adds).
  state.memories.clear();
  conversations = [];
  closeWorkspaceDialog();
  await bootstrap();
  restoreDraft();
}

/** `?conv=` is part of the URL contract, so popstate has to honour it too. */
async function applyConversationParam(conversationId: string | null): Promise<void> {
  if (conversationId === null) {
    if (conversationView !== null) exitConversationView();
    return;
  }
  const target = conversations.find((conversation) => conversation.conversationId === conversationId);
  if (target === undefined) return;
  if (target.active) {
    if (conversationView !== null) exitConversationView();
    return;
  }
  if (conversationView?.conversation.conversationId === conversationId) return;
  await enterConversationView(target);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function refreshWorkspaces(): Promise<void> {
  try {
    const payload = await requestJson<unknown>("/api/workspaces", { workspace: false });
    if (!isRecord(payload) || !Array.isArray(payload.workspaces)) return;
    const next = payload.workspaces
      .map(normalizeWorkspace)
      .filter((workspace): workspace is WorkspaceView => workspace !== null);
    if (next.length === 0) return;
    workspaces = next;
    primaryWorkspaceId = next.find((workspace) => workspace.kind === "primary")?.workspaceId ?? "";
    const requested = new URLSearchParams(window.location.search).get("ws");
    const selected =
      requested !== null && next.some((workspace) => workspace.workspaceId === requested)
        ? requested
        : primaryWorkspaceId;
    if (requested !== null && selected !== requested) {
      const url = new URL(window.location.href);
      url.searchParams.delete("ws");
      url.searchParams.delete("conv");
      window.history.replaceState(null, "", url);
    }
    activeWorkspaceId = selected;
    updateComposerWorkspace();
    renderConversations();
    scheduleWorkspacePoll();
  } catch {
    // Older runtimes have no workspace hub; keep the single-room behavior.
  }
}

function scheduleWorkspacePoll(): void {
  if (workspacePollTimer !== null) return;
  if (
    !workspaces.some(
      (workspace) => workspace.status === "starting" || workspace.status === "stopped"
    )
  ) {
    return;
  }
  workspacePollTimer = window.setTimeout(() => {
    workspacePollTimer = null;
    void refreshWorkspaces().then(async () => {
      await refreshWorkspaceConversations();
    });
  }, 1_500);
}

let conversations: ConversationSummary[] = [];
let collapsedWorkspaceIds = readCollapsedWorkspaceIds();
let conversationView: ConversationView | null = null;
let conversationViewToken = 0;

function readCollapsedWorkspaceIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_WORKSPACES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []
    );
  } catch {
    return new Set();
  }
}

function persistCollapsedWorkspaceIds(): void {
  try {
    localStorage.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify([...collapsedWorkspaceIds]));
  } catch {
    // Presentation-only preference; losing it is harmless.
  }
}

function isWorkspaceCollapsed(workspaceId: string): boolean {
  return collapsedWorkspaceIds.has(workspaceId);
}

/** Collapsing only hides a group's list; the header, count and failure note stay. */
function setWorkspaceCollapsed(workspaceId: string, collapsed: boolean): void {
  if (collapsed === collapsedWorkspaceIds.has(workspaceId)) return;
  if (collapsed) collapsedWorkspaceIds.add(workspaceId);
  else collapsedWorkspaceIds.delete(workspaceId);
  persistCollapsedWorkspaceIds();
  // Re-rendering replaces the trigger, so keyboard focus must be carried over.
  const restoreFocus =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.classList.contains("workspace-group-toggle");
  renderConversations();
  if (!restoreFocus) return;
  const next = Array.from(
    conversationGroups.querySelectorAll<HTMLButtonElement>(".workspace-group-toggle")
  ).find((button) => button.closest(".workspace-group")?.getAttribute("data-workspace-id") === workspaceId);
  next?.focus();
}

/** Switching to a directory or writing a new epoch there always reveals its list. */
function expandWorkspaceGroup(workspaceId: string): void {
  if (!collapsedWorkspaceIds.delete(workspaceId)) return;
  persistCollapsedWorkspaceIds();
  renderConversations();
}

function normalizeConversation(value: unknown): ConversationSummary | null {
  if (!isRecord(value)) return null;
  const conversationId = readStringField(value, "conversationId");
  const title = readStringField(value, "title");
  const startedAt = readStringField(value, "startedAt");
  const startSeq = readNumberField(value, "startSeq");
  const endSeqRaw: unknown = value.endSeq;
  const endSeq = typeof endSeqRaw === "number" ? endSeqRaw : null;
  const active = value.active === true;
  if (!conversationId || !title || !startedAt || typeof startSeq !== "number") return null;
  const ranges: Array<{ fromSeq: number; throughSeq: number }> = [];
  for (const entry of asArray(value.ranges)) {
    if (!isRecord(entry)) continue;
    const fromSeq = readNumberField(entry, "fromSeq");
    const throughSeq = readNumberField(entry, "throughSeq");
    if (fromSeq === null || throughSeq === null || throughSeq < fromSeq) continue;
    ranges.push({ fromSeq, throughSeq });
  }
  return {
    conversationId,
    title,
    startSeq,
    endSeq,
    startedAt,
    active,
    empty: value.empty === true,
    resumedFrom: normalizeResumedConversation(value.resumedFrom),
    ranges
  };
}

function normalizeResumedConversation(value: unknown): ResumedConversationRef | null {
  if (!isRecord(value)) return null;
  const conversationId = readStringField(value, "conversationId");
  const title = readStringField(value, "title");
  const fromSeq = readNumberField(value, "fromSeq");
  const throughSeq = readNumberField(value, "throughSeq");
  if (!conversationId || !title || fromSeq === null || throughSeq === null) return null;
  return { conversationId, title, fromSeq, throughSeq };
}

/** Ranges replayed for one conversation: its resume seed first, then its own. */
function conversationRanges(conversation: ConversationSummary): ConversationView["ranges"] {
  // The server knows every range this conversation occupies (a continuation is
  // another range, possibly with another conversation's events in between).
  if (conversation.ranges.length > 0) {
    return [...conversation.ranges].sort((left, right) => left.fromSeq - right.fromSeq);
  }
  const ranges: ConversationView["ranges"] = [];
  if (conversation.resumedFrom) {
    ranges.push({
      fromSeq: conversation.resumedFrom.fromSeq,
      throughSeq: conversation.resumedFrom.throughSeq
    });
  }
  if (conversation.endSeq !== null) {
    ranges.push({ fromSeq: conversation.startSeq, throughSeq: conversation.endSeq });
  }
  return ranges;
}

function formatConversationStamp(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "新对话";
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

async function refreshConversations(
  workspaceId = activeWorkspaceId,
  options: { render?: boolean } = {}
): Promise<void> {
  try {
    const payload = await requestJson<unknown>(
      withWorkspace("/api/conversations", workspaceId),
      { workspace: false }
    );
    if (!isRecord(payload) || !Array.isArray(payload.conversations)) return;
    const list = payload.conversations
      .map(normalizeConversation)
      .filter((value): value is ConversationSummary => value !== null);
    conversationsByWorkspace.set(workspaceId, list);
    if (workspaceId === activeWorkspaceId) {
      conversations = list;
    }
    if (options.render !== false) renderConversations();
  } catch {
    // The conversation list is optional chrome; the transcript still works.
  }
}

/** Fetch every workspace's list once so the sidebar can group them. */
async function refreshWorkspaceConversations(): Promise<void> {
  const targets = workspaces.length === 0 ? [activeWorkspaceId] : workspaces.map((workspace) => workspace.workspaceId);
  await Promise.all(
    targets.map(async (workspaceId) => {
      const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId);
      if (workspace !== undefined && workspace.status !== "ready") {
        if (!conversationsByWorkspace.has(workspaceId)) {
          conversationsByWorkspace.set(workspaceId, []);
        }
        return;
      }
      await refreshConversations(workspaceId, { render: false });
    })
  );
  conversations = conversationsByWorkspace.get(activeWorkspaceId) ?? conversations;
  renderConversations();
}

/** Seq where the open conversation epoch starts; anything earlier is history, not live. */
let openEpochStartSeq = FIRST_EPOCH_START_SEQ;
/** Turns the epoch change abandoned; their cancellation is recorded after the reset. */
const retiredTurnIds = new Set<string>();

/** A fan-out shares one correlation, so only the turn id identifies one turn. */
function turnIdOf(envelope: AIChatLinkEnvelope): string {
  return isRecord(envelope.body) ? readStringField(envelope.body, "turnId") : "";
}

/**
 * Follow the view into a newer conversation epoch. The transcript itself stays
 * append-only: only this live view moves, and closed epochs remain replayable in
 * the replayed conversation view.
 */
function openConversationEpoch(startSeq: number, options: { repaint?: boolean } = {}): void {
  if (!Number.isSafeInteger(startSeq) || startSeq <= openEpochStartSeq) {
    return;
  }
  for (const turn of state.turns.values()) {
    if (IN_FLIGHT_TURN_STATUSES.has(turn.status)) {
      retiredTurnIds.add(turn.turnId);
    }
  }
  openEpochStartSeq = startSeq;
  // A caller that repaints right after (the in-place rebuild) must not blank the
  // column in between; it clears inside the same synchronous paint.
  if (options.repaint !== false) clearTimelineView();
  void refreshContextUsage();
}

/**
 * A reset can land while turns are still running, so their cancellation is
 * recorded inside the epoch that replaced them. Rebuild those turn ids from a
 * replayed window, otherwise a reload inherits the old teardown.
 */
function seedRetiredTurnIds(events: readonly AIChatLinkEnvelope[]): void {
  const inFlight = new Map<string, boolean>();
  for (const envelope of events) {
    if (envelope.type === "context.reset") {
      for (const [turnId, started] of inFlight) {
        if (started) {
          retiredTurnIds.add(turnId);
        }
      }
      inFlight.clear();
      continue;
    }
    const turnId = turnIdOf(envelope);
    if (!turnId) {
      continue;
    }
    const activity = turnActivityState(envelope.type);
    if (activity === "opening") {
      // A queued turn that never reached a session may still run in the new epoch.
      inFlight.set(turnId, inFlight.get(turnId) === true || envelope.type !== "turn.queued");
    } else if (activity === "terminal") {
      inFlight.delete(turnId);
    }
  }
}

/** Earlier-epoch events and abandoned turns stay out of the live timeline. */
function envelopeInOpenEpoch(envelope: AIChatLinkEnvelope): boolean {
  if (envelope.type === "context.reset") {
    return true;
  }
  const turnId = turnIdOf(envelope);
  if (turnId !== "" && retiredTurnIds.has(turnId)) {
    if (turnActivityState(envelope.type) === "terminal") {
      retiredTurnIds.delete(turnId);
    }
    return false;
  }
  return eventInEpoch(envelope.seq, openEpochStartSeq);
}

/** Drop every rendered item; the durable transcript is untouched. */
function clearTimelineView(): void {
  if (deltaFlushTimer !== null) {
    window.clearTimeout(deltaFlushTimer);
    deltaFlushTimer = null;
  }
  deltaBuckets.clear();
  closedStreamKeys.clear();
  // Every pane is a projection of the same epoch: a reset empties all of them.
  for (const pane of panes) {
    usePaneContext(pane);
    for (const node of Array.from(timeline.children)) {
      if (node !== timelineEmpty) {
        cleanupRemovedItem(node);
        node.remove();
      }
    }
    timeline.replaceChildren(timelineEmpty);
    timelineEmpty.hidden = false;
    eventNodes.clear();
    turnNodes.clear();
    streamNodes.clear();
    toolProgressNodes.clear();
    lastTimelineDate = "";
    trimmedItemCount = 0;
    trimNoticeNode = null;
    pane.lastDate = "";
    pane.trimCount = 0;
    pane.trimNotice = null;
    pane.pendingNew = 0;
    resetJumpLatest();
    setConversationTocOpen(false, pane);
    syncConversationToc(pane);
  }
  if (panes.length > 0) {
    usePaneContext(panes[0]!);
  }
  state.messages.clear();
  state.turns.clear();
  state.transientText.clear();
  state.paneLog = [];
  finishedAgents.clear();
  releasedTurnIds.clear();
  syncAgentActivity();
  unreadCount = 0;
  document.title = BASE_TITLE;
  if (state.replyToEventId !== null) {
    clearReply();
  }
  refreshEmptyStateCopy();
}

function workspaceGroupItems(workspace: WorkspaceView | null): ConversationSummary[] {
  if (workspace === null) return conversations;
  const items = conversationsByWorkspace.get(workspace.workspaceId);
  if (items !== undefined) return items;
  return workspace.workspaceId === activeWorkspaceId ? conversations : [];
}

function renderConversations(): void {
  conversationGroups.replaceChildren();
  if (workspaces.length === 0) {
    renderConversationGroup(null, conversations);
    return;
  }
  for (const workspace of workspaces) {
    renderConversationGroup(workspace, workspaceGroupItems(workspace));
  }
}

/* ------------------------------------------------- workspace group controls */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Inline stroke icons: no icon font, no object URL, nothing CSP must allow. */
function glyph(paths: readonly string[], strokeWidth = 1.7): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const chevronGlyph = (): SVGSVGElement => glyph(["M6 9.5l6 6 6-6"]);
const plusGlyph = (): SVGSVGElement => glyph(["M12 5v14", "M5 12h14"]);
const moreGlyph = (): SVGSVGElement => glyph(["M5 12h.01", "M12 12h.01", "M19 12h.01"], 2.6);
const folderGlyph = (): SVGSVGElement =>
  glyph(["M3.5 7.5a2 2 0 0 1 2-2h3l2 2.5h6a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"]);
const restartGlyph = (): SVGSVGElement => glyph(["M20.5 12a8.5 8.5 0 1 1-2.5-6", "M20.5 3.5v6h-6"]);
const removeGlyph = (): SVGSVGElement =>
  glyph(["M4.5 7h15", "M9.5 7V4.8h5V7", "M6.8 7l.8 12.2h8.8L17.2 7", "M10.5 11v6", "M13.5 11v6"]);

interface WorkspaceMenuAction {
  label: string;
  icon: SVGSVGElement;
  danger?: boolean;
  run: () => void;
}

let workspaceMenuElement: HTMLDivElement | null = null;
let workspaceMenuTrigger: HTMLButtonElement | null = null;

function closeWorkspaceMenu(): void {
  if (workspaceMenuElement === null) return;
  workspaceMenuElement.remove();
  workspaceMenuElement = null;
  if (workspaceMenuTrigger !== null) {
    workspaceMenuTrigger.setAttribute("aria-expanded", "false");
    workspaceMenuTrigger = null;
  }
}

function workspaceMenuActions(workspace: WorkspaceView): WorkspaceMenuAction[] {
  const actions: WorkspaceMenuAction[] = [
    {
      label: "打开文件夹",
      icon: folderGlyph(),
      run: () => {
        void revealWorkspacePath(workspace);
      }
    }
  ];
  if (workspace.kind === "added") {
    actions.push({
      label: "重启 Agent 会话",
      icon: restartGlyph(),
      run: () => {
        void restartWorkspace(workspace.workspaceId);
      }
    });
    actions.push({
      label: "移除工作目录",
      icon: removeGlyph(),
      danger: true,
      run: () => {
        void removeWorkspace(workspace);
      }
    });
  }
  return actions;
}

function openWorkspaceMenu(trigger: HTMLButtonElement, workspace: WorkspaceView): void {
  const reopening = workspaceMenuTrigger === trigger;
  closeWorkspaceMenu();
  if (reopening) return;

  const menu = document.createElement("div");
  menu.className = "workspace-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `${workspace.label} 的更多操作`);

  for (const action of workspaceMenuActions(workspace)) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "workspace-menu-item";
    item.setAttribute("role", "menuitem");
    if (action.danger === true) item.dataset.danger = "true";
    const iconSlot = document.createElement("span");
    iconSlot.className = "workspace-menu-icon";
    iconSlot.append(action.icon);
    const text = document.createElement("span");
    text.textContent = action.label;
    item.append(iconSlot, text);
    item.addEventListener("click", () => {
      closeWorkspaceMenu();
      action.run();
    });
    menu.append(item);
  }

  document.body.append(menu);
  workspaceMenuElement = menu;
  workspaceMenuTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");

  // Fixed positioning keeps the menu outside the sidebar's scroll clip.
  const rect = trigger.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));
  const below = rect.bottom + 4;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelector<HTMLButtonElement>(".workspace-menu-item")?.focus();
}

async function revealWorkspacePath(workspace: WorkspaceView): Promise<void> {
  try {
    await requestJson<unknown>("/api/setup/workspace/reveal", {
      method: "POST",
      workspace: false,
      headers: { "x-aichatlink-setup": "1" },
      body: JSON.stringify({ path: workspace.path })
    });
  } catch (error) {
    showGlobalError(errorMessage(error));
  }
}

function renderConversationGroup(
  workspace: WorkspaceView | null,
  items: ConversationSummary[]
): void {
  // The open epoch is a boundary, not history: paint it only when the group has
  // nothing else. Otherwise deleting a row silently renames it into the “new”
  // conversation the operator did not ask for (see D-060).
  const visible = visibleConversations(items);
  const group = document.createElement("section");
  group.className = "workspace-group";
  const workspaceId = workspace?.workspaceId ?? primaryWorkspaceId;
  if (workspace !== null) {
    const collapsed = isWorkspaceCollapsed(workspace.workspaceId);
    group.dataset.workspaceId = workspace.workspaceId;
    group.dataset.status = workspace.status;
    group.dataset.active = String(workspace.workspaceId === activeWorkspaceId);
    group.dataset.collapsed = String(collapsed);

    const head = document.createElement("header");
    head.className = "workspace-group-head";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "workspace-group-toggle";
    toggle.append(chevronGlyph());
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-controls", `workspace-conversations-${workspace.workspaceId}`);
    toggle.title = `${collapsed ? "展开" : "折叠"}「${workspace.label}」的对话`;
    toggle.setAttribute("aria-label", toggle.title);
    toggle.addEventListener("click", () => {
      setWorkspaceCollapsed(workspace.workspaceId, !isWorkspaceCollapsed(workspace.workspaceId));
    });

    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.className = "workspace-group-switch";
    switchButton.title = `${workspace.label} · ${workspace.path}`;
    const dot = document.createElement("span");
    dot.className = "workspace-group-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "workspace-group-label";
    label.textContent = workspace.label;
    const pathLabel = document.createElement("span");
    pathLabel.className = "workspace-group-path";
    pathLabel.textContent = shortenWorkspacePath(workspace.path);
    const count = document.createElement("span");
    count.className = "workspace-group-count";
    // Only what the group actually shows: a directory whose conversations were
    // all deleted must not keep advertising the old total. Empty means no number.
    if (visible.length === 0) {
      count.hidden = true;
    } else {
      count.textContent = String(visible.length);
    }
    switchButton.append(dot, label, pathLabel, count);
    switchButton.addEventListener("click", () => {
      if (workspace.workspaceId !== activeWorkspaceId) {
        expandWorkspaceGroup(workspace.workspaceId);
        navigateToWorkspace(workspace.workspaceId);
      }
    });

    const actions = document.createElement("div");
    actions.className = "workspace-group-actions";

    const addConversation = document.createElement("button");
    addConversation.type = "button";
    addConversation.className = "workspace-group-action";
    addConversation.append(plusGlyph());
    const ready = workspace.status === "ready";
    addConversation.disabled = !ready;
    addConversation.title = ready
      ? `在「${workspace.label}」新建对话`
      : `「${workspace.label}」${workspace.status === "starting" ? "正在启动" : "尚未就绪"}，暂不能新建对话`;
    addConversation.setAttribute("aria-label", addConversation.title);
    addConversation.addEventListener("click", () => {
      void startNewConversation(workspace);
    });

    const more = document.createElement("button");
    more.type = "button";
    more.className = "workspace-group-action";
    more.append(moreGlyph());
    more.title = "更多操作";
    more.setAttribute("aria-label", `「${workspace.label}」的更多操作`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openWorkspaceMenu(more, workspace);
    });

    actions.append(addConversation, more);
    head.append(toggle, switchButton, actions);
    group.append(head);

    if (workspace.status === "failed") {
      const warning = document.createElement("p");
      warning.className = "workspace-group-warning";
      warning.textContent =
        workspace.errorMessage ?? "工作目录启动失败；在 ⋯ 菜单里重启，或打开配置检查 Agent 命令。";
      group.append(warning);
    }
  }

  const list = document.createElement("ul");
  list.className = "conversation-list";
  list.setAttribute("aria-label", workspace === null ? "对话列表" : `${workspace.label} 的对话`);
  if (workspace !== null) list.id = `workspace-conversations-${workspace.workspaceId}`;
  // Closed boundary artifacts never reach the client. The empty open epoch is
  // rendered only when it is the group's only row (fresh room, or every other
  // conversation was deleted); otherwise it would be the “new conversation”
  // that appears after any unrelated delete.
  for (const conversation of visible) {
    list.append(createConversationItem(workspaceId, conversation));
  }
  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "workspace-group-empty";
    empty.textContent = workspace === null ? "还没有对话" : "这个工作目录还没有对话";
    list.append(empty);
  }
  group.append(list);
  conversationGroups.append(group);
}

/**
 * The conversation the main timeline is showing right now. A replayed history
 * replaces the live epoch on screen, so selection has to follow
 * `conversationView`; keying it off `conversation.active` alone left the accent
 * parked on the first row whichever conversation was actually opened.
 */
function onScreenConversationId(): string | null {
  return conversationView?.conversation.conversationId ?? null;
}

/**
 * The directory the main timeline belongs to. The pre-hub fallback never fills
 * `activeWorkspaceId`, so an empty value means the primary one.
 */
function onScreenWorkspaceId(): string {
  return activeWorkspaceId.length === 0 ? primaryWorkspaceId : activeWorkspaceId;
}

// Conversation ids are only unique inside one directory (both the primary and an
// added directory can hold `conv:1`), so the workspace is part of the key.
function isConversationOnScreen(workspaceId: string, conversation: ConversationSummary): boolean {
  if (workspaceId !== onScreenWorkspaceId()) return false;
  const viewedId = onScreenConversationId();
  if (viewedId !== null) return viewedId === conversation.conversationId;
  // No replay open: the active directory's live epoch is what the timeline holds.
  // Every directory has its own live epoch, so `active` alone would light one row
  // in every group.
  return conversation.active;
}

/**
 * Move the selection without rebuilding the list: replay / resume / exit change
 * which conversation is on screen far more often than which ones exist. With no
 * replay open the live epoch is the one on screen, and `is-active` (written from
 * `conversation.active` at render time) already marks it.
 */
function syncConversationSelection(): void {
  const viewedId = onScreenConversationId();
  for (const item of conversationGroups.querySelectorAll<HTMLElement>(".conversation-item")) {
    const onScreen =
      viewedId === null
        ? item.dataset.workspaceId === onScreenWorkspaceId() && item.classList.contains("is-active")
        : item.dataset.workspaceId === onScreenWorkspaceId() &&
          item.dataset.conversationId === viewedId;
    item.classList.toggle("is-viewing", onScreen);
    const open = item.querySelector<HTMLButtonElement>(".conversation-open");
    if (open === null) continue;
    if (onScreen) open.setAttribute("aria-current", "true");
    else open.removeAttribute("aria-current");
  }
}

function createConversationItem(workspaceId: string, conversation: ConversationSummary): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "conversation-item";
  item.dataset.conversationId = conversation.conversationId;
  item.dataset.workspaceId = workspaceId;
  if (conversation.active) item.classList.add("is-active");
  const onScreen = isConversationOnScreen(workspaceId, conversation);
  if (onScreen) item.classList.add("is-viewing");

  const open = document.createElement("button");
  open.type = "button";
  open.className = "conversation-open";
  open.title =
    `${conversation.title} · seq ${conversation.startSeq}` +
    `${conversation.endSeq === null ? " 起" : `–${conversation.endSeq}`}` +
    (conversation.resumedFrom
      ? ` · 续自 seq ${conversation.resumedFrom.fromSeq}–${conversation.resumedFrom.throughSeq}`
      : "");
  if (onScreen) open.setAttribute("aria-current", "true");
  const title = document.createElement("span");
  title.className = "conversation-title";
  title.textContent = conversation.title;
  const meta = document.createElement("span");
  meta.className = "conversation-meta";
  const activeHere = conversation.active && workspaceId === activeWorkspaceId;
  meta.textContent = `${conversation.active ? (activeHere ? "当前 · " : "进行中 · ") : ""}${formatConversationStamp(conversation.startedAt)}`;
  open.append(title, meta);
  if (conversation.resumedFrom) {
    meta.textContent += ` · 续自 ${conversation.resumedFrom.title}`;
  }
  open.addEventListener("click", () => {
    if (workspaceId !== activeWorkspaceId) {
      navigateToWorkspace(workspaceId, conversation.conversationId);
      return;
    }
    if (conversation.active) {
      if (conversationView !== null) exitConversationView();
      return;
    }
    if (conversationView?.conversation.conversationId === conversation.conversationId) {
      return;
    }
    void enterConversationView(conversation);
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "conversation-delete";
  remove.append(removeGlyph());
  remove.title = "删除这条对话（永久）";
  remove.setAttribute("aria-label", `删除对话 ${conversation.title}`);
  remove.addEventListener("click", () => {
    void deleteConversation(workspaceId, conversation, remove);
  });

  item.append(open, remove);
  return item;
}

/** Drop a deleted row from the local projection before the next paint can rebuild it. */
function forgetConversationLocally(workspaceId: string, conversationId: string): void {
  const strip = (items: readonly ConversationSummary[]): ConversationSummary[] =>
    items.filter((item) => item.conversationId !== conversationId);
  const scoped = conversationsByWorkspace.get(workspaceId);
  if (scoped !== undefined) conversationsByWorkspace.set(workspaceId, strip(scoped));
  if (workspaceId === activeWorkspaceId) conversations = strip(conversations);
  renderConversations();
}

/**
 * Deleting a conversation removes it from the local database: the confirmation
 * is explicit about that, and the row leaves the sidebar in the same click that
 * the server acknowledged. A second click on a stale row is treated as the same
 * delete, not as an error to paint in red.
 */
async function deleteConversation(
  workspaceId: string,
  conversation: ConversationSummary,
  trigger: HTMLButtonElement
): Promise<void> {
  const scope = workspaceId === onScreenWorkspaceId() ? "" : "（另一个工作目录）";
  // The Broker refuses to delete a conversation that still has its own work in
  // flight, and its public error is the generic contract message. Say the real
  // reason here instead of letting that banner do the explaining.
  if (conversation.active && conversationView === null && runningTurnCount() > 0) {
    showGlobalError("这条对话还有任务在运行：先点「终止」，等它收尾后再删除。");
    return;
  }
  const confirmed = window.confirm(
    `删除对话「${conversation.title}」${scope}？\n\n` +
      "该对话的消息、回合与工具记录会从本地数据库永久删除，不能恢复；" +
      "Agent 已记录的记忆不会被删除。"
  );
  if (!confirmed) return;
  trigger.disabled = true;
  trigger.title = "正在删除…";
  try {
    await requestJson<unknown>(withWorkspace("/api/conversations/delete", workspaceId), {
      method: "POST",
      workspace: false,
      body: JSON.stringify({
        clientCommandId: makeClientCommandId("delete-conversation"),
        conversationId: conversation.conversationId,
        resetNativeSessions: true
      })
    });
  } catch (error) {
    // A stale row can be clicked twice. “The conversation is already gone” is
    // the second click's receipt, not a failure worth a red banner.
    if (!(error instanceof ApiFailure && error.code === "UNKNOWN_TARGET")) {
      showGlobalError(errorMessage(error));
      trigger.disabled = false;
      trigger.title = "删除这条对话（永久）";
      return;
    }
  }
  // The POST already returned (or the server had already purged it): drop the
  // row before the next render can rebuild it from the stale list.
  forgetConversationLocally(workspaceId, conversation.conversationId);
  if (conversationView?.conversation.conversationId === conversation.conversationId) {
    exitConversationView();
  } else if (
    new URL(window.location.href).searchParams.get("conv") === conversation.conversationId
  ) {
    syncViewedConversationParam(null);
  }
  await refreshConversations(workspaceId);
  if (
    conversation.active &&
    conversationView === null &&
    workspaceId === onScreenWorkspaceId()
  ) {
    // The server closed the open epoch; follow the fresh one so the live
    // timeline cannot keep showing the conversation that was just deleted. A
    // replayed history on screen stays where it is until the operator leaves.
    const active = conversations.find((candidate) => candidate.active);
    if (active !== undefined) openConversationEpoch(active.startSeq);
  }
}

async function restartWorkspace(workspaceId: string): Promise<void> {
  try {
    await requestJson<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/restart`, {
      method: "POST",
      workspace: false,
      headers: { "x-aichatlink-setup": "1" }
    });
    await refreshWorkspaces();
  } catch (error) {
    showGlobalError(errorMessage(error));
  }
}

async function removeWorkspace(workspace: WorkspaceView): Promise<void> {
  if (!window.confirm(`移除工作目录「${workspace.label}」？对话与数据会保留，只是不再同时运行。`)) {
    return;
  }
  try {
    await requestJson<unknown>(`/api/workspaces/${encodeURIComponent(workspace.workspaceId)}`, {
      method: "DELETE",
      workspace: false,
      headers: { "x-aichatlink-setup": "1" }
    });
    if (workspace.workspaceId === activeWorkspaceId) {
      navigateToWorkspace(primaryWorkspaceId);
      return;
    }
    await refreshWorkspaces();
    await refreshWorkspaceConversations();
    renderWorkspaceSwitcher();
  } catch (error) {
    showGlobalError(errorMessage(error));
  }
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.split(String.fromCharCode(92)).join("/").replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function renderWorkspaceSwitcher(): void {
  workspaceList.replaceChildren();
  for (const workspace of workspaces) {
    const item = document.createElement("li");
    item.className = "workspace-switcher-item";
    item.dataset.active = String(workspace.workspaceId === activeWorkspaceId);

    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.className = "workspace-switcher-switch";
    switchButton.title = workspace.path;
    const label = document.createElement("span");
    label.className = "workspace-switcher-label";
    label.textContent = workspace.label;
    const pathLabel = document.createElement("span");
    pathLabel.className = "workspace-switcher-path";
    pathLabel.textContent = workspace.path;
    const badge = document.createElement("span");
    badge.className = "workspace-switcher-badge";
    badge.textContent =
      workspace.kind === "primary"
        ? "主目录"
        : workspace.status === "ready"
          ? `${workspace.agentCount} 个 Agent`
          : workspace.status === "starting"
            ? "启动中"
            : workspace.status === "failed"
              ? "启动失败"
              : "未启动";
    switchButton.append(label, pathLabel, badge);
    switchButton.addEventListener("click", () => {
      if (workspace.workspaceId === activeWorkspaceId) {
        closeWorkspaceDialog();
        return;
      }
      navigateToWorkspace(workspace.workspaceId);
    });
    item.append(switchButton);

    if (workspace.kind === "added") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "workspace-switcher-remove";
      remove.textContent = "×";
      remove.title = "移除这个工作目录（数据保留）";
      remove.setAttribute("aria-label", `移除 ${workspace.label}`);
      remove.addEventListener("click", () => {
        void removeWorkspace(workspace);
      });
      item.append(remove);
    }
    workspaceList.append(item);
  }
  if (workspaces.length === 0) {
    const empty = document.createElement("li");
    empty.className = "workspace-empty";
    empty.textContent = "尚未添加其他工作目录。";
    workspaceList.append(empty);
  }
}

function openWorkspaceDialog(hint?: string): void {
  if (workspaceDialog.open) return;
  renderWorkspaceSwitcher();
  workspaceListing = null;
  workspaceShortcuts.replaceChildren();
  workspaceEntries.replaceChildren();
  workspaceUse.disabled = true;
  workspaceDialogStatus.textContent = hint ?? "";
  if (typeof workspaceDialog.showModal === "function") workspaceDialog.showModal();
  else workspaceDialog.setAttribute("open", "");
  const active = currentWorkspace();
  void loadWorkspaceListing(active?.path ?? workspaceResolved);
}

/**
 * "New room" is a different act from "new conversation": it starts an
 * independent runtime (its own database, room, and Agent processes) for another
 * directory, so the room that is currently working keeps working. The directory
 * dialog already does exactly that — it just needed to be reachable from the
 * sidebar instead of only from the composer.
 */
function startNewRoom(): void {
  openWorkspaceDialog(
    "选择一个目录：它会在新的房间里独立运行，正在进行的对话不受影响。"
  );
}

function closeWorkspaceDialog(): void {
  if (typeof workspaceDialog.close === "function") workspaceDialog.close();
  else workspaceDialog.removeAttribute("open");
}

async function loadWorkspaceListing(target?: string): Promise<void> {
  workspaceDialogStatus.textContent = "正在读取目录…";
  const query =
    target !== undefined && target.length > 0 ? `?path=${encodeURIComponent(target)}` : "";
  try {
    const payload = await requestJson<unknown>(`/api/setup/workspace${query}`, {
      workspace: false
    });
    const listing = normalizeWorkspaceListing(payload);
    if (listing === null) throw new Error("目录响应无效");
    workspaceListing = listing;
    renderWorkspaceListing();
  } catch (error) {
    workspaceListing = null;
    workspaceUse.disabled = true;
    workspaceDialogStatus.textContent = errorMessage(error);
  }
}

function renderWorkspaceListing(): void {
  const listing = workspaceListing;
  if (listing === null) return;
  workspaceDialogPath.textContent = listing.path;
  workspaceDialogPath.title = listing.path;
  workspaceUp.disabled = listing.parent === null;
  workspaceUse.disabled = workspaceDialogBusy;

  workspaceShortcuts.replaceChildren();
  for (const shortcut of listing.shortcuts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-chip";
    button.textContent = shortcut.name;
    button.title = shortcut.path;
    button.addEventListener("click", () => {
      void loadWorkspaceListing(shortcut.path);
    });
    workspaceShortcuts.append(button);
  }
  workspaceShortcuts.hidden = listing.shortcuts.length === 0;

  workspaceEntries.replaceChildren();
  if (listing.entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "workspace-empty";
    empty.textContent = "这里没有子目录；可以直接使用当前目录。";
    workspaceEntries.append(empty);
  }
  for (const entry of listing.entries) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-entry";
    button.title = entry.path;
    const name = document.createElement("span");
    name.textContent = entry.name;
    button.append(name);
    if (entry.isRepository) {
      const badge = document.createElement("span");
      badge.className = "workspace-badge";
      badge.textContent = "git";
      button.append(badge);
    }
    button.addEventListener("click", () => {
      void loadWorkspaceListing(entry.path);
    });
    item.append(button);
    workspaceEntries.append(item);
  }
  workspaceDialogStatus.textContent = listing.truncated
    ? `目录过多：仅显示前 ${listing.entries.length} 项`
    : `${listing.entries.length} 个子目录`;
}

async function addOrSwitchWorkspace(target: string): Promise<void> {
  if (workspaceDialogBusy) return;
  const existing = workspaces.find((workspace) => sameWorkspacePath(workspace.path, target));
  if (existing !== undefined) {
    navigateToWorkspace(existing.workspaceId);
    return;
  }
  workspaceDialogBusy = true;
  workspaceUse.disabled = true;
  workspaceDialogStatus.textContent = "正在添加并启动工作目录…";
  try {
    const payload = await requestJson<unknown>("/api/workspaces", {
      method: "POST",
      workspace: false,
      headers: { "x-aichatlink-setup": "1" },
      body: JSON.stringify({ path: target })
    });
    const created =
      isRecord(payload) && isRecord(payload.workspace)
        ? normalizeWorkspace(payload.workspace)
        : null;
    if (created === null) throw new Error("工作目录响应无效");
    const deadline = Date.now() + 60_000;
    for (;;) {
      await refreshWorkspaces();
      const current = workspaces.find((workspace) => workspace.workspaceId === created.workspaceId);
      if (current?.status === "ready") {
        navigateToWorkspace(current.workspaceId);
        return;
      }
      if (current?.status === "failed") {
        throw new Error(current.errorMessage ?? "工作目录启动失败");
      }
      if (Date.now() >= deadline) throw new Error("工作目录启动超时");
      workspaceDialogStatus.textContent =
        current?.status === "starting" ? "正在启动 Agent 会话…" : "等待工作目录就绪…";
      await sleep(1_500);
    }
  } catch (error) {
    workspaceDialogStatus.textContent = errorMessage(error);
    workspaceUse.disabled = false;
  } finally {
    workspaceDialogBusy = false;
  }
}

/**
 * Starts a new epoch in the active directory, or in another one straight from
 * its group header: the reset is routed with `?ws=` and the page then follows
 * the new conversation into that directory.
 */
async function startNewConversation(target?: WorkspaceView): Promise<void> {
  if (state.submitting) return;
  const workspaceId = target?.workspaceId ?? activeWorkspaceId;
  const elsewhere = target !== undefined && workspaceId !== activeWorkspaceId;
  const scope = elsewhere ? `在「${target.label}」` : "";
  const running = elsewhere ? 0 : runningTurnCount();
  // A new conversation *terminates* this room's work: the Broker replaces every
  // native session. The confirmation has to say that out loud, not hide behind
  // "上下文会重置".
  const termination = elsewhere
    ? "\n\n注意：该工作目录下正在运行的任务会被终止，未完成的回复会丢失。"
    : running > 0
      ? `\n\n注意：当前有 ${running} 个任务正在运行，继续会终止它们，未完成的回复会丢失。`
      : "";
  const confirmText = elsewhere
    ? `${scope}开始新对话？这个工作目录的当前上下文会重置，历史对话仍可在左侧查看。${termination}`
    : `开始新对话？当前上下文会重置，历史对话仍可在左侧查看。${termination}`;
  if (!window.confirm(confirmText)) return;
  newConversationButton.disabled = true;
  try {
    await requestJson<unknown>(withWorkspace("/api/context/reset", workspaceId), {
      method: "POST",
      workspace: false,
      body: JSON.stringify({
        clientCommandId: makeClientCommandId("new-conversation"),
        resetNativeSessions: true
      })
    });
    expandWorkspaceGroup(workspaceId);
    if (elsewhere) {
      navigateToWorkspace(workspaceId);
      return;
    }
    // A new epoch is live, not a replay: drop `?conv=` before repainting.
    syncViewedConversationParam(null);
    await refreshConversations();
    openConversationEpoch(activeEpochStartSeq(conversations), { repaint: false });
    await rebuildLiveEpoch();
  } catch (error) {
    showGlobalError(errorMessage(error));
  } finally {
    newConversationButton.disabled = false;
  }
}

/**
 * `?conv=` must match the replay on screen: a reload has to land on it, and
 * leaving has to drop it — otherwise the resumed page re-opens the history view
 * the operator just left.
 */
function syncViewedConversationParam(conversationId: string | null): void {
  const url = new URL(window.location.href);
  const current = url.searchParams.get("conv");
  if (conversationId === null) {
    if (current === null) return;
    url.searchParams.delete("conv");
  } else {
    if (current === conversationId) return;
    url.searchParams.set("conv", conversationId);
  }
  window.history.replaceState(null, "", url);
}

/**
 * Enter a closed conversation in the main timeline. Nothing is written yet: the
 * conversation is replayed read-only, and the first send resumes it through the
 * Broker so the Agents receive its range as the seed of a new epoch.
 */
async function enterConversationView(conversation: ConversationSummary): Promise<void> {
  conversationViewToken += 1;
  const token = conversationViewToken;
  // Save the outgoing view's draft before the URL (and therefore the scope)
  // moves, then restore this conversation's own draft.
  saveDraft();
  conversationView = { conversation, ranges: conversationRanges(conversation) };
  syncViewedConversationParam(conversation.conversationId);
  syncConversationSelection();
  syncViewingBanner();
  messageInput.focus();
  const ranges = conversationView.ranges;
  // Load the whole replay before touching the DOM: clearing first left the
  // column blank for the length of the EventSource round-trip, which read as a
  // flash on every switch.
  const played = await Promise.all(ranges.map((range) => loadEventRange(range)));
  if (token !== conversationViewToken || conversationView === null) return;
  const events = played
    .flat()
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  clearTimelineView();
  // After the view has been rebuilt: the restore rewrites the composer, and the
  // send button it syncs must see the new view's (empty) Turn bookkeeping.
  restoreDraft();
  for (const envelope of events) {
    // Events accepted live while another conversation was on screen were never
    // rendered; replaying this conversation must paint them after all.
    state.seenEventIds.delete(envelope.eventId);
    acceptEnvelope(envelope, "replay");
  }
  if (conversationView === null) return;
  settleClosedConversationTurns();
  appendConversationBoundary(`以上为「${conversation.title}」的历史记录`);
  refreshEmptyStateCopy();
  for (const pane of panes) {
    pane.follow.resume(false);
    pane.follow.scrollToLatest(false);
    syncConversationToc(pane);
  }
}

/** Replay one durable seq range without moving the live cursor. */
function loadEventRange(range: { fromSeq: number; throughSeq: number }): Promise<AIChatLinkEnvelope[]> {
  return new Promise((resolve) => {
    const collected: AIChatLinkEnvelope[] = [];
    const source = new EventSource(
      withWorkspace(
        `/api/events?afterSeq=${encodeURIComponent(String(Math.max(0, range.fromSeq - 1)))}`
      )
    );
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      source.close();
      resolve(collected);
    };
    source.onmessage = (message) => {
      try {
        const envelope = normalizeEnvelope(JSON.parse(message.data as string));
        if (envelope === null) return;
        const seq = envelope.seq;
        if (seq === null || seq < range.fromSeq) return;
        if (seq > range.throughSeq) {
          finish();
          return;
        }
        collected.push(envelope);
        if (seq >= range.throughSeq) finish();
      } catch {
        // The replay stream shares the live codec; a malformed frame is not fatal.
      }
    };
    source.onerror = finish;
    window.setTimeout(finish, 6_000);
  });
}

/**
 * A closed conversation cannot still be running. If a Turn's terminal frame is
 * missing from the replayed range (it was cut by an epoch boundary, or written
 * by a build that filed it elsewhere), "interrupted" is the honest state: a
 * forever-spinning card also holds the composer hostage.
 */
function settleClosedConversationTurns(): void {
  for (const turn of [...state.turns.values()]) {
    if (TERMINAL_TURN_STATUSES.has(turn.status)) continue;
    const settled: TurnView = { ...turn, status: "interrupted" };
    state.turns.set(turn.turnId, settled);
    releasedTurnIds.add(turn.turnId);
    renderTurn(settled);
  }
  syncAgentActivity();
}

function appendConversationBoundary(text: string): void {
  const item = document.createElement("li");
  item.className = "timeline-boundary";
  item.textContent = text;
  timeline.append(item);
  timelineEmpty.hidden = true;
  trimTimelineIfNeeded();
}

function syncViewingBanner(): void {
  const view = conversationView;
  if (view === null) {
    viewingBanner.hidden = true;
    return;
  }
  viewingBanner.hidden = false;
  if (view.conversation.active) {
    viewingBannerTitle.textContent = `正在查看「${view.conversation.title}」`;
    viewingBannerNote.textContent = "这段对话仍在进行，直接发送即可继续";
    return;
  }
  viewingBannerTitle.textContent = `正在查看「${view.conversation.title}」`;
  viewingBannerNote.textContent = "发送新消息会以这段对话为上下文，开一段新的继续对话";
}

/** Leave the replayed conversation and return to the live epoch. */
function exitConversationView(): void {
  if (conversationView === null) return;
  saveDraft();
  conversationView = null;
  conversationViewToken += 1;
  syncViewedConversationParam(null);
  syncConversationSelection();
  viewingBanner.hidden = true;
  void rebuildLiveEpoch();
}

/**
 * Repaint the live epoch in place. A reload shows the same transcript, but it
 * also flashes the whole shell and throws away the SSE cursor for a swap that
 * never left this room. Workspace switches still reload (D-041): their seq space
 * is a different one.
 */
async function rebuildLiveEpoch(): Promise<void> {
  const token = conversationViewToken;
  const buffered: AIChatLinkEnvelope[] = [];
  liveEnvelopeBuffer = buffered;
  try {
    const decoded = await requestJson<unknown>("/api/bootstrap");
    if (!isRecord(decoded)) {
      throw new ApiFailure("INVALID_BOOTSTRAP", "bootstrap 响应不是对象", 500);
    }
    // A rebuild is a fresh page as far as the timeline is concerned: retired
    // turns come back from the replay window, not from the view being replaced.
    retiredTurnIds.clear();
    if (!(await paintLiveEpoch(decoded, () => token === conversationViewToken))) {
      liveEnvelopeBuffer = null;
      return;
    }
    restoreDraft();
    for (const pane of panes) {
      pane.follow.resume(false);
      pane.follow.scrollToLatest(false);
      syncConversationToc(pane);
    }
    void refreshConversations();
    void refreshContextUsage();
  } catch {
    // The in-place path is an optimization; the reload is the proven one.
    liveEnvelopeBuffer = null;
    window.location.reload();
    return;
  }
  liveEnvelopeBuffer = null;
  for (const envelope of buffered) {
    acceptEnvelope(envelope, "live");
  }
}

function appendResumeBoundary(conversation: ConversationSummary): void {
  const source = conversation.resumedFrom;
  appendConversationBoundary(
    source
      ? `从「${source.title}」继续 · 以上为原对话记录`
      : "以上为历史记录"
  );
}

/** Only what the operator sent: the index is a table of contents, not a log. */
function userPromptEntries(pane: PaneContext | null = activePane): Array<{
  eventId: string;
  content: string;
}> {
  const entries: Array<{ eventId: string; content: string }> = [];
  if (pane === null) return entries;
  for (const envelope of state.messages.values()) {
    if (envelope.actor.kind !== "user") continue;
    // A collapsed (trimmed) bubble has no node left to jump to, so it is not an
    // index entry: every number in the panel must land inside this pane.
    if (!pane.eventNodes.has(envelope.eventId)) continue;
    const content = messageContent(envelope.body).replace(/\s+/gu, " ").trim();
    if (content.length === 0) continue;
    entries.push({ eventId: envelope.eventId, content });
  }
  return entries;
}

/**
 * One index per pane. A lane pane lists the operator prompts that pane shows, so
 * a number can never point at a node another pane drew.
 */
function renderConversationToc(pane: PaneContext | null = activePane): void {
  if (pane === null) return;
  const entries = userPromptEntries(pane);
  const toc = pane.shell.toc;
  toc.button.hidden = entries.length === 0;
  if (!pane.tocOpen) return;
  toc.list.replaceChildren();
  for (const [index, entry] of entries.entries()) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toc-item";
    button.title = entry.content;
    const badge = document.createElement("span");
    badge.className = "toc-index";
    badge.textContent = String(index + 1);
    const snippet = document.createElement("span");
    snippet.className = "toc-snippet";
    snippet.textContent =
      entry.content.length > 160 ? `${entry.content.slice(0, 160)}…` : entry.content;
    button.append(badge, snippet);
    button.addEventListener("click", () => {
      setConversationTocOpen(false, pane);
      jumpToEvent(entry.eventId, pane);
    });
    item.append(button);
    toc.list.append(item);
  }
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "toc-empty";
    empty.textContent = "这段对话里还没有你发送的消息。";
    toc.list.append(empty);
  }
}

/** Only one index is open at a time; opening another pane's closes the first. */
function setConversationTocOpen(open: boolean, pane: PaneContext | null = activePane): void {
  if (pane === null) return;
  if (open) {
    for (const other of panes) {
      if (other !== pane) setConversationTocOpen(false, other);
    }
  }
  const toc = pane.shell.toc;
  pane.tocOpen = open;
  toc.panel.hidden = !open;
  toc.button.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderConversationToc(pane);
}

/** Keep one pane's index in step with its rendered prompts. */
function syncConversationToc(pane: PaneContext | null = activePane): void {
  if (pane === null) return;
  pane.shell.toc.button.hidden = userPromptEntries(pane).length === 0;
  if (pane.tocOpen) renderConversationToc(pane);
}

function jumpToNode(target: HTMLElement, pane: PaneContext = panes[0]!): void {
  pane.follow.pause();
  pane.follow.markProgrammatic();
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("is-highlighted");
  window.setTimeout(() => target.classList.remove("is-highlighted"), 1_400);
}

function jumpToEvent(eventId: string, pane: PaneContext = panes[0]!): void {
  const target = pane?.eventNodes.get(eventId);
  if (!target) {
    // The bubble was collapsed between painting the panel and the click.
    renderConversationToc(pane);
    return;
  }
  jumpToNode(target, pane);
}

/** The agent rail only ever jumps to a message that still has a node. */
function latestVisibleMessageEventId(
  actorId: string,
  pane: PaneContext = panes[0]!
): string | null {
  let latest: string | null = null;
  for (const envelope of state.messages.values()) {
    if (envelope.type !== "message.created" || envelope.actor.actorId !== actorId) continue;
    if (pane.eventNodes.has(envelope.eventId)) latest = envelope.eventId;
  }
  return latest;
}

/** Prefer the lane that already watches this Agent; fall back to the room. */
function paneForAgent(actorId: string): PaneContext {
  return (
    panes.find((pane) => pane.lens.kind === "agent" && pane.lens.actorId === actorId) ?? panes[0]!
  );
}

/**
 * Clicking an agent answers "show me what just happened". A completed Turn ends
 * in its new reply; an abnormal ending has no reply, so it targets the turn card
 * itself (the rail's title already says why).
 */
function jumpToAgentLatest(actorId: string): void {
  const agent = state.agents.get(actorId);
  if (!agent) return;
  const finished = finishedAgents.get(actorId);
  finishedAgents.delete(actorId);
  syncAgentActivity();
  const pane = paneForAgent(actorId);
  const turnCard = finished === undefined ? undefined : pane.turnNodes.get(finished.turnId);
  if (finished !== undefined && finished.status !== "completed" && turnCard !== undefined) {
    jumpToNode(turnCard, pane);
    return;
  }
  const eventId = latestVisibleMessageEventId(actorId, pane);
  if (eventId !== null) {
    jumpToEvent(eventId, pane);
    return;
  }
  setComposerStatus(`「${agent.displayName}」在本对话还没有可见回复`);
}

function renderTargetChips(): void {
  const existing = Array.from(targetPicker.querySelectorAll<HTMLInputElement>('input[name="target"]'));
  const initialized = existing.length > 0;
  const previouslyChecked = new Set(existing.filter((input) => input.checked).map((input) => input.value));
  for (const chip of Array.from(targetPicker.querySelectorAll(".target-chip[data-agent]"))) {
    chip.remove();
  }
  for (const agent of orderedAgents()) {
    const label = document.createElement("label");
    label.className = `target-chip ${cardToneClass(agent.actorId)}`;
    label.dataset.agent = agent.actorId;
    const input = document.createElement("input");
    input.name = "target";
    input.type = "checkbox";
    input.value = agent.actorId;
    input.checked = initialized ? previouslyChecked.has(agent.actorId) : agent.enabled;
    input.addEventListener("change", () => {
      syncTargetAll();
      invalidatePendingSubmission();
    });
    const text = document.createElement("span");
    text.textContent = `@${agent.displayName}`;
    label.append(input, text);
    targetPicker.append(label);
  }
  syncTargetAvailability();
}

function renderAgents(): void {
  agentList.replaceChildren();
  const ordered = orderedAgents();
  let available = 0;
  for (const agent of ordered) {
    const disabled = !agent.enabled;
    const statusValue = disabled ? "disabled" : agent.status;
    const item = document.createElement("li");
    item.className = `roster-agent ${actorToneClass(agent.actorId)}`;
    item.dataset.actorId = agent.actorId;
    if (disabled) item.dataset.disabled = "true";
    item.title = [
      agent.displayName,
      driverLabel(agent.driver, agent.piDriver),
      disabled ? "已停用" : humanStatus(agent.status),
      agent.cwd || workspaceResolved
    ]
      .filter((part) => part.length > 0)
      .join(" · ");

    const avatar = document.createElement("span");
    avatar.className = "roster-avatar";
    avatar.textContent = agentMonogram(agent.displayName);
    avatar.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "roster-name";
    name.textContent = agent.displayName;

    const status = document.createElement("span");
    status.className = "roster-status";
    status.dataset.status = statusValue;
    status.title = disabled ? "已停用" : humanStatus(agent.status);
    status.setAttribute("aria-hidden", "true");

    // Clicking who you are talking to is the shortcut: the next message goes to
    // that Agent alone. `@all` and multi-select stay in the picker, unprompted.
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "roster-select";
    choose.title = disabled
      ? `${agent.displayName} 已停用`
      : `点一下：下一条消息只发给 ${agent.displayName}`;
    choose.setAttribute("aria-label", `发送给 ${agent.displayName}`);
    choose.disabled = disabled;
    choose.append(avatar, name, status);
    choose.addEventListener("click", () => selectAgentTarget(agent.actorId));

    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "roster-action";
    restart.textContent = "⟳";
    restart.title = `重启 ${agent.displayName}`;
    restart.setAttribute("aria-label", `重启 ${agent.displayName}`);
    restart.disabled =
      !agent.enabled || agent.status === "restarting" || agent.status === "pending_restart";
    restart.addEventListener("click", (event) => {
      event.stopPropagation();
      void restartAgent(agent.actorId);
    });

    const config = document.createElement("a");
    config.className = "roster-action";
    config.href = "/setup";
    config.textContent = "⚙";
    config.title = `配置 ${agent.displayName}（driver / 身份 / 工作目录）`;
    config.setAttribute("aria-label", `配置 ${agent.displayName}`);

    item.append(choose, restart, config);
    agentList.append(item);
    if (
      agent.enabled &&
      !["failed", "offline", "stopped", "unknown", "pending_restart"].includes(agent.status)
    ) {
      available += 1;
    }
  }
  agentCount.textContent = `${available} / ${ordered.length}`;
  agentCount.title = `${available} 个可用 / 共 ${ordered.length} 个 Agent`;
  renderTargetChips();
  renderComposerAgents();
  reconcilePanesWithRoster();
}

function agentMonogram(displayName: string): string {
  const name = displayName.trim();
  if (name.length === 0) return "?";
  return /^[\x00-\x7f]/u.test(name) ? name.slice(0, 2).toUpperCase() : name.slice(0, 1);
}

/* ------------------------------------------------------------------ panes */
/*
 * One inserted pane = one view of the same live state. `panes[0]` is the static
 * #timeline element (so the single-pane baseline keeps its ids and geometry);
 * every other pane is created by pane-view.ts. Rendering functions read the
 * module-level aliases below; usePaneContext() points them at one pane at a time.
 */

interface PaneContext {
  id: string;
  lens: PaneLens;
  shell: PaneShell;
  timeline: HTMLOListElement;
  empty: HTMLLIElement;
  follow: ReturnType<typeof createLatestFollower>;
  eventNodes: Map<string, HTMLElement>;
  turnNodes: Map<string, HTMLElement>;
  streamNodes: Map<string, HTMLElement>;
  toolProgressNodes: Map<string, { node: HTMLElement; snapshot: unknown }>;
  trimCount: number;
  trimNotice: HTMLLIElement | null;
  lastDate: string;
  pendingNew: number;
  /** This pane's message index is open; only one pane keeps it open. */
  tocOpen: boolean;
}

let panes: PaneContext[] = [];
let activePane: PaneContext | null = null;
/** Layout is only reconciled with the roster once bootstrap has loaded it. */
let paneRosterReady = false;

function isSingleRoomMode(): boolean {
  return panes.length === 1 && panes[0]!.lens.kind === "room";
}

/**
 * Every pane owns a floating "back to latest" arrow; the lane header no longer
 * carries a second one. The arrow is projected from that pane's follow state.
 */
function paneJumpControl(pane: PaneContext): {
  button: HTMLButtonElement;
  count: HTMLSpanElement;
} {
  return { button: pane.shell.toc.jump, count: pane.shell.toc.jumpCount };
}

/** Project this pane's follow state onto whichever control is currently visible. */
function renderPaneJumpState(pane: PaneContext): void {
  const nearBottom = pane.follow.isNearBottom();
  if (nearBottom) {
    pane.pendingNew = 0;
  }
  if (activePane === pane) {
    newWhileScrolledUp = pane.pendingNew;
  }
  const control = paneJumpControl(pane);
  control.button.hidden = nearBottom;
  control.count.hidden = pane.pendingNew === 0;
  control.count.textContent = pane.pendingNew > 99 ? "99+" : String(pane.pendingNew);
  const label =
    pane.pendingNew > 0 ? `回到最新进度 · ${pane.pendingNew} 条新消息` : "回到最新进度";
  control.button.title = label;
  control.button.setAttribute("aria-label", label);
}

/**
 * Point every pane-scoped alias at one pane. Save the outgoing pane's scalar
 * state first: the render functions below were written against a single
 * timeline and must not need a rewrite just to become per-pane.
 */
function usePaneContext(pane: PaneContext): void {
  if (activePane === pane) {
    return;
  }
  if (activePane !== null) {
    activePane.trimCount = trimmedItemCount;
    activePane.trimNotice = trimNoticeNode;
    activePane.lastDate = lastTimelineDate;
    activePane.pendingNew = newWhileScrolledUp;
  }
  activePane = pane;
  timeline = pane.timeline;
  timelineEmpty = pane.empty;
  eventNodes = pane.eventNodes;
  turnNodes = pane.turnNodes;
  streamNodes = pane.streamNodes;
  toolProgressNodes = pane.toolProgressNodes;
  roomFollow = pane.follow;
  trimmedItemCount = pane.trimCount;
  trimNoticeNode = pane.trimNotice;
  lastTimelineDate = pane.lastDate;
  newWhileScrolledUp = pane.pendingNew;
  const jump = paneJumpControl(pane);
  jumpLatest = jump.button;
  jumpLatestCount = jump.count;
  renderPaneJumpState(pane);
}

function makePaneContext(shell: PaneShell, lens: PaneLens): PaneContext {
  const pane: PaneContext = {
    id: shell.section.dataset.paneId ?? "pane",
    lens,
    shell,
    timeline: shell.timeline,
    empty: shell.empty,
    follow: createLatestFollower(shell.timeline, {
      onResume() {
        pane.pendingNew = 0;
        renderPaneJumpState(pane);
      }
    }),
    eventNodes: new Map(),
    turnNodes: new Map(),
    streamNodes: new Map(),
    toolProgressNodes: new Map(),
    trimCount: 0,
    trimNotice: null,
    lastDate: "",
    pendingNew: 0,
    tocOpen: false
  };
  shell.select.addEventListener("change", () => {
    const index = panes.indexOf(pane);
    if (index < 0) return;
    const lenses = panes.map((item) => item.lens);
    lenses[index] = parsePaneLens(shell.select.value) ?? roomLens();
    applyPanes(lenses);
  });
  shell.close.addEventListener("click", () => {
    const index = panes.indexOf(pane);
    if (index >= 0) removePaneAt(index);
  });
  shell.toc.button.addEventListener("click", (event) => {
    event.stopPropagation();
    setConversationTocOpen(!pane.tocOpen, pane);
  });
  shell.toc.close.addEventListener("click", () => setConversationTocOpen(false, pane));
  shell.toc.jump.addEventListener("click", () => pane.follow.resume());
  shell.timeline.addEventListener("scroll", () => renderPaneJumpState(pane), { passive: true });
  observeTimelineGrowth(shell.timeline, () => {
    if (!pane.follow.isPaused()) pane.follow.followIfAllowed();
    renderPaneJumpState(pane);
  });
  return pane;
}

function paneLensLabel(lens: PaneLens): string {
  if (lens.kind === "room") {
    return "房间（全部）";
  }
  const agent = state.agents.get(lens.actorId);
  return agent?.displayName ?? lens.actorId.replace(/^agent:/u, "");
}

/** Head chrome + picker options for every pane. */
function syncPaneHeaders(): void {
  if (panes.length === 0) {
    return;
  }
  const agents = orderedAgents();
  const working = new Set(workingActorIds());
  panes.forEach((pane, index) => {
    const shell = pane.shell;
    const value = formatPaneLens(pane.lens);
    fillPaneLensOptions(shell.select, agents, value);
    shell.select.value = value;
    shell.section.setAttribute("aria-label", `窗格 ${index + 1}：${paneLensLabel(pane.lens)}`);
    if (pane.lens.kind === "agent") {
      const agent = state.agents.get(pane.lens.actorId);
      shell.avatar.textContent = agent ? agentMonogram(agent.displayName) : "?";
      shell.avatar.className = `pane-avatar ${agent ? actorToneClass(agent.actorId) : ""}`;
      shell.state.hidden = false;
      const statusValue =
        agent === undefined
          ? "missing"
          : !agent.enabled
            ? "disabled"
            : working.has(agent.actorId)
              ? "working"
              : agent.status;
      shell.state.dataset.state = statusValue;
      const statusText =
        agent === undefined
          ? "不在名册"
          : !agent.enabled
            ? "已停用"
            : working.has(agent.actorId)
              ? "正在工作"
              : humanStatus(agent.status);
      shell.state.title = `${paneLensLabel(pane.lens)} · ${statusText}`;
    } else {
      shell.avatar.textContent = "房";
      shell.avatar.className = "pane-avatar";
      shell.state.hidden = true;
      shell.state.dataset.state = "room";
    }
  });
}

/** A removed Agent must not leave a dead lane behind; a disabled one may stay. */
function reconcilePanesWithRoster(): void {
  if (!paneRosterReady || panes.length === 0) {
    return;
  }
  const lenses = panes.map((pane) =>
    pane.lens.kind === "agent" && !state.agents.has(pane.lens.actorId) ? roomLens() : pane.lens
  );
  const changed = lenses.some(
    (lens, index) => formatPaneLens(lens) !== formatPaneLens(panes[index]!.lens)
  );
  if (changed) {
    applyPanes(lenses);
  } else {
    syncPaneHeaders();
  }
}

function readStoredPanes(): PaneLens[] {
  try {
    const raw = localStorage.getItem(PANES_STORAGE_KEY);
    if (raw === null) {
      return defaultPanes().lenses;
    }
    return normalizePanes(JSON.parse(raw) as unknown).lenses;
  } catch {
    return defaultPanes().lenses;
  }
}

function persistPanes(): void {
  try {
    localStorage.setItem(
      PANES_STORAGE_KEY,
      JSON.stringify({
        count: panes.length,
        lenses: panes.map((pane) => formatPaneLens(pane.lens))
      })
    );
  } catch {
    // localStorage may be unavailable; the layout still works for this session.
  }
}

function layoutPanes(): void {
  const spans = paneSpans(panes.length);
  paneGrid.style.gridTemplateColumns = `repeat(${PANE_TRACKS}, minmax(0, 1fr))`;
  panes.forEach((pane, index) => {
    pane.shell.section.style.gridColumn = `span ${spans[index] ?? PANE_TRACKS}`;
  });
}

function syncPaneChrome(): void {
  document.documentElement.dataset.panes = isSingleRoomMode() ? "single-room" : "grid";
  paneGrid.dataset.count = String(Math.max(1, panes.length));
  layoutPanes();
  for (const pane of panes) {
    pane.shell.close.hidden = panes.length <= 1;
    pane.shell.close.setAttribute("aria-label", `关闭窗格 ${paneLensLabel(pane.lens)}`);
    renderPaneJumpState(pane);
    syncConversationToc(pane);
  }
  syncJumpLatestGeometry();
  syncPaneActionGeometry();
}

function clearPaneDom(pane: PaneContext): void {
  usePaneContext(pane);
  for (const node of Array.from(pane.timeline.children)) {
    if (node === pane.empty) {
      continue;
    }
    cleanupRemovedItem(node);
    node.remove();
  }
  if (!pane.empty.isConnected) {
    pane.timeline.append(pane.empty);
  }
  pane.empty.hidden = false;
  pane.eventNodes.clear();
  pane.turnNodes.clear();
  pane.streamNodes.clear();
  pane.toolProgressNodes.clear();
  trimmedItemCount = 0;
  trimNoticeNode = null;
  lastTimelineDate = "";
  newWhileScrolledUp = 0;
  pane.trimCount = 0;
  pane.trimNotice = null;
  pane.lastDate = "";
  pane.pendingNew = 0;
  setConversationTocOpen(false, pane);
  syncConversationToc(pane);
  renderPaneJumpState(pane);
}

/** Rebuild one pane from the bounded log, in the order the room saw it. */
function repaintPane(pane: PaneContext): void {
  clearPaneDom(pane);
  usePaneContext(pane);
  for (const entry of state.paneLog) {
    if (!lensAccepts(pane.lens, entry.envelope, entry.targetActorId)) {
      continue;
    }
    paintEnvelope(entry.envelope);
  }
  refreshPaneEmptyCopy(pane);
  syncConversationToc(pane);
  if (panes.length > 0) {
    usePaneContext(panes[0]!);
  }
  pane.follow.resume(true);
}

function applyPanes(nextLenses: PaneLens[]): void {
  const lenses = nextLenses.slice(0, MAX_PANES);
  if (lenses.length === 0) {
    lenses.push(roomLens());
  }

  const created = new Set<PaneContext>();
  while (panes.length < lenses.length) {
    const shell = createPaneShell({ id: `pane-${panes.length}`, primary: false });
    paneGrid.append(shell.section);
    const pane = makePaneContext(shell, roomLens());
    panes.push(pane);
    created.add(pane);
  }
  while (panes.length > lenses.length) {
    const removed = panes.pop();
    if (removed === undefined) {
      break;
    }
    if (activePane === removed) {
      activePane = null;
    }
    removed.shell.section.remove();
  }

  panes.forEach((pane, index) => {
    const lens = lenses[index] ?? roomLens();
    const changed = formatPaneLens(pane.lens) !== formatPaneLens(lens);
    pane.lens = lens;
    if (created.has(pane) || changed) {
      repaintPane(pane);
    }
  });

  syncPaneChrome();
  syncPaneHeaders();
  if (panesDialog.open) {
    renderPanesDialog();
  }
  persistPanes();
}

function removePaneAt(index: number): void {
  const lenses = panes
    .map((pane) => pane.lens)
    .filter((_, current) => current !== index);
  applyPanes(lenses.length === 0 ? [roomLens()] : lenses);
}

function resizePanes(count: number): PaneLens[] {
  const target = Math.min(MAX_PANES, Math.max(1, count));
  const lenses = panes.map((pane) => pane.lens).slice(0, target);
  while (lenses.length < target) {
    const used = new Set(
      lenses
        .filter(
          (lens): lens is { kind: "agent"; actorId: string } => lens.kind === "agent"
        )
        .map((lens) => lens.actorId)
    );
    const next = orderedAgents().find((agent) => !used.has(agent.actorId));
    lenses.push(next ? { kind: "agent", actorId: next.actorId } : roomLens());
  }
  return lenses;
}

function panesForAllAgents(): PaneLens[] {
  const eligible = orderedAgents().filter(railEligible);
  const agents = eligible.length > 0 ? eligible : orderedAgents();
  if (agents.length === 0) {
    return [roomLens()];
  }
  return agents.slice(0, MAX_PANES).map((agent) => ({ kind: "agent", actorId: agent.actorId }));
}

function renderPanesDialog(): void {
  for (const button of Array.from(
    panesLayouts.querySelectorAll<HTMLButtonElement>(".panes-layout")
  )) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.count) === panes.length));
  }
  const lanes = panes.filter((pane) => pane.lens.kind === "agent").length;
  panesStatus.textContent =
    `${panes.length} 个窗格 · ${lanes} 个 Agent 车道` +
    (panes.length >= 5 ? " · 多格用于监看进度，长文请单独放大或回单窗格" : "");

  panesAssignments.replaceChildren();
  const agents = orderedAgents();
  panes.forEach((pane, index) => {
    const row = document.createElement("li");
    row.className = "panes-assignment";
    const label = document.createElement("span");
    label.className = "panes-assignment-index";
    label.textContent = `窗格 ${index + 1}`;
    const select = document.createElement("select");
    select.setAttribute("aria-label", `窗格 ${index + 1} 显示内容`);
    fillPaneLensOptions(select, agents, formatPaneLens(pane.lens));
    select.addEventListener("change", () => {
      const lenses = panes.map((item) => item.lens);
      lenses[index] = parsePaneLens(select.value) ?? roomLens();
      applyPanes(lenses);
    });
    row.append(label, select);
    panesAssignments.append(row);
  });
}

function openPanesDialog(): void {
  renderPanesDialog();
  if (typeof panesDialog.showModal === "function") {
    panesDialog.showModal();
  } else {
    panesDialog.setAttribute("open", "");
  }
}

function closePanesDialog(): void {
  if (typeof panesDialog.close === "function") {
    panesDialog.close();
  } else {
    panesDialog.removeAttribute("open");
  }
}

function bindPanesUi(): void {
  panesToggle.addEventListener("click", openPanesDialog);
  panesClose.addEventListener("click", closePanesDialog);
  panesLayouts.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest<HTMLButtonElement>(".panes-layout");
    if (button === null) return;
    applyPanes(resizePanes(Number(button.dataset.count)));
  });
  panesFillAgents.addEventListener("click", () => {
    applyPanes(panesForAllAgents());
  });
  panesReset.addEventListener("click", () => {
    applyPanes([roomLens()]);
  });
  panesOpenWindow.addEventListener("click", () => {
    window.open(window.location.href, "_blank", "noopener");
  });
}

function initPanes(): void {
  const primaryShell = createPaneShell({
    id: "pane-0",
    primary: true,
    timeline: byId<HTMLOListElement>("timeline"),
    empty: byId<HTMLLIElement>("timeline-empty")
  });
  const primary = makePaneContext(primaryShell, roomLens());
  panes = [primary];
  activePane = null;
  usePaneContext(primary);
  bindPanesUi();
  applyPanes(readStoredPanes());
  usePaneContext(primary);
}

/** A pending restart still appears in the roster, but it cannot accept work. */
function railEligible(agent: AgentView): boolean {
  return agent.enabled && agent.status !== "pending_restart";
}

/**
 * The right-hand activity rail. This is a work monitor, not a second roster:
 * membership is limited to agents that can actually accept work, and the only
 * verbs are "spin while busy" and "jump to what it just produced".
 */
function renderComposerAgents(): void {
  const agents = orderedAgents().filter(railEligible);
  const signature = agents
    .map((agent) => `${agent.actorId}\u0000${agent.displayName}`)
    .join("\u0001");
  if (signature !== composerRailSignature) {
    composerRailSignature = signature;
    composerAgents.replaceChildren();
    // Two rows, readable order: row 1 is agents 1..k, row 2 is k+1..N.
    composerAgents.style.setProperty(
      "--rail-cols",
      String(agents.length === 0 ? 0 : Math.ceil(agents.length / 2))
    );
    for (const agent of agents) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `composer-agent ${cardToneClass(agent.actorId)}`;
      button.dataset.agent = agent.actorId;
      const ring = document.createElement("span");
      ring.className = "composer-agent-ring";
      ring.setAttribute("aria-hidden", "true");
      const monogram = document.createElement("span");
      monogram.className = "composer-agent-monogram";
      monogram.textContent = agentMonogram(agent.displayName);
      monogram.setAttribute("aria-hidden", "true");
      button.append(ring, monogram);
      button.addEventListener("click", () => jumpToAgentLatest(agent.actorId));
      composerAgents.append(button);
    }
  }
  composerAgents.hidden = agents.length === 0;
  syncAgentActivity();
  syncJumpLatestGeometry();
}

/** Project the current view's Turns onto the send button and the rail. */
function syncAgentActivity(): void {
  const railAgents = orderedAgents().filter(railEligible);
  const railIds = new Set(railAgents.map((agent) => agent.actorId));
  const working = new Set(workingActorIds());
  for (const button of Array.from(
    composerAgents.querySelectorAll<HTMLButtonElement>(".composer-agent")
  )) {
    const actorId = button.dataset.agent ?? "";
    if (!railIds.has(actorId)) {
      button.remove();
      continue;
    }
    const agent = state.agents.get(actorId);
    if (!agent) continue;
    const isWorking = working.has(actorId);
    // A fresh Turn makes the previous finish dot stale: the icon is spinning
    // again, so keeping the dot would show two contradictory states.
    if (isWorking) finishedAgents.delete(actorId);
    const finished = finishedAgents.get(actorId);
    button.dataset.working = isWorking ? "true" : "false";
    if (finished === undefined) delete button.dataset.finished;
    else button.dataset.finished = finished.status;
    button.setAttribute("aria-busy", String(isWorking));
    const statusLabel = isWorking
      ? "正在工作"
      : finished === undefined
        ? humanStatus(agent.status)
        : humanStatus(finished.status);
    button.title = `${agent.displayName} · ${statusLabel}`;
    button.setAttribute("aria-label", `查看 ${agent.displayName} 的最新回复（${statusLabel}）`);
  }
  // A disabled/removed agent keeps no orphaned mark. Iterate a copy: delete
  // during Map iteration is legal, but the copy makes the intent explicit.
  for (const actorId of Array.from(finishedAgents.keys())) {
    if (!railIds.has(actorId)) finishedAgents.delete(actorId);
  }
  // Watchdog, not a feature: an eligible Agent with an in-flight Turn must own a
  // spinning ring. If a future change routes Turns around this projection again,
  // the console says so instead of silently shipping a still rail.
  const expected = [...working].filter((actorId) => railIds.has(actorId));
  if (
    expected.length > 0 &&
    composerAgents.querySelector('.composer-agent[data-working="true"]') === null
  ) {
    console.warn("[aichatlink] activity rail missing a working ring", {
      working: expected,
      rail: Array.from(composerAgents.querySelectorAll<HTMLElement>(".composer-agent")).map(
        (item) => item.dataset.agent ?? ""
      )
    });
  }
  syncSendButton();
}

function announceAgentActivity(actorId: string, status: string): void {
  const agent = state.agents.get(actorId);
  if (!agent || !railEligible(agent)) return;
  agentActivityLive.textContent = `「${agent.displayName}」${humanStatus(status)}`;
}

function syncTargetAvailability(): void {
  for (const input of targetInputs()) {
    const agent = state.agents.get(input.value);
    const unavailable = agent?.enabled === false || agent?.status === "pending_restart";
    input.disabled = state.submitting || unavailable;
    if (unavailable) {
      input.checked = false;
    }
  }
  syncTargetAll();
}

function syncTargetAll(): void {
  const selectableTargets = targetInputs().filter((input) => state.agents.get(input.value)?.enabled !== false);
  targetAll.checked = selectableTargets.length > 0 && selectableTargets.every((input) => input.checked);
  targetAll.indeterminate = selectableTargets.some((input) => input.checked) && !targetAll.checked;
  targetAll.disabled = state.submitting || selectableTargets.length === 0;
  updateTargetSummary(selectableTargets);
}

/** The collapsed composer only shows who the next message goes to. */
function updateTargetSummary(selectable = targetInputs()): void {
  const selected = selectable.filter((input) => input.checked && !input.disabled);
  if (selected.length === 0) {
    targetSummary.textContent = "未选 Agent";
    targetSummary.title = "尚未选择接收者";
  } else if (selected.length === selectable.length) {
    targetSummary.textContent = "@all";
    targetSummary.title = `全部 ${selected.length} 个 Agent`;
  } else {
    const names = selected.map((input) => {
      const agent = state.agents.get(input.value);
      return `@${agent?.displayName ?? input.value.replace(/^agent:/u, "")}`;
    });
    targetSummary.textContent = names.join("、");
    targetSummary.title = names.join("、");
  }
  markRosterTarget(selected);
}

/** Mirror a sole recipient back onto the roster so the click is visible. */
function markRosterTarget(selected: ReadonlyArray<HTMLInputElement>): void {
  const sole = selected.length === 1 ? selected[0]?.value : undefined;
  for (const item of Array.from(agentList.querySelectorAll<HTMLElement>(".roster-agent"))) {
    const current = sole !== undefined && item.dataset.actorId === sole;
    if (current) item.dataset.target = "true";
    else delete item.dataset.target;
  }
}

/**
 * Roster click = "talk to this one". It replaces the whole recipient set rather
 * than toggling, so a stale `@all` can never survive the click; coming back to
 * `@all` is an explicit click in the picker.
 */
function selectAgentTarget(actorId: string): void {
  const inputs = targetInputs();
  const chosen = inputs.find((input) => input.value === actorId);
  if (chosen === undefined || chosen.disabled) return;
  for (const input of inputs) input.checked = input === chosen;
  syncTargetAll();
  invalidatePendingSubmission();
}

function setTargetPickerOpen(open: boolean): void {
  targetPicker.hidden = !open;
  targetToggle.setAttribute("aria-expanded", String(open));
  if (!open) return;
  const first = targetInputs().find((input) => !input.disabled);
  first?.focus();
}

/** Agent ids that still hold the composer: in flight and not yet released by a stop. */
function workingActorIds(): string[] {
  return activeTurnActorIds(state.turns.values(), { releasedTurnIds });
}

/** Turns in this view that have not reached a terminal status (what a reset ends). */
function runningTurnCount(): number {
  let count = 0;
  for (const turn of state.turns.values()) {
    if (!TERMINAL_TURN_STATUSES.has(turn.status)) count += 1;
  }
  return count;
}

/** The current conversation, not another workspace or a replayed history. */
function isRoomWorking(): boolean {
  return conversationView === null && workingActorIds().length > 0;
}

function syncSendButton(): void {
  const workingCount = state.submitting ? 0 : workingActorIds().length;
  const next = sendButtonState({
    submitting: state.submitting,
    workingCount,
    draftLength: messageInput.value.trim().length,
    stopping: stopInFlight
  });
  sendButton.disabled = next.disabled;
  sendButton.dataset.mode = next.mode;
  // The ring means "work is happening right now". An idle composer with an empty
  // draft is disabled, not busy, so it must keep the paper plane (D-053).
  sendButton.classList.toggle("is-working", next.spinning);
  sendButton.setAttribute("aria-busy", String(next.ariaBusy));
  sendButton.title = next.title;
  sendButton.setAttribute("aria-label", next.ariaLabel);
  if (sendLabel.textContent !== next.label) sendLabel.textContent = next.label;
  // The blocked-Enter hint and the stop acknowledgement must not outlive the
  // lock that produced them, or the bar would say "still working" next to an
  // enabled send button.
  if (next.mode === "send" || next.mode === "blocked") {
    const text = composerStatus.textContent;
    if (text === BUSY_SEND_STATUS || text === STOP_ACK_STATUS || text === STOP_RETRY_STATUS) {
      setComposerStatus("");
    }
  }
}

function setComposerBusy(busy: boolean): void {
  messageInput.disabled = busy;
  syncSendButton();
  clearReplyButton.disabled = busy;
  syncTargetAvailability();
}

async function restartAgent(actorId: string): Promise<void> {
  const agent = state.agents.get(actorId);
  if (
    !agent ||
    !agent.enabled ||
    agent.status === "restarting" ||
    agent.status === "pending_restart"
  ) {
    return;
  }
  const retryKey = `restart:${actorId}`;
  state.agents.set(actorId, { ...agent, status: "restarting" });
  renderAgents();
  try {
    await requestJson<unknown>(`/api/agents/${encodeURIComponent(actorId)}/restart`, {
      method: "POST",
      body: JSON.stringify({ clientCommandId: retryableCommandId(retryKey, "web-restart") }),
    });
    retryCommandIds.delete(retryKey);
  } catch (error) {
    state.agents.set(actorId, agent);
    renderAgents();
    showGlobalError(errorMessage(error));
  }
}

function selectHasOption(select: HTMLSelectElement, value: string): boolean {
  return Array.from(select.options).some((option) => option.value === value);
}

function enterReplaceMode(record: RecordView): void {
  state.replacing = { id: record.id };
  if (selectHasOption(memoryKind, record.kind)) memoryKind.value = record.kind;
  memoryInput.value = record.content;
  publicMemorySection.open = true;
  memoryReplaceBanner.hidden = false;
  memorySubmit.textContent = "保存替换";
  memoryInput.focus();
}

function exitReplaceMode(): void {
  state.replacing = null;
  memoryReplaceBanner.hidden = true;
  memorySubmit.textContent = "固定到房间";
  memoryInput.value = "";
}

async function retractRecord(recordId: string): Promise<void> {
  const retryKey = `retract:memory:${recordId}`;
  const path = `/api/memory/${encodeURIComponent(recordId)}/retract`;
  try {
    await requestJson<unknown>(path, {
      method: "POST",
      body: JSON.stringify({ clientCommandId: retryableCommandId(retryKey, "web-retract") }),
    });
    retryCommandIds.delete(retryKey);
    state.memories.delete(recordId);
    if (state.replacing?.id === recordId) exitReplaceMode();
    renderPublicMemoryRecords();
  } catch (error) {
    showGlobalError(errorMessage(error));
  }
}

function wireRetractButton(button: HTMLButtonElement, recordId: string): void {
  let armed = false;
  let armTimer: number | null = null;
  const disarm = (): void => {
    armed = false;
    button.classList.remove("is-armed");
    button.textContent = "移除";
    if (armTimer !== null) {
      window.clearTimeout(armTimer);
      armTimer = null;
    }
  };
  button.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      button.classList.add("is-armed");
      button.textContent = "确认移除";
      armTimer = window.setTimeout(disarm, 3_000);
      return;
    }
    disarm();
    void retractRecord(recordId);
  });
}

function activePublicMemories(): RecordView[] {
  return Array.from(state.memories.values())
    .filter((record) => record.status === "active" && record.scopeType === "room" && record.scopeId === state.roomId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function createRecordCard(record: RecordView): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "record-card";
    item.dataset.recordId = record.id;
    const meta = document.createElement("div");
    meta.className = "record-meta";
    const kind = document.createElement("span");
    kind.className = "record-kind";
    kind.textContent = record.kind;
    const source = document.createElement("span");
    const subject = record.subjectActorId ? ` → ${record.subjectActorId}` : "";
    source.textContent = `${record.authorActorId}${subject}`;
    if (record.createdAt) {
      source.title = formatFullTime(record.createdAt);
    }
    meta.append(kind, source);
    const content = document.createElement("p");
    content.className = "record-content";
    content.textContent = record.content;

    const actions = document.createElement("div");
    actions.className = "record-actions";
    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "text-button";
    replace.textContent = "替换";
    replace.addEventListener("click", () => enterReplaceMode(record));
    const retract = document.createElement("button");
    retract.type = "button";
    retract.className = "text-button danger-text";
    retract.textContent = "移除";
    wireRetractButton(retract, record.id);
    actions.append(replace, retract);

    item.append(meta, content, actions);
    return item;
}

function renderPublicMemoryRecords(): void {
  const records = activePublicMemories();
  memoryList.replaceChildren(...records.map(createRecordCard));
  publicMemoryCount.textContent = String(records.length);
}

function extractCollection(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function nextCursorFromPage(value: unknown): number | undefined {
  if (!isRecord(value) || value.nextCursor === undefined || value.nextCursor === null) {
    return undefined;
  }
  if (
    typeof value.nextCursor !== "number" ||
    !Number.isSafeInteger(value.nextCursor) ||
    value.nextCursor < 0
  ) {
    throw new ApiFailure("INVALID_PAGE_CURSOR", "记录分页游标无效", 500);
  }
  return value.nextCursor;
}

function publicMemoryPagePath(cursor: number | undefined): string {
  const query = new URLSearchParams({ scopeType: "room", scopeId: state.roomId });
  if (cursor !== undefined) {
    query.set("cursor", String(cursor));
  }
  return `/api/memory?${query.toString()}`;
}

async function loadMemoryRecords(): Promise<void> {
  try {
    const records = await collectCursorPages(async (cursor) => {
      const response = await requestJson<unknown>(publicMemoryPagePath(cursor));
      const items = extractCollection(response, ["memory", "memories", "records", "items"]);
      const nextCursor = nextCursorFromPage(response);
      return nextCursor === undefined ? { items } : { items, nextCursor };
    });
    for (const value of records) {
      const record = normalizeRecord(value, false);
      if (record) {
        state.memories.set(record.id, record);
      }
    }
    renderPublicMemoryRecords();
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.status !== 404) {
      showGlobalError(errorMessage(error));
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiFailure) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "发生未知错误";
}

function selectedTargets(): string[] {
  return targetInputs().filter((input) => input.checked && !input.disabled).map((input) => input.value);
}

function draftSignature(content: string, to: string[], replyToEventId: string | null): string {
  return JSON.stringify({ content, to: [...to].sort(), replyToEventId });
}

function invalidatePendingSubmission(): void {
  if (!state.submitting) {
    state.pendingSubmission = null;
  }
}

async function submitMessage(): Promise<void> {
  if (isRoomWorking()) {
    setComposerStatus(BUSY_SEND_STATUS);
    return;
  }
  const content = messageInput.value.trim();
  const to = selectedTargets();
  if (!content) {
    setComposerStatus("请输入消息内容", true);
    messageInput.focus();
    return;
  }
  if (content.length > MESSAGE_MAX_LENGTH) {
    setComposerStatus(`消息超过 ${MESSAGE_MAX_LENGTH} 字符`, true);
    return;
  }
  if (to.length === 0) {
    setComposerStatus("请至少选择一个目标 Agent", true);
    return;
  }
  if (state.submitting) {
    return;
  }

  const signature = draftSignature(content, to, state.replyToEventId);
  const existing = state.pendingSubmission?.signature === signature ? state.pendingSubmission.draft : null;
  const draft: MessageDraft = existing ?? {
    clientCommandId: makeClientCommandId("web-message"),
    to,
    content,
    replyToEventId: state.replyToEventId,
  };
  state.pendingSubmission = { signature, draft };
  state.submitting = true;
  setComposerBusy(true);
  setComposerStatus(existing ? "正在使用同一命令 ID 重试…" : "正在提交…");

  try {
    // Sending inside a replayed conversation is the resume: open the new epoch
    // first, then post the message into it. The seed stays on screen.
    if (conversationView !== null) {
      setComposerStatus("正在以这段对话为上下文继续…");
      await resumeViewedConversation();
      setComposerStatus(existing ? "正在使用同一命令 ID 重试…" : "正在提交…");
    }
    const accepted = await requestJson<unknown>("/api/messages", {
      method: "POST",
      body: JSON.stringify(draft),
    });
    // The 202 snapshot closes the gap between the POST and the first SSE frame:
    // without it the button would unlock for a few milliseconds and allow a
    // second send that bypasses the busy lock. seedOnly never regresses a Turn
    // the SSE already advanced.
    finishedAgents.clear();
    for (const value of extractCollection(accepted, ["turns"])) {
      const turn = normalizeTurn(value);
      if (turn !== null) renderTurn(turn, { seedOnly: true });
    }
    syncAgentActivity();
    messageInput.value = "";
    clearDraft();
    updateCharacterCount();
    autoresizeComposer();
    clearReply();
    state.pendingSubmission = null;
    roomFollow.resume();
    // The local SSE often delivers turn.queued/started before this response
    // lands, so "waiting" is only honest when the room has not answered yet.
    setComposerStatus(acceptedTurnsSeen(accepted) ? "" : DELIVERY_ACK_STATUS);
  } catch (error) {
    setComposerStatus(`${errorMessage(error)}；再次发送会复用同一命令 ID`, true);
  } finally {
    state.submitting = false;
    setComposerBusy(false);
  }
}

/**
 * Resume the conversation that is open in the timeline. The Broker records a new
 * epoch seeded with its range; from here on the view is live again, with the
 * replayed history still above the new messages.
 */
async function resumeViewedConversation(): Promise<void> {
  const view = conversationView;
  if (view === null) return;
  if (view.conversation.active) {
    conversationView = null;
    syncViewedConversationParam(null);
    syncConversationSelection();
    viewingBanner.hidden = true;
    return;
  }
  const retryKey = `resume:${view.conversation.conversationId}`;
  const response = await requestJson<unknown>("/api/conversations/resume", {
    method: "POST",
    body: JSON.stringify({
      clientCommandId: retryableCommandId(retryKey, "web-resume"),
      conversationId: view.conversation.conversationId,
      resetNativeSessions: true
    })
  });
  retryCommandIds.delete(retryKey);
  const throughSeq = isRecord(response) ? readNumberField(response, "throughSeq") : null;
  conversationView = null;
  conversationViewToken += 1;
  syncViewedConversationParam(null);
  syncConversationSelection();
  viewingBanner.hidden = true;
  if (throughSeq !== null) {
    openEpochStartSeq = Math.max(openEpochStartSeq, throughSeq + 1);
  }
  appendConversationBoundary(`继续自「${view.conversation.title}」· 下面是这次的新消息`);
  syncViewingBanner();
  void refreshConversations();
  void refreshContextUsage();
}

async function submitMemory(): Promise<void> {
  const content = memoryInput.value.trim();
  if (!content) {
    memoryInput.focus();
    return;
  }
  const replacing = state.replacing;
  memorySubmit.disabled = true;
  const retryKey = replacing
    ? `supersede-memory:${replacing.id}:${memoryKind.value}:${content}`
    : `memory:${state.roomId}:${memoryKind.value}:${content}`;
  try {
    const response = await requestJson<unknown>(
      replacing
        ? `/api/memory/${encodeURIComponent(replacing.id)}/supersede`
        : "/api/memory",
      {
        method: "POST",
        body: JSON.stringify(
          replacing
            ? {
                clientCommandId: retryableCommandId(retryKey, "web-supersede"),
                kind: memoryKind.value,
                content,
              }
            : {
                clientCommandId: retryableCommandId(retryKey, "web-memory"),
                scope: { type: "room", id: state.roomId },
                kind: memoryKind.value,
                content,
              }
        ),
      }
    );
    const memory = isRecord(response) ? normalizeRecord(response.memory, false) : null;
    if (memory) {
      if (replacing) {
        state.memories.delete(replacing.id);
      }
      state.memories.set(memory.id, memory);
      renderPublicMemoryRecords();
    }
    retryCommandIds.delete(retryKey);
    memoryInput.value = "";
    if (replacing) {
      exitReplaceMode();
    }
  } catch (error) {
    showGlobalError(errorMessage(error));
  } finally {
    memorySubmit.disabled = false;
  }
}

function supportedEventTypesFromBootstrap(bootstrap: JsonRecord): string[] {
  const result = new Set<string>(DOCUMENTED_EVENT_TYPES);
  const direct = extractCollection(bootstrap, ["eventTypes", "supportedEventTypes"]);
  for (const type of direct) {
    if (typeof type === "string" && type) {
      result.add(type);
    }
  }
  if (isRecord(bootstrap.capabilities)) {
    for (const type of extractCollection(bootstrap.capabilities, ["eventTypes", "supportedEventTypes"])) {
      if (typeof type === "string" && type) {
        result.add(type);
      }
    }
  }
  return Array.from(result);
}

function handleSseMessage(event: MessageEvent<string>): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(event.data) as unknown;
  } catch {
    showGlobalError("收到无法解析的 SSE 事件");
    return;
  }
  const envelope = normalizeEnvelope(decoded);
  if (!envelope) {
    showGlobalError("收到不完整的 AIChatLink Envelope");
    return;
  }
  // A view rebuild replaces the timeline from a snapshot. Frames that land while
  // it runs are held, not dropped: a streaming response would otherwise lose
  // every delta between the snapshot and the repaint.
  if (liveEnvelopeBuffer !== null) {
    liveEnvelopeBuffer.push(envelope);
    return;
  }
  acceptEnvelope(envelope, "live");
}

function closeEventSource(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function scheduleReconnect(detail = ""): void {
  closeEventSource();
  if (reconnectTimer !== null) {
    return;
  }
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempt);
  const jittered = Math.round(base * (1 + Math.random() * 0.2));
  reconnectAttempt += 1;
  setConnection("reconnecting", detail || `${jittered} ms`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectEventSource();
  }, jittered);
}

function reconnectForGap(receivedSeq: number): void {
  scheduleReconnect(`游标缺口 ${state.lastDurableSeq} → ${receivedSeq}`);
}

function refreshEmptyStateCopy(): void {
  for (const pane of panes) {
    refreshPaneEmptyCopy(pane);
  }
}

function setPaneVoice(pane: PaneContext, voice: EmptyVoice | undefined): void {
  const quote = pane.empty.querySelector<HTMLElement>(".pane-empty-quote");
  if (quote === null) {
    return;
  }
  quote.hidden = voice === undefined;
  if (voice === undefined) {
    return;
  }
  const text = quote.querySelector<HTMLElement>(".pane-empty-quote-text");
  const source = quote.querySelector<HTMLElement>(".pane-empty-quote-source");
  if (text !== null) {
    text.textContent = `「${voice.quote}」`;
  }
  if (source !== null) {
    source.textContent = voice.source;
  }
}

function refreshPaneEmptyCopy(pane: PaneContext): void {
  const heading = pane.empty.querySelector<HTMLElement>("h3");
  const paragraph =
    pane.empty.querySelector<HTMLElement>(".pane-empty-note") ??
    pane.empty.querySelector<HTMLElement>("p");
  if (heading === null || paragraph === null) {
    return;
  }
  // Every branch that does not name a voice must clear the previous one.
  setPaneVoice(pane, undefined);
  // "solo" = the epigraph is the only line (agent lane with a known role), so
  // the state line above it becomes a placard label instead of a title.
  pane.empty.dataset.voice = "off";
  heading.hidden = false;
  paragraph.hidden = false;
  if (pane.lens.kind === "agent") {
    const agent = state.agents.get(pane.lens.actorId);
    if (agent === undefined) {
      heading.textContent = "该 Agent 不在当前名册";
      paragraph.textContent = "用窗格标题或顶部 ▦ 换一个 Agent。";
      return;
    }
    if (!agent.enabled) {
      heading.textContent = `「${agent.displayName}」已停用`;
      // The charm line lives in the note: one sentence that both explains the
      // silence and says what is still reachable.
      paragraph.textContent = DISABLED_NOTE;
      return;
    }
    const voice = emptyVoiceFor(agent.displayName);
    if (voice !== undefined) {
      // The lane header already names the Agent and the state dot already says
      // it is ready, so the state line becomes a quiet label above the epigraph
      // instead of the loudest thing in the pane. The sentence explaining what
      // will appear here is dropped: it restated the heading.
      heading.textContent = `还没有「${agent.displayName}」的输出`;
      paragraph.hidden = true;
      pane.empty.dataset.voice = "on";
      setPaneVoice(pane, voice);
      return;
    }
    heading.textContent = `还没有「${agent.displayName}」的输出`;
    // Unknown roles keep the state line and lose the instruction sentence.
    paragraph.hidden = true;
    setPaneVoice(pane, undefined);
    return;
  }
  if (conversationView !== null) {
    heading.textContent = "这段对话没有可显示的消息";
    paragraph.textContent = "直接在下方发送消息即可从这里继续；旧记录不会被改写。";
    return;
  }
  if (openEpochStartSeq > FIRST_EPOCH_START_SEQ) {
    heading.textContent = "新对话已开始";
    paragraph.textContent = "上下文与原生会话已重置，从这里开始计数；上一条对话在左侧列表里只读查看。";
    return;
  }
  heading.textContent = "房间已就绪";
  // With an epigraph present the instruction sentence is dropped: the line
  // already says the first move belongs to the operator.
  paragraph.hidden = true;
  setPaneVoice(pane, ROOM_VOICE);
}

async function refreshHealth(): Promise<void> {
  try {
    const health = await requestJson<unknown>("/api/health");
    if (!isRecord(health)) {
      throw new Error("Health response is not an object");
    }
    const store = isRecord(health.store) ? health.store : null;
    const available = store ? readBooleanField(store, true, "available") : true;
    const integrityOk = store ? readBooleanField(store, true, "integrityOk") : true;
    const activeTurns = readNumberField(health, "activeTurns") ?? 0;
    const queuedTurns = readNumberField(health, "queuedTurns") ?? 0;
    const healthy = available && integrityOk;
    connectionDot.dataset.health = healthy ? "ok" : "degraded";
    connectionDot.title = healthy
      ? `存储正常 · 活跃回合 ${activeTurns} · 排队 ${queuedTurns}`
      : "存储不可用或完整性检查未通过";
    connectionDot.setAttribute("aria-label", connectionDot.title);
  } catch {
    connectionDot.dataset.health = "unknown";
    connectionDot.title = "健康检查失败";
    connectionDot.setAttribute("aria-label", connectionDot.title);
  }
  await refreshConfiguredRoster();
}

async function requestSetupSnapshot(): Promise<unknown | undefined> {
  try {
    return await requestJson<unknown>("/api/setup", { workspace: false });
  } catch {
    // The room can be embedded without the optional setup surface.
    return undefined;
  }
}

/**
 * Projects the saved roster onto the running room. Newly enabled agents wait for
 * a restart; agents the saved roster no longer enables stop being offered as
 * message targets immediately, although their native session stays alive until
 * AIChatLink restarts.
 */
let workspaceResolved = "";

/** Shorten a long path for the header chip: keep the last two segments. */
function shortenWorkspacePath(value: string): string {
  const normalized = value.split(String.fromCharCode(92)).join("/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts.length <= 2 ? value : `…/${parts.slice(-2).join("/")}`;
}

function applyConfiguredWorkspace(snapshot: unknown): void {
  if (!isRecord(snapshot) || !isRecord(snapshot.config)) return;
  const workspace = readStringField(snapshot, "workspaceResolved") ||
    readStringField(snapshot.config, "workspace");
  workspaceResolved = workspace.trim();
  updateComposerWorkspace();
}

/** The composer's directory echo is also the workspace switcher. */
function updateComposerWorkspace(): void {
  const active = currentWorkspace();
  const workspace = active?.path ?? workspaceResolved;
  if (workspace.length === 0) {
    composerWorkspace.hidden = true;
    composerWorkspacePath.textContent = "";
    composerWorkspace.removeAttribute("title");
    composerWorkspace.removeAttribute("aria-label");
    return;
  }
  composerWorkspacePath.textContent = shortenWorkspacePath(workspace);
  const description = `${active === undefined ? "工作目录" : `工作目录 ${active.label}`} · ${workspace}（点击切换）`;
  composerWorkspace.title = description;
  // The narrow stages hide the label and the path text, so the button needs its
  // own name instead of relying on the visible copy.
  composerWorkspace.setAttribute("aria-label", description);
  composerWorkspace.hidden = false;
}

function applyConfiguredRoster(snapshot: unknown): boolean {
  const liveAgents = [...state.agents.values()].filter((agent) => agent.status !== "pending_restart");
  const activeActorIds = new Set(liveAgents.map((agent) => agent.actorId));
  const next = pendingConfiguredAgents(snapshot, activeActorIds);
  const disabledActorIds = disabledConfiguredActorIds(snapshot, activeActorIds);
  const previousIds = [...state.agents.values()]
    .filter((agent) => agent.status === "pending_restart")
    .map((agent) => agent.actorId)
    .sort();
  const nextIds = next.map((agent) => agent.actorId);
  let changed = previousIds.join("\u0000") !== nextIds.join("\u0000") || next.some((agent) => {
    const previous = state.agents.get(agent.actorId);
    return previous?.displayName !== agent.displayName || previous.cwd !== agent.cwd;
  });
  if (disabledActorIds !== undefined) {
    for (const agent of liveAgents) {
      const enabled = !disabledActorIds.has(agent.actorId);
      if (agent.enabled === enabled) continue;
      state.agents.set(agent.actorId, { ...agent, enabled });
      changed = true;
    }
  }
  for (const actorId of previousIds) state.agents.delete(actorId);
  for (const agent of next) state.agents.set(agent.actorId, agent);
  return changed;
}

async function refreshConfiguredRoster(): Promise<void> {
  // Derived workspaces share the primary roster; /api/setup describes the
  // primary config only, so it must not repaint a child workspace's roster.
  if (!isPrimaryWorkspace()) {
    renderAgents();
    return;
  }
  const snapshot = await requestSetupSnapshot();
  if (snapshot === undefined) return;
  applyConfiguredWorkspace(snapshot);
  if (applyConfiguredRoster(snapshot)) renderAgents();
}

function connectEventSource(extraTypes: string[] = []): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  closeEventSource();
  setConnection(reconnectAttempt > 0 ? "reconnecting" : "connecting");
  const source = new EventSource(
    withWorkspace(`/api/events?afterSeq=${encodeURIComponent(String(state.lastDurableSeq))}`)
  );
  eventSource = source;
  for (const eventType of extraTypes) {
    registeredEventTypes.add(eventType);
  }
  for (const eventType of registeredEventTypes) {
    source.addEventListener(eventType, (event) => handleSseMessage(event as MessageEvent<string>));
  }
  source.onmessage = handleSseMessage;
  source.onopen = () => {
    reconnectAttempt = 0;
    setConnection("live");
    refreshEmptyStateCopy();
  };
  source.onerror = () => {
    if (source !== eventSource) {
      return;
    }
    setConnection("reconnecting", "等待 EventSource 恢复");
  };
}

/** Live frames held while a view rebuild replaces the timeline. */
let liveEnvelopeBuffer: AIChatLinkEnvelope[] | null = null;

/** The snapshot's high-water mark: where the live SSE cursor resumes from. */
function advanceDurableCursor(decoded: Record<string, unknown>): void {
  const room = isRecord(decoded.room) ? decoded.room : {};
  const throughSeq = readNumberField(room, "throughSeq") ?? readNumberField(decoded, "throughSeq") ?? 0;
  if (Number.isSafeInteger(throughSeq) && throughSeq >= 0) {
    state.lastDurableSeq = Math.max(state.lastDurableSeq, throughSeq);
  }
}

/**
 * Paint the open conversation epoch from a `/api/bootstrap` snapshot. First load
 * and an in-place return to live share this renderer, so the two cannot drift.
 *
 * Everything that can be awaited is fetched *before* `clearTimelineView()`: an
 * await after the clear leaves the column blank, which is the flash operators
 * saw on every conversation switch. Returns false when the caller's view was
 * replaced while the seed was loading (a faster click wins).
 */
async function paintLiveEpoch(
  decoded: Record<string, unknown>,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  const replayWindow = extractCollection(decoded, ["recentEvents", "events"])
    .map(normalizeEnvelope)
    .filter((event): event is AIChatLinkEnvelope => event !== null)
    .sort((left, right) => (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER));
  const activeConversation = conversations.find((conversation) => conversation.active) ?? null;
  const resumeSeed = activeConversation?.resumedFrom ?? null;
  // The seed predates the recent replay window, so it needs its own fetch.
  const seedEvents =
    activeConversation !== null && resumeSeed !== null
      ? await loadEventRange({ fromSeq: resumeSeed.fromSeq, throughSeq: resumeSeed.throughSeq })
      : [];
  if (!isCurrent()) return false;

  clearTimelineView();
  seedRetiredTurnIds(replayWindow);
  // Seen ids survive a clear, so a rebuilt epoch has to be re-opened explicitly.
  for (const envelope of seedEvents) {
    state.seenEventIds.delete(envelope.eventId);
    acceptEnvelope(envelope, "replay");
  }
  if (activeConversation !== null && resumeSeed !== null) {
    appendResumeBoundary(activeConversation);
  }
  for (const envelope of replayWindow) {
    state.seenEventIds.delete(envelope.eventId);
    acceptEnvelope(envelope, "bootstrap");
  }
  for (const value of extractCollection(decoded, ["activeTurns", "turns"])) {
    const turn = normalizeTurn(value);
    if (turn) {
      renderTurn(turn);
    }
  }
  advanceDurableCursor(decoded);
  refreshEmptyStateCopy();
  return true;
}

async function bootstrap(): Promise<void> {
  setConnection("bootstrapping");
  renderAgents();
  renderPublicMemoryRecords();
  try {
    await refreshWorkspaces();
    const setupPromise = isPrimaryWorkspace() ? requestSetupSnapshot() : Promise.resolve(undefined);
    const [decoded, setupSnapshot] = await Promise.all([
      requestJson<unknown>("/api/bootstrap"),
      setupPromise,
      refreshConversations()
    ]);
    if (!isRecord(decoded)) {
      throw new ApiFailure("INVALID_BOOTSTRAP", "bootstrap 响应不是对象", 500);
    }
    const room = isRecord(decoded.room) ? decoded.room : {};
    state.roomId = readStringField(room, "roomId") || readStringField(decoded, "roomId") || DEFAULT_ROOM_ID;

    state.agents.clear();
    for (const value of extractCollection(decoded, ["agents"])) {
      const agent = normalizeAgent(value);
      if (agent && agent.actorId.startsWith("agent:")) {
        state.agents.set(agent.actorId, agent);
      }
    }
    if (setupSnapshot !== undefined) {
      applyConfiguredWorkspace(setupSnapshot);
      applyConfiguredRoster(setupSnapshot);
    }
    paneRosterReady = true;
    renderAgents();

    // The room transcript is append-only, so a reload would otherwise replay the
    // closed conversation that the operator just replaced. No repaint here:
    // paintLiveEpoch() clears and redraws in one synchronous pass, so the column
    // never goes empty (a workspace switch reuses this path).
    openConversationEpoch(activeEpochStartSeq(conversations), { repaint: false });
    // `?conv=` opens a closed conversation. Painting the live epoch first would
    // blank the column until the replay fetch returns, so only the cursor moves;
    // enterConversationView() paints once, after its own fetch.
    const requestedConversation = new URLSearchParams(window.location.search).get("conv");
    const replayTarget =
      requestedConversation !== null && requestedConversation.length > 0
        ? (conversations.find((conversation) => conversation.conversationId === requestedConversation) ?? null)
        : null;
    if (replayTarget !== null && !replayTarget.active) {
      advanceDurableCursor(decoded);
    } else {
      await paintLiveEpoch(decoded);
    }

    for (const value of extractCollection(decoded, ["memory", "memories"])) {
      const record = normalizeRecord(value, false);
      if (record) {
        state.memories.set(record.id, record);
      }
    }
    renderPublicMemoryRecords();

    const throughSeq = readNumberField(room, "throughSeq") ?? readNumberField(decoded, "throughSeq") ?? 0;
    if (Number.isSafeInteger(throughSeq) && throughSeq >= 0) {
      state.lastDurableSeq = Math.max(state.lastDurableSeq, throughSeq);
    }

    void refreshWorkspaceConversations();
    void loadMemoryRecords();
    void refreshContextUsage();
    void refreshAssistant();
    connectEventSource(supportedEventTypesFromBootstrap(decoded));
    void refreshHealth();
    scheduleWorkspacePoll();
    if (healthTimer === null) {
      healthTimer = window.setInterval(() => {
        void refreshHealth();
      }, HEALTH_POLL_MS);
    }

    const conversationId = new URLSearchParams(window.location.search).get("conv");
    if (conversationId !== null && conversationId.length > 0) {
      const target = conversations.find((conversation) => conversation.conversationId === conversationId);
      if (target === undefined) {
        // The row was deleted (possibly from another tab). Keep the address bar
        // honest so a reload does not keep re-opening the dead id.
        syncViewedConversationParam(null);
        showGlobalError("该对话不存在，或已被删除。");
      } else if (!target.active) {
        void enterConversationView(target);
      } else {
        // `?conv=` pins a replay. The live epoch needs no pin, and leaving one
        // means the address bar claims a view the timeline is not showing.
        syncViewedConversationParam(null);
      }
    }
  } catch (error) {
    setConnection("offline", "bootstrap 失败");
    showGlobalError(errorMessage(error));
    window.setTimeout(() => {
      void bootstrap();
    }, 2_000);
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMessage();
});

/**
 * Clicking the busy button stops the room; pressing Enter does not. Both paths
 * reach the same `<form>`, so the stop intent is bound to the click alone and
 * cancelled before the submit event fires — an accidental Enter must never end
 * eight Agents' work (D-050).
 */
sendButton.addEventListener("click", (event) => {
  if (sendButton.dataset.mode !== "stop") {
    return;
  }
  event.preventDefault();
  void stopAllAgentWork();
});

messageInput.addEventListener("input", () => {
  updateCharacterCount();
  syncSendButton();
  autoresizeComposer();
  saveDraft();
  invalidatePendingSubmission();
  // Typing clears a stale send error. There is no persistent "Enter 发送" hint:
  // it is learned once, and a permanent second line was pure noise. The status
  // slot only carries real errors and in-flight feedback, and collapses when empty.
  if (messageInput.value.length <= MESSAGE_MAX_LENGTH) {
    setComposerStatus("");
  }
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.replyToEventId) {
    clearReply();
    return;
  }
  if (event.key !== "Enter" || event.isComposing) {
    return;
  }
  if (event.shiftKey) {
    return;
  }
  event.preventDefault();
  if (messageInput.value.trim().length === 0) {
    return;
  }
  composer.requestSubmit();
});

targetAll.addEventListener("change", () => {
  for (const input of targetInputs()) {
    if (!input.disabled) {
      input.checked = targetAll.checked;
    }
  }
  targetAll.indeterminate = false;
  updateTargetSummary();
  invalidatePendingSubmission();
});

targetToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  setTargetPickerOpen(targetPicker.hidden !== false);
});

targetSelectAll.addEventListener("click", () => {
  for (const input of targetInputs()) {
    if (!input.disabled) input.checked = true;
  }
  targetAll.checked = true;
  targetAll.indeterminate = false;
  updateTargetSummary();
  invalidatePendingSubmission();
});

targetClear.addEventListener("click", () => {
  for (const input of targetInputs()) input.checked = false;
  syncTargetAll();
  invalidatePendingSubmission();
});

document.addEventListener("click", (event) => {
  if (targetPicker.hidden || targetCluster === null) return;
  if (targetCluster.contains(event.target as Node)) return;
  setTargetPickerOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || targetPicker.hidden) return;
  setTargetPickerOpen(false);
  targetToggle.focus();
});

newConversationButton.addEventListener("click", () => {
  void startNewConversation();
});

newRoomButton.addEventListener("click", () => {
  startNewRoom();
});

document.addEventListener("click", (event) => {
  if (workspaceMenuElement === null) return;
  const target = event.target as Node | null;
  if (target !== null && (workspaceMenuElement.contains(target) || workspaceMenuTrigger?.contains(target) === true)) {
    return;
  }
  closeWorkspaceMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || workspaceMenuElement === null) return;
  const trigger = workspaceMenuTrigger;
  closeWorkspaceMenu();
  trigger?.focus();
});

document.addEventListener("scroll", closeWorkspaceMenu, true);
window.addEventListener("resize", closeWorkspaceMenu);

/** The pane whose index is open, if any. */
function openTocPane(): PaneContext | null {
  return panes.find((pane) => pane.tocOpen) ?? null;
}

document.addEventListener("click", (event) => {
  const pane = openTocPane();
  if (pane === null) return;
  const target = event.target as Node | null;
  if (
    target !== null &&
    (pane.shell.toc.panel.contains(target) || pane.shell.toc.button.contains(target))
  ) {
    return;
  }
  setConversationTocOpen(false, pane);
});

document.addEventListener("keydown", (event) => {
  const pane = openTocPane();
  if (event.key !== "Escape" || pane === null) return;
  setConversationTocOpen(false, pane);
  pane.shell.toc.button.focus();
});

viewingBannerExit.addEventListener("click", exitConversationView);

clearReplyButton.addEventListener("click", clearReply);

compactContextButton.addEventListener("click", () => {
  void compactCurrentContext();
});

memoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMemory();
});

byId<HTMLButtonElement>("memory-replace-cancel").addEventListener("click", () => {
  exitReplaceMode();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unreadCount = 0;
    document.title = BASE_TITLE;
    // Coming back from /setup must not wait for the next health poll.
    void refreshConfiguredRoster();
  }
});

interface AssistantSnapshotView {
  enabled: boolean;
  name: string;
  status: string;
  detail?: string;
}

interface AssistantMessageView {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  pending?: boolean;
}

let assistantSnapshot: AssistantSnapshotView | null = null;
let assistantMessages: AssistantMessageView[] = [];
let assistantSubmitting = false;

function assistantStatusLabel(status: string): string {
  switch (status) {
    case "disabled":
      return "未启用";
    case "starting":
      return "正在启动";
    case "ready":
      return "就绪";
    case "busy":
      return "处理中";
    case "failed":
      return "失败";
    case "restart_required":
      return "需要重启";
    default:
      return status;
  }
}

function setAssistantFormStatus(message: string, error = false): void {
  assistantFormStatus.textContent = message;
  assistantFormStatus.classList.toggle("is-error", error);
}

function autoresizeAssistant(): void {
  const cap = designPx(140);
  assistantInput.style.height = "auto";
  const next = Math.min(assistantInput.scrollHeight, cap);
  assistantInput.style.height = `${next}px`;
  assistantInput.style.overflowY = assistantInput.scrollHeight > cap ? "auto" : "hidden";
}

function syncAssistantSendButton(): void {
  const empty = assistantInput.value.trim().length === 0;
  assistantSend.disabled = assistantSnapshot?.enabled !== true || assistantSubmitting || empty;
}

function applyAssistantSnapshot(snapshot: AssistantSnapshotView): void {
  assistantSnapshot = snapshot;
  const assistantLabel = snapshot.enabled ? snapshot.name : "房间助理";
  assistantToggle.title = assistantLabel;
  assistantToggle.setAttribute("aria-label", assistantLabel);
  assistantToggle.dataset.enabled = String(snapshot.enabled);
  const title = document.getElementById("assistant-drawer-title");
  if (title) title.textContent = snapshot.name;
  const detail = snapshot.detail ? ` · ${snapshot.detail}` : "";
  assistantStatus.textContent = snapshot.enabled
    ? `${assistantStatusLabel(snapshot.status)}${detail}`
    : "未启用";
  assistantGuide.hidden = snapshot.enabled;
  assistantForm.hidden = !snapshot.enabled;
  assistantInput.disabled = !snapshot.enabled;
  syncAssistantSendButton();
  assistantCancel.hidden = !assistantSubmitting;
}

function renderAssistantMessages(): void {
  const fromBottom = assistantTimeline.scrollHeight - assistantTimeline.scrollTop;
  const paused = assistantFollow.isPaused();
  assistantTimeline.replaceChildren();
  for (const message of assistantMessages) {
    const item = document.createElement("li");
    item.className = `assistant-bubble${message.role === "user" ? " is-user" : ""}${message.pending ? " is-pending" : ""}`;
    // The assistant answers in Markdown too; keep its blocks instead of one run.
    const body = document.createElement("div");
    body.className = "event-content";
    renderRichContent(body, message.content);
    item.append(body);
    assistantTimeline.append(item);
  }
  if (paused) {
    assistantFollow.restorePinnedFromBottom(fromBottom);
  } else {
    assistantFollow.followIfAllowed();
  }
}

async function refreshAssistant(): Promise<void> {
  try {
    const [snapshot, page] = await Promise.all([
      requestJson<AssistantSnapshotView>("/api/assistant"),
      requestJson<{ messages?: AssistantMessageView[] }>("/api/assistant/messages")
    ]);
    applyAssistantSnapshot({
      enabled: snapshot.enabled === true,
      name: snapshot.name || "房间助理",
      status: snapshot.status || "disabled",
      ...(typeof snapshot.detail === "string" ? { detail: snapshot.detail } : {})
    });
    const serverMessages = Array.isArray(page.messages) ? page.messages : [];
    const pending = assistantSubmitting
      ? assistantMessages.filter((message) => message.pending === true)
      : [];
    assistantMessages = [
      ...serverMessages,
      ...pending.filter(
        (local) => !serverMessages.some((server) => server.content === local.content && server.role === local.role)
      )
    ];
    renderAssistantMessages();
  } catch (error) {
    assistantStatus.textContent = errorMessage(error);
  }
}

function setAssistantDrawerOpen(open: boolean): void {
  assistantDrawer.hidden = !open;
  assistantToggle.setAttribute("aria-expanded", String(open));
  try {
    sessionStorage.setItem(ASSISTANT_DRAWER_KEY, open ? "1" : "0");
  } catch {
    // sessionStorage is best-effort
  }
  if (open) {
    assistantFollow.resume();
    void refreshAssistant();
    if (!assistantInput.disabled) assistantInput.focus();
  }
}

async function submitAssistantMessage(): Promise<void> {
  const content = assistantInput.value.trim();
  if (!content || assistantSubmitting || assistantSnapshot?.enabled !== true) return;
  assistantSubmitting = true;
  assistantFollow.resume();
  assistantInput.value = "";
  autoresizeAssistant();
  applyAssistantSnapshot({
    ...assistantSnapshot,
    status: "busy"
  });
  setAssistantFormStatus("助理正在回复…");
  const now = new Date().toISOString();
  assistantMessages = [
    ...assistantMessages,
    { messageId: `pending-user:${now}`, role: "user", content, createdAt: now, pending: true },
    { messageId: "pending-assistant", role: "assistant", content: "正在回复…", createdAt: now, pending: true }
  ];
  renderAssistantMessages();
  assistantInput.focus();
  const retryKey = `assistant:${content}`;
  try {
    const accepted = await requestJson<{
      userMessage?: AssistantMessageView;
      assistantMessage?: AssistantMessageView;
      status?: string;
      detail?: string;
    }>("/api/assistant/messages", {
      method: "POST",
      body: JSON.stringify({
        clientCommandId: retryableCommandId(retryKey, "web-assistant"),
        content
      })
    });
    retryCommandIds.delete(retryKey);
    assistantMessages = assistantMessages.filter((message) => message.pending !== true);
    if (accepted.userMessage && !assistantMessages.some((message) => message.messageId === accepted.userMessage?.messageId)) {
      assistantMessages.push(accepted.userMessage);
    }
    if (accepted.assistantMessage && !assistantMessages.some((message) => message.messageId === accepted.assistantMessage?.messageId)) {
      assistantMessages.push(accepted.assistantMessage);
    }
    renderAssistantMessages();
    if (accepted.status) {
      applyAssistantSnapshot({
        enabled: true,
        name: assistantSnapshot?.name ?? "房间助理",
        status: accepted.status,
        ...(typeof accepted.detail === "string" ? { detail: accepted.detail } : {})
      });
    }
    setAssistantFormStatus("Enter 发送 · Shift+Enter 换行");
  } catch (error) {
    assistantMessages = assistantMessages.filter((message) => message.pending !== true);
    renderAssistantMessages();
    setAssistantFormStatus(errorMessage(error), true);
  } finally {
    assistantSubmitting = false;
    if (assistantSnapshot) applyAssistantSnapshot(assistantSnapshot);
    assistantInput.focus();
  }
}

async function cancelAssistant(): Promise<void> {
  try {
    await requestJson("/api/assistant/cancel", {
      method: "POST",
      body: JSON.stringify({ clientCommandId: makeClientCommandId("web-assistant-cancel") })
    });
    setAssistantFormStatus("已请求取消");
    void refreshAssistant();
  } catch (error) {
    setAssistantFormStatus(errorMessage(error), true);
  }
}

function restoreAssistantDrawer(): void {
  try {
    if (sessionStorage.getItem(ASSISTANT_DRAWER_KEY) === "1") {
      setAssistantDrawerOpen(true);
    }
  } catch {
    // sessionStorage is best-effort
  }
}

type ThemeName = "light" | "dark";

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  const toDark = theme !== "dark";
  themeToggle.textContent = toDark ? "☾" : "☀";
  const label = toDark ? "切换到夜间模式" : "切换到日间模式";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
}

function initTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable; theme preference is best-effort
  }
  applyTheme(stored === "dark" ? "dark" : "light");
}

function applySidebar(open: boolean): void {
  document.documentElement.dataset.sidebar = open ? "open" : "closed";
  sidebarToggle.setAttribute("aria-expanded", String(open));
  const label = open ? "收起侧边栏" : "展开侧边栏";
  sidebarToggle.setAttribute("aria-label", label);
  sidebarToggle.title = label;
}

function initSidebar(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable; the sidebar falls back to the viewport default
  }
  applySidebar(stored === null ? window.innerWidth >= 1_280 : stored === "open");
}

initSidebar();

sidebarToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.sidebar !== "open";
  applySidebar(next);
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "open" : "closed");
  } catch {
    // localStorage may be unavailable; the toggle still works for this session
  }
});

themeToggle.addEventListener("click", () => {
  const next: ThemeName = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // localStorage may be unavailable; theme preference is best-effort
  }
});

assistantToggle.addEventListener("click", () => {
  setAssistantDrawerOpen(assistantDrawer.hidden === true);
});
assistantClose.addEventListener("click", () => {
  setAssistantDrawerOpen(false);
});
assistantForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAssistantMessage();
});
assistantCancel.addEventListener("click", () => {
  void cancelAssistant();
});
assistantInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.shiftKey) return;
  event.preventDefault();
  if (assistantInput.value.trim().length === 0) return;
  assistantForm.requestSubmit();
});
assistantInput.addEventListener("input", () => {
  autoresizeAssistant();
  syncAssistantSendButton();
});

composerWorkspace.addEventListener("click", () => openWorkspaceDialog());
workspaceClose.addEventListener("click", closeWorkspaceDialog);
workspaceUp.addEventListener("click", () => {
  const parent = workspaceListing?.parent;
  if (parent !== null && parent !== undefined) void loadWorkspaceListing(parent);
});
workspaceUse.addEventListener("click", () => {
  if (workspaceListing !== null) void addOrSwitchWorkspace(workspaceListing.path);
});
memoryToggle.addEventListener("click", () => {
  if (memoryDialog.open) return;
  if (typeof memoryDialog.showModal === "function") memoryDialog.showModal();
  else memoryDialog.setAttribute("open", "");
});
memoryClose.addEventListener("click", () => {
  if (typeof memoryDialog.close === "function") memoryDialog.close();
  else memoryDialog.removeAttribute("open");
});

initPanes();
initTheme();
restoreDraft();
restoreAssistantDrawer();
updateCharacterCount();
autoresizeComposer();
syncSendButton();
autoresizeAssistant();
syncAssistantSendButton();
syncJumpLatestGeometry();
syncPaneActionGeometry();

window.addEventListener("online", () => {
  if (!eventSource) {
    reconnectAttempt = 0;
    connectEventSource();
  }
});

// Workspace switches are pushState entries, so Back/Forward must re-apply the
// URL instead of leaving the shell showing a room the address bar left behind.
window.addEventListener("popstate", () => {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("ws") ?? "";
  const target = requested.length === 0 ? primaryWorkspaceId : requested;
  if (target !== activeWorkspaceId) {
    saveDraft();
    void switchWorkspace();
    return;
  }
  void applyConversationParam(params.get("conv"));
});

window.addEventListener("offline", () => {
  if (state.connection !== "live") {
    setConnection("reconnecting", "本地 EventSource 仍在重试");
  }
});

window.addEventListener("beforeunload", () => {
  closeEventSource();
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
  }
  if (deltaFlushTimer !== null) {
    window.clearTimeout(deltaFlushTimer);
  }
  if (healthTimer !== null) {
    window.clearInterval(healthTimer);
  }
  if (contextUsageRefreshTimer !== null) {
    window.clearTimeout(contextUsageRefreshTimer);
  }
  if (workspacePollTimer !== null) {
    window.clearTimeout(workspacePollTimer);
  }
});

void bootstrap();
