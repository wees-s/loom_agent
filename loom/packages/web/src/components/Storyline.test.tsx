import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Storyline } from "./Storyline";
import { useLoomStore } from "../store";
import type { NarrationLine } from "@loom/shared";

const lines: NarrationLine[] = [
  { id: "2", cycle: 1, at: 1000, kind: "cycle", tone: "neutral", text: "Ciclo 1 começou" },
  { id: "3", cycle: 1, at: 2000, kind: "agent", tone: "neutral", actor: "Scribe", text: "começou a trabalhar" },
  { id: "5", cycle: 1, at: 3000, kind: "agent", tone: "good", actor: "Scribe", text: "2 riscos novos" },
];

describe("<Storyline/>", () => {
  beforeEach(() => useLoomStore.setState({ storyline: lines, storylineOpen: true }));

  it("renders each narration line's text and actor", () => {
    render(<Storyline />);
    expect(screen.getByText("Ciclo 1 começou")).toBeInTheDocument();
    expect(screen.getAllByText("Scribe").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2 riscos novos")).toBeInTheDocument();
  });

  it("renders a cycle group header", () => {
    render(<Storyline />);
    expect(screen.getByText("Ciclo 1")).toBeInTheDocument(); // exact: the group header, not the line
  });

  it("shows a friendly empty state when there is nothing yet", () => {
    useLoomStore.setState({ storyline: [] });
    render(<Storyline />);
    expect(screen.getByText(/Nada rolando ainda/i)).toBeInTheDocument();
  });
});
