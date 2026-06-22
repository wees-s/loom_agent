import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { useLoomStore } from "../store";
import { TerminalPanel } from "./TerminalPanel";

/* ════════════════════════════════════════════════════════════════════════
 * TerminalPanel tests — jsdom smoke suite.
 *
 * xterm.js lazy-imports real DOM canvas APIs that jsdom does not provide.
 * The component deliberately defers that import to useEffect so in jsdom the
 * terminal chrome (glass shell, header, close button) renders fine, the xterm
 * mount silently skips, and no crash occurs. We assert:
 *
 *   1. The panel is hidden (height:0) when no terminal is selected.
 *   2. Selecting a terminal via the store opens the panel and shows its id.
 *   3. terminal.data chunks buffered in the store are reflected (the text
 *      cannot be seen inside xterm.js in jsdom, but the store state is correct
 *      and no crash occurs — that is the contract).
 *   4. Clicking × closes the panel (selectedTerminalId → null).
 *   5. Re-opening a different terminal id clears the previous state.
 * ════════════════════════════════════════════════════════════════════════ */

/* Minimal WebSocket stub so wsClient never throws in jsdom. */
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
  constructor(_url: string) {}
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

  /* Reset store to a clean, terminal-capable state. */
  act(() => {
    useLoomStore.setState({
      terminals: [
        { id: "term://1", title: "term://1", status: "scribe",   meta: "scribe"   },
        { id: "term://2", title: "term://2", status: "executor", meta: "executor" },
        { id: "term://3", title: "term://3", status: "idle",     meta: "idle"     },
      ],
      terminalData: {},
      selectedTerminalId: null,
      /* keep sendCommand as no-op so terminal.open never throws */
      sendCommand: () => {},
    });
  });
});

describe("TerminalPanel", () => {
  it("renders without crashing even with no terminal selected", () => {
    render(<TerminalPanel />);
    const panel = document.querySelector("[data-terminal-panel]") as HTMLElement;
    expect(panel).toBeTruthy();
    /* collapsed: height:0 via inline style */
    expect(panel.style.height).toBe("0px");
  });

  it("expands and shows the terminal id when a terminal is selected", () => {
    render(<TerminalPanel />);

    act(() => {
      useLoomStore.getState().selectTerminal("term://1");
    });

    const panel = document.querySelector("[data-terminal-panel]") as HTMLElement;
    expect(panel.style.height).toBe("220px");
    expect(screen.getByText("term://1")).toBeInTheDocument();
    expect(screen.getByText("scribe")).toBeInTheDocument();
  });

  it("terminal.data chunks update the store without crashing the component", () => {
    render(<TerminalPanel />);

    act(() => {
      useLoomStore.getState().selectTerminal("term://2");
    });

    /* Simulate live terminal.data arriving from the engine */
    act(() => {
      useLoomStore.getState().applyServerMessage({
        t: "terminal.data",
        terminal: "term://2",
        chunk: "\x1b[32mscaffold\x1b[0m ok\r\n",
      });
    });

    const stored = useLoomStore.getState().terminalData["term://2"];
    expect(stored).toContain("scaffold");

    /* The panel must still be open and not showing the error boundary */
    expect(document.querySelector("[data-error-boundary]")).toBeNull();
    const panel = document.querySelector("[data-terminal-panel]") as HTMLElement;
    expect(panel.style.height).toBe("220px");
  });

  it("clicking × closes the panel", () => {
    render(<TerminalPanel />);

    act(() => {
      useLoomStore.getState().selectTerminal("term://3");
    });

    const closeBtn = document.querySelector("[data-terminal-close]") as HTMLElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);

    expect(useLoomStore.getState().selectedTerminalId).toBeNull();
    const panel = document.querySelector("[data-terminal-panel]") as HTMLElement;
    expect(panel.style.height).toBe("0px");
  });

  it("switching terminals updates the header without crashing", () => {
    render(<TerminalPanel />);

    act(() => {
      useLoomStore.getState().selectTerminal("term://1");
    });
    expect(screen.getByText("term://1")).toBeInTheDocument();

    act(() => {
      useLoomStore.getState().selectTerminal("term://2");
    });
    expect(screen.getByText("term://2")).toBeInTheDocument();
    expect(document.querySelector("[data-error-boundary]")).toBeNull();
  });

  it("pre-buffered terminalData is reflected in store state before xterm mounts", () => {
    /* Seed data before the terminal is selected (backlog/replay scenario). */
    act(() => {
      useLoomStore.setState({
        terminalData: { "term://1": "Hello from backlog\r\n" },
      });
    });

    render(<TerminalPanel />);

    act(() => {
      useLoomStore.getState().selectTerminal("term://1");
    });

    /* jsdom cannot render inside xterm canvas, but the store must be correct. */
    expect(useLoomStore.getState().terminalData["term://1"]).toContain("Hello from backlog");
    expect(document.querySelector("[data-error-boundary]")).toBeNull();
  });
});
