// =============================================================================
// eventlog.ts [eventlog] — append-only event store; the single runtime source
// of truth. ALL SQL is isolated here (swappable to a JSONL fold later).
//
// Runtime requires the `--experimental-sqlite` flag (set in package.json
// dev/start scripts). Imports `node:sqlite` (DatabaseSync), typed via
// @types/node's sqlite.d.ts.
//
// Design:
//   - One append-only table `events(seq AUTOINCREMENT, ts, type, json)`.
//     `seq` is the monotonic WS resync cursor; `json` carries the full
//     LoomEvent. `type` is denormalised into its own column so projection
//     reads can filter in SQL instead of scanning every row.
//   - append() persists (assigning seq + epoch ts), then fires the in-process
//     live-tail listeners synchronously, in seq order — the bridge subscribes
//     to this for loss-less WS fan-out.
//   - Projections (flow summaries / state / cycle counter / recent runs /
//     orphan recovery) are pure folds OVER the log read straight from SQLite,
//     so they survive a restart with no in-memory state to rebuild. The UI is
//     a pure projection of these reads.
// =============================================================================

import { DatabaseSync } from "node:sqlite";
import type {
  FlowId,
  NodeId,
  LoomEvent,
  StoredEvent,
  Run,
  RunStatus,
  TokenUsage,
  Flow,
  FlowSummary,
  FlowState,
} from "@loom/shared";
import { asFlowId, asNodeId, semanticsOf } from "@loom/shared";
import type { EventListener, Unsubscribe } from "./internal.js";

/** Projection of a flow's current runtime state, folded from the log. */
export interface FlowStateProjection {
  flowId: FlowId;
  state: FlowState;
  cycle: number;
}

/** Orphan-recovery snapshot: runs left unfinished at boot + last barrier. */
export interface OrphanRecoveryPlan {
  /** Runs that were started but never finished — orchestrator marks them killed. */
  unfinishedRuns: Run[];
  /** Per-flow last-known cycle, so replan resumes from the last barrier. */
  lastCycleByFlow: Record<string, number>;
}

/** Committed (settled) lifetime spend for one flow, reconstructed from the log. */
export interface FlowSpendFold {
  flowId: FlowId;
  /** Sum of every FINISHED run's final cost for this flow. */
  committedUsd: number;
  /** Sum of every FINISHED run's final token total for this flow. */
  committedTokens: number;
}

export interface EventLog {
  /** Append an event: assign monotonic seq + epoch ts, persist, then live-tail. */
  append(event: LoomEvent): StoredEvent;

  /** All stored events with seq > sinceSeq, in seq order (WS replay cursor). */
  readSince(sinceSeq: number): StoredEvent[];

  /** Highest persisted seq (the resync cursor handed out in `hello`). */
  latestSeq(): number;

  /** Live tail the bridge subscribes to; fires per append, in seq order. */
  subscribe(listener: EventListener): Unsubscribe;

  // ---- Projections used by the UI (read-only folds over the log) ----

  /** Rail/inspector summaries (counts included) for every known flow. */
  projectFlowSummaries(): FlowSummary[];

  /** Current projected runtime state for one flow. */
  flowState(flowId: FlowId): FlowStateProjection;

  /** Current cycle counter for a flow (max cycle seen in cycle.* events). */
  cycleCounter(flowId: FlowId): number;

  /** Recent runs for a node (newest first) — backs run.snapshot. */
  recentRuns(nodeId: NodeId, limit?: number): Run[];

  /** Fold the log to find unfinished runs + last barrier for boot recovery. */
  foldForOrphanRecovery(): OrphanRecoveryPlan;

  /**
   * Fold every FINISHED run's final cost into per-flow committed spend. The guard
   * calls this on boot to REHYDRATE its in-memory per-flow USD/token meter so the
   * lifetime per-flow ceiling survives an engine restart (otherwise every restart
   * silently resets the cap to zero — a runaway-cost hole). Only runs that reached
   * a terminal status are counted; live/orphaned runs are excluded (the latter are
   * settled as killed by orphan recovery, which appends run.finished).
   */
  foldFlowSpend(): FlowSpendFold[];

  /** Flush + close the underlying database. */
  close(): void;
}

// -----------------------------------------------------------------------------
// Persistence layer (the ONLY place that touches SQL).
// -----------------------------------------------------------------------------

/** Raw row shape returned by the prepared SELECTs. */
interface EventRow {
  seq: number | bigint;
  ts: number | bigint;
  json: string;
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS events (
    seq  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   INTEGER NOT NULL,
    type TEXT    NOT NULL,
    json TEXT    NOT NULL
  );

  -- Projections filter by event type (run.*, cycle.*, flow.*) — index it.
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`;

const num = (v: number | bigint): number =>
  typeof v === "bigint" ? Number(v) : v;

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Sum of every token bucket in a usage record (drives Run.usage rollups). */
function totalTokens(u: TokenUsage): number {
  return (
    u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
  );
}

/** A run reconstructed while folding the log (mutated in place during the fold). */
interface RunAccumulator {
  run: Run;
  /** Latest absolute usage seen in a run.token event (claude reports cumulative). */
  hasUsage: boolean;
}

/**
 * Open (and migrate) the event store at `dbPath`. Pass ":memory:" for tests.
 * Creates the append-only `events` table (seq INTEGER PRIMARY KEY AUTOINCREMENT,
 * ts INTEGER, type TEXT, json TEXT) plus the read indices the projections need.
 */
export function open(dbPath: string): EventLog {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  // Prepared statements — compiled once, reused per call.
  const stmtInsert = db.prepare(
    "INSERT INTO events (ts, type, json) VALUES (?, ?, ?)",
  );
  const stmtSince = db.prepare(
    "SELECT seq, ts, json FROM events WHERE seq > ? ORDER BY seq ASC",
  );
  const stmtMaxSeq = db.prepare("SELECT MAX(seq) AS m FROM events");
  const stmtAll = db.prepare(
    "SELECT seq, ts, json FROM events ORDER BY seq ASC",
  );
  // Run + node lifecycle events, oldest→newest, so the fold applies in order.
  const stmtRunEvents = db.prepare(
    `SELECT seq, ts, json FROM events
       WHERE type IN ('run.started','run.token','run.tool','run.finished')
       ORDER BY seq ASC`,
  );

  // In-process live-tail listeners (the bridge subscribes here).
  const listeners = new Set<EventListener>();
  let closed = false;

  // --- helpers --------------------------------------------------------------

  const parseRow = (row: EventRow): StoredEvent => ({
    seq: num(row.seq),
    ts: num(row.ts),
    event: JSON.parse(row.json) as LoomEvent,
  });

  /** Read the whole log once as ordered StoredEvents (used by broad folds). */
  const readAll = (): StoredEvent[] =>
    (stmtAll.all() as unknown as EventRow[]).map(parseRow);

  // --- append ---------------------------------------------------------------

  function append(event: LoomEvent): StoredEvent {
    if (closed) throw new Error("eventlog: append after close()");
    const ts = Date.now();
    const info = stmtInsert.run(ts, event.type, JSON.stringify(event));
    const seq = num(info.lastInsertRowid as number | bigint);
    const stored: StoredEvent = { seq, ts, event };

    // Fire the live tail AFTER the row is durable, in seq order. A throwing
    // listener must not corrupt the log or block other listeners.
    for (const l of listeners) {
      try {
        l(stored);
      } catch {
        // Swallow — the event is already persisted; replay will recover it.
      }
    }
    return stored;
  }

  // --- raw reads ------------------------------------------------------------

  function readSince(sinceSeq: number): StoredEvent[] {
    const from = Number.isFinite(sinceSeq) ? Math.max(0, Math.trunc(sinceSeq)) : 0;
    return (stmtSince.all(from) as unknown as EventRow[]).map(parseRow);
  }

  function latestSeq(): number {
    const row = stmtMaxSeq.get() as { m: number | bigint | null } | undefined;
    const m = row?.m;
    return m == null ? 0 : num(m);
  }

  function subscribe(listener: EventListener): Unsubscribe {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  // --- projections ----------------------------------------------------------

  /**
   * Fold the entire log into per-flow runtime facts in a single pass:
   *   - latest spec (from flow.upserted) for node/edge/trigger counts,
   *   - latest projected FlowState,
   *   - max cycle seen.
   * One scan serves both projectFlowSummaries() and flowState().
   */
  function foldFlows(): Map<
    string,
    { flow: Flow | null; state: FlowState; cycle: number; removed: boolean }
  > {
    const byFlow = new Map<
      string,
      { flow: Flow | null; state: FlowState; cycle: number; removed: boolean }
    >();

    const ensure = (id: string) => {
      let e = byFlow.get(id);
      if (!e) {
        e = { flow: null, state: "ocioso", cycle: 0, removed: false };
        byFlow.set(id, e);
      }
      return e;
    };

    const bumpCycle = (id: string, cycle: number | undefined) => {
      if (typeof cycle !== "number") return;
      const e = ensure(id);
      if (cycle > e.cycle) e.cycle = cycle;
    };

    for (const { event } of readAll()) {
      switch (event.type) {
        case "flow.upserted": {
          const e = ensure(event.flowId);
          e.flow = event.flow;
          // A re-upsert (e.g. re-create with the same id) resurrects a flow that
          // was previously removed — events apply in seq order, last writer wins.
          e.removed = false;
          // Spec carries an initial projected state; keep it unless a later
          // flow.stateChanged overrides (events are applied in seq order).
          e.state = event.flow.state;
          if (event.flow.cycle > e.cycle) e.cycle = event.flow.cycle;
          break;
        }
        case "flow.removed": {
          // Tombstone the flow so projections drop it from the rail/hello. We keep
          // the entry (so a later re-upsert can resurrect it) but mark it removed.
          ensure(event.flowId).removed = true;
          break;
        }
        case "flow.stateChanged": {
          ensure(event.flowId).state = event.state;
          break;
        }
        case "cycle.started":
        case "cycle.ended":
        case "cycle.converged":
          bumpCycle(event.flowId, event.cycle);
          break;
        case "run.started":
        case "node.activated":
          bumpCycle(event.flowId, event.cycle);
          break;
        default:
          // Other events carry no flow-level state/cycle facts.
          break;
      }
    }
    return byFlow;
  }

  function projectFlowSummaries(): FlowSummary[] {
    const folded = foldFlows();
    const out: FlowSummary[] = [];
    for (const [id, e] of folded) {
      if (e.removed) continue; // tombstoned by flow.removed — drop from the rail.
      const flow = e.flow;
      out.push({
        id: asFlowId(id),
        name: flow?.name ?? id,
        schedule: flow?.schedule ?? "",
        state: e.state,
        cycle: e.cycle,
        agents: flow?.nodes.length ?? 0,
        connections: flow?.edges.length ?? 0,
        triggers: flow
          ? flow.nodes.filter((n) => semanticsOf(n.type) === "trigger").length
          : 0,
      });
    }
    // Stable, name-ascending order for a deterministic rail.
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function flowState(flowId: FlowId): FlowStateProjection {
    const e = foldFlows().get(flowId);
    return {
      flowId,
      state: e?.state ?? "ocioso",
      cycle: e?.cycle ?? 0,
    };
  }

  function cycleCounter(flowId: FlowId): number {
    return foldFlows().get(flowId)?.cycle ?? 0;
  }

  /**
   * Fold every run.* event into reconstructed Run records, keyed by runId,
   * applied in seq order. run.token reports CUMULATIVE usage/cost from the CLI,
   * so we take the latest snapshot rather than summing deltas.
   */
  function foldRuns(): Map<string, RunAccumulator> {
    const runs = new Map<string, RunAccumulator>();

    for (const { ts, event } of (
      stmtRunEvents.all() as unknown as EventRow[]
    ).map(parseRow)) {
      switch (event.type) {
        case "run.started": {
          runs.set(event.runId, {
            run: {
              id: event.runId,
              flowId: event.flowId,
              nodeId: event.nodeId,
              cycle: event.cycle,
              status: "running" satisfies RunStatus,
              model: event.model,
              startedAt: event.at ?? ts,
              usage: { ...ZERO_USAGE },
              costUsd: 0,
              toolCalls: 0,
            },
            hasUsage: false,
          });
          break;
        }
        case "run.token": {
          const acc = runs.get(event.runId);
          if (!acc) break;
          // Cumulative snapshot — replace, do not add.
          acc.run.usage = { ...event.usage };
          acc.run.costUsd = event.costUsd;
          acc.hasUsage = true;
          break;
        }
        case "run.tool": {
          const acc = runs.get(event.runId);
          if (!acc) break;
          acc.run.toolCalls += 1;
          break;
        }
        case "run.finished": {
          const acc = runs.get(event.runId);
          if (!acc) break;
          acc.run.status = event.status;
          acc.run.endedAt = event.at ?? ts;
          if (event.resultSummary !== undefined)
            acc.run.resultSummary = event.resultSummary;
          if (event.error !== undefined) acc.run.error = event.error;
          break;
        }
        default:
          break;
      }
    }
    return runs;
  }

  function recentRuns(nodeId: NodeId, limit = 10): Run[] {
    const all: Run[] = [];
    for (const acc of foldRuns().values()) {
      if (acc.run.nodeId === nodeId) all.push(acc.run);
    }
    // Newest first: by startedAt desc, then cycle desc as a tiebreaker.
    all.sort((a, b) => b.startedAt - a.startedAt || b.cycle - a.cycle);
    const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    return n > 0 ? all.slice(0, n) : all;
  }

  /**
   * Per-flow committed spend, folded from FINISHED runs only. run.token carries
   * CUMULATIVE usage/cost from the CLI, so foldRuns already holds each run's final
   * snapshot; here we just sum the runs that reached a terminal status per flow.
   * A run with no terminal run.finished (still "running"/"queued") is an orphan
   * and is NOT counted — orphan recovery converts it to killed (appending
   * run.finished), after which a subsequent fold would include its (partial) cost.
   */
  function foldFlowSpend(): FlowSpendFold[] {
    const byFlow = new Map<string, FlowSpendFold>();
    for (const acc of foldRuns().values()) {
      // Only settled runs contribute to the committed (lifetime) meter.
      if (acc.run.status === "running" || acc.run.status === "queued") continue;
      const id = acc.run.flowId as string;
      let f = byFlow.get(id);
      if (!f) {
        f = { flowId: acc.run.flowId, committedUsd: 0, committedTokens: 0 };
        byFlow.set(id, f);
      }
      f.committedUsd += Math.max(0, acc.run.costUsd);
      f.committedTokens += Math.max(0, totalTokens(acc.run.usage));
    }
    return [...byFlow.values()];
  }

  function foldForOrphanRecovery(): OrphanRecoveryPlan {
    const runs = foldRuns();
    const unfinishedRuns: Run[] = [];
    for (const acc of runs.values()) {
      // Started but never reached a terminal status → an orphan from a prior boot.
      if (acc.run.status === "running" || acc.run.status === "queued") {
        unfinishedRuns.push(acc.run);
      }
    }
    // Last-known cycle per flow drives the replan from the last barrier.
    const lastCycleByFlow: Record<string, number> = {};
    for (const [id, e] of foldFlows()) {
      lastCycleByFlow[id] = e.cycle;
    }
    unfinishedRuns.sort((a, b) => a.startedAt - b.startedAt);
    return { unfinishedRuns, lastCycleByFlow };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    listeners.clear();
    db.close();
  }

  return {
    append,
    readSince,
    latestSeq,
    subscribe,
    projectFlowSummaries,
    flowState,
    cycleCounter,
    recentRuns,
    foldFlowSpend,
    foldForOrphanRecovery,
    close,
  };
}
