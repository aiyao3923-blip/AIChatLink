/**
 * The composer's single button answers two different questions over time:
 * "can I send" and "should I stop". Keeping that as a pure state machine means
 * the DOM projection stays a one-liner and the rules can be tested without a
 * browser — the busy lock is a product invariant, not a styling detail (D-050).
 */

export type SendButtonMode = "send" | "stop" | "blocked";

export interface ComposerStateInput {
  /** A POST /api/messages is still in flight. */
  readonly submitting: boolean;
  /** Turns in the current view that have not reached a terminal status. */
  readonly workingCount: number;
  /** Draft length after trim; zero disables an otherwise sendable button. */
  readonly draftLength: number;
  /** Stop requests were issued and are still outstanding. */
  readonly stopping: boolean;
}

export interface SendButtonState {
  readonly mode: SendButtonMode;
  readonly disabled: boolean;
  readonly label: string;
  readonly title: string;
  /** Only honest for a control that is actually blocked; a stop button is live. */
  readonly ariaBusy: boolean;
  readonly ariaLabel: string;
}

const SEND: SendButtonState = {
  mode: "send",
  disabled: false,
  label: "发送",
  title: "发送给已选 Agent",
  ariaBusy: false,
  ariaLabel: "发送"
};

function stopState(workingCount: number, stopping: boolean): SendButtonState {
  const count = Math.max(1, Math.trunc(workingCount));
  const title = stopping ? "正在终止本轮所有 Agent…" : `终止全部 ${count} 个 Agent 的工作`;
  return {
    mode: "stop",
    // While the cancel requests are outstanding a second click would only
    // re-send the same idempotent commands, so the button reports the state
    // instead of pretending to accept another press.
    disabled: stopping,
    label: "终止",
    title,
    ariaBusy: stopping,
    ariaLabel: `${title}（点击后本轮所有 Agent 立即收到取消）`
  };
}

export function sendButtonState(input: ComposerStateInput): SendButtonState {
  if (input.submitting) {
    return {
      mode: "blocked",
      disabled: true,
      label: "发送",
      title: "正在提交…",
      ariaBusy: true,
      ariaLabel: "正在提交"
    };
  }
  if (input.workingCount > 0) {
    return stopState(input.workingCount, input.stopping);
  }
  if (input.draftLength === 0) {
    return {
      mode: "blocked",
      disabled: true,
      label: "发送",
      title: "发送给已选 Agent",
      ariaBusy: false,
      ariaLabel: "发送"
    };
  }
  return SEND;
}

export interface UserMessageLike {
  readonly eventId: string;
  readonly correlationId: string;
  readonly content: string;
}

export type ResumeReason = "restored" | "kept-draft" | "no-message";

export interface ResumeAfterStopPlan {
  /** What to put back into the textarea, or null when nothing should change. */
  readonly content: string | null;
  /** The message the follow-up continues, so the room sees what is being amended. */
  readonly replyToEventId: string | null;
  readonly reason: ResumeReason;
}

/**
 * Stopping a task is only useful if the operator can fix it. This decides what
 * "补一句再继续" starts from:
 *
 * 1. never overwrite a draft the operator is already typing (`kept-draft`);
 * 2. otherwise bring back the newest prompt that owned one of the cancelled
 *    Turns, and thread the follow-up under it;
 * 3. if that prompt is no longer in view (another conversation, a reset), say so
 *    instead of restoring something unrelated.
 *
 * `messages` is expected oldest → newest and user-authored only; the caller owns
 * that projection because the DOM layer owns the event store.
 */
export function planResumeAfterStop(input: {
  readonly cancelledCorrelationIds: readonly string[];
  readonly messages: readonly UserMessageLike[];
  readonly draftLength: number;
}): ResumeAfterStopPlan {
  if (input.draftLength > 0) {
    return { content: null, replyToEventId: null, reason: "kept-draft" };
  }
  const wanted = new Set(input.cancelledCorrelationIds.filter((id) => id.length > 0));
  if (wanted.size === 0) {
    return { content: null, replyToEventId: null, reason: "no-message" };
  }
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message || !wanted.has(message.correlationId)) continue;
    const content = message.content.trim();
    if (content.length === 0) continue;
    return { content, replyToEventId: message.eventId, reason: "restored" };
  }
  return { content: null, replyToEventId: null, reason: "no-message" };
}
