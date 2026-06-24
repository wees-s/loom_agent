import { describe, it, expect } from "vitest";
import { createGenerator, extractJsonFlow } from "./generator.js";
import { zGeneratedFlow } from "@loom/shared";
import type { Emit } from "./internal.js";

const emit: Emit = (e) => ({ seq: 1, ts: 1, event: e }) as never;

describe("extractJsonFlow", () => {
  it("parses bare JSON", () => {
    expect(extractJsonFlow('{"name":"x"}')).toEqual({ name: "x" });
  });
  it("parses fenced ```json blocks", () => {
    expect(extractJsonFlow('blah\n```json\n{"name":"y"}\n```\ndone')).toEqual({ name: "y" });
  });
  it("finds the first balanced object amid prose", () => {
    expect(extractJsonFlow('Aqui está:\n{"name":"z","nodes":[]}\nfim')).toEqual({ name: "z", nodes: [] });
  });
  it("returns null for non-JSON garbage", () => {
    expect(extractJsonFlow("sem json aqui")).toBeNull();
  });
});

describe("fake generator", () => {
  it("returns a deterministic flow valid against zGeneratedFlow", async () => {
    const gen = createGenerator("fake", emit);
    const r = await gen.generate("revisa PRs e me avisa");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(zGeneratedFlow.safeParse(r.flow).success).toBe(true);
      expect(r.flow.nodes.some((n) => n.type === "Trigger")).toBe(true);
      expect(r.flow.name.toLowerCase()).toContain("revisa"); // incorporates the prompt
    }
  });
});
