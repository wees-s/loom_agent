import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopBar } from "./TopBar";
import type { FlowState } from "@loom/shared";

function props(over: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return {
    flowName: "F",
    cycle: 0,
    mode: "run" as const,
    running: false,
    theme: "light" as const,
    connection: "live" as const,
    canRun: true,
    onSetMode: () => {},
    onTogglePlay: () => {},
    onToggleTheme: () => {},
    onSaveSpec: () => {},
    ...over,
  };
}

describe("TopBar status label reflects the real flow state (not binary running)", () => {
  it("an idle-but-armed flow shows OCIOSO, NOT PAUSADO", () => {
    render(<TopBar {...props({ running: false, flowState: "ocioso" as FlowState })} />);
    expect(screen.getByText("OCIOSO")).toBeInTheDocument();
    expect(screen.queryByText("PAUSADO")).toBeNull();
  });

  it("a genuinely paused flow shows PAUSADO", () => {
    render(<TopBar {...props({ running: false, flowState: "pausado" as FlowState })} />);
    expect(screen.getByText("PAUSADO")).toBeInTheDocument();
  });

  it("a running flow shows EM EXECUÇÃO", () => {
    render(<TopBar {...props({ running: true, flowState: "rodando" as FlowState })} />);
    expect(screen.getByText("EM EXECUÇÃO")).toBeInTheDocument();
  });

  it("an awaiting (checkpoint) flow shows AGUARDANDO", () => {
    render(<TopBar {...props({ running: false, flowState: "aguardando" as FlowState })} />);
    expect(screen.getByText("AGUARDANDO")).toBeInTheDocument();
  });
});

describe("TopBar play/stop button reflects ACTIVE state (armed, not just running)", () => {
  it("an armed-but-idle scheduled flow (agendado) shows the STOP button", () => {
    render(<TopBar {...props({ running: false, flowState: "agendado" as FlowState })} />);
    expect(screen.getByTitle("Parar o fluxo")).toBeInTheDocument();
  });
  it("a truly stopped flow (ocioso) shows the START button", () => {
    render(<TopBar {...props({ running: false, flowState: "ocioso" as FlowState })} />);
    expect(screen.getByTitle(/Iniciar agora/)).toBeInTheDocument();
  });
});
