import { describe, expect, it } from "vitest";

import { echoRetiredBy } from "../../../web/pending-echo.js";

describe("pending send echo", () => {
  it("retires on identical text while the 202 has not named the event yet", () => {
    // The SSE frame regularly wins the race against the POST response, so the
    // echo has no id when its own message arrives.
    expect(
      echoRetiredBy({ content: "继续", eventId: null }, { eventId: "event:642", content: "继续" })
    ).toBe(true);
  });

  it("leaves a different text alone", () => {
    expect(
      echoRetiredBy({ content: "继续", eventId: null }, { eventId: "event:700", content: "换一版" })
    ).toBe(false);
  });

  it("retires on the named event id, not on coincidental text", () => {
    // Once the 202 named an event, the same text from another client must not
    // retire this echo: that frame belongs to somebody else's message.
    const echo = { content: "继续", eventId: "event:642" };
    expect(echoRetiredBy(echo, { eventId: "event:900", content: "继续" })).toBe(false);
    expect(echoRetiredBy(echo, { eventId: "event:642", content: "继续" })).toBe(true);
  });
});
