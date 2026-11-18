import { describe, expect, it } from "vitest";
import { DISABLED_NOTE, ROOM_VOICE, emptyVoiceFor } from "../../../web/empty-voice.js";

const ROLE_NAMES = ["意图", "提案", "批判", "设计", "总管", "审查", "核验", "人话"] as const;

describe("empty-pane voices", () => {
  it("gives every room role its own line, with or without a driver suffix", () => {
    for (const role of ROLE_NAMES) {
      const plain = emptyVoiceFor(role);
      const suffixed = emptyVoiceFor(`${role} · Codex`);
      expect(plain, role).toBeDefined();
      expect(suffixed, role).toEqual(plain);
    }
  });

  it("maps each role to a distinct line and byline", () => {
    const voices = ROLE_NAMES.map((role) => emptyVoiceFor(role));
    const quotes = new Set(voices.map((voice) => voice?.quote));
    const sources = new Set(voices.map((voice) => voice?.source));
    expect(quotes.size).toBe(ROLE_NAMES.length);
    expect(sources.size).toBe(ROLE_NAMES.length);
  });

  it("never invents a byline for a name outside the roster", () => {
    for (const name of ["", "   ", "议长", "总经理", "Agent-7"]) {
      expect(emptyVoiceFor(name), name).toBeUndefined();
    }
  });

  it("keeps the disabled note short enough to read in a lane", () => {
    expect(Array.from(DISABLED_NOTE).length).toBeLessThanOrEqual(30);
  });

  it("keeps every line inside the one-line pane budget", () => {
    const voices = [ROOM_VOICE, ...ROLE_NAMES.map((role) => emptyVoiceFor(role))];
    for (const voice of voices) {
      expect(voice).toBeDefined();
      // The view wraps the line in 「」; 24 CJK characters still fit one line
      // at 15px inside the 372px-wide empty state.
      expect(Array.from(`「${voice?.quote ?? ""}」`).length).toBeLessThanOrEqual(24);
      expect(voice?.source ?? "").not.toContain("——");
    }
  });
});
