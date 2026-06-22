import { create } from "zustand";
import type {
  Flow,
  AgentNode,
  Edge,
  TriggerConfig,
  FlowSummary,
  Terminal,
  Run,
  ModelDef,
  NodeTypeDef,
  ServerMessage,
  ClientCommand,
  LoomEvent,
  StoredEvent,
  EditableFlow,
  FlowId,
  NodeId,
  EdgeId,
  NodeTypeName,
  ModelId,
} from "@loom/shared";
import {
  MODEL_CATALOG,
  NODE_TYPE_CATALOG,
  asFlowId,
  asNodeId,
  asEdgeId,
  makeId,
  typeDef,
} from "@loom/shared";

/* ────────────────────────────────────────────────────────────────────────
 * Connection + mode
 * ──────────────────────────────────────────────────────────────────────── */
export type ConnectionStatus = "mock" | "connecting" | "live" | "reconnecting" | "closed";
export type Theme = "light" | "dark";
export type RunMode = "run" | "edit";

/* The add-agent draft mirrors the mockup's `state.draft`. */
export interface AddAgentDraft {
  type: NodeTypeName;
  name: string;
  role: string;
  model: ModelId;
  /** non-trigger free-text "gatilho" line (e.g. "ao receber do Scribe"). */
  schedule: string;
  /** prompt textarea contents (the mockup reads this from the DOM; here it is state). */
  prompt: string;
  /** present for Trigger drafts. */
  trigger: TriggerConfig;
}

/* A single log-strip entry, projected from `log` events / stage advances. */
export interface LogEntry {
  time: string; // "HH:MM:SS"
  color: string; // oklch type color
  msg: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Store shape
 * ──────────────────────────────────────────────────────────────────────── */
export interface LoomState {
  // ── connection / source of truth ──
  connection: ConnectionStatus;
  /** WS resync cursor: highest StoredEvent.seq folded so far. */
  lastSeq: number;
  serverTime: string | null;

  // ── server-driven catalogs (from `hello`) ──
  models: ModelDef[];
  catalog: NodeTypeDef[];

  // ── rail + flow-info ──
  flows: FlowSummary[];
  terminals: Terminal[];

  // ── selected flow topology (full Flow) ──
  selectedFlowId: FlowId | null;
  /** keyed by flowId; full topology arrives via `flow.snapshot`. */
  flowsById: Record<string, Flow>;

  // ── per-node recent runs (inspector "Execuções recentes") ──
  runsByNode: Record<string, Run[]>;
  /** next-run ISO per node (from `nextRun`). */
  nextRunByNode: Record<string, string | null>;

  // ── live glow/pulses (derived from node.activated/deactivated + edge.fired) ──
  activeNodeIds: Set<string>;
  activeEdgeIds: Set<string>;
  /** runId → nodeId, so node.deactivated / run.finished can clear the right node. */
  runNode: Record<string, NodeId>;

  // ── log strip + cycle ──
  logs: LogEntry[];
  cycle: number;

  // ── terminal output buffers (term://N → text) ──
  terminalData: Record<string, string>;

  // ── selected terminal (shown in the live panel) ──
  selectedTerminalId: string | null;

  // ── UI state (mirrors the mockup `this.state`) ──
  mode: RunMode;
  selectedNodeId: NodeId | null;
  selectedEdgeId: EdgeId | null;
  theme: Theme;
  zoom: number;
  pan: { x: number; y: number };
  railOpen: boolean;
  /** play/pause is the projected runtime state of the selected flow. */
  running: boolean;

  // ── add-agent panel ──
  adding: boolean;
  draft: AddAgentDraft | null;
  advOpen: boolean;
  typeQuery: string;

  // ── command sink (wired by wsClient; no-op + queue in mock mode) ──
  sendCommand: (cmd: ClientCommand) => void;
  /** last ack error surfaced to the UI (toast). */
  lastError: string | null;

  // ════════════════════════ ACTIONS ════════════════════════
  /** Fold a single inbound ServerMessage into state (idempotent for `event`). */
  applyServerMessage: (msg: ServerMessage) => void;
  /** Register the transport's command sink + flip out of mock mode. */
  attachTransport: (send: (cmd: ClientCommand) => void) => void;
  setConnection: (s: ConnectionStatus) => void;

  // command emitters (build the ClientCommand + push through sendCommand)
  play: () => void;
  pause: () => void;
  kill: () => void;
  runNow: (triggerNodeId?: NodeId) => void;
  createFlow: (name: string) => void;
  deleteFlow: (flowId: FlowId) => void;
  saveSpec: () => void;
  setWorkDir: (workDir: string) => void;
  setTrigger: (nodeId: NodeId, trigger: TriggerConfig) => void;
  openTerminal: (terminal: string) => void;
  selectTerminal: (terminalId: string | null) => void;
  sendTerminalInput: (terminal: string, data: string) => void;
  subscribeNode: (nodeId: NodeId) => void;

  // pure UI mutations
  selectFlow: (flowId: FlowId) => void;
  selectNode: (nodeId: NodeId | null) => void;
  selectEdge: (edgeId: EdgeId | null) => void;
  clearSelection: () => void;
  setMode: (mode: RunMode) => void;
  toggleTheme: () => void;
  setRailOpen: (open: boolean) => void;
  setZoom: (zoom: number) => void;
  zoomBy: (delta: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  resetView: () => void;

  // local topology edits (optimistic; persisted on saveSpec)
  moveNode: (nodeId: NodeId, position: { x: number; y: number }) => void;
  addEdge: (from: NodeId, to: NodeId) => void;
  deleteEdge: (edgeId: EdgeId) => void;
  deleteNode: (nodeId: NodeId) => void;
  updateNode: (nodeId: NodeId, patch: Partial<AgentNode>) => void;

  // add-agent draft mutations (mirror openAdd/closeAdd/pickType/createAgent)
  openAdd: () => void;
  closeAdd: () => void;
  setDraft: (patch: Partial<AddAgentDraft>) => void;
  setDraftTrigger: (patch: Partial<TriggerConfig>) => void;
  pickDraftType: (type: NodeTypeName) => void;
  toggleAdv: () => void;
  setTypeQuery: (q: string) => void;
  createAgent: () => void;
}

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */
const TRIGGER_DEFAULT: TriggerConfig = { kind: "Agendado", freq: "Diário", time: "09:00", interval: "1 h", event: "" };

function fmtTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

/** Port of DCLogic.composeSchedule — the rail/inspector schedule preview text. */
export function composeSchedule(t: TriggerConfig | undefined): string {
  const k = t?.kind ?? "Agendado";
  if (k === "Agendado") return `${t?.freq ?? "Diário"} · ${t?.time ?? "09:00"}`;
  if (k === "Intervalo") return `a cada ${t?.interval ?? "1 h"}`;
  if (k === "Webhook") return `webhook · ${t?.event || "evento"}`;
  return "manual";
}

/** Default model id for new agents (mockup default: "Claude Sonnet 4.5"). */
const DEFAULT_MODEL: ModelId = "claude-sonnet-4-6";

function makeCmdId(): string {
  return makeId("cmd_");
}

/** Recompute FlowSummary counts from a full Flow (keeps the rail honest after edits). */
function summarize(flow: Flow): FlowSummary {
  return {
    id: flow.id,
    name: flow.name,
    schedule: flow.schedule,
    state: flow.state,
    cycle: flow.cycle,
    agents: flow.nodes.length,
    connections: flow.edges.length,
    triggers: flow.nodes.filter((n) => n.type === "Trigger").length,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Event folding — the UI is a pure projection of the append-only log.
 * ──────────────────────────────────────────────────────────────────────── */
function foldEvent(state: LoomState, ev: LoomEvent, ts: number): Partial<LoomState> {
  const patch: Partial<LoomState> = {};
  switch (ev.type) {
    case "flow.upserted": {
      patch.flowsById = { ...state.flowsById, [ev.flowId]: ev.flow };
      patch.flows = upsertSummary(state.flows, summarize(ev.flow));
      break;
    }
    case "flow.removed": {
      // Drop the flow from the rail + topology cache. If it was the selected
      // flow, clear the whole selection so the inspector/canvas do not deref a
      // now-missing flow (the white-screen guard: never select a deleted flow).
      const nextById = { ...state.flowsById };
      delete nextById[ev.flowId];
      patch.flowsById = nextById;
      patch.flows = state.flows.filter((s) => s.id !== ev.flowId);
      if (state.selectedFlowId === ev.flowId) {
        const fallback = patch.flows.find((f) => f.id !== ev.flowId) ?? null;
        patch.selectedFlowId = fallback ? asFlowId(fallback.id) : null;
        patch.selectedNodeId = null;
        patch.selectedEdgeId = null;
        patch.activeNodeIds = new Set<string>();
        patch.activeEdgeIds = new Set<string>();
        patch.cycle = fallback ? (state.flowsById[fallback.id]?.cycle ?? 0) : 0;
      }
      break;
    }
    case "flow.spec.changed": {
      const f = state.flowsById[ev.flowId];
      if (f) patch.flowsById = { ...state.flowsById, [ev.flowId]: { ...f, version: ev.version } };
      break;
    }
    case "flow.stateChanged": {
      const f = state.flowsById[ev.flowId];
      if (f) patch.flowsById = { ...state.flowsById, [ev.flowId]: { ...f, state: ev.state } };
      patch.flows = state.flows.map((s) => (s.id === ev.flowId ? { ...s, state: ev.state } : s));
      if (ev.flowId === state.selectedFlowId) patch.running = ev.state === "rodando";
      break;
    }
    case "cycle.started": {
      if (ev.flowId === state.selectedFlowId) patch.cycle = ev.cycle;
      patch.flows = state.flows.map((s) => (s.id === ev.flowId ? { ...s, cycle: ev.cycle } : s));
      break;
    }
    case "cycle.ended":
    case "cycle.converged":
      break;
    case "node.activated": {
      const next = new Set(state.activeNodeIds);
      next.add(ev.nodeId);
      patch.activeNodeIds = next;
      patch.runNode = { ...state.runNode, [ev.runId]: ev.nodeId };
      break;
    }
    case "node.deactivated": {
      const next = new Set(state.activeNodeIds);
      next.delete(ev.nodeId);
      patch.activeNodeIds = next;
      break;
    }
    case "edge.fired": {
      // edge.fired is a transient pulse; we keep the edge "hot" until the next
      // cycle. The render layer fades it; here we just mark it active.
      const next = new Set(state.activeEdgeIds);
      next.add(ev.edgeId);
      patch.activeEdgeIds = next;
      break;
    }
    case "run.started": {
      patch.runNode = { ...state.runNode, [ev.runId]: ev.nodeId };
      break;
    }
    case "run.finished": {
      const nodeId = state.runNode[ev.runId];
      if (nodeId) {
        // patch the most recent run for that node (if present) with status/summary
        const list = state.runsByNode[nodeId];
        if (list && list.length) {
          const updated = list.map((r) =>
            r.id === ev.runId
              ? { ...r, status: ev.status, endedAt: ev.at, resultSummary: ev.resultSummary, error: ev.error }
              : r,
          );
          patch.runsByNode = { ...state.runsByNode, [nodeId]: updated };
        }
        const nextActive = new Set(state.activeNodeIds);
        nextActive.delete(nodeId);
        patch.activeNodeIds = nextActive;
      }
      break;
    }
    case "terminal.state": {
      patch.terminals = state.terminals.map((t) =>
        t.id === ev.terminal ? { ...t, status: ev.status, meta: ev.meta } : t,
      );
      break;
    }
    case "log": {
      const entry: LogEntry = { time: fmtTime(ts), color: ev.color, msg: ev.msg };
      patch.logs = [entry, ...state.logs].slice(0, 12);
      break;
    }
    // events without a direct UI projection (run.token/run.tool/run.output/
    // trigger.fired/blackboard.write/budget.tripped/kill.requested/auth.state)
    default:
      break;
  }
  return patch;
}

function upsertSummary(list: FlowSummary[], s: FlowSummary): FlowSummary[] {
  const idx = list.findIndex((x) => x.id === s.id);
  if (idx === -1) return [...list, s];
  const copy = list.slice();
  copy[idx] = s;
  return copy;
}

/* ────────────────────────────────────────────────────────────────────────
 * Store
 * ──────────────────────────────────────────────────────────────────────── */
export const useLoomStore = create<LoomState>((set, get) => ({
  connection: "mock",
  lastSeq: 0,
  serverTime: null,

  models: MODEL_CATALOG,
  catalog: NODE_TYPE_CATALOG,

  flows: [],
  terminals: [],

  selectedFlowId: null,
  flowsById: {},

  runsByNode: {},
  nextRunByNode: {},

  activeNodeIds: new Set<string>(),
  activeEdgeIds: new Set<string>(),
  runNode: {},

  logs: [],
  cycle: 0,

  terminalData: {},

  selectedTerminalId: null,

  mode: "run",
  selectedNodeId: null,
  selectedEdgeId: null,
  theme: "light",
  zoom: 1,
  pan: { x: 0, y: 0 },
  railOpen: false,
  running: false,

  adding: false,
  draft: null,
  advOpen: false,
  typeQuery: "",

  sendCommand: () => {
    /* no-op until a transport attaches (mock mode) */
  },
  lastError: null,

  /* ── server message folding ── */
  applyServerMessage: (msg) => {
    const state = get();
    switch (msg.t) {
      case "hello": {
        const selected = state.selectedFlowId ?? (msg.flows[0] ? asFlowId(msg.flows[0].id) : null);
        set({
          connection: "live",
          serverTime: msg.serverTime,
          models: msg.models.length ? msg.models : MODEL_CATALOG,
          catalog: msg.catalog.length ? msg.catalog : NODE_TYPE_CATALOG,
          flows: msg.flows,
          terminals: msg.terminals,
          lastSeq: msg.sinceSeq,
          selectedFlowId: selected,
        });
        break;
      }
      case "flow.snapshot": {
        const flow = msg.flow;
        // Auto-select the flow if nothing is selected yet (e.g. right after the
        // user creates their first flow). Without a selection, play()/the inspector
        // have no target and silently do NOTHING — a major source of confusion.
        const autoSelect = state.selectedFlowId == null;
        const isCurrent = autoSelect || flow.id === state.selectedFlowId;
        set({
          flowsById: { ...state.flowsById, [flow.id]: flow },
          flows: upsertSummary(state.flows, summarize(flow)),
          selectedFlowId: autoSelect ? asFlowId(flow.id) : state.selectedFlowId,
          cycle: isCurrent ? flow.cycle : state.cycle,
          running: isCurrent ? flow.state === "rodando" : state.running,
        });
        break;
      }
      case "event": {
        // ordered by seq; fold idempotently and advance the cursor.
        let working = get();
        let maxSeq = working.lastSeq;
        let activeTerm: string | null = null;
        const events = [...msg.events].sort((a, b) => a.seq - b.seq);
        for (const stored of events) {
          if (stored.seq <= working.lastSeq) continue; // already folded
          const ev = stored.event;
          // Track an agent terminal going live so we can auto-open it below.
          if (
            ev.type === "terminal.state" &&
            (ev.status === "busy" || ev.status === "scribe" || ev.status === "executor")
          ) {
            activeTerm = ev.terminal;
          }
          const patch = foldEvent(working, ev, stored.ts);
          working = { ...working, ...patch } as LoomState;
          if (stored.seq > maxSeq) maxSeq = stored.seq;
        }
        set({
          flowsById: working.flowsById,
          flows: working.flows,
          runsByNode: working.runsByNode,
          activeNodeIds: working.activeNodeIds,
          activeEdgeIds: working.activeEdgeIds,
          runNode: working.runNode,
          terminals: working.terminals,
          logs: working.logs,
          cycle: working.cycle,
          running: working.running,
          // selection can change when a flow is removed (flow.removed clears it).
          selectedFlowId: working.selectedFlowId,
          selectedNodeId: working.selectedNodeId,
          selectedEdgeId: working.selectedEdgeId,
          lastSeq: maxSeq,
        });
        // Auto-open the live agent terminal so the user SEES it working, unless
        // they have already picked a terminal to watch.
        if (activeTerm && !get().selectedTerminalId) get().selectTerminal(activeTerm);
        break;
      }
      case "run.snapshot": {
        set({ runsByNode: { ...state.runsByNode, [msg.nodeId]: msg.runs } });
        break;
      }
      case "terminal.snapshot": {
        set({ terminals: msg.terminals });
        break;
      }
      case "terminal.data": {
        const prev = state.terminalData[msg.terminal] ?? "";
        set({ terminalData: { ...state.terminalData, [msg.terminal]: prev + msg.chunk } });
        break;
      }
      case "nextRun": {
        set({ nextRunByNode: { ...state.nextRunByNode, [msg.nodeId]: msg.iso } });
        break;
      }
      case "ack": {
        if (!msg.ok) set({ lastError: msg.error ?? "command failed" });
        break;
      }
      case "error": {
        set({ lastError: `${msg.code}: ${msg.message}` });
        break;
      }
    }
  },

  attachTransport: (send) => {
    set({ sendCommand: send });
  },
  setConnection: (s) => set({ connection: s }),

  /* ── command emitters ── */
  play: () => {
    const { selectedFlowId, sendCommand } = get();
    if (!selectedFlowId) return;
    set({ running: true });
    sendCommand({ t: "flow.play", cmdId: makeCmdId(), flowId: selectedFlowId });
  },
  pause: () => {
    const { selectedFlowId, sendCommand } = get();
    if (!selectedFlowId) return;
    set({ running: false });
    sendCommand({ t: "flow.pause", cmdId: makeCmdId(), flowId: selectedFlowId });
  },
  kill: () => {
    const { selectedFlowId, sendCommand } = get();
    if (!selectedFlowId) return;
    sendCommand({ t: "flow.kill", cmdId: makeCmdId(), flowId: selectedFlowId });
  },
  runNow: (triggerNodeId) => {
    const { selectedFlowId, sendCommand } = get();
    if (!selectedFlowId) return;
    sendCommand({ t: "flow.runNow", cmdId: makeCmdId(), flowId: selectedFlowId, triggerNodeId });
  },
  createFlow: (name) => {
    get().sendCommand({ t: "flow.create", cmdId: makeCmdId(), name });
  },
  deleteFlow: (flowId) => {
    const state = get();
    // Tell the engine to disarm/kill/archive + emit flow.removed (the authoritative
    // removal we fold). We ALSO remove locally and optimistically so the UI is
    // responsive and so mock mode (no engine) works. Mirrors the flow.removed fold:
    // drop from rail + cache and clear selection if it was the selected flow.
    state.sendCommand({ t: "flow.delete", cmdId: makeCmdId(), flowId });
    const nextById = { ...state.flowsById };
    delete nextById[flowId];
    const nextFlows = state.flows.filter((s) => s.id !== flowId);
    if (state.selectedFlowId === flowId) {
      const fallback = nextFlows[0] ?? null;
      set({
        flowsById: nextById,
        flows: nextFlows,
        selectedFlowId: fallback ? asFlowId(fallback.id) : null,
        selectedNodeId: null,
        selectedEdgeId: null,
        activeNodeIds: new Set<string>(),
        activeEdgeIds: new Set<string>(),
        cycle: fallback ? (nextById[fallback.id]?.cycle ?? 0) : 0,
      });
    } else {
      set({ flowsById: nextById, flows: nextFlows });
    }
  },
  saveSpec: () => {
    const { selectedFlowId, flowsById, sendCommand } = get();
    if (!selectedFlowId) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    const editable: EditableFlow = {
      id: flow.id,
      name: flow.name,
      ...(flow.workDir !== undefined ? { workDir: flow.workDir } : {}),
      nodes: flow.nodes,
      edges: flow.edges,
    };
    sendCommand({ t: "spec.save", cmdId: makeCmdId(), flow: editable });
  },
  setWorkDir: (workDir) => {
    const { selectedFlowId, flowsById } = get();
    if (!selectedFlowId) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    const trimmed = workDir.trim();
    // optimistic local patch, then persist via spec.save (which carries workDir)
    const nextFlow = { ...flow, workDir: trimmed === "" ? undefined : trimmed };
    set({ flowsById: { ...flowsById, [selectedFlowId]: nextFlow } });
    get().saveSpec();
  },
  setTrigger: (nodeId, trigger) => {
    const { selectedFlowId, sendCommand } = get();
    if (!selectedFlowId) return;
    // optimistic local patch
    get().updateNode(nodeId, { trigger, schedule: composeSchedule(trigger) });
    sendCommand({ t: "setTrigger", cmdId: makeCmdId(), flowId: selectedFlowId, nodeId, trigger });
  },
  openTerminal: (terminal) => {
    get().sendCommand({ t: "terminal.open", cmdId: makeCmdId(), terminal });
  },
  selectTerminal: (terminalId) => {
    set({ selectedTerminalId: terminalId });
    if (terminalId) {
      // arm the live tail — engine replays recentOutput then fans out live chunks
      get().sendCommand({ t: "terminal.open", cmdId: makeCmdId(), terminal: terminalId });
    }
  },
  sendTerminalInput: (terminal, data) => {
    get().sendCommand({ t: "terminal.input", cmdId: makeCmdId(), terminal, data });
  },
  subscribeNode: (nodeId) => {
    const { selectedFlowId, sendCommand } = get();
    if (!selectedFlowId) return;
    sendCommand({ t: "node.subscribe", cmdId: makeCmdId(), flowId: selectedFlowId, nodeId });
  },

  /* ── pure UI mutations ── */
  selectFlow: (flowId) => {
    const { flowsById, sendCommand, lastSeq } = get();
    const flow = flowsById[flowId];
    const firstNode = flow?.nodes[0]?.id ?? null;
    set({
      selectedFlowId: flowId,
      selectedNodeId: firstNode ? asNodeId(firstNode) : null,
      selectedEdgeId: null,
      cycle: flow?.cycle ?? 0,
      running: flow ? flow.state === "rodando" : get().running,
      // switching flows clears live overlays for the previous flow
      activeNodeIds: new Set<string>(),
      activeEdgeIds: new Set<string>(),
    });
    // ask the engine to stream this flow (resume from our cursor)
    if (get().connection === "live") sendCommand({ t: "subscribe", flowId, sinceSeq: lastSeq });
  },
  selectNode: (nodeId) => set({ selectedNodeId: nodeId, selectedEdgeId: null }),
  selectEdge: (edgeId) => {
    if (get().mode !== "edit") return; // edges only selectable in edit mode (mockup)
    set({ selectedEdgeId: edgeId, selectedNodeId: null });
  },
  clearSelection: () => set({ selectedNodeId: null, selectedEdgeId: null }),
  setMode: (mode) => set({ mode, selectedEdgeId: null }),
  toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
  setRailOpen: (open) => set({ railOpen: open }),
  setZoom: (zoom) => set({ zoom: Math.max(0.4, Math.min(2.6, zoom)) }),
  zoomBy: (delta) => get().setZoom((get().zoom || 1) + delta),
  setPan: (pan) => set({ pan }),
  resetView: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),

  /* ── local topology edits ── */
  moveNode: (nodeId, position) => {
    const { selectedFlowId, flowsById } = get();
    if (!selectedFlowId) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    const nodes = flow.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n));
    set({ flowsById: { ...flowsById, [selectedFlowId]: { ...flow, nodes } } });
  },
  addEdge: (from, to) => {
    const { selectedFlowId, flowsById } = get();
    if (!selectedFlowId || from === to) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    if (flow.edges.some((e) => e.from === from && e.to === to)) return;
    const edge: Edge = { id: asEdgeId(makeId("e_")), from, to, phase: Math.random() * 6 };
    const next: Flow = { ...flow, edges: [...flow.edges, edge] };
    set({ flowsById: { ...flowsById, [selectedFlowId]: next }, flows: upsertSummary(get().flows, summarize(next)) });
  },
  deleteEdge: (edgeId) => {
    const { selectedFlowId, flowsById } = get();
    if (!selectedFlowId) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    const next: Flow = { ...flow, edges: flow.edges.filter((e) => e.id !== edgeId) };
    set({
      flowsById: { ...flowsById, [selectedFlowId]: next },
      flows: upsertSummary(get().flows, summarize(next)),
      selectedEdgeId: null,
    });
  },
  deleteNode: (nodeId) => {
    const { selectedFlowId, flowsById } = get();
    if (!selectedFlowId) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    const node = flow.nodes.find((n) => n.id === nodeId);
    const triggerCount = flow.nodes.filter((n) => n.type === "Trigger").length;
    // a flow must keep at least one Trigger (mockup guard)
    if (node?.type === "Trigger" && triggerCount <= 1) return;
    const next: Flow = {
      ...flow,
      nodes: flow.nodes.filter((n) => n.id !== nodeId),
      edges: flow.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    };
    set({
      flowsById: { ...flowsById, [selectedFlowId]: next },
      flows: upsertSummary(get().flows, summarize(next)),
      selectedNodeId: null,
      selectedEdgeId: null,
    });
  },
  updateNode: (nodeId, patch) => {
    const { selectedFlowId, flowsById } = get();
    if (!selectedFlowId) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    const nodes = flow.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
    set({ flowsById: { ...flowsById, [selectedFlowId]: { ...flow, nodes } } });
  },

  /* ── add-agent draft ── */
  openAdd: () =>
    set({
      adding: true,
      draft: {
        type: "Analyst",
        name: "Novo agente",
        role: "Descreva o agente",
        model: DEFAULT_MODEL,
        schedule: "ao receber",
        prompt: "",
        trigger: { ...TRIGGER_DEFAULT },
      },
    }),
  closeAdd: () => set({ adding: false, draft: null }),
  setDraft: (patch) => set((s) => (s.draft ? { draft: { ...s.draft, ...patch } } : {})),
  setDraftTrigger: (patch) =>
    set((s) => (s.draft ? { draft: { ...s.draft, trigger: { ...s.draft.trigger, ...patch } } } : {})),
  pickDraftType: (type) =>
    set((s) => {
      if (!s.draft) return {};
      const name = !s.draft.name || s.draft.name === "Novo agente" ? type : s.draft.name;
      return { draft: { ...s.draft, type, name } };
    }),
  toggleAdv: () => set((s) => ({ advOpen: !s.advOpen })),
  setTypeQuery: (q) => set({ typeQuery: q }),
  createAgent: () => {
    const { selectedFlowId, flowsById, draft } = get();
    if (!selectedFlowId || !draft) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    const def = typeDef(draft.type);
    const isTrigger = draft.type === "Trigger";
    const id = asNodeId(makeId("n_"));
    const node: AgentNode = {
      id,
      type: draft.type,
      title: draft.name || "Novo agente",
      role: draft.role || "",
      model: draft.model,
      prompt: draft.prompt,
      linkedContexts: [],
      position: { x: 440 + Math.round(Math.random() * 40 - 20), y: 220 + Math.round(Math.random() * 40 - 20) },
      contextIsolation: def.semantics === "synthesizer",
      ...(isTrigger
        ? { trigger: { ...TRIGGER_DEFAULT, ...draft.trigger } }
        : { schedule: draft.schedule || "ao receber" }),
    };
    const next: Flow = { ...flow, nodes: [...flow.nodes, node] };
    set({
      flowsById: { ...flowsById, [selectedFlowId]: next },
      flows: upsertSummary(get().flows, summarize(next)),
      adding: false,
      draft: null,
      advOpen: false,
      selectedNodeId: id,
      selectedEdgeId: null,
    });
  },
}));

/* ────────────────────────────────────────────────────────────────────────
 * Selectors — the documented read API for component agents.
 * Prefer these over reaching into raw state so derived shapes stay consistent.
 * ──────────────────────────────────────────────────────────────────────── */
export const selectCurrentFlow = (s: LoomState): Flow | null =>
  s.selectedFlowId ? (s.flowsById[s.selectedFlowId] ?? null) : null;

export const selectSelectedNode = (s: LoomState): AgentNode | null => {
  const flow = selectCurrentFlow(s);
  if (!flow || !s.selectedNodeId) return null;
  return flow.nodes.find((n) => n.id === s.selectedNodeId) ?? null;
};

export const selectSelectedEdge = (s: LoomState): Edge | null => {
  const flow = selectCurrentFlow(s);
  if (!flow || !s.selectedEdgeId) return null;
  return flow.edges.find((e) => e.id === s.selectedEdgeId) ?? null;
};

/** "none" | "node" | "edge" — drives which inspector panel renders. */
export const selectInspectorKind = (s: LoomState): "none" | "node" | "edge" =>
  s.selectedEdgeId ? "edge" : s.selectedNodeId ? "node" : "none";

export const selectIsNodeActive = (s: LoomState, nodeId: string): boolean => s.activeNodeIds.has(nodeId);
export const selectIsEdgeActive = (s: LoomState, edgeId: string): boolean => s.activeEdgeIds.has(edgeId);

/**
 * Stable empty-array sentinel. zustand v5 reads selectors through
 * `useSyncExternalStore`, which BAILS WITH "Maximum update depth exceeded"
 * (an unhandled exception → white screen) if a selector returns a NEW
 * reference on every call. `s.runsByNode[nodeId] ?? []` minted a fresh `[]`
 * whenever a node had no recorded runs (e.g. an edge is selected so
 * `selectedNodeId` is null, or a brand-new node). Returning this frozen
 * singleton keeps the reference stable across renders.
 */
const EMPTY_RUNS: readonly Run[] = Object.freeze([]) as readonly Run[];
export const selectRunsForNode = (s: LoomState, nodeId: string): Run[] =>
  (s.runsByNode[nodeId] ?? (EMPTY_RUNS as Run[]));

export { TRIGGER_DEFAULT, DEFAULT_MODEL };
