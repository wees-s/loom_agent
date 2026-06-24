import type { Flow, AgentNode, Edge, Run, Terminal, FlowSummary, FlowState } from "@loom/shared";
import type { LoomState, RunMode, Theme } from "./store";

/* ════════════════════════════════════════════════════════════════════════
 * COMPONENT PROP CONTRACTS
 *
 * The 6 component agents build against these. State is owned by the zustand
 * store (store.ts); components either (a) call the documented selectors, or
 * (b) receive these props from a thin container. Keep props minimal and
 * derived — never duplicate store state into component-local state except for
 * transient input/drag buffers.
 *
 * The 6 components and their data source:
 *   1. TopBar       → store: flowName/cycle/mode/running/theme/connection + actions
 *   2. LeftRail     → store: flows/terminals/selectedFlowId + selectFlow/createFlow
 *   3. Canvas       → store: currentFlow/active*Ids/zoom/pan/mode + drag/connect/zoom
 *   4. Inspector    → store: selectInspectorKind + selectedNode/Edge + edit actions
 *   5. LogStrip     → store: logs/cycle/legend
 *   6. AddAgentPanel→ store: draft/adding/advOpen/typeQuery/catalog/models + draft actions
 * ════════════════════════════════════════════════════════════════════════ */

/* The 4 Padrões type colors, for the bottom-strip legend (mockup `legend`). */
export interface LegendItem {
  label: string;
  color: string;
}
export const LEGEND: LegendItem[] = [
  { label: "Trigger", color: "oklch(0.64 0.13 160)" },
  { label: "Analyst", color: "oklch(0.60 0.13 245)" },
  { label: "Synthesizer", color: "oklch(0.56 0.15 292)" },
  { label: "Executor", color: "oklch(0.70 0.12 65)" },
];

export interface TopBarProps {
  flowName: string;
  cycle: number;
  mode: RunMode;
  running: boolean;
  /** The selected flow's projected state — drives the honest status label
   *  (an armed-but-idle flow must NOT read as "PAUSADO"). */
  flowState?: FlowState;
  theme: Theme;
  connection: LoomState["connection"];
  /** false → no flow selected, so the run button renders disabled. */
  canRun: boolean;
  onSetMode: (mode: RunMode) => void;
  onTogglePlay: () => void;
  onToggleTheme: () => void;
  /** Persist the current topology (edit-mode "Salvar"). Without this, node/edge
   *  edits stay local and never reach the engine. */
  onSaveSpec: () => void;
}

export interface LeftRailProps {
  flows: FlowSummary[];
  terminals: Terminal[];
  selectedFlowId: string | null;
  open: boolean;
  onSelectFlow: (id: string) => void;
  onCreateFlow: () => void;
  onOpenChange: (open: boolean) => void;
}

export interface CanvasProps {
  flow: Flow | null;
  mode: RunMode;
  running: boolean;
  zoom: number;
  pan: { x: number; y: number };
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  /** live overlay sets — read with .has(id). */
  activeNodeIds: ReadonlySet<string>;
  activeEdgeIds: ReadonlySet<string>;
}

export interface InspectorProps {
  kind: "none" | "node" | "edge";
  flow: Flow | null;
  node: AgentNode | null;
  edge: Edge | null;
  runs: Run[];
  nextRunIso: string | null;
  isActive: boolean;
  mode: RunMode;
}

export interface LogStripProps {
  logs: { time: string; color: string; msg: string }[];
  cycle: number;
  legend: LegendItem[];
}

/* ════════════════════════════════════════════════════════════════════════
 * CANVAS MATH — ported VERBATIM from DCLogic (Loom.dc.html). Load-bearing:
 * the Canvas + Edge components MUST use these so the wires/pulses match the
 * mockup 1:1. Stage is a fixed 1000×540 world; nodes are 168×88.
 * ════════════════════════════════════════════════════════════════════════ */
export const NODE_W = 168;
export const NODE_H = 88;
export const STAGE_W = 1000;
export const STAGE_H = 540;

/** Default wire softness (mockup prop `wireSoftness`, default 0.6). */
export const WIRE_SOFTNESS = 0.6;

export type Anchor = "left" | "right" | "top" | "bottom";

export interface Pt {
  x: number;
  y: number;
}

/** DCLogic.anchorPt — port edge anchor on a node box at world position P. */
export function anchorPt(P: Pt, side: Anchor): Pt {
  if (side === "right") return { x: P.x + NODE_W, y: P.y + NODE_H / 2 };
  if (side === "left") return { x: P.x, y: P.y + NODE_H / 2 };
  if (side === "bottom") return { x: P.x + NODE_W / 2, y: P.y + NODE_H };
  return { x: P.x + NODE_W / 2, y: P.y };
}

export interface EdgePathParams {
  from: Pt;
  to: Pt;
  feedback?: boolean;
  phase?: number;
  /** seconds since mount (drives wobble); pass 0 for a static path. */
  t?: number;
  /** true while running & not editing → larger wobble amplitude. */
  moving?: boolean;
  softness?: number;
}

/**
 * DCLogic.edgePath — forward bezier with sag + wobble; feedback edges use
 * bottom→bottom anchors with a downward dip. Returns an SVG path "d".
 */
export function edgePath(p: EdgePathParams): string {
  const { from: A, to: B } = p;
  const soft = p.softness ?? WIRE_SOFTNESS;
  const t = p.t ?? 0;
  const phase = p.phase ?? 0;
  const wob = p.moving ? Math.sin(t * 1.1 + phase) * 8 * soft : Math.sin(t * 0.55 + phase) * 3 * soft;

  let aSide: Anchor;
  let bSide: Anchor;
  if (p.feedback) {
    aSide = "bottom";
    bSide = "bottom";
  } else {
    const ac = A.x + NODE_W / 2;
    const bc = B.x + NODE_W / 2;
    if (bc >= ac) {
      aSide = "right";
      bSide = "left";
    } else {
      aSide = "left";
      bSide = "right";
    }
  }
  const a = anchorPt(A, aSide);
  const b = anchorPt(B, bSide);

  if (p.feedback) {
    const dip = 150 * soft + 70 + wob;
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dip} ${b.x} ${b.y + dip} ${b.x} ${b.y}`;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const sag = Math.min(72, dist * 0.16) * soft + 8 + wob;
  const c1x = a.x + dx * 0.36;
  const c1y = a.y + dy * 0.12 + sag;
  const c2x = a.x + dx * 0.64;
  const c2y = b.y - dy * 0.12 + sag;
  return `M ${a.x} ${a.y} C ${c1x} ${c1y} ${c2x} ${c2y} ${b.x} ${b.y}`;
}

/** Edge color = source node's type color (DCLogic.edgeColor). */
export function edgeColor(edge: Edge, nodesById: Record<string, AgentNode>, catalogColor: (n: AgentNode) => string): string {
  const s = nodesById[edge.from];
  return s ? catalogColor(s) : "oklch(0.72 0.02 200)";
}

/** Append an alpha to an oklch(...) color string (DCLogic.alpha). */
export function withAlpha(c: string, a: number): string {
  return c.replace(")", ` / ${a})`);
}

/**
 * DCLogic.applyFit — fit scale for the stage inside the canvas viewport,
 * times the user zoom. Returns the composed scale.
 */
export function fitScale(canvasW: number, canvasH: number, zoom: number): number {
  const fit = Math.min(1.12, (canvasW - 44) / STAGE_W, (canvasH - 44) / STAGE_H);
  return fit * (zoom || 1);
}

/** Build the stage transform string (mockup applyFit). */
export function stageTransform(scale: number, pan: Pt): string {
  return `translate(-50%,-50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
}

/* ════════════════════════════════════════════════════════════════════════
 * Re-export the store selectors the components are expected to use, so an
 * agent can import contracts + selectors from one place.
 * ════════════════════════════════════════════════════════════════════════ */
export {
  useLoomStore,
  selectCurrentFlow,
  selectSelectedNode,
  selectSelectedEdge,
  selectInspectorKind,
  selectIsNodeActive,
  selectIsEdgeActive,
  selectRunsForNode,
  composeSchedule,
} from "./store";
