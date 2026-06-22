import { describe, it, expect } from "vitest";
import { narrateEvent, type NarrationCtx } from "./index.js";
import { asNodeId, asRunId, asFlowId, asEdgeId } from "./index.js";
import type { LoomEvent } from "./index.js";

const NODE = asNodeId("n1");
const RUN = asRunId("r1");
const FLOW = asFlowId("f1");

const ctx: NarrationCtx = {
  node: (id) => (id === NODE ? { title: "Scribe", type: "Analyst" } : undefined),
  runNode: (rid) => (rid === RUN ? NODE : undefined),
};

function line(ev: LoomEvent) {
  return narrateEvent(ev, 7, 1000, ctx);
}

describe("narrateEvent", () => {
  it("trigger.fired (scheduled) → trigger line", () => {
    const r = line({ type: "trigger.fired", flowId: FLOW, nodeId: NODE, cause: "Agendado", at: 1000 });
    expect(r).toMatchObject({ kind: "trigger", tone: "neutral", id: "7", cycle: -1 });
    expect(r!.text).toContain("disparou");
  });

  it("trigger.fired (feedback) → re-arm wording", () => {
    const r = line({ type: "trigger.fired", flowId: FLOW, nodeId: NODE, cause: "feedback", at: 1000 });
    expect(r!.text.toLowerCase()).toContain("realimentou");
  });

  it("cycle.started → cycle line carrying its own cycle number", () => {
    const r = line({ type: "cycle.started", flowId: FLOW, cycle: 3, at: 1000 });
    expect(r).toMatchObject({ kind: "cycle", cycle: 3 });
    expect(r!.text).toContain("3");
  });

  it("node.activated → agent started, actor resolved", () => {
    const r = line({ type: "node.activated", flowId: FLOW, nodeId: NODE, runId: RUN, cycle: 2 });
    expect(r).toMatchObject({ kind: "agent", actor: "Scribe", cycle: 2, tone: "neutral" });
  });

  it("run.finished ok → good, actor via runNode, uses resultSummary", () => {
    const r = line({ type: "run.finished", runId: RUN, status: "ok", resultSummary: "2 riscos novos", at: 1000 });
    expect(r).toMatchObject({ kind: "agent", actor: "Scribe", tone: "good" });
    expect(r!.text).toContain("2 riscos novos");
  });

  it("run.finished error → bad with error text", () => {
    const r = line({ type: "run.finished", runId: RUN, status: "error", error: "claude saiu com código 1", at: 1000 });
    expect(r).toMatchObject({ tone: "bad" });
    expect(r!.text).toContain("código 1");
  });

  it("run.finished timeout/killed → warn", () => {
    expect(line({ type: "run.finished", runId: RUN, status: "timeout", at: 1000 })!.tone).toBe("warn");
    expect(line({ type: "run.finished", runId: RUN, status: "killed", at: 1000 })!.tone).toBe("warn");
  });

  it("blackboard.write → artifact chip with bytes", () => {
    const r = line({ type: "blackboard.write", flowId: FLOW, path: "resumo.md", byNodeId: NODE, bytes: 2300, hash: "abc", at: 1000 });
    expect(r).toMatchObject({ kind: "artifact", actor: "Scribe", tone: "good" });
    expect(r!.artifact).toEqual({ path: "resumo.md", bytes: 2300 });
  });

  it("cycle.converged → neutral cycle line", () => {
    const r = line({ type: "cycle.converged", flowId: FLOW, cycle: 4, reason: "no-new-output", at: 1000 });
    expect(r).toMatchObject({ kind: "cycle", cycle: 4 });
    expect(r!.text.toLowerCase()).toContain("convergiu");
  });

  it("cycle.ended done → null (noise), stopped → warn, killed → bad", () => {
    expect(line({ type: "cycle.ended", flowId: FLOW, cycle: 1, status: "done", totalUsd: 0, at: 1000 })).toBeNull();
    expect(line({ type: "cycle.ended", flowId: FLOW, cycle: 1, status: "stopped", totalUsd: 0, at: 1000 })!.tone).toBe("warn");
    expect(line({ type: "cycle.ended", flowId: FLOW, cycle: 1, status: "killed", totalUsd: 0, at: 1000 })!.tone).toBe("bad");
  });

  it("budget.tripped → warn budget line", () => {
    const r = line({ type: "budget.tripped", flowId: FLOW, scope: "flow", metric: "usd", limit: 20 });
    expect(r).toMatchObject({ kind: "budget", tone: "warn" });
  });

  it("kill.requested → bad", () => {
    const r = line({ type: "kill.requested", flowId: FLOW, by: "user", at: 1000 });
    expect(r).toMatchObject({ kind: "kill", tone: "bad" });
  });

  it("log maps color → tone", () => {
    expect(line({ type: "log", flowId: FLOW, color: "rose", msg: "x", at: 1000 })!.tone).toBe("bad");
    expect(line({ type: "log", flowId: FLOW, color: "amber", msg: "x", at: 1000 })!.tone).toBe("warn");
  });

  it("unknown node id → actor fallback, never throws", () => {
    const r = line({ type: "node.activated", flowId: FLOW, nodeId: asNodeId("missing"), runId: RUN, cycle: 1 });
    expect(r!.actor).toBeUndefined();
    expect(r!.text.length).toBeGreaterThan(0);
  });

  it("noise events return null", () => {
    expect(line({ type: "run.started", runId: RUN, flowId: FLOW, nodeId: NODE, cycle: 1, model: "claude-sonnet-4-6", at: 1000 })).toBeNull();
    expect(line({ type: "node.deactivated", flowId: FLOW, nodeId: NODE, runId: RUN })).toBeNull();
    expect(line({ type: "run.token", runId: RUN, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0 })).toBeNull();
    expect(line({ type: "edge.fired", flowId: FLOW, edgeId: asEdgeId("e1"), cycle: 1 })).toBeNull();
    expect(line({ type: "terminal.state", terminal: "term://1", status: "idle", meta: "" })).toBeNull();
  });
});
