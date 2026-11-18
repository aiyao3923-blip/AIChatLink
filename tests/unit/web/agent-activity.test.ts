import { describe, expect, it } from "vitest";

import {
  TERMINAL_TURN_STATUSES,
  activeTurnActorIds,
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
