/**
 * Conversation epochs are the context resets an operator can create (D-034).
 * The room transcript stays append-only, so the live timeline is only a *view*
 * over the epoch that is currently open: anything recorded before its first
 * sequence belongs to a closed epoch and is replayed read-only from the history
 * drawer instead.
 */
export interface ConversationEpoch {
  readonly startSeq: number;
  readonly active: boolean;
}

/** A room without any reset has exactly one epoch, starting at the first event. */
export const FIRST_EPOCH_START_SEQ = 1;

const TERMINAL_TURN_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.interrupted"
]);

const OPENING_TURN_TYPES = new Set([
  "turn.queued",
  "turn.dispatched",
  "turn.started",
  "turn.streaming"
]);

/** First sequence of the open epoch; falls back to the room start when no epoch is known. */
export function activeEpochStartSeq(epochs: readonly ConversationEpoch[]): number {
  for (const epoch of epochs) {
    if (!epoch.active) continue;
    return Number.isSafeInteger(epoch.startSeq) && epoch.startSeq > 0
      ? epoch.startSeq
      : FIRST_EPOCH_START_SEQ;
  }
  return FIRST_EPOCH_START_SEQ;
}

/** The row fields the sidebar needs to decide whether an epoch is worth showing. */
export interface ConversationVisibility {
  readonly empty: boolean;
}

/**
 * The open epoch is where the next send lands, but it is not history. Show it
 * only while it is the whole group: once a real conversation survives, an empty
 * open row gets a new `对话 N` every time another row is deleted, so the row the
 * operator did not delete looks like a brand-new conversation. The API still
 * projects the live boundary; this only decides which rows the sidebar paints.
 */
export function visibleConversations<T extends ConversationVisibility>(
  items: readonly T[]
): T[] {
  if (items.length <= 1) return [...items];
  const survivors = items.filter((item) => !item.empty);
  return survivors.length === 0 ? [...items] : survivors;
}

/** `context.reset` closes the previous epoch at `throughSeq`; the next one starts right after it. */
export function epochStartAfterReset(throughSeq: number): number {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
    throw new RangeError("throughSeq must be a non-negative safe integer");
  }
  return throughSeq + 1;
}

/** Envelopes without a durable sequence (live deltas) always belong to the open epoch. */
export function eventInEpoch(seq: number | null, epochStartSeq: number): boolean {
  if (seq === null) return true;
  return seq >= epochStartSeq;
}

/**
 * Turn lifecycle as seen from the timeline. A reset can land while a turn is
 * still running: its teardown is then recorded inside the *new* epoch, so the
 * view has to keep tracking the turn it already replaced.
 */
export function turnActivityState(eventType: string): "opening" | "terminal" | null {
  if (OPENING_TURN_TYPES.has(eventType)) return "opening";
  if (TERMINAL_TURN_TYPES.has(eventType)) return "terminal";
  return null;
}
