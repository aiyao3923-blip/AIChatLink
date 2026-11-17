import { describe, expect, it } from "vitest";

import { formatCharacterEstimate } from "../../../web/usage-format.js";

describe("character estimate units", () => {
  it("keeps small figures as plain characters", () => {
    expect(formatCharacterEstimate(0)).toBe("0");
    expect(formatCharacterEstimate(1)).toBe("1");
    expect(formatCharacterEstimate(984)).toBe("984");
    expect(formatCharacterEstimate(999)).toBe("999");
  });

  it("uses k below a million without a hanging decimal", () => {
    expect(formatCharacterEstimate(1_000)).toBe("1k");
    expect(formatCharacterEstimate(17_800)).toBe("17.8k");
    expect(formatCharacterEstimate(25_840)).toBe("25.8k");
    expect(formatCharacterEstimate(100_000)).toBe("100k");
    expect(formatCharacterEstimate(256_000)).toBe("256k");
  });

  it("promotes to M instead of printing 1000k", () => {
    expect(formatCharacterEstimate(999_449)).toBe("999k");
    expect(formatCharacterEstimate(999_500)).toBe("1.0M");
    expect(formatCharacterEstimate(999_999)).toBe("1.0M");
    expect(formatCharacterEstimate(1_000_000)).toBe("1.0M");
    expect(formatCharacterEstimate(1_250_000)).toBe("1.3M");
    expect(formatCharacterEstimate(125_000_000)).toBe("125M");
  });

  it("never renders a negative or non-finite figure as a unit", () => {
    expect(formatCharacterEstimate(-5)).toBe("0");
    expect(formatCharacterEstimate(Number.NaN)).toBe("0");
    expect(formatCharacterEstimate(Number.POSITIVE_INFINITY)).toBe("0");
  });

  it("falls back to G above a billion", () => {
    expect(formatCharacterEstimate(1_000_000_000)).toBe("1.0G");
  });
});
