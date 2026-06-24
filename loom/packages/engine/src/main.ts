import {
  PROTOCOL_VERSION,
  MODEL_CATALOG,
  NODE_TYPE_CATALOG,
  type FlowId,
  type FlowBudget,
  type ServerMessage,
} from "@loom/shared";
import { PATHS, PORTS, DEFAULT_BUDGET } from "./config.js";

// Engine modules (pinned interfaces — bodies are NOT_IMPLEMENTED stubs that the
// 11 implementers fill in; this file pins boot ORDERING + wiring so the seams
// stay coherent).
import { open as openEventLog } from "./eventlog.js";
import { createAuthService } from "./auth.js";
import { createTerminals } from "./terminals.js";
import { createBlackboard } from "./blackboard.js";
import { createSpecStore } from "./spec.js";
import { createGuard } from "./guard.js";
import { createRunner } from "./runner.js";
import { createGenerator } from "./generator.js";
import { createOrchestrator } from "./orchestrator.js";
import { createScheduler } from "./scheduler.js";
import { createBridge, type Bridge } from "./bridge.js";
import type { EngineConfig, EngineDeps, Emit } from "./internal.js";

/** Hard ceiling on the boot auth pre-flight (ms); a stuck CLI must not wedge boot. */
const AUTH_PREFLIGHT_BUDGET_MS = 30_000;

// --- Boot config ------------------------------------------------------------
function buildConfig(): EngineConfig {
  return {
    // LOOM_DB lets a dry run / test point at a clean (or :memory:) db without
    // touching the operator's real event log. Defaults to the repo data dir.
    dbFile: process.env.LOOM_DB || PATHS.dbFile,
    flowsDir: PATHS.flowsDir,
    blackboardRoot: PATHS.blackboardRoot,
    specVersionsDir: `${PATHS.repoRoot}/data/spec_versions`,
    bridgePort: process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : PORTS.bridge,
    runnerMode: process.env.LOOM_RUNNER === "fake" ? "fake" : "real",
  };
}

function buildHello(): ServerMessage {
  return {
    t: "hello",
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    flows: [],
    models: MODEL_CATALOG,
    catalog: NODE_TYPE_CATALOG,
    terminals: [],
    sinceSeq: 0,
  };
}

/**
 * Assemble the dependency graph in DEPENDENCY ORDER. Construction never throws
 * (factories build the objects); the NOT_IMPLEMENTED throws fire only when a
 * method is actually invoked, so the wiring graph itself typechecks + boots.
 */
export function buildEngine(config: EngineConfig): EngineDeps {
  // 1. Event log first — the single source of truth everything emits through.
  const eventlog = openEventLog(config.dbFile);
  const emit: Emit = (event) => eventlog.append(event);

  // 2. Auth pre-flight service (non-fatal at boot; guard gates on isReady()).
  const auth = createAuthService(emit);

  // 3. Terminals (tmux registry) — needed by blackboard for term:// refs.
  const terminals = createTerminals(emit);

  // 4. Blackboard (per-flow cwd, atomic writes, sha256) over terminals.
  const blackboard = createBlackboard(config.blackboardRoot, terminals, emit);

  // 5. Spec store (YAML <-> Flow) — owns budgets the guard reads.
  const spec = createSpecStore(config.flowsDir, config.specVersionsDir, emit);

  // budgets resolve from the loaded spec, falling back to DEFAULT_BUDGET.
  const budgetFor = (flowId: FlowId): FlowBudget =>
    spec.get(flowId)?.budget ?? (DEFAULT_BUDGET as unknown as FlowBudget);

  // 6. Guard — the safety chokepoint; folds run.token from the eventlog.
  const guard = createGuard(eventlog, auth, emit, budgetFor);

  // 7. Runner — needs a guard lease to spawn; writes via the blackboard. REAL
  //    mode launches claude inside a tmux pane via the terminals manager.
  const runner = createRunner(config.runnerMode, guard, blackboard, terminals, emit);

  // NL flow generator — inherits the runner mode (fake → zero-cost canned flow).
  const generator = createGenerator(config.runnerMode, emit);

  // Wire the guard's kill path to tmux kill-session a flow's panes (terminal
  // mode's real kill target). Injected post-construction to avoid a cycle.
  guard.setTerminalDisposer((flowId) => terminals.disposeFlow(flowId));

  // 8. Orchestrator — DAG/Kahn/barrier/feedback; drives runner + guard.
  const orchestrator = createOrchestrator(
    eventlog,
    guard,
    runner,
    blackboard,
    spec,
    terminals,
    emit,
  );

  // 9. Scheduler — trigger daemon; owns the shared node:http server.
  const scheduler = createScheduler(guard, orchestrator, spec, emit);

  return {
    config,
    eventlog,
    emit,
    auth,
    blackboard,
    terminals,
    guard,
    runner,
    spec,
    scheduler,
    orchestrator,
    generator,
  };
}

/**
 * Step (b): load every flows/*.flow.yaml into the spec store AND publish each
 * loaded flow into the event log via flow.upserted. The eventlog projections
 * (flow summaries, cycle counter, the bridge's hello) are pure folds over the
 * log, so a flow only becomes visible to the rail/replay once it is upserted.
 * Idempotent across boots: the projection folds last-writer per flowId.
 */
function loadFlowsIntoLog(deps: EngineDeps, flows: { id: FlowId }[]): void {
  for (const summary of flows) {
    const flow = deps.spec.get(summary.id);
    if (!flow) continue;
    deps.emit({ type: "flow.upserted", flowId: flow.id, flow });
  }
}

/** A boot-time, time-bounded auth pre-flight signal. */
function preflightSignal(): AbortSignal {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("auth pre-flight budget exhausted")), AUTH_PREFLIGHT_BUDGET_MS);
  // Don't let the watchdog keep the event loop (and thus the process) alive.
  (t as unknown as { unref?: () => void }).unref?.();
  return ac.signal;
}

/**
 * Boot the engine. Ordering (full async wiring):
 *   a. buildEngine() — construct the dependency graph (above).
 *   b. spec.listFlows() — load flows/*.flow.yaml + upsert each into the log.
 *   c. orchestrator.recoverOrphans() — fold the log, kill unfinished runs,
 *      replan from the last barrier (idempotent).
 *   d. auth.preflight() — health-check claude (non-fatal; guard stays closed
 *      until it succeeds). Skipped (synthesised ok) under the fake runner.
 *   e. scheduler.start(bridgePort) — open the shared http server + arm triggers.
 *   f. bridge.attach(scheduler.httpServer) — /ws upgrade on the same server.
 *
 * `--dry-run <flowId>`: run exactly ONE cycle of the named flow, then tear down
 * and exit. The scheduler/http server is NOT started (no port, no triggers) —
 * the cycle is driven directly through the orchestrator so the run is hermetic.
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRunIdx = argv.indexOf("--dry-run");
  const dryRunFlowId =
    dryRunIdx >= 0 && argv[dryRunIdx + 1] ? (argv[dryRunIdx + 1] as FlowId) : null;

  const config = buildConfig();
  const deps = buildEngine(config);

  // The bridge shares the scheduler's http server; created after the graph.
  const bridge: Bridge = createBridge(
    deps.eventlog,
    deps.spec,
    deps.scheduler,
    deps.guard,
    deps.terminals,
    deps.orchestrator,
    deps.generator,
    deps.emit,
  );

  const hello = buildHello();
  // eslint-disable-next-line no-console
  console.log(
    `[loom/engine] boot — protocol v${hello.t === "hello" ? hello.protocolVersion : "?"}, ` +
      `${MODEL_CATALOG.length} models, ${NODE_TYPE_CATALOG.length} node types, ` +
      `runner=${config.runnerMode}${dryRunFlowId ? `, dry-run=${dryRunFlowId}` : ""}`,
  );
  // eslint-disable-next-line no-console
  console.log(`[loom/engine] data dir: ${PATHS.dataDir}, bridge port: ${config.bridgePort}`);

  // --- (b) Load flows + publish them into the event log ---------------------
  const flows = await deps.spec.listFlows();
  loadFlowsIntoLog(deps, flows);
  // eslint-disable-next-line no-console
  console.log(`[loom/engine] loaded ${flows.length} flow(s): ${flows.map((f) => f.id).join(", ") || "—"}`);

  // --- (c) Orphan recovery — idempotent fold of the log ---------------------
  await deps.orchestrator.recoverOrphans();

  // --- (d) Auth pre-flight — non-fatal; guard gates on isReady() ------------
  const auth = await deps.auth.preflight(preflightSignal());
  // eslint-disable-next-line no-console
  console.log(`[loom/engine] auth: ${auth.ok ? "ok" : "NOT ready"} — ${auth.detail}`);

  // =========================================================================
  // DRY RUN — one hermetic cycle, then exit. No http server, no triggers.
  // =========================================================================
  if (dryRunFlowId) {
    const flow = deps.spec.get(dryRunFlowId);
    if (!flow) {
      // eslint-disable-next-line no-console
      console.error(
        `[loom/engine] --dry-run: flow "${dryRunFlowId}" not found. Available: ${flows
          .map((f) => f.id)
          .join(", ")}`,
      );
      deps.eventlog.close();
      process.exitCode = 2;
      return;
    }
    if (!deps.auth.isReady()) {
      // eslint-disable-next-line no-console
      console.error(
        `[loom/engine] --dry-run: auth is not ready (${auth.detail}). The guard will deny every spawn. ` +
          `Run with LOOM_RUNNER=fake for a zero-cost dry run.`,
      );
      deps.eventlog.close();
      process.exitCode = 3;
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`[loom/engine] --dry-run: starting ONE cycle of ${flow.id} (runner=${config.runnerMode})`);
    // --dry-run is an EXPLICIT start, so arm the flow in the guard (flows load
    // un-armed / inert by default — see the safe-by-default boot). Without this
    // the guard would deny every spawn with `flow_not_armed`.
    deps.guard.setFlowArmed(flow.id, true);
    const outcome = await deps.orchestrator.startCycle(flow, "Manual");
    // eslint-disable-next-line no-console
    console.log(
      `[loom/engine] --dry-run: cycle outcome = ${outcome.status} (cycle ${outcome.cycle})`,
    );

    // Tear down (close ws + db). Scheduler/http never started, so nothing to stop.
    await bridge.close();
    deps.eventlog.close();
    // A clean cycle is done/converged/stopped (a guard stop such as
    // maxCyclesPerArm is a HEALTHY terminal outcome of a feedback loop). Only a
    // kill (budget/user) is a failure for the dry run.
    process.exitCode = outcome.status === "killed" ? 1 : 0;
    return;
  }

  // --- (e) Scheduler — open the shared http server + arm triggers -----------
  await deps.scheduler.start(config.bridgePort);

  // --- (f) Bridge — /ws upgrade on the scheduler's shared server ------------
  bridge.attach(deps.scheduler.httpServer);

  // eslint-disable-next-line no-console
  console.log(
    `[loom/engine] ready — ws://127.0.0.1:${config.bridgePort}/ws ` +
      `(webhook http://127.0.0.1:${config.bridgePort}/webhook/:flowId/:event)`,
  );

  // Graceful shutdown on signals.
  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[loom/engine] ${sig} — shutting down`);
    try {
      await bridge.close();
      await deps.scheduler.stop();
      deps.eventlog.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

// Run when invoked directly (node --experimental-sqlite dist/main.js / tsx).
void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[loom/engine] fatal boot error:`, err);
  process.exit(1);
});
