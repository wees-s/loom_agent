import { type CSSProperties, useMemo } from "react";
import { useLoomStore, selectStoryline } from "../store";
import type { NarrationLine, NarrationKind, NarrationTone } from "@loom/shared";

/* ════════════════════════════════════════════════════════════════════════
 * Storyline — a calm, human, live narrative of the selected flow's run.
 * Pure projection of store.storyline (folded from the event log). Grouped by
 * cycle, newest cycle first. No authoritative state of its own.
 * ════════════════════════════════════════════════════════════════════════ */

const PANEL_STYLE: CSSProperties = {
  width: 300,
  flex: "none",
  display: "flex",
  flexDirection: "column",
  borderRadius: 15,
  background: "var(--glass)",
  backdropFilter: "blur(22px) saturate(1.4)",
  WebkitBackdropFilter: "blur(22px) saturate(1.4)",
  border: "1px solid var(--glass-border)",
  boxShadow: "0 10px 40px -16px rgba(30,55,45,0.18),inset 0 1px 0 rgba(255,255,255,0.7)",
  overflow: "hidden",
};

const HEADER_STYLE: CSSProperties = {
  padding: "11px 15px",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: "-.01em",
  color: "var(--text)",
  borderBottom: "1px solid var(--line2)",
};

const FEED_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "8px 12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const CYCLE_HEADER_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10.5,
  color: "var(--muted2)",
  margin: "12px 0 4px",
};

const TONE_DOT: Record<NarrationTone, string> = {
  neutral: "var(--line2)",
  good: "oklch(0.62 0.14 160)",
  warn: "oklch(0.78 0.13 80)",
  bad: "oklch(0.62 0.18 25)",
};

const KIND_ICON: Record<NarrationKind, string> = {
  trigger: "⚡", agent: "●", artifact: "✎", cycle: "↻", budget: "⚠", kill: "■", system: "·",
};

function relTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m}min`;
  return `há ${Math.round(m / 60)}h`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} kB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function Line({ line }: { line: NarrationLine }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5, lineHeight: 1.45 }}>
      <span style={{ color: TONE_DOT[line.tone], flex: "none", fontSize: 11 }}>{KIND_ICON[line.kind]}</span>
      <span style={{ flex: 1, minWidth: 0, color: "var(--text2)" }}>
        {line.actor && <strong style={{ color: "var(--text)" }}>{line.actor} </strong>}
        {line.text}
        {line.artifact && (
          <span style={{ marginLeft: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "var(--muted)" }}>
            {line.artifact.path}
            {typeof line.artifact.bytes === "number" ? ` · ${formatBytes(line.artifact.bytes)}` : ""}
          </span>
        )}
      </span>
      <span style={{ flex: "none", fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: "var(--muted)" }}>
        {relTime(line.at)}
      </span>
    </div>
  );
}

export function Storyline() {
  const storyline = useLoomStore(selectStoryline);
  const open = useLoomStore((s) => s.storylineOpen);
  const continueFlow = useLoomStore((s) => s.continue);
  const stopFlow = useLoomStore((s) => s.kill);
  const awaiting = useLoomStore((s) => {
    const f = s.selectedFlowId ? s.flowsById[s.selectedFlowId] : undefined;
    return f?.state === "aguardando";
  });

  // Group by cycle, newest cycle first (lines within a cycle stay chronological).
  const groups = useMemo(() => {
    const byCycle = new Map<number, NarrationLine[]>();
    for (const l of storyline) {
      const arr = byCycle.get(l.cycle);
      if (arr) arr.push(l);
      else byCycle.set(l.cycle, [l]);
    }
    return [...byCycle.entries()].sort((a, b) => b[0] - a[0]);
  }, [storyline]);

  if (!open) return null;

  return (
    <div style={PANEL_STYLE} data-storyline>
      <div style={HEADER_STYLE}>Storyline</div>
      {awaiting && (
        <div data-approval-banner style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8, background: "oklch(0.95 0.05 80 / 0.5)", borderBottom: "1px solid var(--line2)" }}>
          <span style={{ fontSize: 12.5, color: "var(--text)" }}>Ciclo concluído — aguardando sua aprovação para continuar.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => continueFlow()} style={{ flex: 1, padding: "7px 10px", border: "none", borderRadius: 9, background: "oklch(0.62 0.14 160)", color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Continuar ▶</button>
            <button type="button" onClick={() => stopFlow()} style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--line2)", borderRadius: 9, background: "transparent", color: "var(--text2)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Parar ■</button>
          </div>
        </div>
      )}
      <div style={FEED_STYLE}>
        {storyline.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 12.5, padding: "20px 4px", lineHeight: 1.5 }}>
            Nada rolando ainda — aperte ▶ para começar e acompanhe aqui o que cada agente faz.
          </div>
        ) : (
          groups.map(([cycle, lines]) => (
            <div key={cycle}>
              <div style={CYCLE_HEADER_STYLE}>{cycle > 0 ? `Ciclo ${cycle}` : "Início"}</div>
              {lines.map((l) => (
                <Line key={l.id} line={l} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default Storyline;
