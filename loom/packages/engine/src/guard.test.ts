// =============================================================================
// guard.test.ts — Vitest suite for guard.ts (safety chokepoint) and
//                 orchestrator.ts (Kahn layering, feedback-cut DAG, presence barrier).
//
// Uses FAKE EventLog stubs (no node:sqlite / no DB) and FAKE runner mode
// (no token cost, no claude spawn). Fully isolated, zero I/O.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { createGuard, worstCaseRunCost } from "./guard.js";
import { createOrchestrator } from "./orchestrator.js";
import { createRunner } from "./runner.js";
import type {
  EventLog,
  FlowStateProjection,
  OrphanRecoveryPlan,
  FlowSpendFold,
} from "./eventlog.js";
import type { Guard } from "./guard.js";
import type {
  Emit,
  SpawnRequest,
  NextCycleRequest,
  RunSpend,
  EventListener,
  Unsubscribe,
} from "./internal.js";
import type { AuthService, AuthStatus } from "./auth.js";
import type { Blackboard } from "./blackboard.js";
import type { SpecStore } from "./spec.js";
import type { Terminals } from "./terminals.js";
import type {
  Flow,
  FlowId,
  NodeId,
  EdgeId,
  RunId,
  AgentNode,
  Edge,
  FlowBudget,
  ModelId,
  LoomEvent,
  FlowSummary,
  StoredEvent,
} from "@loom/shared";
import {
  asFlowId,
  asNodeId,
  asEdgeId,
  asRunId,
  MODEL_REGISTRY,
} from "@loom/shared";

// =============================================================================
// Fake EventLog — no sqlite, no I/O. Supports subscribe() so the guard can
// register its blackboard.write listener and we can drive it manually.
// =============================================================================

function makeFakeEventLog(): EventLog & {
  /** Manually fire a stored event through all subscribers (for convergence tests). */
  _fire(event: LoomEvent): void;
  /** Current cycle counter per flow (defaults to 0). */
  _setCycleCounter(flowId: FlowId, n: number): void;
  /** Seed the committed-spend fold the guard rehydrates from on construction. */
  _setFlowSpend(folds: FlowSpendFold[]): void;
} {
  const listeners = new Set<EventListener>();
  let seq = 0;
  const cycleCounters = new Map<string, number>();
  let spendFold: FlowSpendFold[] = [];

  function _fire(event: LoomEvent): void {
    seq++;
    const stored: StoredEvent = { seq, ts: Date.now(), event };
    for (const l of listeners) {
      try { l(stored); } catch { /* swallow */ }
    }
  }

  return {
    append(event: LoomEvent): StoredEvent {
      seq++;
      const stored: StoredEvent = { seq, ts: Date.now(), event };
      for (const l of listeners) {
        try { l(stored); } catch { /* swallow */ }
      }
      return stored;
    },
    readSince: () => [],
    latestSeq: () => seq,
    subscribe(listener: EventListener): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    projectFlowSummaries: (): FlowSummary[] => [],
    flowState: (flowId: FlowId): FlowStateProjection => ({
      flowId,
      state: "ocioso",
      cycle: cycleCounters.get(flowId as string) ?? 0,
    }),
    cycleCounter: (flowId: FlowId): number =>
      cycleCounters.get(flowId as string) ?? 0,
    recentRuns: () => [],
    foldFlowSpend: (): FlowSpendFold[] => spendFold,
    foldForOrphanRecovery: (): OrphanRecoveryPlan => ({
      unfinishedRuns: [],
      lastCycleByFlow: {},
    }),
    close: () => {},
    _fire,
    _setCycleCounter(flowId: FlowId, n: number): void {
      cycleCounters.set(flowId as string, n);
    },
    _setFlowSpend(folds: FlowSpendFold[]): void {
      spendFold = folds;
    },
  };
}

// =============================================================================
// Other fakes / helpers
// =============================================================================

function makeEmitter(): { events: LoomEvent[]; emit: Emit } {
  const events: LoomEvent[] = [];
  const emit: Emit = (event) => {
    events.push(event);
    return { seq: events.length, ts: Date.now(), event } as ReturnType<Emit>;
  };
  return { events, emit };
}

function readyAuth(): AuthService {
  const status: AuthStatus = { ok: true, detail: "fake-ok", checkedAt: Date.now() };
  return {
    preflight: async () => status,
    current: () => status,
    isReady: () => true,
  };
}

function notReadyAuth(): AuthService {
  return {
    preflight: async () => ({ ok: false, detail: "not-ready", checkedAt: Date.now() }),
    current: () => ({ ok: false, detail: "not-ready", checkedAt: Date.now() }),
    isReady: () => false,
  };
}

function defaultBudget(): FlowBudget {
  return {
    maxCyclesPerArm: 5,
    maxTokensPerRun: 1_000_000,
    maxUsdPerRun: 100,
    maxTokensPerFlow: 10_000_000,
    maxUsdPerFlow: 1_000,
    maxConcurrentAgents: 4,
    convergenceWindow: 3,
  };
}

function makeGuard(
  log: EventLog,
  auth: AuthService,
  emit: Emit,
  budget: Partial<FlowBudget> = {},
  // Optional flow id the budget applies to (integration call sites pass it for
  // readability). The budget callback returns the SAME merged budget for every
  // flow, so this arg is purely documentary; accept it so those calls typecheck.
  _flowId?: FlowId,
): Guard {
  const merged = { ...defaultBudget(), ...budget };
  const guard = createGuard(log, auth, emit, (_fid) => merged);
  // SAFE-BY-DEFAULT shim for the EXISTING admission/convergence/kill suites: a
  // flow is now un-armed (and thus denied) until explicitly armed. Those tests
  // exercise the post-arm admission math, so the helper auto-arms a flow the
  // first time it is the subject of a spawn/next-cycle request — mirroring what
  // flow.play/runNow do in the bridge. CRITICAL: we only auto-arm a flow that
  // has NOT been killed, because setFlowArmed(true) clears the kill latch (a
  // play after kill is a real re-arm). The kill suite kills then expects
  // flow_killed, so re-arming a killed flow here would wrongly resurrect it.
  // The dedicated "flow_not_armed" suite uses makeRawGuard to test the un-armed
  // denial directly (no auto-arm).
  const autoArmed = new Set<string>();
  const killedHere = new Set<string>();
  // Auto-arm a flow once, but never resurrect one this guard already killed (so
  // the kill suite still sees flow_killed). setFlowArmed(true) clears the kill
  // latch in production (play-after-kill), which the shim must NOT trigger.
  const ensureArmed = (flowId: FlowId): void => {
    const id = flowId as string;
    if (killedHere.has(id) || autoArmed.has(id)) return;
    autoArmed.add(id);
    guard.setFlowArmed(flowId, true);
  };
  return new Proxy(guard, {
    get(target, prop, receiver) {
      if (prop === "requestSpawn") {
        return (req: SpawnRequest): ReturnType<Guard["requestSpawn"]> => {
          ensureArmed(req.flowId);
          return target.requestSpawn(req);
        };
      }
      if (prop === "requestNextCycle") {
        return (req: NextCycleRequest): ReturnType<Guard["requestNextCycle"]> => {
          ensureArmed(req.flowId);
          return target.requestNextCycle(req);
        };
      }
      if (prop === "killFlow") {
        return async (flowId: FlowId, cause: Parameters<Guard["killFlow"]>[1]): Promise<void> => {
          killedHere.add(flowId as string);
          return target.killFlow(flowId, cause);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Raw guard with NO auto-arm shim — used to test the safe-by-default gate. */
function makeRawGuard(
  log: EventLog,
  auth: AuthService,
  emit: Emit,
  budget: Partial<FlowBudget> = {},
): Guard {
  const merged = { ...defaultBudget(), ...budget };
  return createGuard(log, auth, emit, (_fid) => merged);
}

function spawnReq(
  flowId: FlowId,
  model: ModelId = "claude-haiku-4-5",
  estInputTokens = 1_000,
): SpawnRequest & { runId: RunId } {
  const runId = asRunId(`run-${Math.random().toString(36).slice(2)}`);
  return { flowId, runId, nodeId: asNodeId("node-1"), model, estInputTokens };
}

// ---- Orchestrator fakes ----

function makeFakeBlackboard(
  artifacts: Map<string, string> = new Map(),
): Blackboard {
  return {
    resolveDir: () => "/tmp/fake-bb",
    toWindowsPath: async (p) => p,
    atomicWrite: async (flowId, _nodeId, relPath, content) => {
      const hash = `hash-${relPath}-${Date.now()}`;
      artifacts.set(`${String(flowId)}/${relPath}`, hash);
      return {
        relPath,
        bytes: typeof content === "string" ? content.length : content.byteLength,
        hash,
      };
    },
    sha256: async (flowId, relPath) =>
      artifacts.get(`${String(flowId)}/${relPath}`) ?? null,
    read: async (_flowId, relPath) => `content-of-${relPath}`,
    exists: async (flowId, relPath) =>
      artifacts.has(`${String(flowId)}/${relPath}`),
    list: async () => [],
    resolveContext: (_flowId, ref) => ({
      kind: "file",
      relPath: ref,
      absPath: `/tmp/${ref}`,
    }),
  };
}

function makeFakeSpec(flow: Flow | null = null): SpecStore {
  return {
    load: async () => { throw new Error("not implemented"); },
    listFlows: async () => (flow ? [flow] : []),
    get: () => flow,
    all: () => (flow ? [flow] : []),
    save: async () => { throw new Error("not implemented"); },
  } as unknown as SpecStore;
}

function makeFakeTerminals(): Terminals {
  return {
    ensure: async (id: string) => ({ id, title: id, status: "idle", meta: "idle" }),
    send: async () => {},
    runInPane: async () => ({ exitCode: 0, aborted: false, timedOut: false, degraded: false }),
    capturePane: async () => "",
    recentOutput: () => "",
    list: () => [],
    get: () => null,
    setOwnership: () => {},
    onData: () => () => {},
    dispose: async () => {},
    disposeFlow: async () => {},
  } as unknown as Terminals;
}

function makeFlow(
  overrides: {
    id?: string;
    nodes?: AgentNode[];
    edges?: Edge[];
    budget?: Partial<FlowBudget>;
  } = {},
): Flow {
  const id = asFlowId(overrides.id ?? "flow-1");
  return {
    id,
    name: "Test Flow",
    version: 1,
    schedule: "",
    state: "ocioso",
    cycle: 0,
    blackboardDir: `bb-${String(id)}`,
    nodes: overrides.nodes ?? [],
    edges: overrides.edges ?? [],
    budget: { ...defaultBudget(), ...overrides.budget },
  };
}

function makeNode(
  id: string,
  type: "Trigger" | "Analyst" | "Synthesizer" | "Executor" | "Writer" = "Analyst",
  produces?: string[],
): AgentNode {
  return {
    id: asNodeId(id),
    type,
    title: `Node-${id}`,
    role: `role-${id}`,
    model: "claude-haiku-4-5",
    prompt: `prompt for ${id}`,
    linkedContexts: [],
    position: { x: 0, y: 0 },
    ...(produces !== undefined ? { produces } : {}),
  };
}

function makeEdge(
  id: string,
  from: string,
  to: string,
  feedback = false,
): Edge {
  return {
    id: asEdgeId(id),
    from: asNodeId(from),
    to: asNodeId(to),
    feedback,
  };
}

// =============================================================================
// SECTION 1 — worstCaseRunCost helper
// =============================================================================

describe("worstCaseRunCost", () => {
  it("haiku: output ceiling × outputPer1M + input × inputPer1M", () => {
    const p = MODEL_REGISTRY["claude-haiku-4-5"];
    const budgeted = 10_000;
    const expected =
      (p.maxOutputTokens * p.outputPer1M) / 1e6 +
      (budgeted * p.inputPer1M) / 1e6;
    expect(worstCaseRunCost("claude-haiku-4-5", budgeted)).toBeCloseTo(expected, 9);
  });

  it("falls back to the most expensive model for an unknown id", () => {
    const unknownId = "claude-unknown-x" as ModelId;
    const cost = worstCaseRunCost(unknownId, 0);
    const maxCost = Math.max(
      ...Object.values(MODEL_REGISTRY).map(
        (p) => (p.maxOutputTokens * p.outputPer1M) / 1e6,
      ),
    );
    expect(cost).toBeGreaterThanOrEqual(maxCost);
  });

  it("is always positive for zero input", () => {
    for (const id of Object.keys(MODEL_REGISTRY) as ModelId[]) {
      expect(worstCaseRunCost(id, 0)).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// SECTION 2 — Pre-spend admission (requestSpawn)
// =============================================================================

describe("guard — pre-spend admission (requestSpawn)", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;
  let flowId: FlowId;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
    flowId = asFlowId("flow-1");
  });

  it("admits a run that fits within all caps", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    expect(guard.requestSpawn(spawnReq(flowId)).ok).toBe(true);
  });

  it("denies when per-run USD cap is exceeded by worst-case cost (haiku, maxUsdPerRun=0.001)", () => {
    // Haiku worst-case for 0 input: 64_000 × $5/1M = $0.32 >> $0.001.
    const guard = makeGuard(log, readyAuth(), emitter.emit, { maxUsdPerRun: 0.001 });
    const req = spawnReq(flowId, "claude-haiku-4-5", 0);
    const d = guard.requestSpawn(req);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("per_run_usd_cap");

    const tripped = emitter.events.find((e) => e.type === "budget.tripped");
    expect(tripped).toBeDefined();
  });

  it("denies when per-run token cap is exceeded", () => {
    // maxTokensPerRun=1: any model's worst-case token count >> 1.
    const guard = makeGuard(log, readyAuth(), emitter.emit, { maxTokensPerRun: 1 });
    const d = guard.requestSpawn(spawnReq(flowId, "claude-haiku-4-5", 0));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("per_run_token_cap");
  });

  it("denies when per-flow USD cap would be exceeded by projected cost", () => {
    const haiku = MODEL_REGISTRY["claude-haiku-4-5"];
    const wc = (haiku.maxOutputTokens * haiku.outputPer1M) / 1e6; // ≈ $0.32

    // Allow one run but not two: maxUsdPerFlow = 1.5× wc.
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxUsdPerFlow: wc * 1.5,
      maxUsdPerRun: wc * 2, // per-run is generous
      maxConcurrentAgents: 4,
    });

    const d1 = guard.requestSpawn(spawnReq(flowId, "claude-haiku-4-5", 0));
    expect(d1.ok).toBe(true);

    const d2 = guard.requestSpawn(spawnReq(flowId, "claude-haiku-4-5", 0));
    expect(d2.ok).toBe(false);
    if (!d2.ok)
      expect(["per_flow_usd_cap", "per_flow_token_cap"]).toContain(d2.reason);
  });

  it("denies when per-flow token cap would be exceeded", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxTokensPerFlow: 1, // absurdly tiny
    });
    const d = guard.requestSpawn(spawnReq(flowId, "claude-haiku-4-5", 0));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("per_flow_token_cap");
  });

  it("denies when auth is not ready", () => {
    const guard = makeGuard(log, notReadyAuth(), emitter.emit);
    const d = guard.requestSpawn(spawnReq(flowId));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("auth_not_ready");
  });

  it("denies when flow is paused", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    guard.setFlowPaused(flowId, true);
    const d = guard.requestSpawn(spawnReq(flowId));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("flow_paused");
  });

  it("denies when flow has been killed", async () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    await guard.killFlow(flowId, "user");
    const d = guard.requestSpawn(spawnReq(flowId));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("flow_killed");
  });

  it("denies when concurrency limit is reached (maxConcurrentAgents=1)", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxConcurrentAgents: 1,
    });
    const d1 = guard.requestSpawn(spawnReq(flowId));
    expect(d1.ok).toBe(true);
    const d2 = guard.requestSpawn(spawnReq(flowId));
    expect(d2.ok).toBe(false);
    if (!d2.ok) expect(d2.reason).toBe("concurrency_full");
  });

  it("releases slot and reservation after releaseLease, allowing a new admission", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxConcurrentAgents: 1,
    });
    const req1 = spawnReq(flowId);
    const d1 = guard.requestSpawn(req1);
    expect(d1.ok).toBe(true);
    if (d1.ok)
      guard.releaseLease(d1.value, {
        runId: req1.runId,
        usdSpent: 0,
        tokensSpent: 0,
      });

    const d2 = guard.requestSpawn(spawnReq(flowId));
    expect(d2.ok).toBe(true);
  });

  it("resume (setFlowPaused false) clears both paused and killed latch", async () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    await guard.killFlow(flowId, "user");
    guard.setFlowPaused(flowId, false); // resume clears killedFlows too.
    // A real flow.play also re-arms (killFlow disarmed it); mirror that here. The
    // makeGuard proxy won't auto-arm a flow it killed, so arm explicitly.
    guard.setFlowArmed(flowId, true);
    const d = guard.requestSpawn(spawnReq(flowId));
    expect(d.ok).toBe(true);
  });

  it("SpawnLease contains expected fields with correct types", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    const req = spawnReq(flowId);
    const d = guard.requestSpawn(req);
    expect(d.ok).toBe(true);
    if (d.ok) {
      const lease = d.value;
      expect(lease.runId).toBe(req.runId);
      expect(lease.flowId).toBe(flowId);
      expect(lease.model).toBe(req.model);
      expect(lease.reservedUsd).toBeGreaterThan(0);
      expect(lease.reservedTokens).toBeGreaterThan(0);
      expect(typeof lease.signal).toBe("object");
      expect(lease.grantedAt).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// SECTION 2b — SAFE BY DEFAULT: a flow is un-armed (denied) until explicitly
// played/run. Uses makeRawGuard (NO auto-arm shim) to test the gate directly.
// =============================================================================

describe("guard — safe by default (flow must be armed before any spawn/cycle)", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;
  let flowId: FlowId;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
    flowId = asFlowId("flow-arm-gate");
  });

  it("denies requestSpawn with flow_not_armed for a never-armed (freshly-loaded) flow", () => {
    const guard = makeRawGuard(log, readyAuth(), emitter.emit);
    const d = guard.requestSpawn(spawnReq(flowId));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("flow_not_armed");
    // No lease minted → no slot consumed.
    expect(guard.isFlowArmed(flowId)).toBe(false);
  });

  it("denies requestNextCycle with flow_not_armed for a never-armed flow", () => {
    const guard = makeRawGuard(log, readyAuth(), emitter.emit);
    const d = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("flow_not_armed");
  });

  it("admits once explicitly armed (setFlowArmed true) — the flow.play / runNow path", () => {
    const guard = makeRawGuard(log, readyAuth(), emitter.emit);
    expect(guard.requestSpawn(spawnReq(flowId)).ok).toBe(false);
    guard.setFlowArmed(flowId, true);
    expect(guard.isFlowArmed(flowId)).toBe(true);
    expect(guard.requestSpawn(spawnReq(flowId)).ok).toBe(true);
  });

  it("disarming (setFlowArmed false) returns the flow to the denied state", () => {
    const guard = makeRawGuard(log, readyAuth(), emitter.emit);
    guard.setFlowArmed(flowId, true);
    expect(guard.requestSpawn(spawnReq(flowId)).ok).toBe(true);
    guard.setFlowArmed(flowId, false);
    const d = guard.requestSpawn(spawnReq(flowId));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("flow_not_armed");
  });

  it("killFlow disarms — a killed flow reports flow_killed, and after re-arm it runs again", async () => {
    const guard = makeRawGuard(log, readyAuth(), emitter.emit);
    guard.setFlowArmed(flowId, true);
    await guard.killFlow(flowId, "user");
    expect(guard.isFlowArmed(flowId)).toBe(false);
    const killed = guard.requestSpawn(spawnReq(flowId));
    expect(killed.ok).toBe(false);
    if (!killed.ok) expect(killed.reason).toBe("flow_killed");

    // An explicit re-arm (play) clears the kill latch + arms → runs again.
    guard.setFlowArmed(flowId, true);
    expect(guard.requestSpawn(spawnReq(flowId)).ok).toBe(true);
  });
});

// =============================================================================
// SECTION 3 — maxCyclesPerArm (requestNextCycle)
// =============================================================================

describe("guard — maxCyclesPerArm (requestNextCycle)", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;
  let flowId: FlowId;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
    flowId = asFlowId("flow-arm");
  });

  it("allows cycles below maxCyclesPerArm (arms 0..cap-2 all pass)", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxCyclesPerArm: 5,
      convergenceWindow: 99,
    });
    // arm 0 → nextArm=1 < 5 → ok; arm 1 → nextArm=2 < 5 → ok; arm 3 → nextArm=4 < 5 → ok.
    for (let arm = 0; arm < 4; arm++) {
      const d = guard.requestNextCycle({ flowId, arm, cycle: arm + 1 });
      expect(d.ok).toBe(true);
      if (d.ok) {
        expect(d.value.arm).toBe(arm + 1);
        expect(d.value.cycle).toBe(arm + 2);
      }
    }
  });

  it("denies when arm+1 >= maxCyclesPerArm (arm=2, cap=3)", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxCyclesPerArm: 3,
      convergenceWindow: 99,
    });
    const d = guard.requestNextCycle({ flowId, arm: 2, cycle: 3 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("max_cycles_per_arm");

    const tripped = emitter.events.find(
      (e) => e.type === "budget.tripped" && (e as any).metric === "cycles",
    );
    expect(tripped).toBeDefined();
  });

  it("denies immediately when maxCyclesPerArm is 1 (arm=0 → nextArm=1 >= 1)", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxCyclesPerArm: 1,
      convergenceWindow: 99,
    });
    const d = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("max_cycles_per_arm");
  });

  it("denies requestNextCycle when flow is killed", async () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, { convergenceWindow: 99 });
    await guard.killFlow(flowId, "user");
    const d = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("flow_killed");
  });

  it("denies requestNextCycle when auth is not ready", () => {
    const guard = makeGuard(log, notReadyAuth(), emitter.emit, { convergenceWindow: 99 });
    const d = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("auth_not_ready");
  });
});

// =============================================================================
// SECTION 4 — Convergence (artifact-hash window)
// =============================================================================

describe("guard — convergence detection (requestNextCycle)", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;
  let flowId: FlowId;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
    flowId = asFlowId("flow-conv");
  });

  /** Simulate a blackboard.write event with a given hash + cycle. */
  function fireBbWrite(cycle: number, hash: string): void {
    log._setCycleCounter(flowId, cycle);
    log._fire({
      type: "blackboard.write",
      flowId,
      path: "out.md",
      byNodeId: asNodeId("n1"),
      bytes: 100,
      hash,
      at: Date.now(),
    });
  }

  it("allows next cycle when a fresh artifact hash appeared in the previous cycle", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxCyclesPerArm: 99,
      convergenceWindow: 3,
    });
    // Inject a fresh hash for cycle 1.
    fireBbWrite(1, "hash-aaa");

    const d = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d.ok).toBe(true);
  });

  it("denies after convergenceWindow barren cycles (convergenceWindow=2)", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxCyclesPerArm: 99,
      convergenceWindow: 2,
    });

    // First barren call: cyclesWithoutNewHash becomes 1 (< 2) → allow.
    const d1 = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d1.ok).toBe(true);

    // Second barren call: cyclesWithoutNewHash becomes 2 (>= 2) → deny.
    const d2 = guard.requestNextCycle({ flowId, arm: 1, cycle: 2 });
    expect(d2.ok).toBe(false);
    if (!d2.ok) expect(d2.reason).toBe("converged");
  });

  it("resets barren count after a fresh hash appears between calls", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxCyclesPerArm: 99,
      convergenceWindow: 2,
    });

    // First call: barren → cyclesWithoutNewHash = 1.
    const d1 = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d1.ok).toBe(true);

    // Inject a fresh hash before the next call.
    fireBbWrite(2, "hash-brand-new");

    // Second call: new hash was seen → reset counter → allow.
    const d2 = guard.requestNextCycle({ flowId, arm: 1, cycle: 2 });
    expect(d2.ok).toBe(true);

    // Third call with no hash: barren count restarts from 1 (< 2) → allow.
    const d3 = guard.requestNextCycle({ flowId, arm: 2, cycle: 3 });
    expect(d3.ok).toBe(true);
  });

  it("a repeated (already-seen) hash does not count as fresh — window=2 (single-settlement)", () => {
    // convergenceWindow=2: deny when cyclesWithoutNewHash >= 2.
    // SINGLE-SETTLEMENT: the barren counter is bumped EXACTLY ONCE per cycle, at
    // the gate. The old code double-counted (rollover + gate), tripping the window
    // a cycle early; with the off-by-one fixed it takes two genuinely barren
    // cycles to converge.
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxCyclesPerArm: 99,
      convergenceWindow: 2,
    });

    // Cycle 1: fresh hash "same-hash" appears.
    fireBbWrite(1, "same-hash");

    // d1 (arm=0, cycle=1): cycle 1 produced a NEW hash → cyclesWithoutNewHash=0 → allow.
    const d1 = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d1.ok).toBe(true);

    // Cycle 2: SAME hash again — not fresh (already in seenHashes). The rollover
    // in foldArtifactHash NO LONGER touches the counter (single-settlement).
    fireBbWrite(2, "same-hash");

    // d2 (arm=1, cycle=2): barren → counter goes 0→1 (< 2) → allow.
    const d2 = guard.requestNextCycle({ flowId, arm: 1, cycle: 2 });
    expect(d2.ok).toBe(true);

    // Cycle 3: SAME hash again — still not fresh.
    fireBbWrite(3, "same-hash");

    // d3 (arm=2, cycle=3): barren → counter goes 1→2 (>= 2) → deny.
    const d3 = guard.requestNextCycle({ flowId, arm: 2, cycle: 3 });
    expect(d3.ok).toBe(false);
    if (!d3.ok) expect(d3.reason).toBe("converged");
  });

  it("convergenceWindow=1 denies on the very first barren cycle", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxCyclesPerArm: 99,
      convergenceWindow: 1,
    });
    // No artifact hash fired → barren from the start.
    const d = guard.requestNextCycle({ flowId, arm: 0, cycle: 1 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("converged");
  });
});

// =============================================================================
// SECTION 5 — Live per-run abort (meterToken)
// =============================================================================

describe("guard — live per-run abort (meterToken)", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;
  let flowId: FlowId;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
    flowId = asFlowId("flow-meter");
  });

  it("aborts the run's AbortSignal when meterToken exceeds per-run USD cap", () => {
    // maxUsdPerRun must be >= worstCaseRunCost for admission (haiku ≈ $0.321 + input).
    // We set it generously at $2 so admission passes, then meter $3 to trip the live abort.
    const guard = makeGuard(log, readyAuth(), emitter.emit, { maxUsdPerRun: 2.0 });
    const req = spawnReq(flowId);
    const d = guard.requestSpawn(req);
    expect(d.ok).toBe(true);
    if (!d.ok) return;

    const lease = d.value;
    expect(lease.signal.aborted).toBe(false);

    guard.meterToken(req.runId, 3.0, 0); // $3 > $2 per-run cap → live abort fires

    expect(lease.signal.aborted).toBe(true);
    const tripped = emitter.events.find(
      (e) => e.type === "budget.tripped" && (e as any).scope === "run",
    );
    expect(tripped).toBeDefined();
  });

  it("aborts the run's AbortSignal when meterToken exceeds per-run token cap", () => {
    // haiku worst-case tokens = 65_000. Set maxTokensPerRun = 200_000 so admission passes,
    // then meter 300_000 tokens to trip the live abort.
    const guard = makeGuard(log, readyAuth(), emitter.emit, { maxTokensPerRun: 200_000 });
    const req = spawnReq(flowId);
    const d = guard.requestSpawn(req);
    expect(d.ok).toBe(true);
    if (!d.ok) return;

    const lease = d.value;
    expect(lease.signal.aborted).toBe(false);

    guard.meterToken(req.runId, 0, 300_000); // 300k > 200k token cap → live abort fires

    expect(lease.signal.aborted).toBe(true);
    const tripped = emitter.events.find(
      (e) =>
        e.type === "budget.tripped" &&
        (e as any).scope === "run" &&
        (e as any).metric === "tokens",
    );
    expect(tripped).toBeDefined();
  });

  it("tripRun is idempotent — emits budget.tripped only once", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, { maxUsdPerRun: 2.0 });
    const req = spawnReq(flowId);
    const d = guard.requestSpawn(req);
    if (!d.ok) return;

    guard.meterToken(req.runId, 3.0, 0); // trip
    const countAfterFirst = emitter.events.filter(
      (e) => e.type === "budget.tripped" && (e as any).scope === "run",
    ).length;

    guard.meterToken(req.runId, 0.05, 0); // second call — must be idempotent
    const countAfterSecond = emitter.events.filter(
      (e) => e.type === "budget.tripped" && (e as any).scope === "run",
    ).length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("meterToken on an unknown runId does not throw or emit", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    expect(() =>
      guard.meterToken(asRunId("nonexistent-run"), 999, 999_999),
    ).not.toThrow();
    const tripped = emitter.events.find((e) => e.type === "budget.tripped");
    expect(tripped).toBeUndefined();
  });

  it("spendForFlow reflects committed spend after releaseLease", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    const req = spawnReq(flowId);
    const d = guard.requestSpawn(req);
    expect(d.ok).toBe(true);
    if (!d.ok) return;

    guard.meterToken(req.runId, 0.05, 500);
    guard.releaseLease(d.value, {
      runId: req.runId,
      usdSpent: 0.07,
      tokensSpent: 700,
    });

    const snap = guard.spendForFlow(flowId);
    expect(snap.usdSpent).toBeCloseTo(0.07, 9);
    expect(snap.tokensSpent).toBe(700);
    expect(snap.usdReserved).toBe(0);
    expect(snap.tokensReserved).toBe(0);
  });
});

// =============================================================================
// SECTION 6 — killFlow: marks flow killed + aborts live leases
// =============================================================================

describe("guard — killFlow", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;
  let flowId: FlowId;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
    flowId = asFlowId("flow-kill");
  });

  it("emits kill.requested and latches the flow as killed", async () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    await guard.killFlow(flowId, "user");

    const killEvent = emitter.events.find((e) => e.type === "kill.requested");
    expect(killEvent).toBeDefined();
    expect((killEvent as any).by).toBe("user");

    const d = guard.requestSpawn(spawnReq(flowId));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("flow_killed");
  });

  it("aborts all live run signals when the flow is killed", async () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxConcurrentAgents: 3,
    });
    const req1 = spawnReq(flowId);
    const req2 = spawnReq(flowId);
    const d1 = guard.requestSpawn(req1);
    const d2 = guard.requestSpawn(req2);
    expect(d1.ok).toBe(true);
    expect(d2.ok).toBe(true);
    if (!d1.ok || !d2.ok) return;

    const sig1 = d1.value.signal;
    const sig2 = d2.value.signal;
    expect(sig1.aborted).toBe(false);
    expect(sig2.aborted).toBe(false);

    await guard.killFlow(flowId, "budget");

    expect(sig1.aborted).toBe(true);
    expect(sig2.aborted).toBe(true);
  });

  it("all kill causes produce kill.requested with the correct by field", async () => {
    for (const cause of ["user", "budget", "maxCycles", "convergence"] as const) {
      const fid = asFlowId(`flow-kill-${cause}`);
      const localLog = makeFakeEventLog();
      const localEmitter = makeEmitter();
      const guard = makeGuard(localLog, readyAuth(), localEmitter.emit);
      await guard.killFlow(fid, cause);
      const ev = localEmitter.events.find((e) => e.type === "kill.requested");
      expect(ev).toBeDefined();
      expect((ev as any).by).toBe(cause);
    }
  });

  it("availableSlots decreases on admit and increases on release", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxConcurrentAgents: 2,
    });
    expect(guard.availableSlots(flowId)).toBe(2);

    const req1 = spawnReq(flowId);
    const d1 = guard.requestSpawn(req1);
    expect(d1.ok).toBe(true);
    expect(guard.availableSlots(flowId)).toBe(1);

    const req2 = spawnReq(flowId);
    const d2 = guard.requestSpawn(req2);
    expect(d2.ok).toBe(true);
    expect(guard.availableSlots(flowId)).toBe(0);

    if (d1.ok)
      guard.releaseLease(d1.value, {
        runId: req1.runId,
        usdSpent: 0,
        tokensSpent: 0,
      });
    expect(guard.availableSlots(flowId)).toBe(1);
  });

  it("double releaseLease does not throw (best-effort accounting on second call)", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    const req = spawnReq(flowId);
    const d = guard.requestSpawn(req);
    expect(d.ok).toBe(true);
    if (!d.ok) return;

    const spend: RunSpend = { runId: req.runId, usdSpent: 0.01, tokensSpent: 100 };
    guard.releaseLease(d.value, spend);
    // Second release must not throw (best-effort: the guard re-folds spend via unknown path).
    expect(() => guard.releaseLease(d.value, spend)).not.toThrow();
    // Committed spend is non-negative (exact value depends on impl details of the unknown path).
    expect(guard.spendForFlow(flowId).usdSpent).toBeGreaterThanOrEqual(0.01);
  });
});

// =============================================================================
// SECTION 6b — Spend meter REHYDRATION from the event log on a fresh guard.
// The per-flow lifetime cap must survive an engine restart: createGuard folds
// foldFlowSpend() back into committedUsd/committedTokens at construction.
// =============================================================================

describe("guard — spend meter rehydration on boot (foldFlowSpend)", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;
  let flowId: FlowId;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
    flowId = asFlowId("flow-rehydrate");
  });

  it("rebuilds committed spend from the event log so spendForFlow reflects prior runs", () => {
    // Simulate a prior engine run that already spent $7.50 / 12_345 tokens.
    log._setFlowSpend([
      { flowId, committedUsd: 7.5, committedTokens: 12_345 },
    ]);

    // A FRESH guard (engine restart) must rehydrate from the log, not start at 0.
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    const snap = guard.spendForFlow(flowId);
    expect(snap.usdSpent).toBeCloseTo(7.5, 9);
    expect(snap.tokensSpent).toBe(12_345);
  });

  it("the rehydrated per-flow USD cap is enforced — a restart does NOT reset it", () => {
    const haiku = MODEL_REGISTRY["claude-haiku-4-5"];
    const wc = (haiku.maxOutputTokens * haiku.outputPer1M) / 1e6; // ≈ $0.32

    // Prior runs already committed just under one worst-case run below the cap,
    // so after rehydration there is NOT enough headroom for another run.
    const maxUsdPerFlow = wc * 1.5;
    log._setFlowSpend([
      { flowId, committedUsd: maxUsdPerFlow - wc * 0.25, committedTokens: 0 },
    ]);

    const guard = makeGuard(log, readyAuth(), emitter.emit, {
      maxUsdPerFlow,
      maxUsdPerRun: wc * 2, // generous per-run so the per-flow cap is what bites.
    });

    // committed (rehydrated) + worst-case of this run > per-flow cap → denied.
    const d = guard.requestSpawn(spawnReq(flowId, "claude-haiku-4-5", 0));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("per_flow_usd_cap");
  });

  it("a guard with an empty fold starts at zero committed spend (no prior runs)", () => {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    const snap = guard.spendForFlow(flowId);
    expect(snap.usdSpent).toBe(0);
    expect(snap.tokensSpent).toBe(0);
  });
});

// =============================================================================
// SECTION 7 — Orchestrator: Kahn layering + feedback edge cutting (plan())
// =============================================================================

describe("orchestrator — plan() (Kahn layering, feedback edge cutting)", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
  });

  function makeOrchestrator(flow: Flow) {
    const guard = makeGuard(log, readyAuth(), emitter.emit);
    const blackboard = makeFakeBlackboard();
    const spec = makeFakeSpec(flow);
    const terminals = makeFakeTerminals();
    const runner = createRunner("fake", guard, blackboard, terminals, emitter.emit);
    return createOrchestrator(
      log,
      guard,
      runner,
      blackboard,
      spec,
      terminals,
      emitter.emit,
    );
  }

  it("single node → one layer containing that node", () => {
    const flow = makeFlow({ nodes: [makeNode("n1")], edges: [] });
    const plan = makeOrchestrator(flow).plan(flow);
    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0]).toContain(asNodeId("n1"));
    expect(plan.feedbackEdges).toHaveLength(0);
  });

  it("linear chain A→B→C → three separate layers in declaration order", () => {
    const flow = makeFlow({
      nodes: [makeNode("a"), makeNode("b"), makeNode("c")],
      edges: [makeEdge("e1", "a", "b"), makeEdge("e2", "b", "c")],
    });
    const plan = makeOrchestrator(flow).plan(flow);
    expect(plan.layers).toHaveLength(3);
    expect(plan.layers[0]).toContain(asNodeId("a"));
    expect(plan.layers[1]).toContain(asNodeId("b"));
    expect(plan.layers[2]).toContain(asNodeId("c"));
  });

  it("two parallel nodes after a shared root → all three in the expected layers", () => {
    const flow = makeFlow({
      nodes: [makeNode("root"), makeNode("a"), makeNode("b")],
      edges: [makeEdge("e1", "root", "a"), makeEdge("e2", "root", "b")],
    });
    const plan = makeOrchestrator(flow).plan(flow);
    expect(plan.layers[0]).toContain(asNodeId("root"));
    expect(plan.layers[1]).toContain(asNodeId("a"));
    expect(plan.layers[1]).toContain(asNodeId("b"));
  });

  it("feedback edge is CUT from the DAG and appears in feedbackEdges, not as a forward dependency", () => {
    const flow = makeFlow({
      nodes: [
        makeNode("trigger", "Trigger"),
        makeNode("analyst"),
        makeNode("synth", "Synthesizer"),
      ],
      edges: [
        makeEdge("forward", "trigger", "analyst"),
        makeEdge("fwd2", "analyst", "synth"),
        makeEdge("fb", "synth", "trigger", true /* feedback */),
      ],
    });
    const plan = makeOrchestrator(flow).plan(flow);

    expect(plan.feedbackEdges).toHaveLength(1);
    expect(plan.feedbackEdges[0]).toMatchObject({
      from: asNodeId("synth"),
      to: asNodeId("trigger"),
    });

    // All nodes still placed in layers.
    const flat = plan.layers.flat();
    expect(flat).toContain(asNodeId("trigger"));
    expect(flat).toContain(asNodeId("analyst"));
    expect(flat).toContain(asNodeId("synth"));

    // trigger must be in a lower (earlier) layer than analyst.
    const triggerLayer = plan.layers.findIndex((l) =>
      l.includes(asNodeId("trigger")),
    );
    const analystLayer = plan.layers.findIndex((l) =>
      l.includes(asNodeId("analyst")),
    );
    expect(triggerLayer).toBeLessThan(analystLayer);
  });

  it("multiple feedback edges are all cut and the acyclic DAG is still layered", () => {
    const flow = makeFlow({
      nodes: [makeNode("t", "Trigger"), makeNode("a"), makeNode("b")],
      edges: [
        makeEdge("e1", "t", "a"),
        makeEdge("e2", "t", "b"),
        makeEdge("fb1", "a", "t", true),
        makeEdge("fb2", "b", "t", true),
      ],
    });
    const plan = makeOrchestrator(flow).plan(flow);
    expect(plan.feedbackEdges).toHaveLength(2);
    expect(plan.layers[0]).toContain(asNodeId("t"));
    expect(plan.layers[1]).toContain(asNodeId("a"));
    expect(plan.layers[1]).toContain(asNodeId("b"));
  });

  it("preserves declaration order (stable sort) within a layer", () => {
    const flow = makeFlow({
      nodes: [makeNode("n3"), makeNode("n1"), makeNode("n2")],
      edges: [],
    });
    const plan = makeOrchestrator(flow).plan(flow);
    expect(plan.layers[0]).toEqual([
      asNodeId("n3"),
      asNodeId("n1"),
      asNodeId("n2"),
    ]);
  });

  it("dangling edge (unknown node reference) is silently skipped — no throw", () => {
    const flow = makeFlow({
      nodes: [makeNode("n1")],
      edges: [makeEdge("e1", "n1", "ghost" /* non-existent */)],
    });
    expect(() => makeOrchestrator(flow).plan(flow)).not.toThrow();
    const plan = makeOrchestrator(flow).plan(flow);
    expect(plan.layers.flat()).toContain(asNodeId("n1"));
  });

  it("no-edge flow with 5 parallel nodes → one single layer", () => {
    const nodes = ["n1", "n2", "n3", "n4", "n5"].map((id) => makeNode(id));
    const flow = makeFlow({ nodes, edges: [] });
    const plan = makeOrchestrator(flow).plan(flow);
    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0]).toHaveLength(5);
  });
});

// =============================================================================
// SECTION 8 — Orchestrator: artifact-presence barrier (startCycle, FAKE runner)
// =============================================================================

describe("orchestrator — artifact-presence barrier (startCycle, FAKE runner)", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
  });

  function buildOrch(
    flow: Flow,
    artifacts: Map<string, string> = new Map(),
    blackboardOverride?: Partial<Blackboard>,
  ) {
    // Use the flow's own budget so guard caps match what the test configures.
    const guard = createGuard(log, readyAuth(), emitter.emit, (_fid) => flow.budget);
    // ARM the flow: startCycle is always preceded by an explicit play/runNow in
    // production (which arms the guard). Without this the safe-by-default gate
    // denies every spawn with flow_not_armed.
    guard.setFlowArmed(flow.id, true);
    const blackboard = { ...makeFakeBlackboard(artifacts), ...blackboardOverride };
    const spec = makeFakeSpec(flow);
    const terminals = makeFakeTerminals();
    const runner = createRunner("fake", guard, blackboard as Blackboard, terminals, emitter.emit);
    return { guard, blackboard, orch: createOrchestrator(log, guard, runner, blackboard as Blackboard, spec, terminals, emitter.emit) };
  }

  it("single non-trigger node: FAKE runner writes artifact, cycle ends as done", async () => {
    const flow = makeFlow({ nodes: [makeNode("n1", "Analyst")], edges: [] });
    const { orch } = buildOrch(flow);
    const outcome = await orch.startCycle(flow, "Manual");
    expect(outcome.status).toBe("done");
  });

  it("trigger node is a pure entry point: NO run.started, and startCycle does NOT emit trigger.fired (the scheduler owns it)", async () => {
    const flow = makeFlow({
      nodes: [makeNode("t", "Trigger"), makeNode("a", "Analyst")],
      edges: [makeEdge("e1", "t", "a")],
    });
    const { orch } = buildOrch(flow);
    await orch.startCycle(flow, "Manual");

    // trigger.fired is the SCHEDULER's event (it carries the cause + owns the
    // no-overlap drop). startCycle emitting it too double-counted every cycle, so
    // the orchestrator must NOT emit it.
    const triggerFired = emitter.events.filter((e) => e.type === "trigger.fired");
    expect(triggerFired).toHaveLength(0);

    // The trigger node runs no agent → no run.started for it.
    const triggerStarted = emitter.events.filter(
      (e) => e.type === "run.started" && (e as any).nodeId === asNodeId("t"),
    );
    expect(triggerStarted).toHaveLength(0);

    // …but the cycle proceeded PAST the trigger: the downstream Analyst ran.
    const analystStarted = emitter.events.filter(
      (e) => e.type === "run.started" && (e as any).nodeId === asNodeId("a"),
    );
    expect(analystStarted.length).toBeGreaterThanOrEqual(1);
  });

  it("downstream node is skipped when upstream produces[] artifact is absent (sha256 always null)", async () => {
    // n1 declares produces=["x.md"]; the blackboard.sha256 always returns null
    // → the barrier check for n2 sees "expected artifact absent" → n2 skipped.
    const n1 = makeNode("n1", "Analyst", ["x.md"]);
    const n2 = makeNode("n2", "Writer");
    const flow = makeFlow({
      nodes: [n1, n2],
      edges: [makeEdge("e1", "n1", "n2")],
    });

    const { orch } = buildOrch(flow, new Map(), {
      // atomicWrite succeeds (FakeRunner calls it) but sha256 always returns null
      // so the barrier check after n1 runs always fails for n2.
      sha256: async () => null,
    });

    const outcome = await orch.startCycle(flow, "Manual");
    expect(outcome.status).toBe("done");

    const n2Started = emitter.events.filter(
      (e) => e.type === "run.started" && (e as any).nodeId === asNodeId("n2"),
    );
    expect(n2Started).toHaveLength(0);

    // A slate log event must have been emitted for the skipped node.
    const skippedLog = emitter.events.find(
      (e) => e.type === "log" && (e as any).color === "slate",
    );
    expect(skippedLog).toBeDefined();
  });

  it("downstream node DOES run when FAKE runner writes its upstream's artifact", async () => {
    // n1 produces "report.md" and FAKE runner will write it.
    // The default blackboard sha256 reads from the artifacts map that atomicWrite fills.
    const n1 = makeNode("n1", "Analyst", ["report.md"]);
    const n2 = makeNode("n2", "Synthesizer");
    const flow = makeFlow({
      nodes: [n1, n2],
      edges: [makeEdge("e1", "n1", "n2")],
    });

    const { orch } = buildOrch(flow);
    const outcome = await orch.startCycle(flow, "Manual");
    expect(outcome.status).toBe("done");

    const n2Started = emitter.events.filter(
      (e) => e.type === "run.started" && (e as any).nodeId === asNodeId("n2"),
    );
    expect(n2Started.length).toBeGreaterThan(0);
  });

  it("node without produces[] passes the barrier unconditionally (no artifact check)", async () => {
    // n1 has no produces; n2 is downstream. Barrier should not block n2.
    const n1 = makeNode("n1", "Analyst");
    const n2 = makeNode("n2", "Writer");
    const flow = makeFlow({
      nodes: [n1, n2],
      edges: [makeEdge("e1", "n1", "n2")],
    });
    const { orch } = buildOrch(flow);
    await orch.startCycle(flow, "Manual");

    const n2Started = emitter.events.filter(
      (e) => e.type === "run.started" && (e as any).nodeId === asNodeId("n2"),
    );
    expect(n2Started.length).toBeGreaterThan(0);
  });

  it("upstream skipped by guard denial blocks downstream via barrier", async () => {
    // Force n1 denial by setting a tiny per-run USD cap.
    // n1 is skipped (not ok) → n2's barrier sees n1 != ok → n2 is skipped.
    const n1 = makeNode("n1", "Analyst");
    const n2 = makeNode("n2", "Writer");
    const flow = makeFlow({
      nodes: [n1, n2],
      edges: [makeEdge("e1", "n1", "n2")],
      budget: { maxUsdPerRun: 0.001 }, // haiku worst-case >> 0.001 → denied.
    });
    const { orch } = buildOrch(flow);
    const outcome = await orch.startCycle(flow, "Manual");
    expect(outcome.status).toBe("done");

    const n2Started = emitter.events.filter(
      (e) => e.type === "run.started" && (e as any).nodeId === asNodeId("n2"),
    );
    expect(n2Started).toHaveLength(0);
  });
});

// =============================================================================
// SECTION 9 — Orchestrator: cycle outcomes + feedback re-arm
// =============================================================================

describe("orchestrator — cycle outcomes and feedback re-arm", () => {
  let log: ReturnType<typeof makeFakeEventLog>;
  let emitter: ReturnType<typeof makeEmitter>;

  beforeEach(() => {
    log = makeFakeEventLog();
    emitter = makeEmitter();
  });

  function buildOrch(flow: Flow) {
    // Use flow.budget so guard caps match test-configured values.
    const guard = createGuard(log, readyAuth(), emitter.emit, (_fid) => flow.budget);
    // ARM the flow (startCycle is always preceded by an explicit play/runNow that
    // arms the guard; otherwise the safe-by-default gate denies every spawn).
    guard.setFlowArmed(flow.id, true);
    const blackboard = makeFakeBlackboard();
    const spec = makeFakeSpec(flow);
    const terminals = makeFakeTerminals();
    const runner = createRunner("fake", guard, blackboard, terminals, emitter.emit);
    return createOrchestrator(log, guard, runner, blackboard, spec, terminals, emitter.emit);
  }

  it("cycle.started and cycle.ended (done) are emitted for a simple run", async () => {
    const flow = makeFlow({ nodes: [makeNode("n1")], edges: [] });
    await buildOrch(flow).startCycle(flow, "Manual");

    expect(emitter.events.find((e) => e.type === "cycle.started")).toBeDefined();
    expect(
      emitter.events.find(
        (e) => e.type === "cycle.ended" && (e as any).status === "done",
      ),
    ).toBeDefined();
  });

  it("feedback cycle stops after maxCyclesPerArm with status stopped", async () => {
    const trigger = makeNode("t", "Trigger");
    const analyst = makeNode("a", "Analyst", ["out.md"]);
    const flow = makeFlow({
      nodes: [trigger, analyst],
      edges: [
        makeEdge("fwd", "t", "a"),
        makeEdge("fb", "a", "t", true),
      ],
      // arm=0 → nextArm=1; arm=1 → nextArm=2 ≥ 2 → deny.
      budget: { maxCyclesPerArm: 2, convergenceWindow: 99 },
    });
    const outcome = await buildOrch(flow).startCycle(flow, "Manual");
    expect(outcome.status).toBe("stopped");
  });

  it("isRunning is false before and after startCycle (no overlap in serial calls)", async () => {
    const flow = makeFlow({ nodes: [makeNode("n1")], edges: [] });
    const orch = buildOrch(flow);
    expect(orch.isRunning(flow.id)).toBe(false);
    await orch.startCycle(flow, "Manual");
    expect(orch.isRunning(flow.id)).toBe(false);
  });

  it("flow.stateChanged emits rodando during and ocioso|pausado after cycle", async () => {
    const flow = makeFlow({ nodes: [makeNode("n1")], edges: [] });
    await buildOrch(flow).startCycle(flow, "Manual");

    const states = emitter.events
      .filter((e) => e.type === "flow.stateChanged")
      .map((e) => (e as any).state as string);
    expect(states).toContain("rodando");
    expect(states[states.length - 1]).toMatch(/ocioso|pausado/);
  });

  it("no feedback edges → cycle ends as done without calling requestNextCycle", async () => {
    const flow = makeFlow({
      nodes: [makeNode("n1"), makeNode("n2")],
      edges: [makeEdge("e1", "n1", "n2")],
    });
    const outcome = await buildOrch(flow).startCycle(flow, "Manual");
    expect(outcome.status).toBe("done");
    // No budget.tripped from cycles.
    const cycleTripped = emitter.events.find(
      (e) => e.type === "budget.tripped" && (e as any).metric === "cycles",
    );
    expect(cycleTripped).toBeUndefined();
  });
});

// =============================================================================
// SECTION 10 — Integration: guard + orchestrator (FAKE runner, zero cost)
// =============================================================================

describe("integration — guard + orchestrator (FAKE runner, daily-standup style)", () => {
  it("3 parallel analysts + synthesizer → all nodes run, cycle done", async () => {
    const log = makeFakeEventLog();
    const emitter = makeEmitter();

    const trigger = makeNode("trigger", "Trigger");
    const a1 = makeNode("a1", "Analyst", ["a1.md"]);
    const a2 = makeNode("a2", "Analyst", ["a2.md"]);
    const a3 = makeNode("a3", "Analyst", ["a3.md"]);
    const synth = makeNode("synth", "Synthesizer");

    const flow = makeFlow({
      id: "daily-standup",
      nodes: [trigger, a1, a2, a3, synth],
      edges: [
        makeEdge("e-t-a1", "trigger", "a1"),
        makeEdge("e-t-a2", "trigger", "a2"),
        makeEdge("e-t-a3", "trigger", "a3"),
        makeEdge("e-a1-s", "a1", "synth"),
        makeEdge("e-a2-s", "a2", "synth"),
        makeEdge("e-a3-s", "a3", "synth"),
      ],
      budget: { maxConcurrentAgents: 3 },
    });

    const guard = makeGuard(log, readyAuth(), emitter.emit, {}, flow.id);
    const blackboard = makeFakeBlackboard();
    const spec = makeFakeSpec(flow);
    const terminals = makeFakeTerminals();
    const runner = createRunner("fake", guard, blackboard, terminals, emitter.emit);
    const orch = createOrchestrator(log, guard, runner, blackboard, spec, terminals, emitter.emit);

    // Verify the plan.
    const plan = orch.plan(flow);
    expect(plan.layers).toHaveLength(3);
    expect(plan.layers[0]).toContain(asNodeId("trigger"));
    expect(plan.layers[1]).toContain(asNodeId("a1"));
    expect(plan.layers[1]).toContain(asNodeId("a2"));
    expect(plan.layers[1]).toContain(asNodeId("a3"));
    expect(plan.layers[2]).toContain(asNodeId("synth"));
    expect(plan.feedbackEdges).toHaveLength(0);

    const outcome = await orch.startCycle(flow, "Manual");
    expect(outcome.status).toBe("done");

    const nodeIds = emitter.events
      .filter((e) => e.type === "run.started")
      .map((e) => (e as any).nodeId as string);

    expect(nodeIds).toContain(asNodeId("a1"));
    expect(nodeIds).toContain(asNodeId("a2"));
    expect(nodeIds).toContain(asNodeId("a3"));
    expect(nodeIds).toContain(asNodeId("synth"));
    expect(nodeIds).not.toContain(asNodeId("trigger")); // trigger is not an agent.
  });

  it("spend is non-negative and no live reservations remain after full FAKE cycle", async () => {
    const log = makeFakeEventLog();
    const emitter = makeEmitter();
    const flow = makeFlow({
      id: "flow-spend",
      nodes: [makeNode("n1", "Analyst"), makeNode("n2", "Writer")],
      edges: [makeEdge("e1", "n1", "n2")],
    });

    const guard = makeGuard(log, readyAuth(), emitter.emit, {}, flow.id);
    const blackboard = makeFakeBlackboard();
    const spec = makeFakeSpec(flow);
    const terminals = makeFakeTerminals();
    const runner = createRunner("fake", guard, blackboard, terminals, emitter.emit);
    const orch = createOrchestrator(log, guard, runner, blackboard, spec, terminals, emitter.emit);

    await orch.startCycle(flow, "Manual");

    const snap = guard.spendForFlow(flow.id);
    expect(snap.usdSpent).toBeGreaterThanOrEqual(0);
    expect(snap.tokensSpent).toBeGreaterThanOrEqual(0);
    // After the cycle all leases must be released.
    expect(snap.usdReserved).toBe(0);
    expect(snap.tokensReserved).toBe(0);
  });

  it("convergence stops a feedback loop when the same artifact hash repeats", async () => {
    const log = makeFakeEventLog();
    const emitter = makeEmitter();

    const trigger = makeNode("t", "Trigger");
    const writer = makeNode("w", "Writer", ["doc.md"]);
    const flow = makeFlow({
      id: "flow-conv",
      nodes: [trigger, writer],
      edges: [
        makeEdge("fwd", "t", "w"),
        makeEdge("fb", "w", "t", true),
      ],
      // convergenceWindow=1: deny after 1 barren cycle; maxCyclesPerArm=99.
      budget: { maxCyclesPerArm: 99, convergenceWindow: 1 },
    });

    const guard = makeGuard(log, readyAuth(), emitter.emit, {}, flow.id);
    // Use a blackboard where sha256 always returns the same hash (artifact is "stable").
    const fixedHash = "fixed-hash-abc123";
    const blackboard: Blackboard = {
      ...makeFakeBlackboard(),
      atomicWrite: async (_fid, _nid, relPath, content) => ({
        relPath,
        bytes: typeof content === "string" ? content.length : content.byteLength,
        hash: fixedHash,
      }),
      sha256: async () => fixedHash, // always the same hash → seenHashes won't grow.
    };

    const spec = makeFakeSpec(flow);
    const terminals = makeFakeTerminals();
    const runner = createRunner("fake", guard, blackboard, terminals, emitter.emit);
    const orch = createOrchestrator(log, guard, runner, blackboard, spec, terminals, emitter.emit);

    const outcome = await orch.startCycle(flow, "Manual");

    // With convergenceWindow=1, the loop should stop (either converged or stopped).
    expect(["converged", "stopped"]).toContain(outcome.status);
  });
});
