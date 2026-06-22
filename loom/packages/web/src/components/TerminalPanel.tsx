import { useEffect, useRef, useCallback } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useLoomStore } from "../store";

/* ════════════════════════════════════════════════════════════════════════
 * TerminalPanel — live xterm.js view of a tmux pane.
 *
 * Layout contract: the panel sits as a collapsible bottom drawer inside
 * AppShell. When `selectedTerminalId` is non-null the drawer is open (height
 * ~220px); when null it collapses to zero. The user opens it by clicking a
 * terminal row in the LeftRail "Terminais" list or by clicking an agent node
 * that owns a terminal (via selectTerminal). Closing is done by clicking the
 * × button in the panel header.
 *
 * Data flow:
 *   engine tmux pane → pipe-pane FIFO → ReadStream → fanoutData → onData
 *   → ServerMessage terminal.data { terminal, chunk }
 *   → store.applyServerMessage → terminalData[id] += chunk
 *   → TerminalPanel subscribes to terminalData[id] and writes each new chunk
 *     directly to the xterm.js Terminal instance (no full-redraw).
 *
 * xterm.js is NOT imported at the top level — it uses real DOM APIs that jsdom
 * does not provide. We lazy-import it inside useEffect so the module loads only
 * in a real browser context. In jsdom (vitest) the useEffect never fires and
 * the component renders the glass shell without crashing.
 * ════════════════════════════════════════════════════════════════════════ */

const ACCENT = "oklch(0.62 0.14 160)";

/* ── tiny status dot color helper (mirrors LeftRail) ── */
function termDotColor(status: string): string {
  switch (status) {
    case "scribe":   return "oklch(0.64 0.13 160)";
    case "executor": return "oklch(0.70 0.12 65)";
    case "busy":     return "oklch(0.60 0.13 245)";
    default:         return "oklch(0.75 0.01 200)";
  }
}

export function TerminalPanel() {
  const selectedTerminalId = useLoomStore((s) => s.selectedTerminalId);
  const terminals          = useLoomStore((s) => s.terminals);
  const terminalData       = useLoomStore((s) => s.terminalData);
  const selectTerminal     = useLoomStore((s) => s.selectTerminal);
  const sendTerminalInput  = useLoomStore((s) => s.sendTerminalInput);

  const terminalMeta = terminals.find((t) => t.id === selectedTerminalId) ?? null;

  /* Refs that survive re-renders without triggering them */
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef     = useRef<XTerm | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  /** track the last length of the accumulated text we have written to xterm */
  const writtenLenRef = useRef<number>(0);

  /* ── bootstrap / teardown the xterm.js instance ── */
  useEffect(() => {
    if (!selectedTerminalId || !containerRef.current) return;

    let disposed = false;
    let xterm: XTerm;
    let fit: FitAddon;

    /* Lazy import — never runs in jsdom (no real DOM). */
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed || !containerRef.current) return;

      xterm = new Terminal({
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        fontSize: 12,
        lineHeight: 1.4,
        theme: {
          background: "transparent",
          foreground: "#c8d8d0",
          cursor:     ACCENT,
          selectionBackground: "oklch(0.62 0.14 160 / 0.28)",
          black:   "#1a2820",
          red:     "#e06c75",
          green:   "#62c073",
          yellow:  "#e5c07b",
          blue:    "#61afef",
          magenta: "#c678dd",
          cyan:    "#56b6c2",
          white:   "#abb2bf",
          brightBlack:   "#5c6370",
          brightRed:     "#e06c75",
          brightGreen:   "#98c379",
          brightYellow:  "#e5c07b",
          brightBlue:    "#61afef",
          brightMagenta: "#c678dd",
          brightCyan:    "#56b6c2",
          brightWhite:   "#ffffff",
        },
        allowTransparency: true,
        scrollback: 5000,
        convertEol: true,
      });

      fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(containerRef.current!);
      fit.fit();

      xtermRef.current     = xterm;
      fitRef.current       = fit;
      writtenLenRef.current = 0;

      /* Write initial backlog that was already in the store. */
      const existing = useLoomStore.getState().terminalData[selectedTerminalId] ?? "";
      if (existing) {
        xterm.write(existing);
        writtenLenRef.current = existing.length;
      }

      /* ResizeObserver keeps the terminal fitted when the panel resizes. */
      const ro = new ResizeObserver(() => {
        try { fit.fit(); } catch { /* ignore */ }
      });
      if (containerRef.current) ro.observe(containerRef.current);

      /* Forward keystrokes to the engine (pass-through input). */
      xterm.onData((data) => {
        sendTerminalInput(selectedTerminalId, data);
      });

      /* Cleanup */
      return () => {
        ro.disconnect();
      };
    }).catch(() => { /* xterm unavailable (test/SSR) — silently skip */ });

    return () => {
      disposed = true;
      try { xtermRef.current?.dispose(); } catch { /* ignore */ }
      xtermRef.current     = null;
      fitRef.current       = null;
      writtenLenRef.current = 0;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTerminalId]);

  /* ── stream new chunks into xterm without full-redraw ── */
  const accumulated = selectedTerminalId ? (terminalData[selectedTerminalId] ?? "") : "";
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm || !selectedTerminalId) return;
    const already = writtenLenRef.current;
    if (accumulated.length > already) {
      xterm.write(accumulated.slice(already));
      writtenLenRef.current = accumulated.length;
    }
  }, [accumulated, selectedTerminalId]);

  /* Fit on panel open/close transition */
  const handleFit = useCallback(() => {
    try { fitRef.current?.fit(); } catch { /* ignore */ }
  }, []);

  /* ── close panel ── */
  const close = useCallback(() => selectTerminal(null), [selectTerminal]);

  const isOpen = !!selectedTerminalId;

  return (
    <div
      data-terminal-panel
      style={{
        height: isOpen ? 220 : 0,
        overflow: "hidden",
        transition: "height .28s cubic-bezier(.4,0,.2,1)",
        flexShrink: 0,
      }}
      onTransitionEnd={handleFit}
    >
      {/* glass card — same aesthetic as TopBar/LogStrip */}
      <div
        style={{
          height: "100%",
          borderRadius: 18,
          background: "var(--glass)",
          backdropFilter: "blur(22px) saturate(1.4)",
          WebkitBackdropFilter: "blur(22px) saturate(1.4)",
          border: "1px solid var(--glass-border)",
          boxShadow: "0 10px 40px -14px rgba(30,55,45,0.18),inset 0 1px 0 var(--card-top)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* header bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            borderBottom: "1px solid var(--line)",
            flexShrink: 0,
          }}
        >
          {/* terminal icon */}
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ color: ACCENT, flexShrink: 0 }}>
            <path d="M1 3l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M7 9h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>

          {/* terminal id */}
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text2)",
              flex: 1,
            }}
          >
            {selectedTerminalId ?? "—"}
          </span>

          {/* status dot + meta */}
          {terminalMeta && (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 10,
                color: "var(--muted)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 2,
                  background: termDotColor(terminalMeta.status),
                  display: "block",
                }}
              />
              {terminalMeta.meta}
            </span>
          )}

          {/* × close */}
          <button
            type="button"
            data-terminal-close
            onClick={close}
            aria-label="Fechar terminal"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted2)",
              padding: "2px 4px",
              borderRadius: 6,
              fontSize: 14,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--muted2)"; }}
          >
            ×
          </button>
        </div>

        {/* xterm.js mount point */}
        <div
          ref={containerRef}
          data-xterm-container
          style={{
            flex: 1,
            padding: "6px 10px 4px",
            overflow: "hidden",
            minHeight: 0,
            /* xterm renders its own canvas; the outer bg shows through
               (allowTransparency:true) giving the glass look. */
          }}
        />
      </div>
    </div>
  );
}

export default TerminalPanel;
