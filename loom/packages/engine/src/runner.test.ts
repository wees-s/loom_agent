import { describe, it, expect } from "vitest";
import { summarize } from "./runner.js";

describe("summarize", () => {
  it("returns the last meaningful line (the conclusion), not the first", () => {
    const pane = [
      "\x1b[2m$ claude -p ...\x1b[0m",
      "Welcome to Claude Code",
      "",
      "Analisei o log e encontrei 2 riscos novos.",
    ].join("\n");
    expect(summarize(pane)).toBe("Analisei o log e encontrei 2 riscos novos.");
  });

  it("strips ANSI escapes", () => {
    expect(summarize("\x1b[32mpronto\x1b[0m")).toBe("pronto");
  });

  it("skips trailing shell prompt lines", () => {
    const pane = ["resultado final aqui", "$ "].join("\n");
    expect(summarize(pane)).toBe("resultado final aqui");
  });

  it("returns undefined for empty / whitespace-only input", () => {
    expect(summarize("   \n  \n")).toBeUndefined();
  });

  it("truncates very long lines with an ellipsis", () => {
    const long = "x".repeat(300);
    const out = summarize(long)!;
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
  });
});
