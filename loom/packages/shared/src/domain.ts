import type { FlowId, NodeId, EdgeId, RunId } from "./ids.js";
import type { ModelId } from "./models.js";
import type { NodeTypeName } from "./catalog.js";

export type FlowState = "rodando" | "agendado" | "ocioso" | "pausado" | "rascunho" | "aguardando";
export type RunMode = "run" | "edit";

export type TriggerKind = "Agendado" | "Intervalo" | "Webhook" | "Manual";
export type Freq = "Diário" | "Dias úteis" | "Semanal" | "Mensal";
export type IntervalChoice = "30 s" | "1 min" | "5 min" | "15 min" | "1 h" | "6 h";

export interface TriggerConfig {
  kind: TriggerKind;
  freq?: Freq;            // Agendado
  time?: string;          // "09:00" (Agendado)
  weekday?: number;       // Semanal (0-6); day-of-month for Mensal
  interval?: IntervalChoice; // Intervalo
  event?: string;         // Webhook, e.g. "github.push"
}

export interface AgentNode {
  id: NodeId;
  type: NodeTypeName;
  title: string;
  role: string;
  model: ModelId;                 // real id; UI shows the friendly label
  prompt: string;
  linkedContexts: string[];       // ["daily-log.md", "#standup", "term://2"]
  position: { x: number; y: number };
  /** Artifact files this node is expected to write — drives the presence barrier + write lint. */
  produces?: string[];
  trigger?: TriggerConfig;        // present iff type === "Trigger"
  schedule?: string;              // non-trigger "gatilho" text e.g. "ao receber do Scribe"
  /** true for Synthesizer/Reviewer-class: sees only artifacts, never peer transcripts. */
  contextIsolation?: boolean;
}

export interface Edge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  feedback?: boolean;             // loops back to a trigger; cut from the DAG, gated by the guard
  phase?: number;                 // animation phase offset (visual only)
}

export interface FlowBudget {
  maxCyclesPerArm: number;        // hard cap on feedback re-arms within one trigger firing (primary lifetime-cost bound in terminal mode)
  maxTokensPerRun: number;        // per-run pre-spend cap (worstCaseRunTokens ≤ this); active in ALL modes (no metering needed)
  maxUsdPerRun: number;           // per-run pre-spend cap (worstCaseRunCost ≤ this); active in ALL modes (no metering needed)
  maxTokensPerFlow: number;       // rolling per-flow ceiling. NOTE: terminal mode has no live meter, so committed spend stays 0 and this only bounds concurrently-in-flight runs, NOT lifetime. See review_loom.md §7.1.
  maxUsdPerFlow: number;          // rolling per-flow ceiling. Same caveat as maxTokensPerFlow: NOT a lifetime budget in terminal mode.
  maxConcurrentAgents: number;    // fan-out semaphore
  convergenceWindow: number;      // stop if N cycles produce no new artifact hash
}

export interface Flow {
  id: FlowId;
  name: string;
  version: number;                // bumped on every spec save
  schedule: string;               // rail display label ("09:00", "a cada 2h")
  state: FlowState;               // projected runtime state
  cycle: number;                  // current cycle counter (from event log)
  nodes: AgentNode[];
  edges: Edge[];
  budget: FlowBudget;
  blackboardDir: string;          // relative to blackboardRoot (internal sandbox)
  /**
   * Optional absolute POSIX path to a REAL user folder the flow's agents run in
   * (cwd + claude --add-dir), e.g. "/home/wesley/WORKSPACE/meu-projeto". When set,
   * the blackboard reads/writes there (still safeRelPath-scoped — `..` can never
   * escape it) instead of the internal blackboardDir sandbox. Unset => sandbox.
   */
  workDir?: string;
  /** When true, a feedback loop pauses into "aguardando" after each cycle and
   *  waits for an explicit flow.continue before re-arming (human-in-the-loop). */
  reviewEachCycle?: boolean;
}

export type RunStatus =
  | "queued" | "running" | "ok" | "error" | "killed" | "budget_exceeded" | "timeout";

export interface ToolCall {
  name: string;
  at: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Run {
  id: RunId;
  flowId: FlowId;
  nodeId: NodeId;
  cycle: number;
  status: RunStatus;
  model: ModelId;
  startedAt: number;
  endedAt?: number;
  usage: TokenUsage;
  costUsd: number;
  toolCalls: number;
  resultSummary?: string;         // recent-runs label, e.g. "2 riscos novos"
  error?: string;
}

export interface Cycle {
  flowId: FlowId;
  n: number;
  startedAt: number;
  endedAt?: number;
  totalUsd: number;
  totalTokens: number;
  status: "running" | "done" | "converged" | "stopped" | "killed";
}

// First-class terminal contract (term://N) — backs the left-rail terminal list.
// Status is DERIVED from orchestrator run-ownership, never guessed from pane content.
export type TerminalStatus = "scribe" | "executor" | "idle" | "busy";

export interface Terminal {
  id: string;                 // "term://1"
  title: string;              // display name shown in the rail
  status: TerminalStatus;     // derived from run-ownership
  meta: string;               // short label, e.g. "scribe" / "executor" / "idle"
  flowId?: FlowId;            // owning flow when busy
  nodeId?: NodeId;            // owning node when busy
}
