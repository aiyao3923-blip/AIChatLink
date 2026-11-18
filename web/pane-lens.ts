/**
 * Pane lenses — the pure part of the multi-pane monitor.
 *
 * One room page owns exactly one live epoch, one EventSource and one state
 * (see docs/DECISIONS.md D-045). A pane is a read-only projection of that
 * state: `room` paints everything the page already paints, `agent:<actorId>`
 * paints one Agent's lane. Nothing here touches the DOM or the network, so the
 * acceptance matrix can be unit-tested without a browser.
 */

export type PaneLens = { kind: "room" } | { kind: "agent"; actorId: string };

export interface StoredPanes {
  count: number;
  lenses: PaneLens[];
}

/** Eight panes = 3 columns × 3 rows, the natural maximum for an 8-Agent room. */
export const MAX_PANES = 8;
/** The grid is laid out on six equal tracks so 2/3/5/7/8 panes can still tile evenly. */
export const PANE_TRACKS = 6;

const ROOM_TOKEN = "room";
/** Lens actor ids are the room's full actor ids, e.g. "agent:pi-lead". */
const AGENT_PREFIX = "agent:";

export function roomLens(): PaneLens {
  return { kind: "room" };
}

export function defaultPanes(): StoredPanes {
  return { count: 1, lenses: [roomLens()] };
}

/** Parse the persisted form: "room" or a full actor id such as "agent:pi-lead". */
export function parsePaneLens(value: unknown): PaneLens | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (text === ROOM_TOKEN) {
    return roomLens();
  }
  if (!text.startsWith(AGENT_PREFIX) || text.length === AGENT_PREFIX.length) {
    return null;
  }
  return { kind: "agent", actorId: text };
}

export function formatPaneLens(lens: PaneLens): string {
  return lens.kind === "room" ? ROOM_TOKEN : lens.actorId;
}

export function clampPaneCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_PANES, Math.max(1, Math.trunc(value)));
}

/**
 * Tolerate anything found in localStorage: an absent object, a bad count, a
 * short/long lens list, or junk entries. Every slot is filled so callers never
 * index a hole.
 */
export function normalizePanes(value: unknown): StoredPanes {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaultPanes();
  }
  const record = value as Record<string, unknown>;
  const count = clampPaneCount(record.count);
  const rawLenses = Array.isArray(record.lenses) ? record.lenses : [];
  const lenses: PaneLens[] = [];
  for (let index = 0; index < count; index += 1) {
    lenses.push(parsePaneLens(rawLenses[index]) ?? roomLens());
  }
  return { count, lenses };
}

/** 1 → 1 column, 2–4 → 2, 5–8 → 3. */
export function paneColumns(count: number): 1 | 2 | 3 {
  const safe = clampPaneCount(count);
  if (safe <= 1) {
    return 1;
  }
  return safe <= 4 ? 2 : 3;
}

/**
 * Spans on the six-track grid. Each plan fills whole rows:
 * 1 → [6] · 2 → [3,3] · 3 → [3,3,6] · 4 → [3,3,3,3] ·
 * 5 → [2,2,2,3,3] · 6 → [2,2,2,2,2,2] ·
 * 7 → [2,2,2,2,2,2,6] · 8 → [2,2,2,2,2,2,3,3].
 */
export function paneSpans(count: number): number[] {
  const safe = clampPaneCount(count);
  const columns = paneColumns(safe);
  const perColumn = PANE_TRACKS / columns;
  const spans = Array.from({ length: safe }, () => perColumn);
  if (safe === 3) {
    spans[2] = PANE_TRACKS;
  }
  if (safe === 5) {
    spans[3] = 3;
    spans[4] = 3;
  }
  if (safe === 7) {
    // Three full rows of 3: 2+2+2, 2+2+2, then one wide pane.
    spans[6] = PANE_TRACKS;
  }
  if (safe === 8) {
    // Three full rows of 3: 2+2+2, 2+2+2, then two half-width panes.
    spans[6] = 3;
    spans[7] = 3;
  }
  return spans;
}

/**
 * Which panes paint this envelope. Target resolution is the caller's job:
 * terminal turn events carry no `targetActorId`, so the dispatcher resolves it
 * from state and hands the result in (D-044).
 */
export function lensAccepts(
  lens: PaneLens,
  envelope: { type: string; actor?: { kind?: string; actorId?: string } },
  targetActorId: string | null | undefined
): boolean {
  if (lens.kind === "room") {
    return true;
  }
  const type = envelope.type;
  if (type === "message.created") {
    return envelope.actor?.kind === "user" || envelope.actor?.actorId === lens.actorId;
  }
  if (type.startsWith("turn.")) {
    return targetActorId === lens.actorId;
  }
  if (type === "tool.progress" || type === "tool.progress.recorded") {
    return targetActorId === lens.actorId;
  }
  // supervision / operator.dispatch / memory activity / session / generic are
  // room-level records: a lane must not repaint them under one Agent's name.
  return false;
}
