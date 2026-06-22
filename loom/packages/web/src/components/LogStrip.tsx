import { type CSSProperties } from "react";
import { useLoomStore } from "../store";
import { LEGEND } from "../contracts";
import type { LogStripProps } from "../contracts";

/* ════════════════════════════════════════════════════════════════════════
 * LogStrip — bottom glass strip. Ported 1:1 from Loom.dc.html lines 546–567:
 *   type legend (Trigger/Analyst/Synthesizer/Executor) with square dots
 *   vertical divider
 *   horizontally-scrolling live log: time mono · color dot · msg mono
 *     with left-fade mask at 88% (webkit-mask-image)
 *   "N ciclos · M execuções" counter (mono, right-pinned)
 *
 * Connects directly to the zustand store (logs + cycle).
 * Props are accepted for container-driven usage (matches LogStripProps
 * from contracts.ts) but the component is also self-sufficient via the
 * store when rendered without explicit props.
 *
 * The scroll container auto-scrolls to show the newest entry (left edge)
 * since entries are prepended (newest-first from store.logs).
 * ════════════════════════════════════════════════════════════════════════ */

/* ── container ──────────────────────────────────────────────────────── */
const STRIP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "9px 16px",
  borderRadius: 15,
  background: "var(--glass)",
  backdropFilter: "blur(22px) saturate(1.4)",
  WebkitBackdropFilter: "blur(22px) saturate(1.4)",
  border: "1px solid var(--glass-border)",
  boxShadow:
    "0 10px 40px -16px rgba(30,55,45,0.18),inset 0 1px 0 rgba(255,255,255,0.7)",
};

/* ── legend cluster ─────────────────────────────────────────────────── */
const LEGEND_CLUSTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 13,
  flex: "none",
};

const LEGEND_ITEM_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

/* ── divider ────────────────────────────────────────────────────────── */
const DIVIDER_STYLE: CSSProperties = {
  width: 1,
  height: 20,
  background: "var(--line2)",
  flex: "none",
};

/* ── scrolling log area ─────────────────────────────────────────────── */
const LOG_AREA_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 18,
  overflow: "hidden",
  /* Left-fade mask: content visible on left, fades to transparent on right
   * (mockup uses 90deg gradient so #000 side = left = newest entries first). */
  WebkitMaskImage: "linear-gradient(90deg, #000 88%, transparent)",
  maskImage: "linear-gradient(90deg, #000 88%, transparent)",
};

/* ── individual log entry ───────────────────────────────────────────── */
const LOG_ENTRY_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flex: "none",
};

const LOG_TIME_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10,
  color: "var(--muted)",
};

const LOG_MSG_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  color: "var(--text2)",
  whiteSpace: "nowrap",
};

/* ── counter ────────────────────────────────────────────────────────── */
const COUNTER_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10.5,
  color: "var(--muted2)",
  flex: "none",
};

/* ════════════════════════════════════════════════════════════════════════
 * Component
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * LogStrip rendered with explicit props (container-driven pattern).
 * Use `<LogStripConnected />` for the self-wired zustand version.
 */
export function LogStrip({ logs, cycle, legend }: LogStripProps) {
  /* The mockup shows "N ciclos · 312 execuções". The store has no
   * execution counter, so we accumulate a pseudo-count from the log
   * length (each log entry ≈ one execution event). A real backend would
   * push this via the hello / cycle.started events. */
  const execCount = Math.max(logs.length, 0);

  return (
    <div style={STRIP_STYLE}>
      {/* ── type legend ── */}
      <div style={LEGEND_CLUSTER_STYLE}>
        {legend.map((lg) => (
          <div key={lg.label} style={LEGEND_ITEM_STYLE}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 3,
                background: lg.color,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 11, color: "var(--text3)" }}>{lg.label}</span>
          </div>
        ))}
      </div>

      {/* ── vertical divider ── */}
      <div style={DIVIDER_STYLE} />

      {/* ── scrolling log entries (newest first, mask fades right edge) ── */}
      <div style={LOG_AREA_STYLE}>
        {logs.length === 0 ? (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "var(--muted)",
              whiteSpace: "nowrap",
            }}
          >
            aguardando eventos…
          </span>
        ) : (
          logs.map((log, i) => (
            <div key={i} style={LOG_ENTRY_STYLE}>
              <span style={LOG_TIME_STYLE}>{log.time}</span>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: log.color,
                  flexShrink: 0,
                }}
              />
              <span style={LOG_MSG_STYLE}>{log.msg}</span>
            </div>
          ))
        )}
      </div>

      {/* ── cycle · execuções counter ── */}
      <div style={COUNTER_STYLE}>
        {cycle} ciclos &middot; {execCount} execuções
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Self-wired variant — connects directly to the zustand store.
 * App.tsx (or whatever assembles the layout) can import this instead of
 * manually selecting from the store and passing props down.
 * ════════════════════════════════════════════════════════════════════════ */
export function LogStripConnected() {
  const logs = useLoomStore((s) => s.logs);
  const cycle = useLoomStore((s) => s.cycle);
  return <LogStrip logs={logs} cycle={cycle} legend={LEGEND} />;
}

export default LogStripConnected;
