import { describe, it, expect } from "vitest";
import {
  MODEL_CATALOG,
  MODEL_REGISTRY,
  labelForModel,
  NODE_TYPE_CATALOG,
  typeDef,
  semanticsOf,
  zFlowSpec,
  zGeneratedFlow,
  zClientCommand,
  findForwardCycle,
  PROTOCOL_VERSION,
  makeId,
} from "./index.js";

describe("flow.generate + zGeneratedFlow", () => {
  it("zClientCommand accepts flow.generate", () => {
    expect(zClientCommand.safeParse({ t: "flow.generate", cmdId: "c1", prompt: "faça um loop" }).success).toBe(true);
  });
  const good = {
    name: "Revisor de PRs",
    nodes: [
      { id: "t", type: "Trigger", title: "Cron", role: "entry", prompt: "" },
      { id: "a", type: "Analyst", title: "Analista", role: "analisa", prompt: "analise os PRs" },
    ],
    edges: [{ from: "t", to: "a" }],
  };
  it("zGeneratedFlow accepts a valid full flow", () => {
    expect(zGeneratedFlow.safeParse(good).success).toBe(true);
  });
  it("rejects a flow with no Trigger node", () => {
    const noTrig = { ...good, nodes: [good.nodes[1]] };
    expect(zGeneratedFlow.safeParse(noTrig).success).toBe(false);
  });
  it("rejects an edge referencing an unknown node id", () => {
    const badEdge = { ...good, edges: [{ from: "t", to: "ghost" }] };
    expect(zGeneratedFlow.safeParse(badEdge).success).toBe(false);
  });
});

describe("flow.continue + reviewEachCycle contracts", () => {
  it("zClientCommand accepts flow.continue", () => {
    const r = zClientCommand.safeParse({ t: "flow.continue", cmdId: "c1", flowId: "f1" });
    expect(r.success).toBe(true);
  });
  it("zClientCommand rejects flow.continue without flowId", () => {
    const r = zClientCommand.safeParse({ t: "flow.continue", cmdId: "c1" });
    expect(r.success).toBe(false);
  });
  it("zFlowSpec accepts an optional reviewEachCycle boolean", () => {
    const base = {
      id: "f1", name: "x", version: 1, schedule: "manual", blackboardDir: "f1",
      budget: { maxCyclesPerArm: 4, maxTokensPerRun: 1, maxUsdPerRun: 1, maxTokensPerFlow: 1, maxUsdPerFlow: 1, maxConcurrentAgents: 1, convergenceWindow: 1 },
      nodes: [{ id: "n1", type: "Trigger", title: "t", role: "", model: MODEL_CATALOG[0]!.id, prompt: "", position: { x: 0, y: 0 } }],
      edges: [],
    };
    expect(zFlowSpec.safeParse({ ...base, reviewEachCycle: true }).success).toBe(true);
    expect(zFlowSpec.safeParse(base).success).toBe(true);
  });
});

describe("models", () => {
  it("every catalog model has a registry entry and vice-versa", () => {
    const catalogIds = MODEL_CATALOG.map((m) => m.id).sort();
    const registryIds = Object.keys(MODEL_REGISTRY).sort();
    expect(catalogIds).toEqual(registryIds);
  });

  it("labelForModel resolves friendly labels and falls back to the id", () => {
    expect(labelForModel("claude-opus-4-8")).toBe("Claude Opus 4.1");
    // @ts-expect-error — unknown id falls back to itself at runtime
    expect(labelForModel("nope")).toBe("nope");
  });

  it("registry pricing is internally consistent (output >= input, positive ceilings)", () => {
    for (const p of Object.values(MODEL_REGISTRY)) {
      expect(p.outputPer1M).toBeGreaterThanOrEqual(p.inputPer1M);
      expect(p.maxOutputTokens).toBeGreaterThan(0);
    }
  });
});

describe("catalog", () => {
  it("has the four recommended Padrões with correct semantics", () => {
    const padroes = NODE_TYPE_CATALOG.filter((d) => d.category === "Padrões");
    expect(padroes.map((d) => d.type)).toEqual(["Trigger", "Analyst", "Synthesizer", "Executor"]);
    expect(typeDef("Trigger").semantics).toBe("trigger");
    expect(semanticsOf("Synthesizer")).toBe("synthesizer");
    expect(semanticsOf("Coder")).toBe("generic");
  });

  it("typeDef throws on an unknown type", () => {
    // @ts-expect-error — deliberately invalid
    expect(() => typeDef("Nonexistent")).toThrow();
  });

  it("all type names are unique", () => {
    const names = NODE_TYPE_CATALOG.map((d) => d.type);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("zFlowSpec", () => {
  const base = {
    id: "f1",
    name: "Test",
    version: 0,
    schedule: "09:00",
    blackboardDir: "daily",
    budget: {
      maxCyclesPerArm: 3,
      maxTokensPerRun: 100_000,
      maxUsdPerRun: 1,
      maxTokensPerFlow: 500_000,
      maxUsdPerFlow: 5,
      maxConcurrentAgents: 3,
      convergenceWindow: 2,
    },
    nodes: [
      {
        id: "n1",
        type: "Trigger",
        title: "Start",
        role: "kickoff",
        model: "claude-haiku-4-5",
        prompt: "go",
        linkedContexts: [],
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };

  it("accepts a valid spec with a Trigger node", () => {
    const parsed = zFlowSpec.parse(base);
    expect(parsed.nodes[0]?.type).toBe("Trigger");
  });

  it("rejects a spec with no Trigger node", () => {
    const bad = { ...base, nodes: [{ ...base.nodes[0], type: "Analyst" }] };
    expect(zFlowSpec.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty node list", () => {
    expect(zFlowSpec.safeParse({ ...base, nodes: [] }).success).toBe(false);
  });

  it("workDir is optional but accepted as an absolute path when present", () => {
    // Omitted → still valid, and absent from the parsed object.
    const without = zFlowSpec.parse(base);
    expect(without.workDir).toBeUndefined();

    // Present → round-trips verbatim (a REAL user folder).
    const withWd = zFlowSpec.parse({ ...base, workDir: "/home/wesley/WORKSPACE/proj" });
    expect(withWd.workDir).toBe("/home/wesley/WORKSPACE/proj");
  });
});

describe("zClientCommand", () => {
  it("validates a play command", () => {
    const r = zClientCommand.safeParse({ t: "flow.play", cmdId: "c1", flowId: "f1" });
    expect(r.success).toBe(true);
  });

  it("validates a flow.delete command", () => {
    const r = zClientCommand.safeParse({ t: "flow.delete", cmdId: "c1", flowId: "f1" });
    expect(r.success).toBe(true);
  });

  it("rejects a flow.delete missing flowId", () => {
    const r = zClientCommand.safeParse({ t: "flow.delete", cmdId: "c1" });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown command tag", () => {
    const r = zClientCommand.safeParse({ t: "bogus", cmdId: "c1" });
    expect(r.success).toBe(false);
  });

  it("spec.save accepts an EditableFlow carrying an optional workDir", () => {
    const flow = {
      id: "f1",
      name: "Test",
      workDir: "/home/wesley/WORKSPACE/proj",
      nodes: [
        {
          id: "n1",
          type: "Trigger",
          title: "Start",
          role: "kickoff",
          model: "claude-haiku-4-5",
          prompt: "go",
          linkedContexts: [],
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    };
    const r = zClientCommand.safeParse({ t: "spec.save", cmdId: "c1", flow });
    expect(r.success).toBe(true);
    if (r.success && r.data.t === "spec.save") {
      expect(r.data.flow.workDir).toBe("/home/wesley/WORKSPACE/proj");
    }
  });
});

describe("findForwardCycle", () => {
  it("returns null on an acyclic forward graph", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    expect(findForwardCycle(nodes, edges)).toBeNull();
  });

  it("ignores feedback edges when detecting cycles", () => {
    const nodes = [{ id: "a" }, { id: "b" }];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "a", feedback: true },
    ];
    expect(findForwardCycle(nodes, edges)).toBeNull();
  });

  it("detects a real forward cycle", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ];
    const cyc = findForwardCycle(nodes, edges);
    expect(cyc).not.toBeNull();
    expect(cyc!.length).toBeGreaterThan(0);
  });
});

describe("misc", () => {
  it("PROTOCOL_VERSION is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
  it("makeId honours the prefix and is reasonably unique", () => {
    const a = makeId("n_");
    const b = makeId("n_");
    expect(a.startsWith("n_")).toBe(true);
    expect(a).not.toBe(b);
  });
});
