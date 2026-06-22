import {
  useRef,
  useEffect,
  useCallback,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AgentNode, Edge } from "@loom/shared";
import { typeDef } from "@loom/shared";
import type { CanvasProps } from "../contracts";
import {
  NODE_W,
  NODE_H,
  edgePath,
  withAlpha,
  fitScale,
  stageTransform,
  anchorPt,
} from "../contracts";
import {
  useLoomStore,
  selectCurrentFlow,
} from "../store";

/* ════════════════════════════════════════════════════════════════════════
 * CanvasGraph — the main orchestration canvas, ported 1:1 from Loom.dc.html.
 *
 * Layout (mockup lines 171-339):
 *   • glass card container with dotted-grid + radial-vignette background
 *   • data-stage div (1000×540 world, fit-scaled + pan)
 *     – SVG edge layer: bezier paths (forward + feedback), traveling pulses
 *     – data-temp SVG path (drag-connect ghost)
 *     – Node glass cards (type dot, title, role, meta badge, port handle in edit)
 *   • "Adicionar agente" button overlay (edit mode)
 *   • Bottom-left canvas hint
 *   • Bottom-right zoom controls
 *
 * Animation is driven by requestAnimationFrame (tick), ported verbatim from
 * the mockup's DCLogic.tick() + edgePath() + anchorPt().
 *
 * The zustand store is the single source of truth; this component reads state
 * and dispatches store actions. It does NOT own node positions (store owns them
 * via moveNode), zoom/pan (store owns via setZoom/setPan), or selection.
 * ════════════════════════════════════════════════════════════════════════ */

/* ── Type color helper ─────────────────────────────────────────────────── */
function nodeColor(node: AgentNode): string {
  try {
    return typeDef(node.type).color;
  } catch {
    return "oklch(0.72 0.02 200)";
  }
}

function nodeTypeLabel(node: AgentNode): string {
  try {
    return typeDef(node.type).label;
  } catch {
    return node.type;
  }
}

function edgeSourceColor(edge: Edge, nodesById: Record<string, AgentNode>): string {
  const src = nodesById[edge.from];
  return src ? nodeColor(src) : "var(--edge-idle)";
}

/* ── Accent (always Verde, same as TopBar) ─────────────────────────────── */
const ACCENT = "oklch(0.62 0.14 160)";

/* ════════════════════════════════════════════════════════════════════════
 * CanvasGraph component
 * ════════════════════════════════════════════════════════════════════════ */
export function CanvasGraph(props: CanvasProps) {
  const {
    flow,
    mode,
    running,
    zoom,
    pan,
    selectedNodeId,
    selectedEdgeId,
    activeNodeIds,
    activeEdgeIds,
  } = props;

  const edit = mode === "edit";

  /* Store actions */
  const selectNode = useLoomStore((s) => s.selectNode);
  const selectEdge = useLoomStore((s) => s.selectEdge);
  const clearSelection = useLoomStore((s) => s.clearSelection);
  const moveNode = useLoomStore((s) => s.moveNode);
  const addEdge = useLoomStore((s) => s.addEdge);
  const setZoom = useLoomStore((s) => s.setZoom);
  const setPan = useLoomStore((s) => s.setPan);

  /* DOM refs */
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tempPathRef = useRef<SVGPathElement>(null);

  /* Mutable animation refs (not state — avoids re-renders in RAF) */
  const t0Ref = useRef<number>(performance.now());
  const scaleRef = useRef<number>(1);
  const rafRef = useRef<number>(0);

  /* Drag-move state (mutable ref, pointer events) */
  const dragRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  /* Pan state */
  const panningRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  /* Drag-connect state */
  const connectRef = useRef<{ from: string } | null>(null);

  /* ── applyFit — matches mockup DCLogic.applyFit() ─────────────────────── */
  const applyFit = useCallback(() => {
    const cont = containerRef.current;
    const stage = stageRef.current;
    if (!cont || !stage || !cont.clientWidth) return;
    const s = fitScale(cont.clientWidth, cont.clientHeight, zoom);
    scaleRef.current = s;
    const currentPan = useLoomStore.getState().pan;
    stage.style.transform = stageTransform(s, currentPan);
  }, [zoom]);

  /* ── toStage — client coords → stage coords (accounts for fit scale) ──── */
  const toStage = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const r = stage.getBoundingClientRect();
    const s = scaleRef.current || 1;
    return { x: (clientX - r.left) / s, y: (clientY - r.top) / s };
  }, []);

  /* ── hitNode — find which node (if any) contains the pointer ──────────── */
  const hitNode = useCallback((clientX: number, clientY: number, exclude?: string): string | null => {
    const f = useLoomStore.getState();
    const currentFlow = selectCurrentFlow(f);
    if (!currentFlow) return null;
    const { x, y } = toStage(clientX, clientY);
    for (const n of currentFlow.nodes) {
      if (n.id === exclude) continue;
      const p = n.position;
      if (x >= p.x && x <= p.x + NODE_W && y >= p.y && y <= p.y + NODE_H) {
        return n.id;
      }
    }
    return null;
  }, [toStage]);

  /* ── RAF tick — matches mockup DCLogic.tick() ─────────────────────────── */
  const tick = useCallback(() => {
    const t = (performance.now() - t0Ref.current) / 1000;
    const s = useLoomStore.getState();
    const currentFlow = selectCurrentFlow(s);
    applyFit();

    if (currentFlow && svgRef.current) {
      const nodesById: Record<string, AgentNode> = {};
      for (const n of currentFlow.nodes) nodesById[n.id] = n;
      const isMoving = s.running && !s.mode.startsWith("edit");

      /* ── edge paths + strokes ─────────────────────────────────────────── */
      for (const edge of currentFlow.edges) {
        const pathEl = svgRef.current.querySelector<SVGPathElement>(`[data-edge="${edge.id}"]`);
        if (!pathEl) continue;

        const fromNode = nodesById[edge.from];
        const toNode = nodesById[edge.to];
        if (!fromNode || !toNode) continue;

        const d = edgePath({
          from: fromNode.position,
          to: toNode.position,
          feedback: edge.feedback,
          phase: edge.phase ?? 0,
          t,
          moving: isMoving,
        });
        pathEl.setAttribute("d", d);

        const col = edgeSourceColor(edge, nodesById);
        const isActive = s.activeEdgeIds.has(edge.id);
        const isSel = edge.id === s.selectedEdgeId;

        pathEl.style.stroke = isSel ? ACCENT : isActive ? col : "var(--edge-idle)";
        pathEl.setAttribute("stroke-width", isSel ? "3.2" : isActive ? "2.6" : "1.4");
        pathEl.style.opacity = isSel ? "1" : isActive ? "0.95" : "0.42";
        pathEl.style.filter = isActive ? `drop-shadow(0 0 6px ${withAlpha(col, 0.7)})` : "none";
      }

      /* ── pulse circles ────────────────────────────────────────────────── */
      svgRef.current.querySelectorAll<SVGCircleElement>("[data-pulse-edge]").forEach((c) => {
        const eid = c.getAttribute("data-pulse-edge")!;
        const pathEl = svgRef.current!.querySelector<SVGPathElement>(`[data-edge="${eid}"]`);
        if (!pathEl) { c.style.opacity = "0"; return; }

        const edge = currentFlow.edges.find((e) => e.id === eid);
        if (!edge) { c.style.opacity = "0"; return; }

        const fromNode = nodesById[edge.from];
        if (!fromNode) { c.style.opacity = "0"; return; }
        const col = edgeSourceColor(edge, nodesById);
        const k = parseFloat(c.getAttribute("data-pulse-k") ?? "0");
        const isActive = s.activeEdgeIds.has(eid);
        const len = pathEl.getTotalLength();
        const pct = ((isMoving ? t * 0.26 : t * 0.05) + k + (edge.phase ?? 0) * 0.12) % 1;
        const pt = pathEl.getPointAtLength(len * pct);
        c.setAttribute("cx", String(pt.x));
        c.setAttribute("cy", String(pt.y));
        c.setAttribute("fill", col);
        const tw = 0.6 + 0.4 * Math.sin(t * 3 + pct * 6);
        c.setAttribute("r", isActive ? "4.3" : "2.4");
        c.style.opacity = isActive ? String(tw) : "0.2";
        c.style.filter = isActive ? `drop-shadow(0 0 6px ${col})` : "none";
      });

      /* ── node card glow + float ───────────────────────────────────────── */
      for (const node of currentFlow.nodes) {
        const el = stageRef.current?.querySelector<HTMLDivElement>(`[data-node="${node.id}"]`);
        if (!el) continue;

        const p = node.position;
        const isActive = s.activeNodeIds.has(node.id);
        const mv = isActive && s.running && s.mode !== "edit";
        const phase = (node as AgentNode & { phase?: number }).phase ?? 0;
        const dy = mv ? Math.sin(t * 1.3 + phase) * 3 : 0;
        const dx = mv ? Math.cos(t * 1.0 + phase) * 2 : 0;
        el.style.transform = `translate(${p.x + dx}px, ${p.y + dy}px)`;

        const col = nodeColor(node);
        let bs: string;
        let bc: string;
        if (isActive) {
          const gl = 0.5 + 0.5 * Math.sin(t * 2.4 + phase);
          bs = `0 0 0 1px ${withAlpha(col, 0.55)}, 0 12px 34px -8px ${withAlpha(col, 0.45)}, 0 0 ${22 + gl * 26}px ${withAlpha(col, 0.18 + gl * 0.18)}`;
          bc = withAlpha(col, 0.6);
        } else {
          bs = "0 8px 24px -10px var(--shadow), inset 0 1px 0 var(--card-top)";
          bc = "var(--glass-border)";
        }
        if (node.id === s.selectedNodeId) {
          bs += `, 0 0 0 2px ${ACCENT}`;
        }
        el.style.boxShadow = bs;
        el.style.borderColor = bc;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFit]);

  /* ── Lifecycle: mount + unmount ─────────────────────────────────────────── */
  useEffect(() => {
    t0Ref.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    applyFit();

    const cont = containerRef.current;
    if (!cont) return;

    /* Wheel → zoom (mockup DCLogic.onWheel) */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = -e.deltaY * 0.0015;
      const cur = useLoomStore.getState().zoom || 1;
      setZoom(cur + d * cur);
    };

    /* ResizeObserver → applyFit */
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => applyFit());
      ro.observe(cont);
    }
    const onResize = () => applyFit();
    window.addEventListener("resize", onResize);
    cont.addEventListener("wheel", onWheel, { passive: false });

    /* Keyboard — Escape clears selection */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      cont.removeEventListener("wheel", onWheel);
      if (ro) ro.disconnect();
      window.removeEventListener("pointermove", onPanMove);
      window.removeEventListener("pointerup", onPanUp);
      window.removeEventListener("pointermove", onConnMove);
      window.removeEventListener("pointerup", onConnUp);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, applyFit]);

  /* Re-apply fit when zoom/pan changes */
  useEffect(() => { applyFit(); }, [applyFit, zoom, pan]);

  /* ── Pan handlers (background drag) ──────────────────────────────────── */
  const onPanMove = useCallback((e: PointerEvent) => {
    if (!panningRef.current) return;
    const { x, y, px, py } = panningRef.current;
    setPan({ x: px + (e.clientX - x), y: py + (e.clientY - y) });
  }, [setPan]);

  const onPanUp = useCallback(() => {
    panningRef.current = null;
    window.removeEventListener("pointermove", onPanMove);
    window.removeEventListener("pointerup", onPanUp);
  }, [onPanMove]);

  const handleCanvasPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    /* Only pan if clicking on background (canvas, stage, or svg) */
    const ok =
      target === containerRef.current ||
      target === stageRef.current ||
      target.tagName === "svg" ||
      target.hasAttribute("data-canvas-bg");
    if (!ok) return;
    clearSelection();
    const cur = useLoomStore.getState().pan;
    panningRef.current = { x: e.clientX, y: e.clientY, px: cur.x, py: cur.y };
    window.addEventListener("pointermove", onPanMove);
    window.addEventListener("pointerup", onPanUp);
  }, [clearSelection, onPanMove, onPanUp]);

  /* ── Node drag handlers ───────────────────────────────────────────────── */
  const onDragMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return;
    const { id, ox, oy } = dragRef.current;
    const { x, y } = toStage(e.clientX, e.clientY);
    const nx = Math.max(-1600, Math.min(1000 + 1600, x - ox));
    const ny = Math.max(-1600, Math.min(540 + 1600, y - oy));
    moveNode(id as import("@loom/shared").NodeId, { x: nx, y: ny });
  }, [toStage, moveNode]);

  const onDragUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragUp);
  }, [onDragMove]);

  const handleNodePointerDown = useCallback((nodeId: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    selectNode(nodeId as import("@loom/shared").NodeId);
    const { x, y } = toStage(e.clientX, e.clientY);
    const f = useLoomStore.getState();
    const currentFlow = selectCurrentFlow(f);
    const node = currentFlow?.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const p = node.position;
    dragRef.current = { id: nodeId, ox: x - p.x, oy: y - p.y };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  }, [selectNode, toStage, onDragMove, onDragUp]);

  /* ── Port drag (drag-to-connect, edit mode) ────────────────────────────── */
  const onConnMove = useCallback((e: PointerEvent) => {
    if (!connectRef.current) return;
    const f = useLoomStore.getState();
    const currentFlow = selectCurrentFlow(f);
    if (!currentFlow) return;
    const fromNode = currentFlow.nodes.find((n) => n.id === connectRef.current!.from);
    if (!fromNode) return;
    const { x, y } = toStage(e.clientX, e.clientY);
    const a = anchorPt(fromNode.position, "right");
    const dx = x - a.x;
    const tmp = tempPathRef.current;
    if (tmp) {
      tmp.setAttribute(
        "d",
        `M ${a.x} ${a.y} C ${a.x + dx * 0.5} ${a.y} ${x - dx * 0.5} ${y} ${x} ${y}`,
      );
      tmp.style.display = "";
    }
  }, [toStage]);

  const onConnUp = useCallback((e: PointerEvent) => {
    const tmp = tempPathRef.current;
    if (tmp) tmp.style.display = "none";
    const target = hitNode(e.clientX, e.clientY, connectRef.current?.from);
    if (connectRef.current && target) {
      addEdge(
        connectRef.current.from as import("@loom/shared").NodeId,
        target as import("@loom/shared").NodeId,
      );
    }
    connectRef.current = null;
    window.removeEventListener("pointermove", onConnMove);
    window.removeEventListener("pointerup", onConnUp);
  }, [hitNode, addEdge, onConnMove]);

  const handlePortPointerDown = useCallback((nodeId: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    connectRef.current = { from: nodeId };
    window.addEventListener("pointermove", onConnMove);
    window.addEventListener("pointerup", onConnUp);
  }, [onConnMove, onConnUp]);

  /* ── Edge click (edit mode) ─────────────────────────────────────────────── */
  const handleEdgeClick = useCallback((edgeId: string) => () => {
    if (!edit) return;
    selectEdge(edgeId as import("@loom/shared").EdgeId);
  }, [edit, selectEdge]);

  /* ── Build nodes + edges data for render ───────────────────────────────── */
  const nodes = flow?.nodes ?? [];
  const edges = flow?.edges ?? [];

  const nodesById: Record<string, AgentNode> = {};
  for (const n of nodes) nodesById[n.id] = n;

  /* ── Styles ─────────────────────────────────────────────────────────────── */
  const containerStyle: CSSProperties = {
    position: "relative",
    flex: 1,
    minWidth: 0,
    borderRadius: 20,
    overflow: "hidden",
    background: "var(--canvas-bg)",
    backdropFilter: "blur(10px) saturate(1.2)",
    WebkitBackdropFilter: "blur(10px) saturate(1.2)",
    border: "1px solid var(--glass-border)",
    boxShadow: "0 14px 50px -18px rgba(30,55,45,0.22),inset 0 1px 0 rgba(255,255,255,0.6)",
    cursor: edit ? "default" : "default",
  };

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      onPointerDown={handleCanvasPointerDown}
    >
      {/* Dotted grid background */}
      <div
        data-canvas-bg
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(circle, var(--grid) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          pointerEvents: "none",
        }}
      />

      {/* Radial vignette */}
      <div
        data-canvas-bg
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(60% 60% at 50% 45%, transparent 50%, var(--canvas-vignette) 100%)",
          pointerEvents: "none",
        }}
      />

      {/* Stage (1000×540 world) */}
      <div
        ref={stageRef}
        data-stage
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 1000,
          height: 540,
          transform: "translate(-50%,-50%)",
        }}
      >
        {/* SVG edge layer */}
        <svg
          ref={svgRef}
          width="1000"
          height="540"
          viewBox="0 0 1000 540"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            overflow: "visible",
            pointerEvents: edit ? "auto" : "none",
          }}
        >
          {/* Edges */}
          {edges.map((edge) => {
            const fromNode = nodesById[edge.from];
            const toNode = nodesById[edge.to];
            if (!fromNode || !toNode) return null;
            const d = edgePath({
              from: fromNode.position,
              to: toNode.position,
              feedback: edge.feedback,
              phase: edge.phase ?? 0,
              t: 0,
              moving: false,
            });
            return (
              <path
                key={edge.id}
                data-edge={edge.id}
                d={d}
                onClick={handleEdgeClick(edge.id)}
                fill="none"
                stroke="var(--edge-idle)"
                strokeWidth="1.4"
                strokeLinecap="round"
                style={{
                  opacity: 0.42,
                  pointerEvents: edit ? "stroke" : "none",
                  cursor: "pointer",
                  transition: "opacity 0.2s",
                }}
              />
            );
          })}

          {/* Drag-connect ghost path */}
          <path
            ref={tempPathRef}
            data-temp
            d=""
            fill="none"
            stroke={ACCENT}
            strokeWidth="2.4"
            strokeDasharray="5 5"
            strokeLinecap="round"
            style={{ display: "none", opacity: 0.85, pointerEvents: "none" }}
          />

          {/* Pulse circles — 2 per edge, at k=0 and k=0.5 */}
          {edges.flatMap((edge) => {
            const fromNode = nodesById[edge.from];
            if (!fromNode) return [];
            const col = edgeSourceColor(edge, nodesById);
            return [0.0, 0.5].map((k) => (
              <circle
                key={`${edge.id}-${k}`}
                data-pulse-edge={edge.id}
                data-pulse-k={k}
                cx="0"
                cy="0"
                r="2.6"
                fill={col}
                style={{ opacity: 0.2, pointerEvents: "none" }}
              />
            ));
          })}
        </svg>

        {/* Node glass cards */}
        {nodes.map((node) => {
          const color = nodeColor(node);
          const typeLabel = nodeTypeLabel(node);
          const isActive = activeNodeIds.has(node.id);
          const isSel = node.id === selectedNodeId;
          const p = node.position;

          /* schedule/meta badge: show trigger schedule for Trigger nodes,
             schedule text for others (in run mode only) */
          const metaText = node.type === "Trigger"
            ? (node.trigger
                ? `${node.trigger.kind === "Agendado" ? (node.trigger.freq ?? "Diário") + " · " + (node.trigger.time ?? "09:00") : node.trigger.kind === "Intervalo" ? "a cada " + (node.trigger.interval ?? "1 h") : node.trigger.kind === "Webhook" ? "webhook · " + (node.trigger.event || "evento") : "manual"}`
                : null)
            : (node.schedule ?? null);
          const showMeta = !edit && !!metaText;

          return (
            <div
              key={node.id}
              data-node={node.id}
              onPointerDown={handleNodePointerDown(node.id)}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: NODE_W,
                transform: `translate(${p.x}px, ${p.y}px)`,
                display: "flex",
                flexDirection: "column",
                gap: 5,
                padding: "11px 13px",
                borderRadius: 16,
                cursor: "grab",
                userSelect: "none",
                background: "var(--glass)",
                backdropFilter: "blur(12px) saturate(1.3)",
                WebkitBackdropFilter: "blur(12px) saturate(1.3)",
                border: `1px solid ${isSel ? ACCENT : isActive ? withAlpha(color, 0.6) : "var(--glass-border)"}`,
                boxShadow: isActive
                  ? `0 0 0 1px ${withAlpha(color, 0.55)}, 0 12px 34px -8px ${withAlpha(color, 0.45)}, 0 0 28px ${withAlpha(color, 0.24)}`
                  : `0 8px 24px -10px var(--shadow), inset 0 1px 0 var(--card-top)`,
                transition: "box-shadow 0.25s, border-color 0.25s",
              }}
            >
              {/* Type dot + label */}
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: color,
                    boxShadow: `0 0 9px ${color}`,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 9,
                    letterSpacing: ".07em",
                    textTransform: "uppercase",
                    color: "var(--muted2)",
                  }}
                >
                  {typeLabel}
                </span>
              </div>

              {/* Title */}
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  letterSpacing: "-.01em",
                  color: "var(--text)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {node.title}
              </div>

              {/* Role */}
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text3)",
                  lineHeight: 1.3,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {node.role}
              </div>

              {/* Meta badge (schedule / trigger info) */}
              {showMeta && (
                <div
                  style={{
                    marginTop: 3,
                    alignSelf: "flex-start",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 9.5,
                    color: "oklch(0.5 0.10 160)",
                    background: "oklch(0.92 0.05 160 / 0.6)",
                    padding: "3px 8px",
                    borderRadius: 999,
                    letterSpacing: ".02em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "100%",
                  }}
                >
                  {metaText}
                </div>
              )}

              {/* Port handle (edit mode) */}
              {edit && (
                <div
                  onPointerDown={handlePortPointerDown(node.id)}
                  title="arraste para conectar"
                  style={{
                    position: "absolute",
                    right: -7,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 15,
                    height: 15,
                    borderRadius: "50%",
                    background: "#fff",
                    border: `2.5px solid ${color}`,
                    cursor: "crosshair",
                    boxShadow: "0 1px 5px rgba(0,0,0,.18)",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}

/* ── Container component — pulls store props and renders CanvasGraph ─────── */
export function CanvasGraphContainer() {
  const flow = useLoomStore(selectCurrentFlow);
  const mode = useLoomStore((s) => s.mode);
  const running = useLoomStore((s) => s.running);
  const zoom = useLoomStore((s) => s.zoom);
  const pan = useLoomStore((s) => s.pan);
  const selectedNodeId = useLoomStore((s) => s.selectedNodeId);
  const selectedEdgeId = useLoomStore((s) => s.selectedEdgeId);
  const activeNodeIds = useLoomStore((s) => s.activeNodeIds);
  const activeEdgeIds = useLoomStore((s) => s.activeEdgeIds);

  return (
    <CanvasGraph
      flow={flow}
      mode={mode}
      running={running}
      zoom={zoom}
      pan={pan}
      selectedNodeId={selectedNodeId}
      selectedEdgeId={selectedEdgeId}
      activeNodeIds={activeNodeIds}
      activeEdgeIds={activeEdgeIds}
    />
  );
}

export default CanvasGraph;
