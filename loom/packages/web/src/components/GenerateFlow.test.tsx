import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GenerateFlow } from "./GenerateFlow";
import { useLoomStore } from "../store";
import type { ClientCommand } from "@loom/shared";

describe("<GenerateFlow/>", () => {
  let sent: ClientCommand[];
  beforeEach(() => {
    sent = [];
    useLoomStore.setState({ sendCommand: (c) => sent.push(c), generating: false });
  });

  it("sends flow.generate with the typed prompt", () => {
    render(<GenerateFlow />);
    fireEvent.change(screen.getByPlaceholderText(/descreva/i), { target: { value: "um loop que revisa PRs" } });
    fireEvent.click(screen.getByRole("button", { name: /gerar/i }));
    expect(sent.some((c) => c.t === "flow.generate" && c.prompt === "um loop que revisa PRs")).toBe(true);
  });
});
