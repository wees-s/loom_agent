import { describe, it, expect, beforeEach } from "vitest";
import { useLoomStore } from "./store";
import type { Flow, ClientCommand } from "@loom/shared";
import { asFlowId } from "@loom/shared";

const FLOW = asFlowId("f1");
const flow: Flow = {
  id: FLOW, name: "Loop", version: 1, schedule: "manual", state: "ocioso", cycle: 0,
  nodes: [{ id: "n1" as never, type: "Trigger", title: "T", role: "", model: "claude-sonnet-4-6", prompt: "", linkedContexts: [], position: { x: 0, y: 0 } }],
  edges: [],
  budget: { maxCyclesPerArm: 4, maxTokensPerRun: 1, maxUsdPerRun: 1, maxTokensPerFlow: 1, maxUsdPerFlow: 1, maxConcurrentAgents: 1, convergenceWindow: 1 },
  blackboardDir: "f1",
};

describe("store checkpoint actions", () => {
  let sent: ClientCommand[];
  beforeEach(() => {
    sent = [];
    useLoomStore.setState({ flowsById: { [FLOW]: flow }, selectedFlowId: FLOW, sendCommand: (c) => sent.push(c) });
  });

  it("continue() sends flow.continue for the selected flow", () => {
    useLoomStore.getState().continue();
    expect(sent.some((c) => c.t === "flow.continue" && c.flowId === FLOW)).toBe(true);
  });

  it("setReviewEachCycle persists via spec.save carrying the flag + optimistic patch", () => {
    useLoomStore.getState().setReviewEachCycle(true);
    const save = sent.find((c) => c.t === "spec.save");
    expect(save).toBeTruthy();
    expect((save as Extract<ClientCommand, { t: "spec.save" }>).flow.reviewEachCycle).toBe(true);
    expect(useLoomStore.getState().flowsById[FLOW]!.reviewEachCycle).toBe(true);
  });
});
