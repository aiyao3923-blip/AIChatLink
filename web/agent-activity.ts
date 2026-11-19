/**
 * Turn activity projected for the composer. The send button answers "can I
 * send", the per-agent rail answers "who is still working"; both must read the
 * same view-local Turn map, so the classification lives here instead of inside
 * the DOM module.
 */

/** A Turn that reached one of these can no longer produce a reply. */
export const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

/**
 * Unknown statuses are deliberately *not* terminal: if a native adapter grows a
 * new in-flight state, the composer must stay locked until a known terminal
 * event arrives rather than unlock while work is still running.
 */
export function isTerminalTurnStatus(status: string): boolean {
  return TERMINAL_TURN_STATUSES.has(status);
}

export interface TurnActivityLike {
  readonly targetActorId: string;
  readonly status: string;
  /** Present in the live view; lets callers exclude Turns already released. */
  readonly turnId?: string;
}

export interface ActiveTurnOptions {
  /**
   * Turns whose cancellation was already accepted. They are still non-terminal
   * in the store, but the operator asked for them to stop, so they must stop
   * holding the composer and the activity rail (D-053).
   */
  readonly releasedTurnIds?: ReadonlySet<string>;
}

/**
 * Agent ids with at least one Turn that has not reached a terminal status, in
 * first-seen order. A queued Turn counts as work: its lane has not answered yet.
 * Released Turns are skipped — "the ring means work is happening" only holds if
 * a confirmed stop stops the ring too.
 */
export function activeTurnActorIds(
  turns: Iterable<TurnActivityLike>,
  options: ActiveTurnOptions = {}
): string[] {
  const released = options.releasedTurnIds;
  const active: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const actorId = turn.targetActorId.trim();
    if (actorId.length === 0 || seen.has(actorId) || isTerminalTurnStatus(turn.status)) {
      continue;
    }
    const turnId = turn.turnId?.trim() ?? "";
    if (released !== undefined && turnId.length > 0 && released.has(turnId)) {
      continue;
    }
    seen.add(actorId);
    active.push(actorId);
  }
  return active;
}

/**
 * Only an observed active -> terminal transition earns a "just finished" mark.
 * Replayed history and bootstrap snapshots start without a previous entry, so a
 * reload cannot light up every Turn in the recent window.
 */
export function isFinishedTransition(previous: string | undefined, next: string): boolean {
  return previous !== undefined && !isTerminalTurnStatus(previous) && isTerminalTurnStatus(next);
}

export interface CancellableTurnLike extends TurnActivityLike {
  readonly turnId: string;
}

/**
 * Turns a "stop everything" click has to reach, in first-seen order.
 *
 * Terminal Turns are already done and `cancel_requested` ones already asked, so
 * a second click re-sends nothing: the Broker's per-Turn cancel is idempotent by
 * `(bindingId, clientCommandId)`, and burning one command per finished Turn
 * would only produce noise in the receipts. Unknown statuses are *not* terminal,
 * so a Turn in a state this build does not know is still cancelled (fail-safe,
 * same rule as the busy lock).
 */
export function cancellableTurnIds(turns: Iterable<CancellableTurnLike>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const turnId = turn.turnId.trim();
    if (turnId.length === 0 || seen.has(turnId)) continue;
    if (isTerminalTurnStatus(turn.status) || turn.status === "cancel_requested") continue;
    seen.add(turnId);
    ids.push(turnId);
  }
  return ids;
}
