import { describe, it, expect } from "vitest";
import { glassPanel, RADIUS, SPACE, FONT, TONE } from "./primitives";

describe("glassPanel", () => {
  it("returns the canonical glass recipe", () => {
    const g = glassPanel();
    expect(g.background).toBe("var(--glass)");
    expect(String(g.backdropFilter)).toContain("blur(22px)");
    expect(String(g.border)).toContain("var(--glass-border)");
    expect(typeof g.boxShadow).toBe("string");
    expect(g.borderRadius).toBe(RADIUS.lg);
  });
  it("merges overrides (overrides win)", () => {
    const g = glassPanel({ width: 300, borderRadius: 8 });
    expect(g.width).toBe(300);
    expect(g.borderRadius).toBe(8); // override wins
    expect(g.background).toBe("var(--glass)"); // recipe preserved
  });
});

describe("scales + tones", () => {
  it("RADIUS/SPACE/FONT have the expected anchors", () => {
    expect(RADIUS.lg).toBe(15);
    expect(SPACE.lg).toBe(16);
    expect(FONT.lg).toBe(13);
  });
  it("TONE covers all four tones with non-empty values", () => {
    for (const t of ["neutral", "good", "warn", "bad"] as const) {
      expect(typeof TONE[t]).toBe("string");
      expect(TONE[t].length).toBeGreaterThan(0);
    }
    expect(TONE.good).toBe("var(--accent)");
  });
});
