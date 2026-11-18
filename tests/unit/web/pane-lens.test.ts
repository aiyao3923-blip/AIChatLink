import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  PANE_TRACKS,
  clampPaneCount,
  defaultPanes,
  formatPaneLens,
  lensAccepts,
  normalizePanes,
  paneColumns,
  paneSpans,
  parsePaneLens,
  roomLens
} from "../../../web/pane-lens.js";

const agent = (actorId: string) => ({ kind: "agent", actorId });
const LEAD = "agent:pi-lead";
const REVIEWER = "agent:pi-reviewer";

describe("pane lens persistence", () => {
  it("round-trips the two persisted forms", () => {
    expect(parsePaneLens("room")).toEqual({ kind: "room" });
    expect(parsePaneLens(LEAD)).toEqual({ kind: "agent", actorId: LEAD });
    expect(formatPaneLens(roomLens())).toBe("room");
    expect(formatPaneLens({ kind: "agent", actorId: LEAD })).toBe(LEAD);
  });

  it("rejects anything that is not a usable lens", () => {
    for (const value of [null, undefined, 42, {}, [], "", "room ", "agent", "agent:", "agent:  "]) {
      const parsed = parsePaneLens(value);
      if (value === "room ") {
        // Trimming is intentional: a stray space must not lose the layout.
        expect(parsed).toEqual({ kind: "room" });
        continue;
      }
      expect(parsed, String(value)).toBeNull();
    }
  });

  it("clamps the count and fills every slot", () => {
    expect(clampPaneCount(undefined)).toBe(1);
    expect(clampPaneCount(0)).toBe(1);
    expect(clampPaneCount(-3)).toBe(1);
    expect(clampPaneCount(99)).toBe(MAX_PANES);
    expect(clampPaneCount(3.9)).toBe(3);

    expect(normalizePanes(undefined)).toEqual(defaultPanes());
    expect(normalizePanes("nope")).toEqual(defaultPanes());
    expect(normalizePanes({ count: 3, lenses: ["agent:a"] })).toEqual({
      count: 3,
      lenses: [{ kind: "agent", actorId: "agent:a" }, { kind: "room" }, { kind: "room" }]
    });
    expect(
      normalizePanes({ count: 2, lenses: ["agent:a", "agent:b", "agent:c"] })
    ).toEqual({
      count: 2,
      lenses: [{ kind: "agent", actorId: "agent:a" }, { kind: "agent", actorId: "agent:b" }]
    });
    expect(normalizePanes({ count: 2.7, lenses: ["nonsense", "room"] })).toEqual({
      count: 2,
      lenses: [{ kind: "room" }, { kind: "room" }]
    });
  });
});

describe("pane layout plan", () => {
  it("uses one, two then three columns", () => {
    expect([1, 2, 3, 4, 5, 6].map(paneColumns)).toEqual([1, 2, 2, 2, 3, 3]);
  });

  it("fills whole rows on the six-track grid", () => {
    const plans = [1, 2, 3, 4, 5, 6].map(paneSpans);
    expect(plans).toEqual([
      [6],
      [3, 3],
      [3, 3, 6],
      [3, 3, 3, 3],
      [2, 2, 2, 3, 3],
      [2, 2, 2, 2, 2, 2]
    ]);
    for (const spans of plans) {
      expect(spans.reduce((sum, span) => sum + span, 0) % PANE_TRACKS).toBe(0);
      expect(spans.every((span) => span > 0 && span <= PANE_TRACKS)).toBe(true);
    }
  });
});

describe("lane acceptance", () => {
  const lead = agent(LEAD);
  const lane = { kind: "agent" as const, actorId: LEAD };

  it("room accepts everything", () => {
    expect(lensAccepts(roomLens(), { type: "anything", actor: agent("x") }, null)).toBe(true);
  });

  it("keeps the operator's prompts and its own messages", () => {
    expect(
      lensAccepts(lane, { type: "message.created", actor: { kind: "user", actorId: "user:1" } }, null)
    ).toBe(true);
    expect(
      lensAccepts(lane, { type: "message.created", actor: agent(LEAD) }, null)
    ).toBe(true);
    expect(
      lensAccepts(lane, { type: "message.created", actor: agent(REVIEWER) }, null)
    ).toBe(false);
    expect(
      lensAccepts(lane, { type: "message.created", actor: { kind: "system", actorId: "system" } }, null)
    ).toBe(false);
  });

  it("accepts the whole turn family by resolved target", () => {
    for (const type of [
      "turn.queued",
      "turn.dispatched",
      "turn.started",
      "turn.streaming",
      "turn.content.delta",
      "turn.reasoning.delta",
      "turn.reasoning.recorded",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "turn.interrupted"
    ]) {
      expect(lensAccepts(lane, { type, actor: agent(LEAD) }, LEAD), type).toBe(true);
      expect(lensAccepts(lane, { type, actor: { kind: "system", actorId: "system" } }, LEAD), type).toBe(
        true
      );
      expect(lensAccepts(lane, { type, actor: agent(LEAD) }, REVIEWER), type).toBe(false);
      expect(lensAccepts(lane, { type, actor: agent(LEAD) }, null), type).toBe(false);
    }
  });

  it("keeps tool progress in the lane that owns the turn", () => {
    expect(
      lensAccepts(lane, { type: "tool.progress", actor: agent(LEAD) }, LEAD)
    ).toBe(true);
    expect(
      lensAccepts(lane, { type: "tool.progress.recorded", actor: agent(LEAD) }, REVIEWER)
    ).toBe(false);
  });

  it("keeps room-level records out of a lane", () => {
    for (const type of [
      "supervision.paired",
      "supervision.observed",
      "supervision.steered",
      "operator.dispatch",
      "memory.remembered",
      "identity.remembered",
      "session.ready",
      "context.compaction.completed",
      "system.error",
      "routing.loop_stopped",
      "totally.unknown"
    ]) {
      expect(lensAccepts(lane, { type, actor: agent(LEAD) }, LEAD), type).toBe(false);
    }
  });
});
