import type { StoredEventRecord } from "../storage/types.js";
import type { AIChatLinkStore } from "../storage/types.js";

export interface MemoryClock {
  now(): string;
}

export type MemoryApplicationStore = Pick<
  AIChatLinkStore,
  | "rememberMemory"
  | "supersedeMemory"
  | "retractMemory"
  | "searchMemory"
  | "rememberIdentity"
  | "supersedeIdentity"
  | "retractIdentity"
  | "readIdentity"
>;

export type ContextPacketStore = Pick<
  AIChatLinkStore,
  | "getDeliveryCursor"
  | "getActiveSummary"
  | "getLatestContextReset"
  | "getLatestContextResetThroughSeq"
  | "getEvent"
  | "getRoomHighWaterSeq"
  | "listEvents"
  | "listEventsThrough"
  | "searchMemory"
  | "readIdentity"
>;

export interface RoomContextUsage {
  roomId: string;
  throughSeq: number;
  estimatedCharacters: number;
  maxCharacters: number;
  compactionTriggerCharacters: number;
  utilizationPercent: number;
  uncompactedMessageCount: number;
  summaryThroughSeq?: number;
  resetThroughSeq?: number;
  /** Messages replayed from the resumed conversation, included in the estimate. */
  resumedMessageCount?: number;
  compactable: boolean;
}

export interface RoomContextCompactionResult {
  compacted: boolean;
  usage: RoomContextUsage;
}

export interface RoomContextResetResult {
  reset: boolean;
  throughSeq: number;
  resetNativeSessions: boolean;
  usage: RoomContextUsage;
}

export type IdentityPerspective = "configured" | "self" | "user-authored" | "observed";

export interface CurrentContextMessage {
  authorActorId: string;
  authorDisplayName?: string;
  content: string;
  sourceEventId?: string;
  sourceKind?: string;
  replyToEventId?: string;
  occurredAt?: string;
}

interface BuildContextPacketBase {
  roomId: string;
  targetActorId: string;
  /** Stable Agent identity read from aichatlink.json, never from chat or memory. */
  configuredIdentity?: string;
  throughSeq: number;
  maxChars: number;
  packetKind?: "business" | "supervision_watch";
}

export type BuildContextPacketInput = BuildContextPacketBase &
  (
    | { currentEvent: StoredEventRecord; currentMessage?: never }
    | { currentEvent?: never; currentMessage: CurrentContextMessage }
  );

export interface ContextSourceLabel {
  kind: string;
  eventId?: string;
  recordId?: string;
}

export interface ContextEntry {
  entryType: "message" | "memory" | "identity" | "summary";
  id: string;
  authorActorId: string;
  authorDisplayName?: string;
  subject: string;
  source: ContextSourceLabel;
  content: string;
  seq?: number;
  occurredAt?: string;
}

export interface IdentityContextEntry extends ContextEntry {
  entryType: "identity";
  subject: string;
  perspective: IdentityPerspective;
}

export interface ContextPacketSections {
  /** At most one mandatory identity configured for the target Agent. */
  configuredIdentity: IdentityContextEntry[];
  selfIdentity: IdentityContextEntry[];
  userAuthoredIdentity: IdentityContextEntry[];
  observedIdentity: IdentityContextEntry[];
  /** Stable memory explicitly curated by the target Agent or user. */
  agentCoreMemory: ContextEntry[];
  /** Automatic per-day semantic rollups, isolated to the target Agent. */
  agentDatedMemory: ContextEntry[];
  publicMemory: ContextEntry[];
  /** At most one persisted cumulative room checkpoint. */
  generatedSummary: ContextEntry[];
  /** Closed conversation replayed as the starting context of this epoch. */
  resumedTranscript: ContextEntry[];
  unreadTranscript: ContextEntry[];
  replyChain: ContextEntry[];
  currentMessage: ContextEntry;
}

export interface ContextPacketOmissions {
  selfIdentity: number;
  userAuthoredIdentity: number;
  observedIdentity: number;
  agentCoreMemory: number;
  agentDatedMemory: number;
  publicMemory: number;
  generatedSummary: number;
  resumedTranscript: number;
  unreadTranscript: number;
}

export interface ContextPacket {
  schema: "aichatlink.context/0.5";
  roomId: string;
  targetActorId: string;
  afterSeq: number;
  throughSeq: number;
  /** Range of the closed conversation this epoch was resumed from, if any. */
  resumedConversation?: {
    conversationId: string;
    fromSeq: number;
    throughSeq: number;
  };
  maxChars: number;
  charCount: number;
  sections: ContextPacketSections;
  omitted: ContextPacketOmissions;
  text: string;
}
