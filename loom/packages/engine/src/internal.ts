// =============================================================================
// internal.ts — shared INTERNAL engine contracts (not exposed over the wire).
//
// These types pin the seams BETWEEN engine modules so 11 implementers can build
// in parallel without interface drift. Everything wire-facing lives in
// @loom/shared; everything here is engine-private glue.
//
// Dependency direction (no cycles):
//   eventlog  ← (everyone emits/reads through it)
//   streamParser → (pure; runner consumes)
//   blackboard → terminals (term:// refs)
//   guard → consumes run.token from eventlog; mints SpawnLease
//   runner → guard (lease) + streamParser + blackboard + eventlog
//   scheduler → guard + orchestrator
//   orchestrator → guard + runner + eventlog + blackboard + spec
//   bridge → eventlog + spec + scheduler + guard + terminals + orchestrator
// =============================================================================

import type {
  Flow,
  FlowId,
  NodeId,
  RunId,
  AgentNode,
  ModelId,
  TokenUsage,
  RunStatus,
  Run,
  Terminal,
  LoomEvent,
  StoredEvent,
} from "@loom/shared";

import type { EventLog } from "./eventlog.js";
import type { Blackboard } from "./blackboard.js";
import type { Terminals } from "./terminals.js";
import type { Guard } from "./guard.js";
import type { Runner } from "./runner.js";
import type { Generator } from "./generator.js";
import type { SpecStore } from "./spec.js";
import type { Scheduler } from "./scheduler.js";
import type { Orchestrator } from "./orchestrator.js";
import type { AuthService } from "./auth.js";

// -----------------------------------------------------------------------------
// Emit seam — the ONE way any module writes to the source of truth.
// Modules never import the sqlite layer; they take an `Emit` (or the EventLog).
// -----------------------------------------------------------------------------

/** Append a runtime event; returns the persisted, seq-stamped row. */
export type Emit = (event: LoomEvent) => StoredEvent;

/** Live-tail subscription handle: call to unsubscribe. */
export type Unsubscribe = () => void;

/** Live event listener (post-persist, in seq order). */
export type EventListener = (stored: StoredEvent) => void;

// -----------------------------------------------------------------------------
// What triggered a cycle (carried into trigger.fired / cycle bookkeeping).
// -----------------------------------------------------------------------------

export type CycleCause =
  | "Agendado"
  | "Intervalo"
  | "Webhook"
  | "Manual"
  | "feedback";

// -----------------------------------------------------------------------------
// RunCtx / RunResult — the runner's input/output contract.
// -----------------------------------------------------------------------------

/** Everything a single agent run needs, assembled by the orchestrator. */
export interface RunCtx {
  runId: RunId;
  flowId: FlowId;
  flow: Flow;
  node: AgentNode;
  cycle: number;
  /** Feedback arm index (0 for the first pass; bumped by requestNextCycle). */
  arm: number;
  /** Absolute POSIX path of the flow blackboard dir = the agent cwd. */
  flowDir: string;
  /** `wslpath -w flowDir` — handed to the Windows claude via --add-dir. */
  winFlowDir: string;
  /**
   * The per-(flow,node) terminal this run executes in: "term://<flow>.<node>".
   * In REAL/terminal mode the runner launches `claude` inside this tmux pane and
   * the user watches it live; FAKE mode ignores it. Assigned by the orchestrator.
   */
  runTerminalId: string;
  /** Fully-assembled prompt (system + node.prompt + linked context refs). */
  prompt: string;
  model: ModelId;
  /** Guard-issued permission to spawn — runner CANNOT spawn without it. */
  lease: SpawnLease;
  /** Aborts the in-flight child (guard wires this to the live token meter). */
  signal: AbortSignal;
}

/** Terminal outcome of a single agent run. */
export interface RunResult {
  runId: RunId;
  status: RunStatus;
  usage: TokenUsage;
  costUsd: number;
  toolCalls: number;
  /** Recent-runs label, derived from last assistant text or the artifact. */
  resultSummary?: string;
  error?: string;
  /** Artifacts the run actually wrote (relPath → sha256), feeds the barrier. */
  artifacts: Record<string, string>;
}

// -----------------------------------------------------------------------------
// SpawnLease — opaque admission token. ONLY guard mints it (its fields are
// readonly + carry a private brand the runner cannot forge).
// -----------------------------------------------------------------------------

declare const LeaseBrand: unique symbol;

export interface SpawnLease {
  readonly [LeaseBrand]: true;
  readonly leaseId: string;
  readonly runId: RunId;
  readonly flowId: FlowId;
  readonly model: ModelId;
  /** Pre-spend reservation in USD (worstCaseRunCost at admission time). */
  readonly reservedUsd: number;
  /** Pre-spend reservation in tokens. */
  readonly reservedTokens: number;
  /** The per-run abort controller's signal (also reachable via RunCtx). */
  readonly signal: AbortSignal;
  /** Monotonic ms timestamp the lease was granted. */
  readonly grantedAt: number;
}

export interface SpawnRequest {
  flowId: FlowId;
  runId: RunId;
  nodeId: NodeId;
  model: ModelId;
  /** Budgeted input tokens for the worst-case admission math. */
  estInputTokens: number;
}

export interface NextCycleRequest {
  flowId: FlowId;
  /** Current feedback arm; guard decides whether arm+1 may start. */
  arm: number;
  cycle: number;
}

/** A uniform allow/deny result shape used by both guard admission paths. */
export type Decision<T> =
  | { ok: true; value: T }
  | { ok: false; reason: DenialReason; detail: string };

export type DenialReason =
  | "auth_not_ready"
  | "flow_not_armed"
  | "per_run_usd_cap"
  | "per_run_token_cap"
  | "per_flow_usd_cap"
  | "per_flow_token_cap"
  | "concurrency_full"
  | "max_cycles_per_arm"
  | "converged"
  | "flow_killed"
  | "flow_paused";

// -----------------------------------------------------------------------------
// Spend accounting (guard) — the live meter folded from run.token events.
// -----------------------------------------------------------------------------

export interface SpendSnapshot {
  flowId: FlowId;
  usdSpent: number;
  tokensSpent: number;
  /** Outstanding pre-spend reservations from live leases. */
  usdReserved: number;
  tokensReserved: number;
}

export interface RunSpend {
  runId: RunId;
  usdSpent: number;
  tokensSpent: number;
}

// -----------------------------------------------------------------------------
// streamParser — structured events from claude stream-json NDJSON.
// -----------------------------------------------------------------------------

export type StreamEvent =
  | { kind: "init"; sessionId: string; cwd: string; model?: string }
  | { kind: "thinking"; tokens: number }
  | { kind: "rateLimit"; raw: unknown }
  | { kind: "text"; text: string }
  | { kind: "toolUse"; name: string; at: number; raw: unknown }
  | { kind: "usage"; usage: TokenUsage; costUsd: number }
  | {
      kind: "result";
      status: RunStatus;
      totalCostUsd: number;
      durationMs: number;
      usage: TokenUsage;
      resultSummary?: string;
    }
  | { kind: "unknown"; raw: unknown };

// -----------------------------------------------------------------------------
// EngineDeps — the assembled dependency graph, built once in main.ts and
// threaded into the bridge/scheduler/orchestrator. Lets tests inject fakes.
// -----------------------------------------------------------------------------

export interface EngineConfig {
  dbFile: string;
  flowsDir: string;
  blackboardRoot: string;
  specVersionsDir: string;
  bridgePort: number;
  /** "fake" => runner writes canned artifacts and never calls claude. */
  runnerMode: "real" | "fake";
}

export interface EngineDeps {
  config: EngineConfig;
  eventlog: EventLog;
  emit: Emit;
  auth: AuthService;
  blackboard: Blackboard;
  terminals: Terminals;
  guard: Guard;
  runner: Runner;
  spec: SpecStore;
  scheduler: Scheduler;
  orchestrator: Orchestrator;
  generator: Generator;
}

// Re-export the domain Run/Terminal so engine modules can import run-shaped
// values from one place without reaching back into @loom/shared everywhere.
export type { Run, Terminal };
