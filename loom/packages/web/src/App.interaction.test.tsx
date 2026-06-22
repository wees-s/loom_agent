import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { App } from "./App";
import { useLoomStore } from "./store";
import { seedMockStore } from "./mock";

/* ════════════════════════════════════════════════════════════════════════
 * App interaction test — the white-screen reproducer + regression lock.
 *
 * The user reported that clicking ANYTHING (a flow row in the rail, a node
 * card, an edge) blanks the whole screen — an unhandled React exception. This
 * test mounts the real <App/> (mock-seeded daily-standup, exactly like prod
 * boot) and drives the same clicks. Before the fix it throws; after the fix it
 * renders without ever showing the ErrorBoundary fallback.
 *
 * We stub the WebSocket so wsClient.startWsClient() doesn't explode in jsdom
 * (jsdom has no real WS to localhost) — this keeps the app in mock mode, which
 * is precisely the state the user is clicking around in.
 * ════════════════════════════════════════════════════════════════════════ */

/* Minimal WebSocket stub: never opens, never errors loudly. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  constructor(_url: string) {
    /* stays CONNECTING forever → app stays in mock mode */
  }
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  // reset store to a clean slate so each test starts from the same boot state
  seedMockStore();
});

/** True iff the ErrorBoundary fallback is on screen (i.e. a render crashed). */
function errorBoundaryShown(): boolean {
  return !!document.querySelector("[data-error-boundary]");
}

describe("App white-screen reproducer / regression lock", () => {
  it("boots mock-seeded and renders the daily-standup flow without crashing", () => {
    render(<App />);
    // TopBar shows the flow name; LogStrip shows the legend → tree rendered.
    expect(screen.getByText("Daily Standup Loop")).toBeInTheDocument();
    expect(errorBoundaryShown()).toBe(false);
  });

  it("clicking a flow row, a node card, and an edge does not blank the screen", () => {
    render(<App />);

    // ── 1. Click a flow row in the rail ──────────────────────────────────
    // Hover the rail to expand it, then click a flow row by name.
    const railFlow = screen.getByText("Daily Standup Loop");
    fireEvent.click(railFlow);
    expect(errorBoundaryShown()).toBe(false);

    // Selecting the daily flow lights its first node (scribe) in the inspector.
    // The store should now have a selected node (selectFlow picks nodes[0]).
    expect(useLoomStore.getState().selectedFlowId).toBe("daily");

    // ── 2. Click a node card on the canvas ───────────────────────────────
    const nodeCard = document.querySelector('[data-node="a1"]') as HTMLElement;
    expect(nodeCard).toBeTruthy();
    fireEvent.pointerDown(nodeCard);
    expect(errorBoundaryShown()).toBe(false);
    expect(useLoomStore.getState().selectedNodeId).toBe("a1");

    // ── 3. Click an edge (must be in edit mode for edges to be selectable) ─
    // Toggle to Editar via the TopBar button so React flushes the mode change
    // (edges are only clickable in edit mode — handleEdgeClick early-returns
    // otherwise, and edge paths only get pointer-events in edit mode).
    fireEvent.click(screen.getByText("Editar"));
    expect(useLoomStore.getState().mode).toBe("edit");
    const edgePath = document.querySelector('[data-edge="e4"]') as SVGPathElement;
    expect(edgePath).toBeTruthy();
    fireEvent.click(edgePath);
    expect(errorBoundaryShown()).toBe(false);
    expect(useLoomStore.getState().selectedEdgeId).toBe("e4");
    // edge selection clears node selection → inspector now reads a null node;
    // the runs selector keyed by `selectedNodeId ?? ""` must not loop/crash.
    expect(useLoomStore.getState().selectedNodeId).toBeNull();
  });

  it("toggling Executar/Editar and selecting a node for editing does not crash", () => {
    render(<App />);

    // Toggle to Editar mode via the TopBar button.
    fireEvent.click(screen.getByText("Editar"));
    expect(useLoomStore.getState().mode).toBe("edit");
    expect(errorBoundaryShown()).toBe(false);

    // Select a node for editing (EditNodeView renders the prompt textarea).
    const synthCard = document.querySelector('[data-node="synth"]') as HTMLElement;
    expect(synthCard).toBeTruthy();
    fireEvent.pointerDown(synthCard);
    expect(errorBoundaryShown()).toBe(false);
    expect(useLoomStore.getState().selectedNodeId).toBe("synth");

    // Toggle back to Executar — the RunNodeView for the selected node renders.
    fireEvent.click(screen.getByText("Executar"));
    expect(useLoomStore.getState().mode).toBe("run");
    expect(errorBoundaryShown()).toBe(false);

    // The selected node's recent-runs panel renders without throwing.
    expect(screen.getByText("Execuções recentes")).toBeInTheDocument();
  });

  it("deleting the selected flow clears selection and does not blank the screen", () => {
    render(<App />);
    // Daily is selected on mock seed.
    expect(useLoomStore.getState().selectedFlowId).toBe("daily");

    // Auto-confirm the destructive confirm() dialog.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    // Switch the inspector to FLOW-INFO (nothing selected) so the delete button
    // renders, then click it.
    act(() => {
      useLoomStore.getState().clearSelection();
    });
    const delBtn = document.querySelector("[data-delete-flow]") as HTMLElement;
    expect(delBtn).toBeTruthy();
    fireEvent.click(delBtn);

    expect(confirmSpy).toHaveBeenCalled();
    expect(errorBoundaryShown()).toBe(false);
    // The daily flow is gone from the rail + cache.
    expect(useLoomStore.getState().flows.find((f) => f.id === "daily")).toBeUndefined();
    expect(useLoomStore.getState().flowsById["daily"]).toBeUndefined();
    // Selection fell back to another flow (or null) — never the deleted one.
    expect(useLoomStore.getState().selectedFlowId).not.toBe("daily");

    confirmSpy.mockRestore();
  });

  it("selecting a node then clicking the empty canvas background to deselect is stable", () => {
    // Extra coverage: the node → none transition through the canvas background
    // (data-canvas-bg pointerDown → clearSelection). After deselect the
    // inspector falls back from the node panel to FLOW-INFO; the runs selector
    // is then read with selectedNodeId === null (key "") — the undefined path
    // that minted a fresh [] and looped under zustand v5.
    render(<App />);

    // Select a node first (run mode, default).
    const nodeCard = document.querySelector('[data-node="a1"]') as HTMLElement;
    expect(nodeCard).toBeTruthy();
    fireEvent.pointerDown(nodeCard);
    expect(useLoomStore.getState().selectedNodeId).toBe("a1");
    expect(errorBoundaryShown()).toBe(false);

    // Click the empty canvas background → clearSelection().
    const bg = document.querySelector("[data-canvas-bg]") as HTMLElement;
    expect(bg).toBeTruthy();
    fireEvent.pointerDown(bg);
    expect(errorBoundaryShown()).toBe(false);
    expect(useLoomStore.getState().selectedNodeId).toBeNull();
    expect(useLoomStore.getState().selectedEdgeId).toBeNull();
  });

  it("selecting a node with NO seeded runs (undefined runsByNode entry) is stable", () => {
    // This is the core deref: runsByNode[nodeId] is undefined for a fresh node.
    render(<App />);

    // Add a brand-new node via the store (no runs recorded for it).
    act(() => {
      useLoomStore.getState().setMode("edit");
      useLoomStore.getState().openAdd();
      useLoomStore.getState().createAgent();
    });
    const newId = useLoomStore.getState().selectedNodeId;
    expect(newId).toBeTruthy();
    expect(useLoomStore.getState().runsByNode[newId as string]).toBeUndefined();

    // Switch to run mode → RunNodeView reads selectRunsForNode (the undefined
    // path). A non-cached selector here is what blanked the screen in zustand v5.
    act(() => {
      useLoomStore.getState().setMode("run");
    });
    expect(errorBoundaryShown()).toBe(false);
    expect(screen.getByText("Execuções recentes")).toBeInTheDocument();
  });
});

describe("App — clean empty boot (no seed flows)", () => {
  it("renders with ZERO flows (fresh install) without crashing", () => {
    // Simulate a fresh install / empty engine: clear the seeded store entirely.
    act(() => {
      useLoomStore.setState({
        flows: [],
        flowsById: {},
        selectedFlowId: null,
        selectedNodeId: null,
        selectedEdgeId: null,
        runsByNode: {},
        terminals: [],
        logs: [],
        cycle: 0,
        activeNodeIds: new Set<string>(),
        activeEdgeIds: new Set<string>(),
      });
    });

    render(<App />);
    // No flow selected → TopBar shows the em-dash placeholder, nothing crashes.
    expect(errorBoundaryShown()).toBe(false);
    // The seeded daily flow is NOT on screen.
    expect(screen.queryByText("Daily Standup Loop")).toBeNull();
  });
});
