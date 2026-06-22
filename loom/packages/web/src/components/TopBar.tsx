import { useEffect, useState, type CSSProperties } from "react";
import type { TopBarProps } from "../contracts";

/* ════════════════════════════════════════════════════════════════════════
 * TopBar — glass top bar. Ported 1:1 from Loom.dc.html (lines 59-118):
 *   logo + "Loom / orquestração de agentes"
 *   flow name + "ciclo N" pill
 *   Executar / Editar segmented toggle (sets mode)
 *   status pill (EM EXECUÇÃO / PAUSADO) with animated dot   [run mode]
 *   MODO EDIÇÃO pill                                          [edit mode]
 *   play / pause accent button                               [run mode]
 *   light / dark theme toggle (sun / moon svg)
 *   live clock (updates each second)
 *
 * The store owns flowName/cycle/mode/running/theme; the only component-local
 * state is the transient ticking clock (allowed by the contract).
 * ════════════════════════════════════════════════════════════════════════ */

/* Accent is fixed Verde (hue 160) — the mockup has no `accent` prop, so
 * DCLogic.accentCol() resolves to oklch(0.62 0.14 160). */
const ACCENT = "oklch(0.62 0.14 160)";

/** DCLogic.alpha — append an alpha to an oklch(...) color string. */
function alpha(c: string, a: number): string {
  return c.replace(")", ` / ${a})`);
}

/** DCLogic.fmt — "HH:MM:SS" from a Date. */
function fmtClock(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

/* Segmented toggle button styles (DCLogic tabBase / tabOn / tabOff). */
const TAB_BASE: CSSProperties = {
  fontFamily: "'Hanken Grotesk',sans-serif",
  fontSize: 12,
  fontWeight: 600,
  padding: "6px 13px",
  border: "none",
  borderRadius: 9,
  cursor: "pointer",
  transition: "all .15s",
};
const TAB_ON: CSSProperties = {
  ...TAB_BASE,
  background: "#fff",
  color: "#1d2a28",
  boxShadow: "0 2px 8px -3px rgba(30,55,45,0.25)",
};
const TAB_OFF: CSSProperties = {
  ...TAB_BASE,
  background: "transparent",
  color: "#7a8c86",
};

export function TopBar(props: TopBarProps) {
  const { flowName, cycle, mode, running, theme, connection, canRun, onSetMode, onTogglePlay, onToggleTheme, onSaveSpec } = props;

  const edit = mode === "edit";
  const isDark = theme === "dark";

  // Engine connection indicator — makes "is the engine actually up?" visible.
  const CONN: Record<string, { c: string; t: string; pulse?: boolean }> = {
    live: { c: "oklch(0.64 0.13 160)", t: "engine online" },
    connecting: { c: "oklch(0.70 0.12 65)", t: "conectando…", pulse: true },
    reconnecting: { c: "oklch(0.70 0.12 65)", t: "reconectando…", pulse: true },
    mock: { c: "oklch(0.62 0.02 230)", t: "demo · sem engine" },
    closed: { c: "oklch(0.60 0.16 25)", t: "engine offline" },
  };
  const conn = CONN[connection] ?? { c: "oklch(0.62 0.02 230)", t: String(connection) };

  // Live clock — transient UI buffer, ticks once per second (mockup nowText).
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const accentGlow = alpha(ACCENT, 0.55);

  // Status pill (run mode) — DCLogic statusBg/Border/Dot/Text/Anim.
  const statusBg = running ? alpha(ACCENT, 0.12) : "var(--fill)";
  const statusBorder = running ? alpha(ACCENT, 0.25) : "var(--line)";
  const statusDot = running ? ACCENT : "var(--muted)";
  const statusText = running ? alpha(ACCENT, 0.95) : "#7a8c86";
  const statusLabel = running ? "EM EXECUÇÃO" : "PAUSADO";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "11px 16px 11px 14px",
        borderRadius: 18,
        background: "var(--glass)",
        backdropFilter: "blur(22px) saturate(1.4)",
        WebkitBackdropFilter: "blur(22px) saturate(1.4)",
        border: "1px solid var(--glass-border)",
        boxShadow: "0 10px 40px -14px rgba(30,55,45,0.20),inset 0 1px 0 rgba(255,255,255,0.7)",
      }}
    >
      {/* logo + wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <div
          style={{
            position: "relative",
            width: 34,
            height: 34,
            borderRadius: 11,
            background: "linear-gradient(140deg, oklch(0.66 0.14 160), oklch(0.58 0.13 175))",
            boxShadow: "0 4px 14px -4px oklch(0.62 0.14 160 / 0.6),inset 0 1px 0 rgba(255,255,255,0.4)",
            overflow: "hidden",
          }}
        >
          <svg width="34" height="34" viewBox="0 0 34 34" style={{ position: "absolute", inset: 0, opacity: 0.9 }}>
            <g stroke="rgba(255,255,255,0.55)" strokeWidth="1.2">
              <path d="M9 6 V28 M17 6 V28 M25 6 V28" />
              <path d="M6 12 H28 M6 20 H28" stroke="rgba(255,255,255,0.3)" />
            </g>
          </svg>
        </div>
        <div style={{ lineHeight: 1.15 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-.02em" }}>Loom</div>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              color: "var(--muted2)",
            }}
          >
            orquestração de agentes
          </div>
        </div>
      </div>

      <div style={{ width: 1, height: 26, background: "var(--line2)" }} />

      {/* flow name + ciclo pill */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{flowName}</span>
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 10.5,
            color: "var(--text3)",
            background: "var(--fill)",
            padding: "3px 8px",
            borderRadius: 7,
          }}
        >
          ciclo {cycle}
        </span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Executar / Editar segmented toggle */}
      <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: 12, background: "var(--fill)" }}>
        <button onClick={() => onSetMode("run")} style={!edit ? TAB_ON : TAB_OFF}>
          Executar
        </button>
        <button onClick={() => onSetMode("edit")} style={edit ? TAB_ON : TAB_OFF}>
          Editar
        </button>
      </div>

      {/* run-mode: status pill + play/pause */}
      {!edit && (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "5px 11px 5px 9px",
              borderRadius: 999,
              background: statusBg,
              border: `1px solid ${statusBorder}`,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: statusDot,
                animation: running ? "softpulse 1.8s ease-in-out infinite" : undefined,
              }}
            />
            <span
              style={{
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 10,
                letterSpacing: ".07em",
                color: statusText,
              }}
            >
              {statusLabel}
            </span>
          </div>
          <button
            onClick={onTogglePlay}
            disabled={!canRun}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 38,
              height: 38,
              border: "none",
              borderRadius: 12,
              cursor: canRun ? "pointer" : "not-allowed",
              opacity: canRun ? 1 : 0.45,
              background: canRun ? ACCENT : "var(--fill)",
              boxShadow: canRun
                ? `0 6px 18px -6px ${accentGlow},inset 0 1px 0 rgba(255,255,255,0.3)`
                : "none",
            }}
            onMouseEnter={(e) => {
              if (canRun) e.currentTarget.style.filter = "brightness(1.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = "";
            }}
            title={
              !canRun
                ? "Selecione ou crie um fluxo primeiro"
                : running
                  ? "Parar o fluxo"
                  : "Iniciar agora (executa + agenda)"
            }
          >
            {running ? (
              <svg width="14" height="14" viewBox="0 0 14 14">
                <rect x="2.5" y="2" width="3.2" height="10" rx="1" fill="#fff" />
                <rect x="8.3" y="2" width="3.2" height="10" rx="1" fill="#fff" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14">
                <path d="M3 2.2 L12 7 L3 11.8 Z" fill="#fff" />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* edit-mode: MODO EDIÇÃO pill */}
      {edit && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "5px 11px",
            borderRadius: 999,
            background: "oklch(0.93 0.04 60 / 0.6)",
            border: "1px solid oklch(0.8 0.08 60 / 0.5)",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "oklch(0.70 0.12 65)" }} />
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 10,
              letterSpacing: ".07em",
              color: "oklch(0.5 0.1 65)",
            }}
          >
            MODO EDIÇÃO
          </span>
        </div>
      )}

      {/* edit-mode: persist topology to the engine (without this, edits stay local) */}
      {edit && (
        <button
          type="button"
          onClick={onSaveSpec}
          disabled={!canRun}
          title={canRun ? "Salvar o fluxo (versiona a spec no engine)" : "Selecione um fluxo primeiro"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "7px 14px",
            border: "none",
            borderRadius: 11,
            cursor: canRun ? "pointer" : "not-allowed",
            opacity: canRun ? 1 : 0.45,
            background: ACCENT,
            color: "#fff",
            fontSize: 12.5,
            fontWeight: 600,
            boxShadow: canRun ? `0 6px 18px -6px ${accentGlow},inset 0 1px 0 rgba(255,255,255,0.3)` : "none",
          }}
          onMouseEnter={(e) => { if (canRun) e.currentTarget.style.filter = "brightness(1.06)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = ""; }}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M2 2.5h7.5L12 5v6.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5Z" stroke="#fff" strokeWidth="1.3" />
            <path d="M4.5 2.5v3h4v-3M4.5 12V8.5h5V12" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          Salvar
        </button>
      )}

      {/* engine connection indicator */}
      <div
        data-conn={connection}
        title={`Conexão com o engine: ${connection}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderRadius: 999,
          background: alpha(conn.c, 0.12),
          border: `1px solid ${alpha(conn.c, 0.28)}`,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: conn.c,
            animation: conn.pulse ? "softpulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: conn.c,
          }}
        >
          {conn.t}
        </span>
      </div>

      {/* theme toggle */}
      <button
        onClick={onToggleTheme}
        title="Alternar tema"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          border: "1px solid var(--line)",
          borderRadius: 11,
          background: "var(--fill)",
          cursor: "pointer",
          color: "var(--text2)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--line2)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--fill)";
        }}
      >
        {!isDark ? (
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M13.2 9.6A5.5 5.5 0 1 1 6.4 2.8 4.5 4.5 0 0 0 13.2 9.6Z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="3.2" fill="currentColor" />
            <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
            </g>
          </svg>
        )}
      </button>

      {/* live clock */}
      <div
        style={{
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 13,
          fontWeight: 500,
          color: "var(--text2)",
          minWidth: 74,
          textAlign: "right",
        }}
      >
        {fmtClock(now)}
      </div>
    </div>
  );
}

export default TopBar;
