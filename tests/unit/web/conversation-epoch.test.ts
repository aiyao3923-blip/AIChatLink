import { describe, expect, it } from "vitest";

import {
  FIRST_EPOCH_START_SEQ,
  activeEpochStartSeq,
  epochStartAfterReset,
  eventInEpoch,
  turnActivityState
} from "../../../web/conversation-epoch.js";

describe("conversation epochs", () => {
  it("reads the open epoch start from the conversation list", () => {
    expect(
      activeEpochStartSeq([
        { startSeq: 260, active: true },
        { startSeq: 230, active: false }
      ])
    ).toBe(260);
  });

  it("falls back to the room start when no epoch is active", () => {
    expect(activeEpochStartSeq([])).toBe(FIRST_EPOCH_START_SEQ);
    expect(activeEpochStartSeq([{ startSeq: 30, active: false }])).toBe(FIRST_EPOCH_START_SEQ);
  });

  it("starts the next epoch right after the reset through seq", () => {
    expect(epochStartAfterReset(259)).toBe(260);
    expect(epochStartAfterReset(0)).toBe(1);
    expect(() => epochStartAfterReset(-1)).toThrow(/non-negative safe integer/u);
    expect(() => epochStartAfterReset(1.5)).toThrow(/non-negative safe integer/u);
  });

  it("keeps only the open epoch in the live timeline", () => {
    expect(eventInEpoch(259, 260)).toBe(false);
    expect(eventInEpoch(260, 260)).toBe(true);
    expect(eventInEpoch(266, 260)).toBe(true);
    // Live deltas carry no durable sequence.
    expect(eventInEpoch(null, 260)).toBe(true);
  });

  it("classifies turn lifecycle events", () => {
    expect(turnActivityState("turn.queued")).toBe("opening");
    expect(turnActivityState("turn.started")).toBe("opening");
    expect(turnActivityState("turn.cancelled")).toBe("terminal");
    expect(turnActivityState("turn.completed")).toBe("terminal");
    expect(turnActivityState("message.created")).toBeNull();
  });
});
