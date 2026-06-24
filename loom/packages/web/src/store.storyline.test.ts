import { describe, it, expect, beforeEach } from "vitest";
import { useLoomStore, selectStoryline } from "./store";
import type { Flow, StoredEvent, LoomEvent } from "@loom/shared";
import { asFlowId, asNodeId, asRunId } from "@loom/shared";

const FLOW = asFlowId("f1");
const NODE = asNodeId("n1");
const RUN = asRunId("r1");

const flow: Flow = {
  id: FLOW, name: "Teste", version: 1, schedule: "manual", state: "ocioso", cycle: 0,
  nodes: [{ id: NODE, type: "Analyst", title: "Scribe", role: "", model: "claude-sonnet-4-6", prompt: "", linkedContexts: [], position: { x: 0, y: 0 }, produces: ["resumo.md"] }],
  edges: [],
  budget: { maxCyclesPerArm: 4, maxTokensPerRun: 200000, maxUsdPerRun: 2, maxTokensPerFlow: 2000000, maxUsdPerFlow: 20, maxConcurrentAgents: 3, convergenceWindow: 2 },
  blackboardDir: "f1",
};

function ev(seq: number, event: LoomEvent): StoredEvent {
  return { seq, ts: seq * 1000, event };
}

function reset() {
  useLoomStore.setState({
    flowsById: { [FLOW]: flow }, selectedFlowId: FLOW, storyline: [],
    runNode: {}, lastSeq: 0, cycle: 0,
  });
}

describe("store storyline projection", () => {
  beforeEach(reset);

  it("folds a run into a coherent, ordered storyline grouped by cycle", () => {
    const store = useLoomStore.getState();
    store.applyServerMessage({
      t: "event",
      events: [
        ev(1, { type: "trigger.fired", flowId: FLOW, nodeId: NODE, cause: "Manual", at: 1000 }),
        ev(2, { type: "cycle.started", flowId: FLOW, cycle: 1, at: 2000 }),
        ev(3, { type: "node.activated", flowId: FLOW, nodeId: NODE, runId: RUN, cycle: 1 }),
        ev(4, { type: "blackboard.write", flowId: FLOW, path: "resumo.md", byNodeId: NODE, bytes: 2300, hash: "h", at: 4000 }),
        ev(5, { type: "run.finished", runId: RUN, status: "ok", resultSummary: "2 riscos novos", at: 5000 }),
      ],
    });
    const lines = selectStoryline(useLoomStore.getState());
    expect(lines.map((l) => l.kind)).toEqual(["trigger", "cycle", "agent", "artifact", "agent"]);
    expect(lines[4]!.cycle).toBe(1); // run.finished (cycle -1) stamped with running cycle
    expect(lines[4]!.actor).toBe("Scribe"); // resolved via runNode → node title
    expect(lines[3]!.artifact).toEqual({ path: "resumo.md", bytes: 2300 });
  });

  it("clears the storyline on selectFlow", () => {
    const store = useLoomStore.getState();
    store.applyServerMessage({ t: "event", events: [ev(1, { type: "cycle.started", flowId: FLOW, cycle: 1, at: 1000 })] });
    expect(selectStoryline(useLoomStore.getState()).length).toBe(1);
    useLoomStore.getState().selectFlow(FLOW);
    expect(selectStoryline(useLoomStore.getState()).length).toBe(0);
  });

  it("caps the buffer at STORYLINE_MAX (keeps newest)", () => {
    const events: StoredEvent[] = [];
    for (let i = 1; i <= 350; i++) events.push(ev(i, { type: "cycle.started", flowId: FLOW, cycle: i, at: i * 1000 }));
    useLoomStore.getState().applyServerMessage({ t: "event", events });
    const lines = selectStoryline(useLoomStore.getState());
    expect(lines.length).toBe(300);
    expect(lines[lines.length - 1]!.cycle).toBe(350); // newest kept
  });
});
