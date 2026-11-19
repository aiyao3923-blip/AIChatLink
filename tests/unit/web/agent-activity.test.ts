import { describe, expect, it } from "vitest";

import {
  TERMINAL_TURN_STATUSES,
  activeTurnActorIds,
  cancellableTurnIds,
  isFinishedTransition,
  isTerminalTurnStatus
} from "../../../web/agent-activity.js";

describe("turn activity", () => {
  it("treats only completed, failed, cancelled and interrupted as terminal", () => {
    expect([...TERMINAL_TURN_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
      "interrupted"
    ]);
    for (const status of ["queued", "dispatching", "running", "streaming", "cancelling", "cancel_requested"]) {
      expect(isTerminalTurnStatus(status)).toBe(false);
    }
    expect(isTerminalTurnStatus("completed")).toBe(true);
  });

  it("keeps an unknown status active so a new native state cannot unlock the composer early", () => {
    expect(isTerminalTurnStatus("paused")).toBe(false);
    expect(activeTurnActorIds([{ targetActorId: "agent:reviewer", status: "paused" }])).toEqual([
      "agent:reviewer"
    ]);
  });

  it("lists each working agent once, in first-seen order, while queued turns count", () => {
    expect(
      activeTurnActorIds([
        { targetActorId: "agent:reviewer", status: "running" },
        { targetActorId: "agent:architect", status: "queued" },
        { targetActorId: "agent:reviewer", status: "dispatching" },
        { targetActorId: "agent:reviewer", status: "completed" },
        { targetActorId: "agent:contrarian", status: "cancelling" },
        { targetActorId: "  ", status: "running" }
      ])
    ).toEqual(["agent:reviewer", "agent:architect", "agent:contrarian"]);
  });

  it("returns no working agent when every turn is terminal or the view is empty", () => {
    expect(activeTurnActorIds([])).toEqual([]);
    expect(
      activeTurnActorIds([
        { targetActorId: "agent:reviewer", status: "completed" },
        { targetActorId: "agent:architect", status: "failed" }
      ])
    ).toEqual([]);
  });

  it("earns a finished mark only from an observed active -> terminal transition", () => {
    expect(isFinishedTransition("running", "completed")).toBe(true);
    expect(isFinishedTransition("queued", "failed")).toBe(true);
    expect(isFinishedTransition(undefined, "completed")).toBe(false);
    expect(isFinishedTransition("completed", "completed")).toBe(false);
    expect(isFinishedTransition("failed", "completed")).toBe(false);
    expect(isFinishedTransition("running", "streaming")).toBe(false);
  });
});

describe("stop-everything target set", () => {
  it("keeps every non-terminal Turn, in first-seen order", () => {
    expect(
      cancellableTurnIds([
        { turnId: "turn:a", targetActorId: "agent:one", status: "running" },
        { turnId: "turn:b", targetActorId: "agent:two", status: "queued" },
        { turnId: "turn:c", targetActorId: "agent:three", status: "dispatching" }
      ])
    ).toEqual(["turn:a", "turn:b", "turn:c"]);
  });

  it("skips terminal Turns and Turns already asked to cancel", () => {
    expect(
      cancellableTurnIds([
        { turnId: "turn:done", targetActorId: "agent:one", status: "completed" },
        { turnId: "turn:asked", targetActorId: "agent:two", status: "cancel_requested" },
        { turnId: "turn:cancelling", targetActorId: "agent:two", status: "cancelling" },
        { turnId: "turn:fail", targetActorId: "agent:three", status: "failed" },
        { turnId: "turn:wip", targetActorId: "agent:four", status: "running" }
      ])
    ).toEqual(["turn:cancelling", "turn:wip"]);
  });

  it("drops blank and duplicated ids so one click is one command per Turn", () => {
    expect(
      cancellableTurnIds([
        { turnId: "  ", targetActorId: "agent:one", status: "running" },
        { turnId: " turn:x ", targetActorId: "agent:one", status: "running" },
        { turnId: "turn:x", targetActorId: "agent:one", status: "streaming" }
      ])
    ).toEqual(["turn:x"]);
  });

  it("still cancels a Turn in an unknown status (fail-safe, same rule as the lock)", () => {
    expect(
      cancellableTurnIds([{ turnId: "turn:paused", targetActorId: "agent:one", status: "paused" }])
    ).toEqual(["turn:paused"]);
  });
});

describe("released turns", () => {
  const turns = [
    { turnId: "turn:a", targetActorId: "agent:one", status: "cancel_requested" },
    { turnId: "turn:b", targetActorId: "agent:two", status: "running" }
  ];

  it("stops holding the composer once a stop was accepted", () => {
    expect(activeTurnActorIds(turns)).toEqual(["agent:one", "agent:two"]);
    expect(activeTurnActorIds(turns, { releasedTurnIds: new Set(["turn:a"]) })).toEqual([
      "agent:two"
    ]);
    expect(
      activeTurnActorIds(turns, { releasedTurnIds: new Set(["turn:a", "turn:b"]) })
    ).toEqual([]);
  });

  it("ignores releases for Turns that no longer exist and keeps order stable", () => {
    expect(
      activeTurnActorIds(turns, { releasedTurnIds: new Set(["turn:gone"]) })
    ).toEqual(["agent:one", "agent:two"]);
  });
});
