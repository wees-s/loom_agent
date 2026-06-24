import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "./TopBar";
import { useLoomStore } from "../store";
import type { Flow, ClientCommand } from "@loom/shared";
import { asFlowId } from "@loom/shared";

function props(over: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return {
    flowName: "F",
    cycle: 0,
    mode: "edit" as const,
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

describe("TopBar Save button (edit mode)", () => {
  it("shows a Salvar button in edit mode and calls onSaveSpec", () => {
    const onSaveSpec = vi.fn();
    render(<TopBar {...props({ mode: "edit", onSaveSpec })} />);
    const btn = screen.getByRole("button", { name: /salvar/i });
    fireEvent.click(btn);
    expect(onSaveSpec).toHaveBeenCalledTimes(1);
  });

  it("does NOT show the Salvar button in run mode", () => {
    render(<TopBar {...props({ mode: "run" })} />);
    expect(screen.queryByRole("button", { name: /salvar/i })).toBeNull();
  });
});

const FLOW = asFlowId("f1");
const flow: Flow = {
  id: FLOW, name: "F", version: 1, schedule: "manual", state: "ocioso", cycle: 0,
  nodes: [{ id: "trig" as never, type: "Trigger", title: "T", role: "", model: "claude-sonnet-4-6", prompt: "", linkedContexts: [], position: { x: 0, y: 0 } }],
  edges: [],
  budget: { maxCyclesPerArm: 4, maxTokensPerRun: 1, maxUsdPerRun: 1, maxTokensPerFlow: 1, maxUsdPerFlow: 1, maxConcurrentAgents: 1, convergenceWindow: 1 },
  blackboardDir: "f1",
};

describe("add agent → save persists the new node (the bug-1 path)", () => {
  let sent: ClientCommand[];
  beforeEach(() => {
    sent = [];
    useLoomStore.setState({ flowsById: { [FLOW]: flow }, selectedFlowId: FLOW, sendCommand: (c) => sent.push(c), draft: null, adding: false });
  });

  it("saveSpec sends spec.save carrying a freshly added agent", () => {
    const s = useLoomStore.getState();
    s.openAdd();
    s.setDraft({ name: "Terceiro", type: "Analyst" });
    s.createAgent(); // local-only (the bug) — must be followed by an explicit save
    s.saveSpec();
    const save = sent.find((c) => c.t === "spec.save");
    expect(save).toBeTruthy();
    const flowSaved = (save as Extract<ClientCommand, { t: "spec.save" }>).flow;
    expect(flowSaved.nodes.some((n) => n.title === "Terceiro")).toBe(true);
  });
});
