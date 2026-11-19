import { describe, expect, it } from "vitest";

import { planResumeAfterStop, sendButtonState } from "../../../web/composer-state.js";

const idle = { submitting: false, workingCount: 0, draftLength: 0, stopping: false };

describe("composer send/stop button", () => {
  it("is a blocked send button when the draft is empty — and keeps the plane", () => {
    expect(sendButtonState(idle)).toMatchObject({
      mode: "blocked",
      disabled: true,
      label: "发送",
      ariaBusy: false,
      // An idle composer is disabled, not busy: the ring must never spin here.
      spinning: false
    });
  });

  it("is a send button once there is a draft and nothing is running", () => {
    expect(sendButtonState({ ...idle, draftLength: 3 })).toMatchObject({
      mode: "send",
      disabled: false,
      label: "发送",
      title: "发送给已选 Agent",
      spinning: false
    });
  });

  it("blocks while the POST is in flight, before any Turn exists", () => {
    expect(sendButtonState({ ...idle, submitting: true, draftLength: 3 })).toMatchObject({
      mode: "blocked",
      disabled: true,
      ariaBusy: true,
      title: "正在提交…"
    });
  });

  it("becomes a live stop button while any Turn is in flight, draft or not", () => {
    const state = sendButtonState({ ...idle, workingCount: 2 });
    expect(state).toMatchObject({
      mode: "stop",
      disabled: false,
      label: "终止",
      ariaBusy: false,
      spinning: true
    });
    expect(state.title).toContain("终止全部 2 个 Agent");
    expect(state.ariaLabel).toContain("终止全部 2 个 Agent");
  });

  it("keeps the stop button but reports progress while cancels are outstanding", () => {
    expect(sendButtonState({ ...idle, workingCount: 8, stopping: true })).toMatchObject({
      mode: "stop",
      disabled: true,
      ariaBusy: true,
      title: "正在终止本轮所有 Agent…"
    });
  });

  it("spins again while the stop requests are still outstanding", () => {
    expect(
      sendButtonState({ ...idle, submitting: false, workingCount: 0, draftLength: 0, stopping: false })
        .spinning
    ).toBe(false);
    expect(sendButtonState({ ...idle, workingCount: 2, stopping: true }).spinning).toBe(true);
  });

  it("counts an unknown working state as one Agent instead of printing a NaN", () => {
    expect(sendButtonState({ ...idle, workingCount: 0.4 }).title).toContain("1 个 Agent");
  });

  it("never disables a live stop button just because the draft is empty", () => {
    expect(sendButtonState({ ...idle, workingCount: 1, draftLength: 0 }).disabled).toBe(false);
  });

  it("prefers the submit block over the stop button: one POST is one intent", () => {
    expect(sendButtonState({ ...idle, submitting: true, workingCount: 3 }).mode).toBe("blocked");
  });
});

describe("resume after stop", () => {
  const messages = [
    { eventId: "evt:1", correlationId: "corr:a", content: "  先分析日志  " },
    { eventId: "evt:2", correlationId: "corr:b", content: "顺手把 README 也改了" }
  ];

  it("brings back the newest prompt that owned a cancelled Turn", () => {
    expect(
      planResumeAfterStop({
        cancelledCorrelationIds: ["corr:a", "corr:b"],
        messages,
        draftLength: 0
      })
    ).toEqual({ content: "顺手把 README 也改了", replyToEventId: "evt:2", reason: "restored" });
  });

  it("picks the message of the cancelled correlation, not the newest message overall", () => {
    expect(
      planResumeAfterStop({
        cancelledCorrelationIds: ["corr:a"],
        messages,
        draftLength: 0
      })
    ).toEqual({ content: "先分析日志", replyToEventId: "evt:1", reason: "restored" });
  });

  it("never overwrites a draft the operator is already typing", () => {
    expect(
      planResumeAfterStop({
        cancelledCorrelationIds: ["corr:a"],
        messages,
        draftLength: 7
      })
    ).toEqual({ content: null, replyToEventId: null, reason: "kept-draft" });
  });

  it("reports no-message when the prompt is out of view instead of restoring a stranger", () => {
    expect(
      planResumeAfterStop({
        cancelledCorrelationIds: ["corr:gone"],
        messages,
        draftLength: 0
      })
    ).toEqual({ content: null, replyToEventId: null, reason: "no-message" });
  });

  it("ignores blank correlations and blank content", () => {
    expect(
      planResumeAfterStop({
        cancelledCorrelationIds: ["  "],
        messages,
        draftLength: 0
      }).reason
    ).toBe("no-message");
    expect(
      planResumeAfterStop({
        cancelledCorrelationIds: ["corr:blank"],
        messages: [{ eventId: "evt:9", correlationId: "corr:blank", content: "   " }],
        draftLength: 0
      }).reason
    ).toBe("no-message");
  });
});
