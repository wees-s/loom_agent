import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { useLoomStore, selectCurrentFlow } from "./store";
import { startWsClient, type LoomWsClient } from "./wsClient";

import { TopBar } from "./components/TopBar";
import { LeftRail } from "./components/LeftRail";
import { CanvasGraphContainer } from "./components/CanvasGraph";
import { CanvasOverlay } from "./components/CanvasOverlay";
import { Inspector } from "./components/Inspector";
import { Storyline } from "./components/Storyline";
import { LogStripConnected } from "./components/LogStrip";
import { TerminalPanel } from "./components/TerminalPanel";

/**
 * App shell — composes the full Loom layout 1:1 with the mockup
 * (Loom.dc.html lines 49-345):
 *
 *   [data-loom] root
 *     ├ animated background blobs (z:0)
 *     └ z:1 flex-column (pad 15, gap 13)
 *         ├ <TopBar/>                                   (own glass bar)
 *         ├ middle row [LeftRail | Canvas | Inspector]  (flex, gap 13)
 *         │     ├ <LeftRail/>            (own glass rail, 56↔212)
 *         │     ├ canvas box            <CanvasGraph/> + <CanvasOverlay/>
 *         │     └ <Inspector/>           (own glass panel)
 *         └ <LogStripConnected/>                        (own glass strip)
 *
 * Bootstrap: start the ws client and wait for the engine. SAFE/CLEAN DEFAULT:
 * we no longer seed a prebuilt mock flow on boot — a fresh install opens with
 * ZERO flows (an empty, clean state) until the engine's `hello` arrives or the
 * user creates their own. (The `seedMockStore` helper still exists in mock.ts as
 * an opt-in for tests / manual UI previews; the production app does not call it.)
 *
 * The canvas box is a single `position:relative` wrapper so CanvasOverlay's
 * absolutely-positioned chrome (add-agent panel, etc.) anchors to the same
 * box CanvasGraph fills — mirroring the mockup's single `[data-canvas]`
 * container that holds both the stage and its overlay UI.
 */
/* ════════════════════════════════════════════════════════════════════════
 * ErrorBoundary — a render error ANYWHERE below here must never blank the
 * whole screen. React error boundaries have to be class components; this one
 * catches the throw, logs it, and shows a readable panel with the message +
 * stack instead of an unrecoverable white page. A "Recarregar" button lets the
 * user recover without losing the tab.
 * ════════════════════════════════════════════════════════════════════════ */
interface ErrorBoundaryState {
  error: Error | null;
  info: ErrorInfo | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it for diagnostics; the panel below shows it to the user too.
    // eslint-disable-next-line no-console
    console.error("Loom render error caught by ErrorBoundary:", error, info);
    this.setState({ error, info });
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        data-error-boundary
        role="alert"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: "32px 40px",
          overflow: "auto",
          background: "oklch(0.98 0.01 160)",
          color: "oklch(0.30 0.04 160)",
          fontFamily: "'Hanken Grotesk',-apple-system,sans-serif",
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em" }}>
          Algo quebrou ao renderizar o Loom
        </div>
        <div style={{ fontSize: 14, color: "oklch(0.45 0.03 160)", maxWidth: 720, lineHeight: 1.5 }}>
          A interface encontrou um erro inesperado e parou de renderizar esta tela. Os detalhes
          abaixo ajudam a diagnosticar. Nada foi perdido no engine — recarregue para tentar de novo.
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            alignSelf: "flex-start",
            padding: "9px 16px",
            border: "none",
            borderRadius: 10,
            background: "oklch(0.62 0.14 160)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Recarregar
        </button>
        <pre
          data-error-message
          style={{
            margin: 0,
            padding: "14px 16px",
            borderRadius: 12,
            background: "oklch(0.95 0.03 25 / 0.5)",
            border: "1px solid oklch(0.8 0.08 25 / 0.5)",
            color: "oklch(0.40 0.14 25)",
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 12.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {String(error.stack ?? error.message ?? error)}
        </pre>
        {info?.componentStack && (
          <pre
            style={{
              margin: 0,
              padding: "14px 16px",
              borderRadius: 12,
              background: "oklch(0.96 0.01 200 / 0.6)",
              border: "1px solid oklch(0.85 0.02 200)",
              color: "oklch(0.45 0.03 200)",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {info.componentStack}
          </pre>
        )}
      </div>
    );
  }
}

/**
 * App — the exported root. Wraps the shell in the ErrorBoundary so any future
 * render error shows a readable message instead of a blank white page.
 */
export function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

function AppShell() {
  // TopBar is prop-driven (the others self-connect to the store).
  const flow = useLoomStore(selectCurrentFlow);
  const cycle = useLoomStore((s) => s.cycle);
  const mode = useLoomStore((s) => s.mode);
  const running = useLoomStore((s) => s.running);
  const theme = useLoomStore((s) => s.theme);
  const connection = useLoomStore((s) => s.connection);
  const setMode = useLoomStore((s) => s.setMode);
  const play = useLoomStore((s) => s.play);
  const pause = useLoomStore((s) => s.pause);
  const runNow = useLoomStore((s) => s.runNow);
  const kill = useLoomStore((s) => s.kill);
  const selectedFlowId = useLoomStore((s) => s.selectedFlowId);
  const toggleTheme = useLoomStore((s) => s.toggleTheme);
  const saveSpec = useLoomStore((s) => s.saveSpec);

  const wsRef = useRef<LoomWsClient | null>(null);

  // bootstrap once: connect to the engine. No mock seeding — the app opens with
  // a clean, empty state (zero flows) and fills in from the engine's `hello`.
  useEffect(() => {
    wsRef.current = startWsClient();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  // ESC clears canvas selection (mockup global keydown).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useLoomStore.getState().clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Big green button = START the flow: run a cycle NOW and (for scheduled/interval
  // triggers) arm it so it keeps firing. Stop = disarm + kill anything in flight.
  // No flow selected → nothing to run (the button renders disabled, see canRun).
  const onTogglePlay = () => {
    if (!selectedFlowId) return;
    if (running) {
      pause();
      kill();
    } else {
      play();
      runNow();
    }
  };

  return (
    <div
      data-loom
      data-theme={theme}
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "'Hanken Grotesk',-apple-system,sans-serif",
        color: "var(--text)",
        background: "var(--page)",
        transition: "color .3s",
      }}
    >
      {/* animated background blobs (mockup verbatim) */}
      <div style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: -120, left: "6%", width: 460, height: 460, borderRadius: "50%", background: "var(--blob1)", filter: "blur(80px)", opacity: 0.5, animation: "floatA 18s ease-in-out infinite", willChange: "transform" }} />
        <div style={{ position: "absolute", top: "30%", right: -100, width: 420, height: 420, borderRadius: "50%", background: "var(--blob2)", filter: "blur(86px)", opacity: 0.42, animation: "floatB 22s ease-in-out infinite", willChange: "transform" }} />
        <div style={{ position: "absolute", bottom: -160, left: "38%", width: 480, height: 480, borderRadius: "50%", background: "var(--blob3)", filter: "blur(90px)", opacity: 0.4, animation: "blob 20s ease-in-out infinite 1s", willChange: "transform" }} />
      </div>

      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", height: "100%", padding: 15, gap: 13 }}>
        {/* ── Top bar ── */}
        <TopBar
          flowName={flow?.name ?? "—"}
          cycle={cycle}
          mode={mode}
          running={running}
          theme={theme}
          connection={connection}
          canRun={!!selectedFlowId}
          onSetMode={setMode}
          onTogglePlay={onTogglePlay}
          onToggleTheme={toggleTheme}
          onSaveSpec={saveSpec}
        />

        {/* ── Middle row: LeftRail · Canvas · Inspector ── */}
        <div style={{ display: "flex", gap: 13, flex: 1, minHeight: 0 }}>
          <LeftRail />

          {/* Canvas box — single positioned container holding the graph stage
              and its overlay chrome (mockup's [data-canvas]). */}
          <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
            <CanvasGraphContainer />
            <CanvasOverlay />
          </div>

          <Inspector />
          <Storyline />
        </div>

        {/* ── Live terminal drawer (collapses when no terminal is selected) ── */}
        <TerminalPanel />

        {/* ── Bottom log strip ── */}
        <LogStripConnected />
      </div>
    </div>
  );
}

export default App;
