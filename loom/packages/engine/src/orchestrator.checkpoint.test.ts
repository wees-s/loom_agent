import { describe, it, expect } from "vitest";
import { createOrchestrator } from "./orchestrator.js";
import type { Guard } from "./guard.js";
import type { Runner } from "./runner.js";
import type { Blackboard } from "./blackboard.js";
import type { SpecStore } from "./spec.js";
import type { Terminals } from "./terminals.js";
import type { EventLog } from "./eventlog.js";
import type { Emit, RunCtx, RunResult } from "./internal.js";
import {
  asFlowId, asNodeId, asEdgeId, type Flow, type LoomEvent, type StoredEvent,
} from "@loom/shared";

const FLOW = asFlowId("f1");
const TRIG = asNodeId("trig");
const WORK = asNodeId("work");

function makeFlow(reviewEachCycle: boolean): Flow {
  return {
    id: FLOW, name: "loop", version: 1, schedule: "manual", state: "ocioso", cycle: 0,
    reviewEachCycle,
    nodes: [
      { id: TRIG, type: "Trigger", title: "Trigger", role: "entry", model: "claude-haiku-4-5", prompt: "", linkedContexts: [], position: { x: 0, y: 0 }, trigger: { kind: "Intervalo", interval: "30 s" } },
      { id: WORK, type: "Analyst", title: "Worker", role: "w", model: "claude-haiku-4-5", prompt: "faz", linkedContexts: [], position: { x: 1, y: 0 } },
    ],
    edges: [
      { id: asEdgeId("e1"), from: TRIG, to: WORK },
      { id: asEdgeId("e2"), from: WORK, to: TRIG, feedback: true }, // feedback loop
    ],
    budget: { maxCyclesPerArm: 10, maxTokensPerRun: 999999, maxUsdPerRun: 999, maxTokensPerFlow: 9999999, maxUsdPerFlow: 9999, maxConcurrentAgents: 3, convergenceWindow: 99 },
    blackboardDir: "f1",
  };
}

function harness(flow: Flow) {
  const events: LoomEvent[] = [];
  const emit: Emit = (event) => { events.push(event); return { seq: events.length, ts: 1, event } as StoredEvent; };
  let cycleN = 0;
  const eventlog = { cycleCounter: () => cycleN, foldForOrphanRecovery: () => ({ unfinishedRuns: [], lastCycleByFlow: {} }) } as unknown as EventLog;
  // Guard fake: admit every spawn; grant the next cycle a few times, then deny
  // (so AUTO mode terminates instead of recursing forever in the test).
  let nextCalls = 0;
  const guard = {
    requestSpawn: () => ({ ok: true, value: { leaseId: "l", runId: "r", flowId: FLOW, model: "claude-haiku-4-5", reservedUsd: 0, reservedTokens: 0, signal: new AbortController().signal, grantedAt: 0 } }),
    releaseLease: () => {},
    requestNextCycle: () => {
      nextCalls++; cycleN++;
      if (nextCalls >= 4) return { ok: false as const, reason: "max_cycles_per_arm", detail: "cap" };
      return { ok: true as const, value: { arm: nextCalls, cycle: cycleN + 1 } };
    },
    spendForFlow: () => ({ flowId: FLOW, usdSpent: 0, tokensSpent: 0, usdReserved: 0, tokensReserved: 0 }),
    registerTerminal: () => {}, unregisterTerminal: () => {}, meterToken: () => {},
    isFlowArmed: () => true,
  } as unknown as Guard;
  // Runner fake: every run ok, no artifacts (nodes declare no produces → barrier passes on ok).
  const runner = {
    mode: "fake" as const,
    runAgent: async (ctx: RunCtx): Promise<RunResult> => {
      emit({ type: "run.started", runId: ctx.runId, flowId: FLOW, nodeId: ctx.node.id, cycle: ctx.cycle, model: ctx.model, at: 1 });
      emit({ type: "run.finished", runId: ctx.runId, status: "ok", at: 1 });
      return { runId: ctx.runId, status: "ok", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, toolCalls: 0, artifacts: {} };
    },
  } as unknown as Runner;
  const blackboard = {
    resolveDir: () => "/tmp/f1",
    toWindowsPath: async (p: string) => p,
    sha256: async () => undefined,
    resolveContext: () => ({ kind: "file", relPath: "x" }),
  } as unknown as Blackboard;
  const spec = { get: () => flow } as unknown as SpecStore;
  const terminals = { setOwnership: () => {}, ensure: async () => {} } as unknown as Terminals;
  const orch = createOrchestrator(eventlog, guard, runner, blackboard, spec, terminals, emit);
  return { orch, events, runCount: () => events.filter((e) => e.type === "run.started").length };
}

describe("orchestrator cycle checkpoint", () => {
  it("review mode: pauses into awaiting after the first cycle, no next-arm runs", async () => {
    const flow = makeFlow(true);
    const { orch, events, runCount } = harness(flow);
    const out = await orch.startCycle(flow, "Manual", 0);
    expect(out.status).toBe("awaiting");
    expect(orch.isAwaiting(FLOW)).toBe(true);
    expect(events.some((e) => e.type === "cycle.awaitingApproval")).toBe(true);
    expect(events.some((e) => e.type === "flow.stateChanged" && (e as { state: string }).state === "aguardando")).toBe(true);
    expect(runCount()).toBe(1); // only the first cycle's Worker ran
  });

  it("continueFlow resumes the approved arm (a second cycle runs)", async () => {
    const flow = makeFlow(true);
    const { orch, runCount } = harness(flow);
    await orch.startCycle(flow, "Manual", 0);
    expect(runCount()).toBe(1);
    const resumed = await orch.continueFlow(FLOW);
    expect(resumed).not.toBeNull();
    expect(runCount()).toBe(2);
  });

  it("auto mode: never awaits; terminates when the guard denies", async () => {
    const flow = makeFlow(false);
    const { orch } = harness(flow);
    const out = await orch.startCycle(flow, "Manual", 0);
    expect(out.status).not.toBe("awaiting");
    expect(orch.isAwaiting(FLOW)).toBe(false);
  });

  it("auto mode: an armed scheduled flow ends a cycle as 'agendado', not 'ocioso'", async () => {
    const flow = makeFlow(false); // no checkpoint; runs + stops at the guard cap
    const { orch, events } = harness(flow);
    await orch.startCycle(flow, "Manual", 0);
    const states = events.filter((e) => e.type === "flow.stateChanged").map((e) => (e as { state: string }).state);
    expect(states).toContain("agendado");
    expect(states[states.length - 1]).toBe("agendado"); // settles as scheduled, not stopped
  });

  it("clearAwaiting cancels a pending continuation", async () => {
    const flow = makeFlow(true);
    const { orch } = harness(flow);
    await orch.startCycle(flow, "Manual", 0);
    expect(orch.isAwaiting(FLOW)).toBe(true);
    orch.clearAwaiting(FLOW);
    expect(orch.isAwaiting(FLOW)).toBe(false);
    expect(await orch.continueFlow(FLOW)).toBeNull();
  });
});
