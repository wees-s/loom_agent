import { describe, it, expect, beforeEach } from "vitest";
import { useLoomStore } from "./store";
import type { ClientCommand } from "@loom/shared";

describe("store generateFlow", () => {
  let sent: ClientCommand[];
  beforeEach(() => {
    sent = [];
    useLoomStore.setState({ sendCommand: (c) => sent.push(c), generating: false });
  });

  it("sends flow.generate and sets generating", () => {
    useLoomStore.getState().generateFlow("revisa PRs");
    expect(sent.some((c) => c.t === "flow.generate" && c.prompt === "revisa PRs")).toBe(true);
    expect(useLoomStore.getState().generating).toBe(true);
  });

  it("ignores an empty prompt", () => {
    useLoomStore.getState().generateFlow("   ");
    expect(sent.length).toBe(0);
    expect(useLoomStore.getState().generating).toBe(false);
  });

  it("clears generating on ack", () => {
    useLoomStore.setState({ generating: true });
    useLoomStore.getState().applyServerMessage({ t: "ack", cmdId: "x", ok: true });
    expect(useLoomStore.getState().generating).toBe(false);
  });
});
