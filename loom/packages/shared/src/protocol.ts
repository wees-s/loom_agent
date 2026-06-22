import type { FlowId, NodeId } from "./ids.js";
import type { Flow, FlowState, Run, AgentNode, Edge, TriggerConfig, Terminal } from "./domain.js";
import type { StoredEvent } from "./events.js";
import type { ModelDef } from "./models.js";
import type { NodeTypeDef } from "./catalog.js";

export const PROTOCOL_VERSION = 1 as const;

// Flow snapshot for the rail + inspector FLOW-INFO view — counts included (fidelity graft #6).
export interface FlowSummary {
  id: FlowId;
  name: string;
  schedule: string;
  state: FlowState;
  cycle: number;
  agents: number;        // node count
  connections: number;   // edge count
  triggers: number;      // Trigger-node count
}

// engine → UI
export type ServerMessage =
  | { t: "hello"; protocolVersion: typeof PROTOCOL_VERSION; serverTime: string; flows: FlowSummary[]; models: ModelDef[]; catalog: NodeTypeDef[]; terminals: Terminal[]; sinceSeq: number }
  | { t: "flow.snapshot"; flow: Flow }
  | { t: "event"; events: StoredEvent[] }                 // batched, ordered by seq; folded idempotently
  | { t: "run.snapshot"; nodeId: NodeId; runs: Run[] }     // recent-runs for the inspector
  | { t: "terminal.snapshot"; terminals: Terminal[] }      // first-class rail terminal list
  | { t: "terminal.data"; terminal: string; chunk: string }
  | { t: "nextRun"; nodeId: NodeId; iso: string | null }
  | { t: "ack"; cmdId: string; ok: boolean; error?: string }
  | { t: "error"; code: string; message: string };

// Editable subset persisted on spec.save (topology/prompt/positions/budget/trigger).
export interface EditableFlow {
  id: FlowId;
  name: string;
  /** Optional absolute path to a REAL user folder the agents run in; persisted by spec.save. */
  workDir?: string;
  /** Persisted review-each-cycle preference (human-in-the-loop checkpoint). */
  reviewEachCycle?: boolean;
  nodes: AgentNode[];
  edges: Edge[];
}

// UI → engine (each carries cmdId for ack-matching)
export type ClientCommand =
  | { t: "subscribe"; flowId: FlowId; sinceSeq?: number }
  | { t: "flow.play"; cmdId: string; flowId: FlowId }
  | { t: "flow.pause"; cmdId: string; flowId: FlowId }
  | { t: "flow.kill"; cmdId: string; flowId: FlowId }
  | { t: "flow.runNow"; cmdId: string; flowId: FlowId; triggerNodeId?: NodeId }
  | { t: "flow.create"; cmdId: string; name: string }
  | { t: "flow.delete"; cmdId: string; flowId: FlowId }
  | { t: "flow.continue"; cmdId: string; flowId: FlowId }
  | { t: "spec.save"; cmdId: string; flow: EditableFlow }
  | { t: "setTrigger"; cmdId: string; flowId: FlowId; nodeId: NodeId; trigger: TriggerConfig }
  | { t: "node.subscribe"; cmdId: string; flowId: FlowId; nodeId: NodeId }
  | { t: "terminal.open"; cmdId: string; terminal: string }
  | { t: "terminal.input"; cmdId: string; terminal: string; data: string };
