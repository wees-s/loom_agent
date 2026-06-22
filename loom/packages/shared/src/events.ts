import type { FlowId, NodeId, EdgeId, RunId } from "./ids.js";
import type { ModelId } from "./models.js";
import type { Flow, FlowState, RunStatus, TokenUsage, ToolCall, Cycle, TerminalStatus } from "./domain.js";

// APPEND-ONLY EVENT LOG — the single source of truth. The UI is a pure projection.
// Every event is persisted to node:sqlite and assigned a monotonic seq on append.
export type LoomEvent =
  | { type: "flow.upserted"; flowId: FlowId; flow: Flow }
  | { type: "flow.removed"; flowId: FlowId; at: number }
  | { type: "flow.spec.changed"; flowId: FlowId; version: number }
  | { type: "flow.stateChanged"; flowId: FlowId; state: FlowState }
  | { type: "auth.state"; ok: boolean; detail: string }
  | { type: "cycle.started"; flowId: FlowId; cycle: number; at: number }
  | { type: "cycle.ended"; flowId: FlowId; cycle: number; status: Cycle["status"]; totalUsd: number; at: number }
  | { type: "cycle.converged"; flowId: FlowId; cycle: number; reason: "no-new-output"; at: number }
  | { type: "trigger.fired"; flowId: FlowId; nodeId: NodeId; cause: "Agendado" | "Intervalo" | "Webhook" | "Manual" | "feedback"; at: number }
  | { type: "run.started"; runId: RunId; flowId: FlowId; nodeId: NodeId; cycle: number; model: ModelId; at: number }
  | { type: "run.token"; runId: RunId; usage: TokenUsage; costUsd: number }
  | { type: "run.tool"; runId: RunId; tool: ToolCall }
  | { type: "run.output"; runId: RunId; chunk: string }
  | { type: "run.finished"; runId: RunId; status: RunStatus; resultSummary?: string; error?: string; at: number }
  | { type: "node.activated"; flowId: FlowId; nodeId: NodeId; runId: RunId; cycle: number }
  | { type: "node.deactivated"; flowId: FlowId; nodeId: NodeId; runId: RunId }
  | { type: "edge.fired"; flowId: FlowId; edgeId: EdgeId; cycle: number }
  | { type: "blackboard.write"; flowId: FlowId; path: string; byNodeId: NodeId; bytes: number; hash: string; at: number }
  | { type: "terminal.state"; terminal: string; status: TerminalStatus; meta: string }
  | { type: "budget.tripped"; flowId: FlowId; scope: "run" | "flow" | "cycle"; metric: "tokens" | "usd" | "cycles"; limit: number; runId?: RunId }
  | { type: "kill.requested"; flowId: FlowId; by: "user" | "budget" | "maxCycles" | "convergence"; at: number }
  | { type: "log"; flowId: FlowId; color: string; msg: string; at: number };

export interface StoredEvent {
  seq: number;   // monotonic, the WS resync cursor
  ts: number;    // epoch ms
  event: LoomEvent;
}
