import { describe, expect, it } from "vitest";

import { sendButtonState } from "../../../web/composer-state.js";

const idle = { submitting: false, workingCount: 0, draftLength: 0, stopping: false };

describe("composer send/stop button", () => {
  it("is a blocked send button when the draft is empty", () => {
    expect(sendButtonState(idle)).toMatchObject({
      mode: "blocked",
      disabled: true,
      label: "发送",
      ariaBusy: false
    });
  });

  it("is a send button once there is a draft and nothing is running", () => {
    expect(sendButtonState({ ...idle, draftLength: 3 })).toMatchObject({
      mode: "send",
      disabled: false,
      label: "发送",
      title: "发送给已选 Agent"
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
      ariaBusy: false
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
