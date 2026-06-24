import { type CSSProperties } from "react";
import type { LeftRailProps } from "../contracts";
import type { FlowSummary, Terminal } from "@loom/shared";
import { useLoomStore } from "../store";
import { GenerateFlow } from "./GenerateFlow";

/* ════════════════════════════════════════════════════════════════════════
 * LeftRail — collapsible glass rail.
 *
 * Collapsed (56 px): hamburger icon + per-flow color dot chips + "+" new-flow
 * Expanded (212 px, on hover): "Fluxos" header + add button; flows list with
 *   color dot, name, schedule (mono), state (colored); bottom "Terminais"
 *   section from store.terminals (term://N, meta, status dot).
 *
 * Ported 1:1 from Loom.dc.html lines 124-168 (LEFT RAIL region).
 * ════════════════════════════════════════════════════════════════════════ */

/* The accent green fixed for the selected flow highlight (DCLogic.accentCol Verde). */
const ACCENT = "oklch(0.62 0.14 160)";

function alpha(c: string, a: number): string {
  return c.replace(")", ` / ${a})`);
}

/* Map FlowState → display color (mockup flowMeta.stateColor). */
function stateColor(state: string): string {
  switch (state) {
    case "rodando":
      return "oklch(0.55 0.12 160)";
    case "pausado":
      return "oklch(0.66 0.12 65)";
    case "agendado":
      return "#8a9c96";
    case "ocioso":
      return "#9aaca6";
    case "rascunho":
      return "#9aaca6";
    default:
      return "var(--muted)";
  }
}

/* Map FlowState → dot color (type-color from the first node type in the flow;
 * for rail collapsed we use the flow's state to infer a color). */
function flowDotColor(flow: FlowSummary, isSelected: boolean): string {
  // Use accent green for selected; otherwise derive from state.
  if (isSelected) return ACCENT;
  switch (flow.state) {
    case "rodando":
      return "oklch(0.64 0.13 160)";
    case "pausado":
      return "oklch(0.70 0.12 65)";
    case "agendado":
      return "oklch(0.60 0.13 245)";
    case "ocioso":
      return "oklch(0.7 0.02 200)";
    case "rascunho":
      return "oklch(0.7 0.02 200)";
    default:
      return "oklch(0.7 0.02 200)";
  }
}

/* Map TerminalStatus → status dot color (mockup terminals array). */
function terminalDotColor(status: Terminal["status"]): string {
  switch (status) {
    case "scribe":
      return "oklch(0.64 0.13 160)";   // green
    case "executor":
      return "oklch(0.70 0.12 65)";    // amber
    case "busy":
      return "oklch(0.60 0.13 245)";   // blue
    case "idle":
    default:
      return "oklch(0.75 0.01 200)";   // near-neutral teal
  }
}

/* ── Collapsed view ──────────────────────────────────────────────────── */
interface CollapsedProps {
  flows: FlowSummary[];
  selectedFlowId: string | null;
  onSelectFlow: (id: string) => void;
  onCreateFlow: () => void;
}

function CollapsedRail({ flows, selectedFlowId, onSelectFlow, onCreateFlow }: CollapsedProps) {
  return (
    <div
      style={{
        width: 56,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 11,
        padding: "15px 0",
      }}
    >
      {/* Hamburger / list icon */}
      <div
        style={{
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--muted2)",
        }}
      >
        <svg width="15" height="15" viewBox="0 0 15 15">
          <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M3 4h9M3 7.5h9M3 11h9" />
          </g>
        </svg>
      </div>

      {/* Per-flow dot chips */}
      {flows.map((flow) => {
        const isSelected = flow.id === selectedFlowId;
        const dot = flowDotColor(flow, isSelected);
        const bg = isSelected ? alpha(ACCENT, 0.10) : "transparent";
        const border = isSelected ? alpha(ACCENT, 0.22) : "var(--line)";
        return (
          <div
            key={flow.id}
            onClick={() => onSelectFlow(flow.id)}
            title={flow.name}
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              background: bg,
              border: `1px solid ${border}`,
            }}
            onMouseEnter={(e) => {
              if (!isSelected) {
                e.currentTarget.style.background = "var(--fill)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isSelected) {
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: dot,
                boxShadow: `0 0 7px ${dot}`,
                display: "block",
              }}
            />
          </div>
        );
      })}

      {/* Add new flow (+) */}
      <div
        onClick={onCreateFlow}
        title="Novo fluxo"
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          background: "var(--fill)",
          color: "var(--text3)",
          fontSize: 16,
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--line2)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--fill)";
        }}
      >
        +
      </div>
    </div>
  );
}

/* ── Expanded view ───────────────────────────────────────────────────── */
interface ExpandedProps {
  flows: FlowSummary[];
  terminals: Terminal[];
  selectedFlowId: string | null;
  selectedTerminalId: string | null;
  onSelectFlow: (id: string) => void;
  onCreateFlow: () => void;
  onSelectTerminal: (id: string) => void;
  onDeleteFlow: (id: string, name: string) => void;
}

function ExpandedRail({ flows, terminals, selectedFlowId, selectedTerminalId, onSelectFlow, onCreateFlow, onSelectTerminal, onDeleteFlow }: ExpandedProps) {
  return (
    <div
      style={{
        width: 212,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: "15px 13px",
      }}
    >
      {/* Header row: "FLUXOS" label + add button */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 10,
            letterSpacing: ".1em",
            textTransform: "uppercase" as CSSProperties["textTransform"],
            color: "var(--muted2)",
          }}
        >
          Fluxos
        </span>
        <div
          onClick={onCreateFlow}
          title="Novo fluxo"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: 7,
            background: "var(--fill)",
            color: "var(--text3)",
            fontSize: 15,
            lineHeight: "1",
            cursor: "pointer",
            userSelect: "none",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--line2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--fill)";
          }}
        >
          +
        </div>
      </div>

      {/* Generate a flow from a natural-language description (slice C). */}
      <GenerateFlow />

      {/* Flows list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {flows.map((flow) => {
          const isSelected = flow.id === selectedFlowId;
          const dot = flowDotColor(flow, isSelected);
          const bg = isSelected ? alpha(ACCENT, 0.10) : "transparent";
          const border = isSelected ? alpha(ACCENT, 0.22) : "var(--line)";
          const sc = stateColor(flow.state);
          // flow.schedule is the pre-composed display label from the server/store.
          const scheduleDisplay = flow.schedule || "—";

          return (
            <div
              key={flow.id}
              onClick={() => onSelectFlow(flow.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 5,
                padding: "10px 11px",
                borderRadius: 12,
                cursor: "pointer",
                background: bg,
                border: `1px solid ${border}`,
                transition: "background .15s",
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = "var(--fill)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              {/* Name row: dot + name */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: dot,
                    boxShadow: `0 0 7px ${dot}`,
                    display: "block",
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--text)",
                    flex: 1,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {flow.name}
                </span>
                <button
                  type="button"
                  data-delete-flow-rail={flow.id}
                  title={`Apagar fluxo "${flow.name}"`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteFlow(flow.id, flow.name);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 20,
                    height: 20,
                    flexShrink: 0,
                    border: "none",
                    borderRadius: 6,
                    background: "transparent",
                    color: "var(--muted)",
                    cursor: "pointer",
                    padding: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "oklch(0.62 0.16 25 / 0.14)";
                    e.currentTarget.style.color = "oklch(0.55 0.18 25)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--muted)";
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 3.6h9M5.3 3.6V2.5h3.4v1.1M3.6 3.6l.5 8h5.8l.5-8M6 5.8v4M8 5.8v4" />
                  </svg>
                </button>
              </div>

              {/* Schedule + state row */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingLeft: 15,
                }}
              >
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 9.5,
                    color: "var(--muted)",
                  }}
                >
                  {scheduleDisplay}
                </span>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 9.5,
                    color: sc,
                  }}
                >
                  {flow.state}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom: Terminais section */}
      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          paddingTop: 13,
          borderTop: "1px solid var(--line)",
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 10,
            letterSpacing: ".1em",
            textTransform: "uppercase" as CSSProperties["textTransform"],
            color: "var(--muted2)",
          }}
        >
          Terminais
        </span>
        {terminals.map((t) => {
          const dot = terminalDotColor(t.status);
          const isActiveTerm = t.id === selectedTerminalId;
          return (
            <div
              key={t.id}
              data-terminal-row={t.id}
              onClick={() => onSelectTerminal(t.id)}
              title={`Abrir ${t.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 7px",
                borderRadius: 9,
                cursor: "pointer",
                background: isActiveTerm ? "oklch(0.62 0.14 160 / 0.10)" : "transparent",
                border: isActiveTerm ? "1px solid oklch(0.62 0.14 160 / 0.22)" : "1px solid transparent",
                transition: "background .12s",
              }}
              onMouseEnter={(e) => {
                if (!isActiveTerm) e.currentTarget.style.background = "var(--fill)";
              }}
              onMouseLeave={(e) => {
                if (!isActiveTerm) e.currentTarget.style.background = "transparent";
              }}
            >
              {/* Square-ish dot (border-radius:2px matches mockup's border-radius:2px for terminals) */}
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 2,
                  background: dot,
                  display: "block",
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 10.5,
                  color: "var(--text3)",
                  flex: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {t.id}
              </span>
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 9.5,
                  color: "var(--muted)",
                  flexShrink: 0,
                }}
              >
                {t.meta}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * LeftRail — the exported component.
 *
 * Can be used two ways:
 *   1. Prop-driven (container pattern): pass LeftRailProps from a thin parent.
 *   2. Self-contained: import and drop in; reads from the zustand store directly.
 *
 * We implement the self-contained pattern here as the primary export so the
 * component can be rendered without a container. The prop-driven variant is
 * also supported (the component checks for passed props vs store defaults).
 * ══════════════════════════════════════════════════════════════════════ */
export function LeftRail(props?: Partial<LeftRailProps>) {
  // Pull from the store (authoritative); allow prop overrides for testing.
  const storeFlows = useLoomStore((s) => s.flows);
  const storeTerminals = useLoomStore((s) => s.terminals);
  const storeSelectedId = useLoomStore((s) => s.selectedFlowId);
  const storeSelectedTerminalId = useLoomStore((s) => s.selectedTerminalId);
  const storeRailOpen = useLoomStore((s) => s.railOpen);
  const selectFlowAction = useLoomStore((s) => s.selectFlow);
  const createFlowAction = useLoomStore((s) => s.createFlow);
  const selectTerminalAction = useLoomStore((s) => s.selectTerminal);
  const deleteFlowAction = useLoomStore((s) => s.deleteFlow);
  const setRailOpen = useLoomStore((s) => s.setRailOpen);

  const flows = props?.flows ?? storeFlows;
  const terminals = props?.terminals ?? storeTerminals;
  const selectedFlowId = props?.selectedFlowId ?? storeSelectedId;
  const selectedTerminalId = storeSelectedTerminalId;
  const open = props?.open ?? storeRailOpen;

  const onSelectFlow = props?.onSelectFlow ?? ((id: string) => selectFlowAction(id as import("@loom/shared").FlowId));
  const onCreateFlow = props?.onCreateFlow ?? (() => createFlowAction("Novo fluxo"));
  const onOpenChange = props?.onOpenChange ?? setRailOpen;
  const onSelectTerminal = (id: string) => selectTerminalAction(id);
  const onDeleteFlow = (id: string, name: string) => {
    const ok =
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(
            `Apagar o fluxo "${name}"? Ele para de rodar e sai do app (a spec é arquivada e recuperável).`,
          )
        : true;
    if (ok) deleteFlowAction(id as import("@loom/shared").FlowId);
  };

  return (
    <div
      onMouseEnter={() => { if (!open) onOpenChange(true); }}
      onMouseLeave={() => { if (open) onOpenChange(false); }}
      style={{
        // Width transitions: 56px collapsed → 212px expanded.
        width: open ? 212 : 56,
        flexShrink: 0,
        borderRadius: 18,
        background: "var(--glass)",
        backdropFilter: "blur(22px) saturate(1.4)",
        WebkitBackdropFilter: "blur(22px) saturate(1.4)",
        border: "1px solid var(--glass-border)",
        boxShadow:
          "0 10px 40px -14px rgba(30,55,45,0.18),inset 0 1px 0 var(--card-top)",
        overflow: "hidden",
        transition: "width .28s cubic-bezier(.4,0,.2,1)",
      }}
    >
      {!open ? (
        <CollapsedRail
          flows={flows}
          selectedFlowId={selectedFlowId}
          onSelectFlow={onSelectFlow}
          onCreateFlow={onCreateFlow}
        />
      ) : (
        <ExpandedRail
          flows={flows}
          terminals={terminals}
          selectedFlowId={selectedFlowId}
          selectedTerminalId={selectedTerminalId}
          onSelectFlow={onSelectFlow}
          onCreateFlow={onCreateFlow}
          onSelectTerminal={onSelectTerminal}
          onDeleteFlow={onDeleteFlow}
        />
      )}
    </div>
  );
}

export default LeftRail;
