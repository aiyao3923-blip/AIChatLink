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
}

/**
 * Agent ids with at least one Turn that has not reached a terminal status, in
 * first-seen order. A queued Turn counts as work: its lane has not answered yet.
 */
export function activeTurnActorIds(turns: Iterable<TurnActivityLike>): string[] {
  const active: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const actorId = turn.targetActorId.trim();
    if (actorId.length === 0 || seen.has(actorId) || isTerminalTurnStatus(turn.status)) {
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
