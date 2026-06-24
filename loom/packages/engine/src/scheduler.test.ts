// =============================================================================
// scheduler.test.ts — SAFE BY DEFAULT: the scheduler must NOT auto-arm or
// auto-fire any trigger on boot. A loaded flow's triggers register DORMANT
// (paused, no cron/timer, nextRun null); a cycle starts ONLY on an explicit
// flow.play (resumeFlow) or flow.runNow. Uses fakes (no real guard/orchestrator,
// no claude); the http server binds to an ephemeral port and is closed per test.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createScheduler, type Scheduler } from "./scheduler.js";
import type { Guard } from "./guard.js";
import type { Orchestrator, CycleOutcome } from "./orchestrator.js";
import type { SpecStore } from "./spec.js";
import type { Emit, CycleCause } from "./internal.js";
import {
  asFlowId,
  asNodeId,
  type Flow,
  type FlowId,
  type LoomEvent,
  type StoredEvent,
  type AgentNode,
  type TriggerConfig,
} from "@loom/shared";

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

function makeEmitter(): { events: LoomEvent[]; emit: Emit } {
  const events: LoomEvent[] = [];
  const emit: Emit = (event) => {
    events.push(event);
    return { seq: events.length, ts: Date.now(), event } as StoredEvent;
  };
  return { events, emit };
}

/** Orchestrator fake that just RECORDS startCycle calls (the "did it fire?" probe). */
function makeFakeOrchestrator(): Orchestrator & { started: { flowId: string; cause: CycleCause }[] } {
  const started: { flowId: string; cause: CycleCause }[] = [];
  return {
    started,
    plan: () => ({ flowId: asFlowId("x"), layers: [], feedbackEdges: [] }),
    startCycle: async (flow: Flow, cause: CycleCause): Promise<CycleOutcome> => {
      started.push({ flowId: flow.id as string, cause });
      return { status: "done", cycle: 1 };
    },
    recoverOrphans: async () => {},
    isRunning: () => false,
    continueFlow: async () => null,
    isAwaiting: () => false,
    clearAwaiting: () => {},
  };
}

function makeFakeGuard(): Guard {
  // The scheduler never calls the guard directly (it defers to the orchestrator),
  // so a do-nothing stub is enough.
  return {} as unknown as Guard;
}

function triggerNode(id: string, trigger: TriggerConfig): AgentNode {
  return {
    id: asNodeId(id),
    type: "Trigger",
    title: `Trigger ${id}`,
    role: "entry",
    model: "claude-haiku-4-5",
    prompt: "",
    linkedContexts: [],
    position: { x: 0, y: 0 },
    trigger,
  };
}

function makeFlow(id: string, trigger: TriggerConfig): Flow {
  return {
    id: asFlowId(id),
    name: `Flow ${id}`,
    version: 1,
    schedule: "",
    state: "ocioso",
    cycle: 0,
    blackboardDir: id,
    nodes: [triggerNode("trigger", trigger)],
    edges: [],
    budget: {
      maxCyclesPerArm: 4,
      maxTokensPerRun: 200_000,
      maxUsdPerRun: 2,
      maxTokensPerFlow: 2_000_000,
      maxUsdPerFlow: 20,
      maxConcurrentAgents: 3,
      convergenceWindow: 2,
    },
  };
}

function makeFakeSpec(flows: Flow[]): SpecStore {
  const byId = new Map(flows.map((f) => [f.id as string, f]));
  return {
    load: async () => { throw new Error("nope"); },
    listFlows: async () => flows,
    get: (id: FlowId) => byId.get(id as string) ?? null,
    all: () => [...byId.values()],
    save: async () => { throw new Error("nope"); },
    create: async () => { throw new Error("nope"); },
    delete: async () => { throw new Error("nope"); },
    lint: () => [],
  };
}

// Ephemeral port (0) so parallel test files never collide.
const PORT = 0;

let sched: Scheduler | null = null;
afterEach(async () => {
  if (sched) await sched.stop();
  sched = null;
  vi.useRealTimers();
});

describe("scheduler — SAFE BY DEFAULT (no auto-arm / no auto-fire on boot)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("start() registers every trigger DORMANT (paused, nextRun null) and fires nothing", async () => {
    const orch = makeFakeOrchestrator();
    const agendado = makeFlow("flow-agendado", { kind: "Agendado", freq: "Diário", time: "09:00" });
    const intervalo = makeFlow("flow-intervalo", { kind: "Intervalo", interval: "5 min" });
    const webhook = makeFlow("flow-webhook", { kind: "Webhook", event: "github.push" });
    const spec = makeFakeSpec([agendado, intervalo, webhook]);
    const { emit } = makeEmitter();

    sched = createScheduler(makeFakeGuard(), orch, spec, emit);
    await sched.start(PORT);

    // EVERY arm is dormant: paused true, nextRun null (no cron/interval computed).
    const arms = sched.armed();
    expect(arms.length).toBe(3);
    for (const a of arms) {
      expect(a.paused).toBe(true);
      expect(a.nextRun).toBeNull();
    }

    // Advance well past every interval/cron window — NOTHING fires (boot is inert).
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000); // 7 hours
    expect(orch.started).toHaveLength(0);
  });

  it("an Intervalo flow does NOT fire on boot even after its interval elapses", async () => {
    const orch = makeFakeOrchestrator();
    const flow = makeFlow("flow-int", { kind: "Intervalo", interval: "5 min" });
    sched = createScheduler(makeFakeGuard(), orch, makeFakeSpec([flow]), makeEmitter().emit);
    await sched.start(PORT);

    await vi.advanceTimersByTimeAsync(20 * 60_000); // 20 min: 4 windows
    expect(orch.started).toHaveLength(0);
  });

  it("flow.play (resumeFlow) is what arms a flow; only then does it fire", async () => {
    const orch = makeFakeOrchestrator();
    const flow = makeFlow("flow-int2", { kind: "Intervalo", interval: "5 min" });
    sched = createScheduler(makeFakeGuard(), orch, makeFakeSpec([flow]), makeEmitter().emit);
    await sched.start(PORT);

    // Before play: dormant, nextRun null.
    expect(sched.nextRunFor(flow.id, asNodeId("trigger"))).toBeNull();

    // Explicit play.
    sched.resumeFlow(flow.id);
    expect(sched.armed()[0]?.paused).toBe(false);
    // An interval arm now has a forward nextRun.
    expect(sched.nextRunFor(flow.id, asNodeId("trigger"))).not.toBeNull();

    // After play, the interval window fires a cycle.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(orch.started.length).toBeGreaterThanOrEqual(1);
    expect(orch.started[0]?.cause).toBe("Intervalo");
  });

  it("pauseFlow disarms an armed flow back to dormant (no further fires)", async () => {
    const orch = makeFakeOrchestrator();
    const flow = makeFlow("flow-int3", { kind: "Intervalo", interval: "5 min" });
    sched = createScheduler(makeFakeGuard(), orch, makeFakeSpec([flow]), makeEmitter().emit);
    await sched.start(PORT);

    sched.resumeFlow(flow.id);
    sched.pauseFlow(flow.id);
    expect(sched.armed()[0]?.paused).toBe(true);
    expect(sched.nextRunFor(flow.id, asNodeId("trigger"))).toBeNull();

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(orch.started).toHaveLength(0);
  });

  it("runNow force-fires a DORMANT (never-played) flow — an explicit user start", async () => {
    const orch = makeFakeOrchestrator();
    const flow = makeFlow("flow-manual", { kind: "Manual" });
    sched = createScheduler(makeFakeGuard(), orch, makeFakeSpec([flow]), makeEmitter().emit);
    await sched.start(PORT);

    // The flow is dormant (paused) on boot…
    expect(sched.armed()[0]?.paused).toBe(true);
    // …yet runNow fires it (explicit action), with the Manual cause.
    await sched.runNow(flow.id);
    expect(orch.started).toHaveLength(1);
    expect(orch.started[0]?.cause).toBe("Manual");
  });

  it("an ARMED Intervalo fires REPEATEDLY on its own (recurrence); pause stops it", async () => {
    const orch = makeFakeOrchestrator();
    const flow = makeFlow("flow-rec", { kind: "Intervalo", interval: "1 min" });
    sched = createScheduler(makeFakeGuard(), orch, makeFakeSpec([flow]), makeEmitter().emit);
    await sched.start(PORT);

    // Arm it (flow.play). It must now fire ON ITS OWN, repeatedly — no further
    // user action. This is the heart of "agendamento recorrente".
    sched.resumeFlow(flow.id);
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 500); // ~4 one-minute windows
    expect(orch.started.length).toBeGreaterThanOrEqual(2); // re-armed + fired again
    expect(orch.started.every((s) => s.cause === "Intervalo")).toBe(true);

    // Pause disarms — zero further autonomous fires after that point.
    const atPause = orch.started.length;
    sched.pauseFlow(flow.id);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(orch.started.length).toBe(atPause);
  });
});
