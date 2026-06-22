// =============================================================================
// guard.ts [guard] — THE single safety chokepoint. Runaway loops are impossible
// BY CONSTRUCTION: the runner CANNOT spawn without a SpawnLease, and only guard
// mints one. Four independent ceilings (architecture decision #3):
//   1. PRE-SPEND ADMISSION: spentSoFar + worstCaseRunCost(model) <= per-run AND
//      per-flow caps, where worstCaseRunCost = maxOutputTokens*outputPrice +
//      budgetedInput (from MODEL_REGISTRY).
//   2. Live per-run AbortController wired to the token meter (mid-flight abort).
//   3. maxCyclesPerArm per feedback arm.
//   4. Convergence: no new artifact hash within convergenceWindow.
// Tracks spend per run/flow/cycle by consuming run.token events (via meterToken).
// Maintains a kill registry of child PIDs per flow; killFlow() tree-kills
// (tree-kill dep; taskkill /T fallback for the Windows child). Emits
// budget.tripped / kill.requested.
// =============================================================================

import { createRequire } from "node:module";
import { exec as nodeExec } from "node:child_process";

import {
  MODEL_REGISTRY,
  asRunId,
  newId,
  type FlowId,
  type ModelId,
  type RunId,
  type NodeId,
  type FlowBudget,
} from "@loom/shared";
import type {
  Emit,
  SpawnLease,
  SpawnRequest,
  NextCycleRequest,
  Decision,
  DenialReason,
  SpendSnapshot,
  RunSpend,
} from "./internal.js";
import type { EventLog } from "./eventlog.js";
import type { AuthService } from "./auth.js";

// -----------------------------------------------------------------------------
// tree-kill — ships its own index.d.ts (`export = treeKill`), but it is a
// CommonJS module. Under verbatimModuleSyntax we load it via createRequire to
// avoid interop friction while keeping the precise call signature locally typed.
// -----------------------------------------------------------------------------
type TreeKillFn = (
  pid: number,
  signal?: string | number | ((error?: Error) => void),
  callback?: (error?: Error) => void,
) => void;

/**
 * Grace window (ms) after firing every kill mechanism before we VERIFY the child
 * is actually gone. Processes do not die synchronously; if the pid is still alive
 * after this window we treat the kill as FAILED and surface a kill.failed log.
 * Kept small so the operator learns about an orphan quickly; overridable for tests.
 */
const KILL_GRACE_MS = Number(process.env.LOOM_KILL_GRACE_MS ?? 1_500);

const require_ = createRequire(import.meta.url);
let cachedTreeKill: TreeKillFn | null = null;
function loadTreeKill(): TreeKillFn | null {
  if (cachedTreeKill) return cachedTreeKill;
  try {
    cachedTreeKill = require_("tree-kill") as TreeKillFn;
    return cachedTreeKill;
  } catch {
    return null;
  }
}

// =============================================================================
// worstCaseRunCost — the pre-spend admission yardstick.
// =============================================================================

/** Worst-case USD a single run of `model` could cost (pre-spend admission). */
export function worstCaseRunCost(model: ModelId, budgetedInputTokens: number): number {
  const p = MODEL_REGISTRY[model];
  // Defensive: an unknown model id should never under-estimate cost. Fall back
  // to the most expensive entry in the registry rather than admit for free.
  const pricing =
    p ??
    Object.values(MODEL_REGISTRY).reduce((worst, cur) =>
      cur.outputPer1M > worst.outputPer1M ? cur : worst,
    );
  const input = Math.max(0, budgetedInputTokens);
  const outputCost = (pricing.maxOutputTokens * pricing.outputPer1M) / 1e6;
  const inputCost = (input * pricing.inputPer1M) / 1e6;
  return outputCost + inputCost;
}

/** Worst-case TOKENS a single run could consume (output ceiling + budgeted in). */
function worstCaseRunTokens(model: ModelId, budgetedInputTokens: number): number {
  const pricing = MODEL_REGISTRY[model];
  const maxOut =
    pricing?.maxOutputTokens ??
    Object.values(MODEL_REGISTRY).reduce(
      (m, cur) => Math.max(m, cur.maxOutputTokens),
      0,
    );
  return maxOut + Math.max(0, budgetedInputTokens);
}

export type KillCause = "user" | "budget" | "maxCycles" | "convergence";

export interface Guard {
  // ---- Admission (the ONLY way to obtain spawn permission) ----
  requestSpawn(req: SpawnRequest): Decision<SpawnLease>;
  releaseLease(lease: SpawnLease, finalSpend: RunSpend): void;
  requestNextCycle(req: NextCycleRequest): Decision<{ arm: number; cycle: number }>;

  // ---- Live metering (driven by run.token events) ----
  meterToken(runId: RunId, deltaUsd: number, deltaTokens: number): void;
  spendForFlow(flowId: FlowId): SpendSnapshot;

  // ---- Kill registry ----
  registerChild(flowId: FlowId, runId: RunId, pid: number): void;
  unregisterChild(runId: RunId): void;
  /**
   * Register the tmux terminal a TERMINAL-MODE run executes in, so killFlow can
   * tmux kill-session it. In terminal mode there is no child PID we own — the
   * pane session IS the kill target.
   */
  registerTerminal(flowId: FlowId, runId: RunId, terminalId: string): void;
  unregisterTerminal(runId: RunId): void;
  /**
   * Wire the terminals manager's disposeFlow so killFlow tears down a flow's
   * panes. Injected post-construction (main.ts) to avoid a guard↔terminals
   * construction cycle; a no-op until set (fake/tests never need it).
   */
  setTerminalDisposer(dispose: (flowId: FlowId) => Promise<void>): void;
  killFlow(flowId: FlowId, cause: KillCause): Promise<void>;

  // ---- Concurrency semaphore (fan-out bound) ----
  availableSlots(flowId: FlowId): number;
  setFlowPaused(flowId: FlowId, paused: boolean): void;

  // ---- Safe-by-default arming ----
  /**
   * Mark a flow as ARMED (the user explicitly started it via flow.play / runNow)
   * or DISARMED. A flow is DISARMED until armed — and a disarmed flow can NEVER
   * obtain a spawn lease. This is the belt-and-suspenders behind the scheduler's
   * dormant-on-boot behavior: even if something tried to drive a cycle on a
   * freshly-loaded flow, the guard denies every spawn with `flow_not_armed`.
   */
  setFlowArmed(flowId: FlowId, armed: boolean): void;
  /** True iff the flow has been explicitly armed (debug / status). */
  isFlowArmed(flowId: FlowId): boolean;
}

// -----------------------------------------------------------------------------
// Internal bookkeeping shapes.
// -----------------------------------------------------------------------------

/** A minted, live lease + its private control handles (kept guard-side only). */
interface LiveLease {
  lease: SpawnLease;
  controller: AbortController;
  flowId: FlowId;
  runId: RunId;
  /** Worst-case reservation held against caps until the lease is released. */
  reservedUsd: number;
  reservedTokens: number;
  /** Per-run committed spend so far (folded from meterToken deltas). */
  spentUsd: number;
  spentTokens: number;
  /** Latched once this run is aborted by its own cap, so we abort/emit once. */
  runCapTripped: boolean;
  released: boolean;
}

/** Committed (settled) spend for a flow, plus the per-cycle roll-up. */
interface FlowMeter {
  flowId: FlowId;
  /** Committed USD/tokens from finished runs (live runs add via reservations). */
  committedUsd: number;
  committedTokens: number;
}

/** Convergence tracking: hashes ever seen + cycles without a fresh hash. */
interface ConvergenceState {
  seenHashes: Set<string>;
  /** Hashes newly observed during the cycle currently in flight. */
  cyclesWithoutNewHash: number;
  /** The highest cycle number we have folded for, to detect cycle rollover. */
  lastCycleSeen: number;
  /** Did the current (lastCycleSeen) cycle produce at least one new hash? */
  newHashThisCycle: boolean;
}

interface ChildEntry {
  flowId: FlowId;
  runId: RunId;
  pid: number;
}

function ok<T>(value: T): Decision<T> {
  return { ok: true, value };
}
function deny<T>(reason: DenialReason, detail: string): Decision<T> {
  return { ok: false, reason, detail };
}

// =============================================================================
// createGuard
// =============================================================================

export function createGuard(
  eventlog: EventLog,
  auth: AuthService,
  emit: Emit,
  budgetFor: (flowId: FlowId) => FlowBudget,
): Guard {
  // runId → live lease (the per-run meter + abort controller live here).
  const liveLeases = new Map<string, LiveLease>();
  // flowId → set of live runIds (concurrency + reservation aggregation).
  const flowLiveRuns = new Map<string, Set<string>>();
  // flowId → committed spend meter.
  const flowMeters = new Map<string, FlowMeter>();
  // flowId → paused?
  const pausedFlows = new Set<string>();
  // flowId → ARMED? SAFE BY DEFAULT: a flow is NOT armed until the user explicitly
  // plays/runs it. An un-armed flow can never obtain a spawn lease — so a freshly
  // LOADED flow (boot) cannot spend a cent until explicitly started. This set is
  // intentionally NOT rehydrated from the log: every engine restart starts inert.
  const armedFlows = new Set<string>();
  // flowId → killed? (latched until a fresh cycle re-arms the flow).
  const killedFlows = new Set<string>();
  // flowId → convergence tracking.
  const convergence = new Map<string, ConvergenceState>();
  // runId → registered child process entry (kill registry).
  const children = new Map<string, ChildEntry>();
  // runId → tmux terminal id (TERMINAL-MODE kill registry; the pane is the
  // kill target since terminal-mode runs have no child PID we own).
  const runTerminals = new Map<string, { flowId: FlowId; terminalId: string }>();
  // Injected by main.ts: tears down a flow's tmux panes on kill (no-op until set).
  let disposeTerminalsForFlow: ((flowId: FlowId) => Promise<void>) | null = null;

  function flowMeter(flowId: FlowId): FlowMeter {
    let m = flowMeters.get(flowId);
    if (!m) {
      m = { flowId, committedUsd: 0, committedTokens: 0 };
      flowMeters.set(flowId, m);
    }
    return m;
  }

  // ---------------------------------------------------------------------------
  // BOOT REHYDRATION (HIGH fix — spend meter must survive restarts).
  //
  // committedUsd/committedTokens are in-memory; without this fold every engine
  // restart RESETS the per-flow lifetime ceiling to zero, so a flow could spend
  // its full cap again on each restart (a runaway-cost hole). Fold every FINISHED
  // run's final cost from the event log back into the per-flow meter so the
  // per-flow USD/token cap is enforced across the flow's whole lifetime, not just
  // the current process. This is idempotent: it runs exactly once at construction
  // and reads only settled runs (live runs add via reservations later).
  // ---------------------------------------------------------------------------
  try {
    for (const fold of eventlog.foldFlowSpend()) {
      const m = flowMeter(fold.flowId);
      m.committedUsd = Math.max(0, fold.committedUsd);
      m.committedTokens = Math.max(0, fold.committedTokens);
    }
  } catch {
    // A failing fold (e.g. an empty/locked log at boot) must not wedge the guard.
    // Worst case we start from zero — the live admission still bounds spend by at
    // most one in-flight run's worth until the next run.finished re-commits.
  }

  function liveRunSet(flowId: FlowId): Set<string> {
    let s = flowLiveRuns.get(flowId);
    if (!s) {
      s = new Set<string>();
      flowLiveRuns.set(flowId, s);
    }
    return s;
  }

  function convState(flowId: FlowId): ConvergenceState {
    let c = convergence.get(flowId);
    if (!c) {
      c = {
        seenHashes: new Set<string>(),
        cyclesWithoutNewHash: 0,
        lastCycleSeen: -1,
        newHashThisCycle: false,
      };
      convergence.set(flowId, c);
    }
    return c;
  }

  /** Sum of outstanding worst-case reservations across a flow's live runs. */
  function outstanding(flowId: FlowId): { usd: number; tokens: number } {
    let usd = 0;
    let tokens = 0;
    for (const runId of liveRunSet(flowId)) {
      const ll = liveLeases.get(runId);
      if (!ll) continue;
      // A live run reserves the GREATER of its worst-case reservation and what
      // it has actually spent so far (a run that overshoots its estimate must
      // not free reservation headroom for siblings).
      usd += Math.max(ll.reservedUsd, ll.spentUsd);
      tokens += Math.max(ll.reservedTokens, ll.spentTokens);
    }
    return { usd, tokens };
  }

  // ---------------------------------------------------------------------------
  // Convergence (ADVISORY signal — NOT a hard ceiling). Fold a blackboard.write
  // hash for a flow's current cycle. Called from the eventlog subscription below.
  //
  // SINGLE-SETTLEMENT INVARIANT (HIGH+MED fix): the barren-cycle counter
  // (cyclesWithoutNewHash) is incremented in EXACTLY ONE place — requestNextCycle,
  // the feedback-arm gate. Previously it was bumped BOTH here (on cycle rollover)
  // AND at the gate, an off-by-one that double-counted barren cycles and made the
  // window fire a cycle early. Here we ONLY observe hashes + flip the per-cycle
  // "did this cycle produce a NEW hash" latch; we never touch the counter.
  // ---------------------------------------------------------------------------
  function foldArtifactHash(flowId: FlowId, cycle: number, hash: string): void {
    const c = convState(flowId);
    if (cycle !== c.lastCycleSeen) {
      // Rolled into a new cycle. The PREVIOUS cycle's barren/fresh accounting is
      // settled at the gate (requestNextCycle), never here — see the invariant.
      c.lastCycleSeen = cycle;
      c.newHashThisCycle = false;
    }
    if (!c.seenHashes.has(hash)) {
      c.seenHashes.add(hash);
      c.newHashThisCycle = true;
    }
  }

  // Subscribe to the event log for convergence + a metering safety net.
  // SPEND is metered exclusively via meterToken (the runner calls it with the
  // per-event delta) to avoid double counting; here we only fold artifact
  // hashes (convergence) and observe blackboard writes.
  const unsubscribe = eventlog.subscribe((stored) => {
    const ev = stored.event;
    if (ev.type === "blackboard.write") {
      // The write event does not itself carry the cycle; resolve it from the
      // flow's current cycle counter projection.
      const cycle = eventlog.cycleCounter(ev.flowId);
      foldArtifactHash(ev.flowId, cycle, ev.hash);
    }
  });
  void unsubscribe; // guard lives for the engine's lifetime; nothing tears it down.

  // ---------------------------------------------------------------------------
  // Live per-run abort wiring.
  // ---------------------------------------------------------------------------
  function tripRun(ll: LiveLease, metric: "usd" | "tokens", limit: number): void {
    if (ll.runCapTripped) return;
    ll.runCapTripped = true;
    emit({
      type: "budget.tripped",
      flowId: ll.flowId,
      scope: "run",
      metric,
      limit,
      runId: ll.runId,
    });
    if (!ll.controller.signal.aborted) {
      try {
        ll.controller.abort(
          new Error(`run ${ll.runId} exceeded per-run ${metric} cap (${limit})`),
        );
      } catch {
        /* AbortController.abort never throws on modern node; be defensive. */
      }
    }
  }

  // ===========================================================================
  // requestSpawn — PRE-SPEND admission.
  // ===========================================================================
  function requestSpawn(req: SpawnRequest): Decision<SpawnLease> {
    const { flowId, runId, model } = req;
    const budget = budgetFor(flowId);

    // 0. Hard state gates (killed / paused / armed / auth). Order matters: a
    //    flow killed/paused by an explicit action reports that more-specific
    //    reason; a flow that was simply never started reports flow_not_armed.
    if (killedFlows.has(flowId)) {
      return deny("flow_killed", `flow ${flowId} has been killed`);
    }
    if (pausedFlows.has(flowId)) {
      return deny("flow_paused", `flow ${flowId} is paused`);
    }
    // SAFE BY DEFAULT: an un-armed flow (never explicitly played/run) is denied
    // every spawn. This is the belt behind the scheduler's dormant-on-boot arms.
    if (!armedFlows.has(flowId)) {
      return deny(
        "flow_not_armed",
        `flow ${flowId} is not armed — play it (flow.play) or run it (flow.runNow) first`,
      );
    }
    if (!auth.isReady()) {
      const detail = auth.current()?.detail ?? "claude auth pre-flight not completed";
      return deny("auth_not_ready", detail);
    }

    // 1. Concurrency semaphore.
    const inUse = liveRunSet(flowId).size;
    if (inUse >= budget.maxConcurrentAgents) {
      return deny(
        "concurrency_full",
        `flow ${flowId} at concurrency limit ${budget.maxConcurrentAgents}`,
      );
    }

    // 2. Worst-case cost/tokens of THIS run.
    const wcUsd = worstCaseRunCost(model, req.estInputTokens);
    const wcTokens = worstCaseRunTokens(model, req.estInputTokens);

    // 3. PER-RUN ceilings (a single run can never be admitted above its own cap).
    if (wcUsd > budget.maxUsdPerRun) {
      emit({
        type: "budget.tripped",
        flowId,
        scope: "run",
        metric: "usd",
        limit: budget.maxUsdPerRun,
        runId,
      });
      return deny(
        "per_run_usd_cap",
        `worst-case $${wcUsd.toFixed(4)} > per-run cap $${budget.maxUsdPerRun}`,
      );
    }
    if (wcTokens > budget.maxTokensPerRun) {
      emit({
        type: "budget.tripped",
        flowId,
        scope: "run",
        metric: "tokens",
        limit: budget.maxTokensPerRun,
        runId,
      });
      return deny(
        "per_run_token_cap",
        `worst-case ${wcTokens} tok > per-run cap ${budget.maxTokensPerRun}`,
      );
    }

    // 4. PER-FLOW ceilings: committed + outstanding reservations + this run's
    //    worst case must stay within the rolling flow caps. This is the core
    //    invariant: the per-flow cap can be exceeded by at most ONE in-flight
    //    run's worth of estimation error, never by a runaway loop.
    const meter = flowMeter(flowId);
    const out = outstanding(flowId);
    const projUsd = meter.committedUsd + out.usd + wcUsd;
    const projTokens = meter.committedTokens + out.tokens + wcTokens;

    if (projUsd > budget.maxUsdPerFlow) {
      emit({
        type: "budget.tripped",
        flowId,
        scope: "flow",
        metric: "usd",
        limit: budget.maxUsdPerFlow,
        runId,
      });
      return deny(
        "per_flow_usd_cap",
        `projected $${projUsd.toFixed(4)} > per-flow cap $${budget.maxUsdPerFlow}`,
      );
    }
    if (projTokens > budget.maxTokensPerFlow) {
      emit({
        type: "budget.tripped",
        flowId,
        scope: "flow",
        metric: "tokens",
        limit: budget.maxTokensPerFlow,
        runId,
      });
      return deny(
        "per_flow_token_cap",
        `projected ${projTokens} tok > per-flow cap ${budget.maxTokensPerFlow}`,
      );
    }

    // 5. ADMIT — mint the opaque lease, occupy a slot, hold the reservation.
    const controller = new AbortController();
    const lease = {
      leaseId: newId("lease_"),
      runId,
      flowId,
      model,
      reservedUsd: wcUsd,
      reservedTokens: wcTokens,
      signal: controller.signal,
      grantedAt: Date.now(),
    } as unknown as SpawnLease; // brand is phantom (declare const); cast at the mint site only.

    const ll: LiveLease = {
      lease,
      controller,
      flowId,
      runId,
      reservedUsd: wcUsd,
      reservedTokens: wcTokens,
      spentUsd: 0,
      spentTokens: 0,
      runCapTripped: false,
      released: false,
    };
    liveLeases.set(runId, ll);
    liveRunSet(flowId).add(runId);

    return ok(lease);
  }

  // ===========================================================================
  // releaseLease — settle a run's slot + reservation, commit its final spend.
  // ===========================================================================
  function releaseLease(lease: SpawnLease, finalSpend: RunSpend): void {
    const ll = liveLeases.get(lease.runId);
    if (!ll || ll.released) {
      // Idempotent: a double-release (e.g. abort + normal exit) is a no-op, but
      // we still commit final spend exactly once below if we have the lease.
      if (!ll) {
        // Unknown lease: still fold the spend into the flow meter so accounting
        // does not silently lose tokens (best effort using the lease's flow).
        const m = flowMeter(lease.flowId);
        m.committedUsd += Math.max(0, finalSpend.usdSpent);
        m.committedTokens += Math.max(0, finalSpend.tokensSpent);
      }
      return;
    }
    ll.released = true;

    // Commit the run's ACTUAL final spend (not the worst-case reservation) into
    // the flow meter, then drop the reservation + free the concurrency slot.
    const meter = flowMeter(ll.flowId);
    meter.committedUsd += Math.max(0, finalSpend.usdSpent);
    meter.committedTokens += Math.max(0, finalSpend.tokensSpent);

    liveRunSet(ll.flowId).delete(ll.runId);
    liveLeases.delete(ll.runId);

    // Drop the kill-registry entry if the child has not already unregistered.
    children.delete(ll.runId);
  }

  // ===========================================================================
  // requestNextCycle — feedback-arm gate (maxCyclesPerArm + convergence).
  // ===========================================================================
  function requestNextCycle(
    req: NextCycleRequest,
  ): Decision<{ arm: number; cycle: number }> {
    const { flowId, arm, cycle } = req;
    const budget = budgetFor(flowId);

    if (killedFlows.has(flowId)) {
      return deny("flow_killed", `flow ${flowId} has been killed`);
    }
    if (pausedFlows.has(flowId)) {
      return deny("flow_paused", `flow ${flowId} is paused`);
    }
    if (!armedFlows.has(flowId)) {
      return deny(
        "flow_not_armed",
        `flow ${flowId} is not armed — play it (flow.play) or run it (flow.runNow) first`,
      );
    }
    if (!auth.isReady()) {
      const detail = auth.current()?.detail ?? "claude auth pre-flight not completed";
      return deny("auth_not_ready", detail);
    }

    const nextArm = arm + 1;

    // Ceiling 3: maxCyclesPerArm — bounded feedback re-arms within one firing.
    if (nextArm >= budget.maxCyclesPerArm) {
      emit({
        type: "budget.tripped",
        flowId,
        scope: "cycle",
        metric: "cycles",
        limit: budget.maxCyclesPerArm,
      });
      return deny(
        "max_cycles_per_arm",
        `arm ${nextArm} would exceed maxCyclesPerArm ${budget.maxCyclesPerArm}`,
      );
    }

    // ADVISORY signal 4: convergence — settle the just-finished cycle into the
    // window, then deny if no new artifact hash appeared within
    // `convergenceWindow`. This is the ONE AND ONLY place the barren counter is
    // settled (foldArtifactHash never touches it — single-settlement invariant).
    // Convergence is an ADVISORY stop, NOT an independent hard ceiling: the HARD
    // bounds are maxCyclesPerArm + the per-flow USD/token caps above. It can be
    // defeated by nondeterministic artifact content (a fresh hash every cycle), so
    // it must never be the only thing standing between a flow and runaway spend.
    const c = convState(flowId);
    if (c.newHashThisCycle) {
      // The cycle that just ran produced at least one previously-unseen hash.
      c.cyclesWithoutNewHash = 0;
    } else {
      // Barren cycle (no fresh hash — covers both "same hash repeated" and "no
      // artifact writes observed at all"). Count it exactly once, here.
      c.cyclesWithoutNewHash += 1;
    }
    // Reset the per-cycle latch so the next cycle starts fresh.
    c.newHashThisCycle = false;

    if (c.cyclesWithoutNewHash >= budget.convergenceWindow) {
      return deny(
        "converged",
        `no new artifact hash in ${c.cyclesWithoutNewHash} cycle(s) (window ${budget.convergenceWindow})`,
      );
    }

    return ok({ arm: nextArm, cycle: cycle + 1 });
  }

  // ===========================================================================
  // meterToken — fold a live usage delta; abort the run if it crosses its cap.
  // ===========================================================================
  function meterToken(runId: RunId, deltaUsd: number, deltaTokens: number): void {
    const ll = liveLeases.get(runId);
    if (!ll || ll.released) return;

    ll.spentUsd += Math.max(0, deltaUsd);
    ll.spentTokens += Math.max(0, deltaTokens);

    const budget = budgetFor(ll.flowId);

    // Live per-run abort (ceiling 2): the moment a run crosses its own cap we
    // abort its child and emit budget.tripped — once.
    if (ll.spentUsd > budget.maxUsdPerRun) {
      tripRun(ll, "usd", budget.maxUsdPerRun);
      return;
    }
    if (ll.spentTokens > budget.maxTokensPerRun) {
      tripRun(ll, "tokens", budget.maxTokensPerRun);
      return;
    }

    // Live per-flow abort: committed (settled runs) + every live run's current
    // spend. If the flow as a whole crosses a cap mid-flight, kill the flow.
    const meter = flowMeter(ll.flowId);
    let liveUsd = 0;
    let liveTokens = 0;
    for (const id of liveRunSet(ll.flowId)) {
      const x = liveLeases.get(id);
      if (!x) continue;
      liveUsd += x.spentUsd;
      liveTokens += x.spentTokens;
    }
    const flowUsd = meter.committedUsd + liveUsd;
    const flowTokens = meter.committedTokens + liveTokens;

    if (flowUsd > budget.maxUsdPerFlow) {
      emit({
        type: "budget.tripped",
        flowId: ll.flowId,
        scope: "flow",
        metric: "usd",
        limit: budget.maxUsdPerFlow,
        runId: ll.runId,
      });
      void killFlow(ll.flowId, "budget");
      return;
    }
    if (flowTokens > budget.maxTokensPerFlow) {
      emit({
        type: "budget.tripped",
        flowId: ll.flowId,
        scope: "flow",
        metric: "tokens",
        limit: budget.maxTokensPerFlow,
        runId: ll.runId,
      });
      void killFlow(ll.flowId, "budget");
    }
  }

  // ===========================================================================
  // spendForFlow — snapshot (committed live spend + outstanding reservations).
  // ===========================================================================
  function spendForFlow(flowId: FlowId): SpendSnapshot {
    const meter = flowMeter(flowId);
    let liveUsd = 0;
    let liveTokens = 0;
    let resUsd = 0;
    let resTokens = 0;
    for (const id of liveRunSet(flowId)) {
      const ll = liveLeases.get(id);
      if (!ll) continue;
      liveUsd += ll.spentUsd;
      liveTokens += ll.spentTokens;
      // Outstanding reservation = the still-unspent portion of the worst case.
      resUsd += Math.max(0, ll.reservedUsd - ll.spentUsd);
      resTokens += Math.max(0, ll.reservedTokens - ll.spentTokens);
    }
    return {
      flowId,
      usdSpent: meter.committedUsd + liveUsd,
      tokensSpent: meter.committedTokens + liveTokens,
      usdReserved: resUsd,
      tokensReserved: resTokens,
    };
  }

  // ===========================================================================
  // Kill registry.
  // ===========================================================================
  function registerChild(flowId: FlowId, runId: RunId, pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    children.set(runId, { flowId, runId, pid });
  }

  function unregisterChild(runId: RunId): void {
    children.delete(runId);
  }

  function registerTerminal(
    flowId: FlowId,
    runId: RunId,
    terminalId: string,
  ): void {
    if (!terminalId) return;
    runTerminals.set(runId, { flowId, terminalId });
  }

  function unregisterTerminal(runId: RunId): void {
    runTerminals.delete(runId);
  }

  function setTerminalDisposer(
    dispose: (flowId: FlowId) => Promise<void>,
  ): void {
    disposeTerminalsForFlow = dispose;
  }

  /** Fire `cmd` best-effort and resolve when it exits (never rejects). */
  function execBestEffort(cmd: string): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        nodeExec(cmd, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  /**
   * Is `pid` still alive? `process.kill(pid, 0)` does not kill — it only probes:
   * it throws ESRCH if the pid is gone, EPERM if it exists but we cannot signal
   * it (still alive). Any other throw → assume gone (best-effort verification).
   */
  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true; // signal delivered → alive.
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "EPERM"; // exists but unsignalable → still alive.
    }
  }

  /**
   * KILL SWITCH (belt-and-suspenders). The engine runs in WSL/Linux but the
   * agent child is the AUTHED WINDOWS claude.exe launched via interop, so a
   * single mechanism is unreliable across the boundary. We therefore fire ALL of
   * them, UNCONDITIONALLY (never gated on process.platform), in parallel:
   *   1. tree-kill(pid, SIGKILL)        — reaps the WSL-side launcher subtree.
   *   2. POSIX process-group kill        — kill(-pgid, SIGKILL); the runner spawns
   *      the child detached so the whole group dies even if tree-kill misses.
   *   3. taskkill.exe /T /F (via interop)— reaps the Win32 claude.exe the WSL
   *      pid cannot reach. taskkill is taken from PATH (works under WSL interop).
   * Resolves to whether the pid is STILL alive after a grace window (caller logs
   * a kill.failed on true so the operator knows an orphan may still be spending).
   */
  function killPid(pid: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const attempts: Promise<void>[] = [];

      // 1. tree-kill the (WSL-side) process subtree.
      const tk = loadTreeKill();
      if (tk) {
        attempts.push(
          new Promise<void>((res) => {
            try {
              tk(pid, "SIGKILL", () => res());
            } catch {
              res();
            }
          }),
        );
      }

      // 2. POSIX process-group kill (runner spawns detached → child is a group
      //    leader, so its pid == pgid; the negative target hits the whole group).
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* not a group leader / already gone / not POSIX — fall through */
      }
      // Also the bare pid, in case it is not a group leader.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }

      // 3. Windows-side reaping — UNCONDITIONAL (the dead-code bug was gating this
      //    on platform==="win32", which is never true in the WSL engine). taskkill
      //    resolves through WSL interop and reaps the real Win32 claude.exe tree.
      attempts.push(execBestEffort(`taskkill.exe /pid ${pid} /T /F`));

      // Settle once all best-effort attempts have fired, then verify after a
      // short grace window (processes do not die synchronously).
      void Promise.all(attempts).then(() => {
        setTimeout(() => resolve(pidAlive(pid)), KILL_GRACE_MS).unref?.();
      });
    });
  }

  async function killFlow(flowId: FlowId, cause: KillCause): Promise<void> {
    // Latch the flow as killed so no further spawns/cycles are admitted, and
    // DISARM it — a killed flow must require an explicit re-play to run again.
    killedFlows.add(flowId);
    armedFlows.delete(flowId);

    emit({ type: "kill.requested", flowId, by: cause, at: Date.now() });

    // Abort every live run's controller (stops streaming/parsing promptly) …
    for (const runId of liveRunSet(flowId)) {
      const ll = liveLeases.get(runId);
      if (ll && !ll.controller.signal.aborted) {
        try {
          ll.controller.abort(new Error(`flow ${flowId} killed (${cause})`));
        } catch {
          /* defensive */
        }
      }
    }

    // … then belt-and-suspenders kill every registered child PID of this flow,
    // and VERIFY each is gone. A survivor means an interop-launched orphan we
    // could not reap — surface it loudly so the operator can act (the BELT
    // --max-turns + the runner wall-clock timeout still bound its spend).
    const toKill: { runId: RunId; pid: number }[] = [];
    for (const entry of children.values()) {
      if (entry.flowId === flowId) toKill.push({ runId: entry.runId, pid: entry.pid });
    }
    const results = await Promise.all(
      toKill.map(async ({ runId, pid }) => ({
        runId,
        pid,
        stillAlive: await killPid(pid),
      })),
    );
    for (const r of results) {
      if (!r.stillAlive) continue;
      // kill.failed surfaced via a `log` event (the wire contract has no dedicated
      // kill.failed type; rose = error severity in the UI log strip).
      emit({
        type: "log",
        flowId,
        color: "rose",
        msg:
          `kill.failed: pid ${r.pid} (run ${String(r.runId)}) survived SIGKILL/` +
          `tree-kill/taskkill — a Windows claude.exe orphan may still be spending. ` +
          `Bounded by --max-turns + the per-run wall-clock timeout; verify via Task Manager.`,
        at: Date.now(),
      });
    }

    // Drop the kill-registry entries for this flow (the children are dead).
    for (const [runId, entry] of [...children.entries()]) {
      if (entry.flowId === flowId) children.delete(runId);
    }

    // TERMINAL MODE: tmux kill-session every pane this flow ran in. This is the
    // real kill target in terminal mode — the abort above sends Ctrl-C to the
    // pane's claude, and this reaps the whole session so no orphan pane survives.
    for (const [runId, entry] of [...runTerminals.entries()]) {
      if (entry.flowId === flowId) runTerminals.delete(runId);
    }
    if (disposeTerminalsForFlow) {
      await disposeTerminalsForFlow(flowId).catch(() => undefined);
    }
  }

  // ===========================================================================
  // Concurrency semaphore + pause/resume.
  // ===========================================================================
  function availableSlots(flowId: FlowId): number {
    const budget = budgetFor(flowId);
    const inUse = liveRunSet(flowId).size;
    return Math.max(0, budget.maxConcurrentAgents - inUse);
  }

  function setFlowPaused(flowId: FlowId, paused: boolean): void {
    if (paused) pausedFlows.add(flowId);
    else {
      pausedFlows.delete(flowId);
      // Resuming a flow also clears a prior kill latch so it can run again.
      killedFlows.delete(flowId);
    }
  }

  function setFlowArmed(flowId: FlowId, armed: boolean): void {
    if (armed) {
      armedFlows.add(flowId);
      // Arming via an explicit play also clears a prior kill latch (mirrors the
      // resume semantics) so a previously-killed flow can run again once played.
      killedFlows.delete(flowId);
    } else {
      armedFlows.delete(flowId);
    }
  }

  function isFlowArmed(flowId: FlowId): boolean {
    return armedFlows.has(flowId);
  }

  return {
    requestSpawn,
    releaseLease,
    requestNextCycle,
    meterToken,
    spendForFlow,
    registerChild,
    unregisterChild,
    registerTerminal,
    unregisterTerminal,
    setTerminalDisposer,
    killFlow,
    availableSlots,
    setFlowPaused,
    setFlowArmed,
    isFlowArmed,
  };
}

// Silence unused-import lints for symbols kept for forward-compat with callers
// that pass branded ids straight through (asRunId/NodeId narrowing helpers).
void asRunId;
type _NodeIdKeep = NodeId;
