import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import type { InspectorProps } from "../contracts";
import type { TriggerConfig, Run } from "@loom/shared";
import { MODEL_CATALOG, typeDef } from "@loom/shared";
import {
  useLoomStore,
  selectCurrentFlow,
  selectSelectedNode,
  selectSelectedEdge,
  selectInspectorKind,
  selectRunsForNode,
  composeSchedule,
} from "../store";

/* ════════════════════════════════════════════════════════════════════════
 * Inspector — right panel (220px wide). Ports the four mutually-exclusive
 * views from Loom.dc.html (lines ~344–542) to React + the zustand store.
 *
 * Views:
 *  (a) RUN + node selected  → type/status header, Agenda, Contextos, Prompt,
 *                              Execuções recentes
 *  (b) EDIT + node selected → Nome, Função, Modelo chips, Trigger config
 *                              (for Trigger nodes) or gatilho text input,
 *                              Prompt textarea + degIn/degOut, Excluir guard
 *  (c) EDIT + edge selected → from→to + Remover
 *  (d) nothing selected     → flow counts + agents list (FLOW-INFO)
 * ════════════════════════════════════════════════════════════════════════ */

/* ─── accent / color helpers ─── */
const ACCENT = "oklch(0.62 0.14 160)";
function alpha(c: string, a: number): string {
  return c.replace(")", ` / ${a})`);
}

/* ─── section label style ─── */
const LABEL: CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 9.5,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: 8,
};

const LABEL_SM: CSSProperties = {
  ...LABEL,
  fontSize: 9,
  letterSpacing: ".06em",
  marginBottom: 6,
};

/* ─── chip builder (matches DCLogic chip()) ─── */
interface ChipStyle {
  bg: string;
  border: string;
  color: string;
}
function chipStyle(selected: boolean, col: string): ChipStyle {
  return {
    bg: selected ? alpha(col, 0.16) : "var(--fill)",
    border: selected ? alpha(col, 0.5) : "var(--line)",
    color: selected ? alpha(col, 0.95) : "var(--text3)",
  };
}

/* ─── trigger kind / freq / interval constants (mirror store TRIGGER_DEFAULT) ─── */
const TRIGGER_KINDS: Array<TriggerConfig["kind"]> = ["Agendado", "Intervalo", "Webhook", "Manual"];
const FREQS: NonNullable<TriggerConfig["freq"]>[] = ["Diário", "Dias úteis", "Semanal", "Mensal"];
const INTERVALS: NonNullable<TriggerConfig["interval"]>[] = ["30 s", "1 min", "5 min", "15 min", "1 h", "6 h"];

/* ─── run status dot color ─── */
function runDot(run: Run): string {
  switch (run.status) {
    case "ok":      return "oklch(0.64 0.13 160)";  // green
    case "running": return "oklch(0.62 0.14 160)";  // accent green
    case "error":   return "oklch(0.60 0.15 25)";   // rose/red
    case "killed":  return "oklch(0.60 0.15 25)";
    default:        return "oklch(0.72 0.02 200)";  // dim
  }
}

/* ─── run label: prefer resultSummary, else status ─── */
function runLabel(run: Run): string {
  if (run.resultSummary) return run.resultSummary;
  const map: Record<string, string> = {
    ok: "concluído",
    running: "em execução",
    error: "erro",
    killed: "interrompido",
    queued: "na fila",
    budget_exceeded: "orçamento excedido",
    timeout: "timeout",
  };
  return map[run.status] ?? run.status;
}

/* ─── run tokens label ─── */
function runTok(run: Run): string {
  const total = (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
  if (!total) return "";
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
  return String(total);
}

/* ─── run time label ─── */
function runTime(run: Run): string {
  if (!run.startedAt) return "";
  return new Date(run.startedAt).toTimeString().slice(0, 5);
}

/* ─── delete button shared style ─── */
const DEL_BTN: CSSProperties = {
  marginTop: 6,
  width: "100%",
  padding: 10,
  border: "1px solid oklch(0.7 0.12 25 / 0.4)",
  borderRadius: 10,
  background: "oklch(0.95 0.04 25 / 0.6)",
  color: "oklch(0.52 0.16 25)",
  fontFamily: "'Hanken Grotesk',sans-serif",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

/* ─── The four panel views ─── */

/** (a) RUN mode, node selected */
function RunNodeView({ node, runs, nextRunIso, isActive, flow }: InspectorProps) {
  if (!node || !flow) return null;

  const def = (() => {
    try { return typeDef(node.type); } catch { return null; }
  })();
  const typeLabel = def?.label ?? node.type;
  const typeColor = def?.color ?? "var(--muted)";

  const statusText = isActive ? "ativo agora" : "ocioso";
  const statusBg = isActive ? alpha(typeColor, 0.14) : "var(--fill)";
  const statusColor = isActive ? alpha(typeColor, 0.95) : "var(--muted)";

  const nextRunLabel = nextRunIso
    ? (() => {
        const d = new Date(nextRunIso);
        const now = Date.now();
        const diff = d.getTime() - now;
        if (diff < 0) return "passado";
        const h = Math.floor(diff / 3_600_000);
        const m = Math.floor((diff % 3_600_000) / 60_000);
        if (h > 0) return `próx. em ${h}h${m > 0 ? ` ${m}min` : ""}`;
        if (m > 0) return `próx. em ${m}min`;
        return "agora";
      })()
    : (node.type === "Trigger" ? "—" : "on-trigger");

  const schedule = node.type === "Trigger" && node.trigger
    ? composeSchedule(node.trigger)
    : (node.schedule ?? "—");

  const contexts = node.linkedContexts ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* header */}
      <div style={{ padding: "16px 16px 14px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9.5,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted2)",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: typeColor }} />
            {typeLabel}
          </span>
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9.5,
              padding: "3px 8px",
              borderRadius: 999,
              background: statusBg,
              color: statusColor,
            }}
          >
            {statusText}
          </span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.02em", color: "var(--text)" }}>
          {node.title}
        </div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 3 }}>{node.role}</div>
      </div>

      {/* body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "15px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 17,
        }}
      >
        {/* Agenda */}
        <div>
          <div style={LABEL}>Agenda</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5 }}>
            <span style={{ color: "var(--text2)", fontWeight: 500 }}>{schedule}</span>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: ACCENT }}>
              {nextRunLabel}
            </span>
          </div>
        </div>

        {/* Contextos vinculados */}
        <div>
          <div style={LABEL}>Contextos vinculados</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {contexts.length === 0 && (
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 10.5,
                  color: "var(--muted)",
                }}
              >
                —
              </span>
            )}
            {contexts.map((c) => (
              <span
                key={c}
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 10.5,
                  color: "var(--text3)",
                  background: "var(--fill)",
                  padding: "4px 9px",
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                }}
              >
                {c}
              </span>
            ))}
          </div>
        </div>

        {/* Prompt */}
        <div>
          <div style={LABEL}>Prompt</div>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11,
              lineHeight: 1.55,
              color: "var(--text2)",
              background: "var(--input)",
              border: "1px solid var(--line)",
              borderRadius: 11,
              padding: "11px 12px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {node.prompt || <span style={{ color: "var(--muted)" }}>sem prompt</span>}
          </div>
        </div>

        {/* Execuções recentes */}
        <div>
          <div style={LABEL}>Execuções recentes</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {runs.length === 0 && (
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>nenhuma execução registrada</span>
            )}
            {runs.slice(0, 6).map((r) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: runDot(r),
                    flex: "none",
                  }}
                />
                <span style={{ fontSize: 12, color: "var(--text2)", flex: 1 }}>{runLabel(r)}</span>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)" }}>
                  {runTok(r)}
                </span>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 10,
                    color: "var(--muted2)",
                    minWidth: 42,
                    textAlign: "right",
                  }}
                >
                  {runTime(r)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** (b) EDIT mode, node selected */
function EditNodeView({ node, flow }: InspectorProps) {
  const updateNode = useLoomStore((s) => s.updateNode);
  const deleteNode = useLoomStore((s) => s.deleteNode);
  const setTrigger = useLoomStore((s) => s.setTrigger);
  const models = useLoomStore((s) => s.models);

  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Keep the textarea in sync with the node prompt (per-node, not per-render)
  useEffect(() => {
    if (promptRef.current && node) {
      promptRef.current.value = node.prompt ?? "";
    }
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePromptInput = useCallback(() => {
    if (!node) return;
    updateNode(node.id, { prompt: promptRef.current?.value ?? "" });
  }, [node, updateNode]);

  if (!node || !flow) return null;

  const def = (() => {
    try { return typeDef(node.type); } catch { return null; }
  })();
  const typeLabel = def?.label ?? node.type;
  const typeColor = def?.color ?? "var(--muted)";
  const isTrigger = node.type === "Trigger";

  const triggerCount = flow.nodes.filter((n) => n.type === "Trigger").length;
  const canDelete = !(isTrigger && triggerCount <= 1);

  const etrig: TriggerConfig = node.trigger ?? { kind: "Agendado", freq: "Diário", time: "09:00", interval: "1 h", event: "" };
  const eKind = etrig.kind ?? "Agendado";

  const degIn = flow.edges.filter((e) => e.to === node.id).length;
  const degOut = flow.edges.filter((e) => e.from === node.id).length;

  const schedulePreview = composeSchedule(etrig);

  /* Trigger edit helpers */
  const editTrig = (field: keyof TriggerConfig, val: string) => {
    const next: TriggerConfig = { ...etrig, [field]: val };
    setTrigger(node.id, next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* header */}
      <div
        style={{
          padding: "16px 16px 14px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: "var(--muted2)",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: typeColor }} />
          {typeLabel}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            color: "oklch(0.5 0.1 65)",
          }}
        >
          editando
        </span>
      </div>

      {/* body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "15px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 15,
        }}
      >
        {/* Nome */}
        <div>
          <div style={LABEL}>Nome</div>
          <input
            value={node.title}
            onChange={(e) => updateNode(node.id, { title: e.target.value })}
            placeholder="Nome do agente"
            style={{
              width: "100%",
              fontFamily: "'Hanken Grotesk',sans-serif",
              fontSize: 15,
              fontWeight: 600,
              color: "var(--text)",
              background: "var(--input)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              padding: "9px 11px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Função */}
        <div>
          <div style={LABEL}>Função</div>
          <input
            value={node.role}
            onChange={(e) => updateNode(node.id, { role: e.target.value })}
            placeholder="O que este agente faz"
            style={{
              width: "100%",
              fontFamily: "'Hanken Grotesk',sans-serif",
              fontSize: 13,
              color: "var(--text2)",
              background: "var(--input)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              padding: "9px 11px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Modelo */}
        <div>
          <div style={LABEL}>Modelo</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(models.length > 0 ? models : MODEL_CATALOG).map((m) => {
              const c = chipStyle(node.model === m.id, ACCENT);
              return (
                <button
                  key={m.id}
                  onClick={() => updateNode(node.id, { model: m.id })}
                  style={{
                    padding: "6px 10px",
                    border: `1px solid ${c.border}`,
                    borderRadius: 999,
                    background: c.bg,
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 10.5,
                    color: c.color,
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Trigger config — only for Trigger nodes */}
        {isTrigger && (
          <div
            style={{
              padding: 13,
              borderRadius: 12,
              background: "oklch(0.95 0.03 160 / 0.5)",
              border: "1px solid oklch(0.8 0.06 160 / 0.4)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 9.5,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  color: "#5a7a6c",
                }}
              >
                Gatilho
              </span>
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 9,
                  color: "#fff",
                  background: "oklch(0.58 0.12 160)",
                  padding: "2px 7px",
                  borderRadius: 999,
                }}
              >
                obrigatório
              </span>
            </div>

            {/* Kind chips */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 11 }}>
              {TRIGGER_KINDS.map((k) => {
                const c = chipStyle(eKind === k, ACCENT);
                return (
                  <button
                    key={k}
                    onClick={() => editTrig("kind", k)}
                    style={{
                      padding: "6px 11px",
                      border: `1px solid ${c.border}`,
                      borderRadius: 999,
                      background: c.bg,
                      cursor: "pointer",
                      fontFamily: "'Hanken Grotesk',sans-serif",
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: c.color,
                    }}
                  >
                    {k}
                  </button>
                );
              })}
            </div>

            {/* Agendado sub-form */}
            {eKind === "Agendado" && (
              <>
                <div style={LABEL_SM}>Frequência</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                  {FREQS.map((f) => {
                    const c = chipStyle((etrig.freq ?? "Diário") === f, ACCENT);
                    return (
                      <button
                        key={f}
                        onClick={() => editTrig("freq", f)}
                        style={{
                          padding: "5px 10px",
                          border: `1px solid ${c.border}`,
                          borderRadius: 999,
                          background: c.bg,
                          cursor: "pointer",
                          fontFamily: "'Hanken Grotesk',sans-serif",
                          fontSize: 11,
                          color: c.color,
                        }}
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>
                <div style={LABEL_SM}>Horário</div>
                <input
                  defaultValue={etrig.time ?? "09:00"}
                  onBlur={(e) => editTrig("time", e.target.value)}
                  placeholder="09:00"
                  style={{
                    width: "100%",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 12,
                    color: "var(--text2)",
                    background: "var(--glass)",
                    border: "1px solid var(--line)",
                    borderRadius: 9,
                    padding: "8px 10px",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </>
            )}

            {/* Intervalo sub-form */}
            {eKind === "Intervalo" && (
              <>
                <div style={LABEL_SM}>Executar a cada</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {INTERVALS.map((i) => {
                    const c = chipStyle((etrig.interval ?? "1 h") === i, ACCENT);
                    return (
                      <button
                        key={i}
                        onClick={() => editTrig("interval", i)}
                        style={{
                          padding: "5px 10px",
                          border: `1px solid ${c.border}`,
                          borderRadius: 999,
                          background: c.bg,
                          cursor: "pointer",
                          fontFamily: "'JetBrains Mono',monospace",
                          fontSize: 11,
                          color: c.color,
                        }}
                      >
                        {i}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* Webhook sub-form */}
            {eKind === "Webhook" && (
              <>
                <div style={LABEL_SM}>Evento / endpoint</div>
                <input
                  defaultValue={etrig.event ?? ""}
                  onBlur={(e) => editTrig("event", e.target.value)}
                  placeholder="ex: github.push"
                  style={{
                    width: "100%",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 11,
                    color: "var(--text2)",
                    background: "var(--glass)",
                    border: "1px solid var(--line)",
                    borderRadius: 9,
                    padding: "8px 10px",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </>
            )}

            {/* Manual sub-form */}
            {eKind === "Manual" && (
              <div style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.4 }}>
                Disparado manualmente por você ou por outro agente.
              </div>
            )}

            {/* Schedule preview */}
            <div
              style={{
                marginTop: 11,
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 10,
                color: "#5a7a6c",
              }}
            >
              <span style={{ opacity: 0.7 }}>agenda:</span>
              <span style={{ fontWeight: 500 }}>{schedulePreview}</span>
            </div>
          </div>
        )}

        {/* Gatilho text — non-Trigger nodes */}
        {!isTrigger && (
          <div>
            <div style={LABEL}>Gatilho</div>
            <input
              value={node.schedule ?? ""}
              onChange={(e) => updateNode(node.id, { schedule: e.target.value })}
              placeholder="ex: ao receber do Scribe"
              style={{
                width: "100%",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 11,
                color: "var(--text2)",
                background: "var(--input)",
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: "9px 11px",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}

        {/* Prompt */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 7,
            }}
          >
            <span style={LABEL as CSSProperties}>Prompt</span>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, color: "var(--muted)" }}>
              {degIn} in · {degOut} out
            </span>
          </div>
          <textarea
            ref={promptRef}
            onInput={handlePromptInput}
            placeholder="Instruções completas do agente..."
            style={{
              width: "100%",
              minHeight: 170,
              resize: "vertical",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11.5,
              lineHeight: 1.6,
              color: "var(--text2)",
              background: "var(--input)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              padding: "11px 12px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Delete / guard */}
        {canDelete ? (
          <button
            onClick={() => deleteNode(node.id)}
            style={DEL_BTN}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "oklch(0.92 0.06 25 / 0.7)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "oklch(0.95 0.04 25 / 0.6)";
            }}
          >
            Excluir agente
          </button>
        ) : (
          <div
            style={{
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 12px",
              borderRadius: 10,
              background: "oklch(0.95 0.03 160 / 0.5)",
              border: "1px solid oklch(0.8 0.06 160 / 0.4)",
              fontSize: 11.5,
              color: "#5a7a6c",
              lineHeight: 1.4,
            }}
          >
            Trigger obrigatório — o fluxo precisa de ao menos um.
          </div>
        )}
      </div>
    </div>
  );
}

/** (c) EDIT mode, edge selected */
function EdgeView({ edge, flow }: InspectorProps) {
  const deleteEdge = useLoomStore((s) => s.deleteEdge);

  if (!edge || !flow) return null;

  const nodesById: Record<string, string> = {};
  flow.nodes.forEach((n) => { nodesById[n.id] = n.title; });

  const fromTitle = nodesById[edge.from] ?? "?";
  const toTitle = nodesById[edge.to] ?? "?";

  const fromDef = (() => {
    const n = flow.nodes.find((nd) => nd.id === edge.from);
    if (!n) return null;
    try { return typeDef(n.type); } catch { return null; }
  })();
  const edgeColor = fromDef?.color ?? ACCENT;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* header */}
      <div style={{ padding: "16px 16px 14px", borderBottom: "1px solid var(--line)" }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: "var(--muted2)",
          }}
        >
          Conexão
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 11 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{fromTitle}</span>
          <span style={{ color: edgeColor, fontSize: 16 }}>→</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{toTitle}</span>
        </div>
      </div>

      {/* body */}
      <div style={{ padding: "15px 16px" }}>
        <button
          onClick={() => deleteEdge(edge.id)}
          style={DEL_BTN}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "oklch(0.92 0.06 25 / 0.7)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "oklch(0.95 0.04 25 / 0.6)";
          }}
        >
          Remover conexão
        </button>
      </div>
    </div>
  );
}

/** (d) Nothing selected — flow info */
function FlowInfoView({ flow }: InspectorProps) {
  const selectNode = useLoomStore((s) => s.selectNode);
  const flows = useLoomStore((s) => s.flows);
  const selectedFlowId = useLoomStore((s) => s.selectedFlowId);
  const deleteFlow = useLoomStore((s) => s.deleteFlow);
  const setWorkDir = useLoomStore((s) => s.setWorkDir);

  if (!flow) return null;

  // Delete the whole flow (rail/inspector FLOW-INFO action). A native confirm
  // guards the destructive action; the engine ARCHIVES the YAML (never hard-rm)
  // and the store clears the selection so we never deref a deleted flow.
  const onDeleteFlow = () => {
    const name = flow.name;
    const ok = typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm(
          `Excluir o fluxo "${name}"? A spec é arquivada (recuperável), mas ele sai do app e para de rodar.`,
        )
      : true;
    if (ok) deleteFlow(flow.id);
  };

  const meta = flows.find((f) => f.id === selectedFlowId);
  const stateColor = (() => {
    const st = meta?.state ?? flow.state;
    switch (st) {
      case "rodando":  return "oklch(0.55 0.12 160)";
      case "agendado": return "#8a9c96";
      case "ocioso":   return "#9aaca6";
      case "pausado":  return "oklch(0.66 0.12 65)";
      default:         return "var(--muted)";
    }
  })();

  const schedule = meta?.schedule ?? flow.schedule ?? "—";
  const stateLabel = meta?.state ?? flow.state ?? "";

  const agentCount = flow.nodes.length;
  const connCount = flow.edges.length;
  const trigCount = flow.nodes.filter((n) => n.type === "Trigger").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* header */}
      <div style={{ padding: "16px 16px 14px", borderBottom: "1px solid var(--line)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 9,
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9.5,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted2)",
            }}
          >
            Fluxo
          </span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, color: stateColor }}>
            {stateLabel}
          </span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.02em", color: "var(--text)" }}>
          {flow.name}
        </div>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "var(--text3)", marginTop: 4 }}>
          {schedule}
        </div>
      </div>

      {/* body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "15px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* stat cards */}
        <div style={{ display: "flex", gap: 8 }}>
          {[
            { val: agentCount, label: "agentes" },
            { val: connCount, label: "conexões" },
            { val: trigCount, label: "triggers" },
          ].map(({ val, label }) => (
            <div
              key={label}
              style={{
                flex: 1,
                padding: "11px 10px",
                borderRadius: 11,
                background: "var(--fill)",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text)" }}>{val}</div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 9,
                  letterSpacing: ".05em",
                  textTransform: "uppercase",
                  color: "var(--muted)",
                  marginTop: 2,
                }}
              >
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* agents list */}
        <div>
          <div style={LABEL}>Agentes do fluxo</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {flow.nodes.map((nd) => {
              const def = (() => {
                try { return typeDef(nd.type); } catch { return null; }
              })();
              const color = def?.color ?? "var(--muted)";
              const typeLabel = def?.label ?? nd.type;
              return (
                <AgentRow
                  key={nd.id}
                  id={nd.id}
                  title={nd.title}
                  color={color}
                  typeLabel={typeLabel}
                  onSelect={() => selectNode(nd.id)}
                />
              );
            })}
          </div>
        </div>

        {/* hint */}
        <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
          Selecione um agente ou conexão no canvas para editar os detalhes. ESC ou clique no fundo
          volta para esta visão do fluxo.
        </div>

        {/* Pasta de trabalho (workDir) — agents in this flow run INSIDE this real folder. */}
        <div>
          <div style={LABEL}>Pasta de trabalho (workDir)</div>
          <input
            key={flow.id}
            data-workdir-input
            defaultValue={flow.workDir ?? ""}
            placeholder="/home/voce/projeto  ·  vazio = sandbox interna"
            spellCheck={false}
            onBlur={(e) => setWorkDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11.5,
              color: "var(--text2)",
              background: "var(--input)",
              border: "1px solid var(--line)",
              borderRadius: 9,
              padding: "8px 10px",
              outline: "none",
            }}
          />
          <div style={{ fontSize: 10.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 6 }}>
            Os agentes deste fluxo rodam <strong>dentro</strong> desta pasta (cwd + acesso a arquivos
            escopado a ela). Vazio = sandbox interna do Loom. Enter ou sair do campo salva.
          </div>
        </div>

        {/* Excluir fluxo — destructive, confirm-guarded; archives the YAML. */}
        <button
          type="button"
          data-delete-flow
          onClick={onDeleteFlow}
          style={DEL_BTN}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "oklch(0.92 0.06 25 / 0.7)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "oklch(0.95 0.04 25 / 0.6)";
          }}
        >
          Excluir fluxo
        </button>
      </div>
    </div>
  );
}

/* Agent row in flow-info — needs hover state without CSS class */
function AgentRow({
  id,
  title,
  color,
  typeLabel,
  onSelect,
}: {
  id: string;
  title: string;
  color: string;
  typeLabel: string;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "8px 10px",
        borderRadius: 10,
        cursor: "pointer",
        background: "var(--fill)",
      }}
      onMouseEnter={() => {
        if (ref.current) ref.current.style.background = "var(--line2)";
      }}
      onMouseLeave={() => {
        if (ref.current) ref.current.style.background = "var(--fill)";
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flex: "none" }} />
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 500,
          color: "var(--text2)",
          flex: 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </span>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "var(--muted)" }}>
        {typeLabel}
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Inspector — container. Pulls from the store and renders one of the four
 * views. Exported as both named + default for flexibility.
 * ════════════════════════════════════════════════════════════════════════ */
export function Inspector(_props: Partial<InspectorProps> = {}) {
  /* ── store reads ── */
  const mode = useLoomStore((s) => s.mode);
  const selectedNodeId = useLoomStore((s) => s.selectedNodeId);
  const selectedEdgeId = useLoomStore((s) => s.selectedEdgeId);
  const kind = useLoomStore(selectInspectorKind);
  const flow = useLoomStore(selectCurrentFlow);
  const node = useLoomStore(selectSelectedNode);
  const edge = useLoomStore(selectSelectedEdge);
  const runs = useLoomStore((s) => selectRunsForNode(s, selectedNodeId ?? ""));
  const nextRunIso = useLoomStore((s) =>
    selectedNodeId ? (s.nextRunByNode[selectedNodeId] ?? null) : null,
  );
  const isActive = useLoomStore((s) => (selectedNodeId ? s.activeNodeIds.has(selectedNodeId) : false));

  /* Build a unified InspectorProps object to forward down */
  const viewProps: InspectorProps = {
    kind,
    flow,
    node,
    edge,
    runs,
    nextRunIso,
    isActive,
    mode,
  };

  /* Determine which view to render */
  const showRunNode  = mode === "run"  && kind === "node";
  const showEditNode = mode === "edit" && kind === "node";
  const showEdge     = mode === "edit" && kind === "edge";
  const showFlowInfo = kind === "none";

  return (
    <div
      style={{
        width: 298,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRadius: 18,
        background: "var(--glass)",
        backdropFilter: "blur(22px) saturate(1.4)",
        WebkitBackdropFilter: "blur(22px) saturate(1.4)",
        border: "1px solid var(--glass-border)",
        boxShadow:
          "0 10px 40px -14px rgba(30,55,45,0.20),inset 0 1px 0 rgba(255,255,255,0.7)",
        overflow: "hidden",
      }}
    >
      {showRunNode  && <RunNodeView  {...viewProps} />}
      {showEditNode && <EditNodeView {...viewProps} />}
      {showEdge     && <EdgeView     {...viewProps} />}
      {showFlowInfo && <FlowInfoView {...viewProps} />}
    </div>
  );
}

export default Inspector;
