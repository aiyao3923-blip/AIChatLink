/**
 * The operator's own message is painted before the Broker confirms it. The
 * transcript is a projection of durable events, so a normal send shows nothing
 * until the `POST /api/messages` 202 lands and its `message.created` frame
 * arrives over SSE. Inside a resumed conversation that gap is the whole native
 * session swap — every Adapter is replaced before the message may even be
 * posted — so the operator watches an empty column for seconds after pressing
 * Enter.
 *
 * The echo is chrome, not state: it never enters `state.messages`, `eventNodes`,
 * `paneLog`, or the message index, and it never claims the message is stored —
 * it stays labelled 发送中 until a durable frame retires it, and it is removed
 * when the send fails. This module holds only the retirement rule, so the rule
 * can be tested without a DOM.
 */

export interface PendingEchoClaim {
  /** What the operator sent; the only evidence available before the 202 lands. */
  content: string;
  /** Known once `POST /api/messages` returned its `messageEventId`. */
  eventId: string | null;
}

/**
 * Whether a durable operator message retires the echo.
 *
 * The event id wins as soon as the 202 has named one: from then on a text match
 * could belong to a different operator message sent from another client. Before
 * that the id is unknown — the SSE frame regularly wins the race against the
 * 202 — so identical content is the only evidence an envelope carries.
 */
export function echoRetiredBy(
  echo: PendingEchoClaim,
  incoming: { eventId: string; content: string }
): boolean {
  if (echo.eventId !== null) {
    return echo.eventId === incoming.eventId;
  }
  return echo.content === incoming.content;
}
