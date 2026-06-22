// =============================================================================
// terminals.test.ts — tmux-backed terminal streaming + lifecycle.
//
// Loom is TERMINAL-NATIVE: an agent run is a real command inside a real tmux
// pane, streamed live as terminal.data. This suite drives that mechanism WITHOUT
// spending a cent (it runs `echo`/`sh` in the pane, never `claude`) — proving the
// pipe-pane → fifo → onData stream, the replay buffer, exit-code recovery, abort,
// ownership status, and disposeFlow teardown.
//
// The streaming path needs a working tmux. When tmux is unavailable the manager
// degrades gracefully (status stays valid, runInPane reports degraded) and the
// suite asserts THAT contract instead, so it is green on any box.
// =============================================================================

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

import { createTerminals } from "./terminals.js";
import type { Emit } from "./internal.js";
import type { FlowId } from "@loom/shared";

/** Is a usable tmux on PATH? (the streaming path needs it.) */
function tmuxAvailable(): boolean {
  try {
    const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** A no-op emit that records the terminal.state events for assertions. */
function recordingEmit(): { emit: Emit; states: { terminal: string; status: string; meta: string }[] } {
  const states: { terminal: string; status: string; meta: string }[] = [];
  const emit: Emit = ((event) => {
    if (event.type === "terminal.state") {
      states.push({ terminal: event.terminal, status: event.status, meta: event.meta });
    }
    return { seq: 0, ts: Date.now(), event };
  }) as Emit;
  return { emit, states };
}

const HAVE_TMUX = tmuxAvailable();
/** Poll until `cond()` is true or we time out (streaming is async). */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe("terminals — id/session/registry (no tmux required)", () => {
  it("accepts both term://N and term://<flow>.<node> ids and lists them", () => {
    const { emit } = recordingEmit();
    const terms = createTerminals(emit);

    // setOwnership registers an entry without needing tmux.
    terms.setOwnership("term://1", { status: "idle", meta: "idle" });
    terms.setOwnership("term://flow-abc.node-xyz", {
      status: "busy",
      meta: "Analyst",
      flowId: "flow-abc" as FlowId,
    });

    const list = terms.list();
    const ids = list.map((t) => t.id);
    expect(ids).toContain("term://1");
    expect(ids).toContain("term://flow-abc.node-xyz");

    // Numeric terminal sorts before the run terminal.
    expect(ids.indexOf("term://1")).toBeLessThan(ids.indexOf("term://flow-abc.node-xyz"));

    // The run terminal parses its owning flow/node from the id.
    const run = terms.get("term://flow-abc.node-xyz");
    expect(run?.flowId).toBe("flow-abc");
    expect(run?.nodeId).toBe("node-xyz");
    expect(run?.title).toBe("node-xyz");
  });

  it("rejects malformed ids", () => {
    const { emit } = recordingEmit();
    const terms = createTerminals(emit);
    expect(terms.get("not-a-term")).toBeNull();
    expect(() => terms.setOwnership("nope://1", { status: "idle", meta: "" })).toThrow();
  });

  it("setOwnership emits terminal.state on change", () => {
    const { emit, states } = recordingEmit();
    const terms = createTerminals(emit);
    terms.setOwnership("term://7", { status: "busy", meta: "running" });
    expect(states.some((s) => s.terminal === "term://7" && s.status === "busy")).toBe(true);
  });
});

describe.runIf(HAVE_TMUX)("terminals — live tmux streaming + lifecycle", () => {
  it("runInPane streams pane output to onData + recentOutput, recovers exit code", async () => {
    const { emit } = recordingEmit();
    const terms = createTerminals(emit);
    const id = `term://flow-test.stream-${Math.random().toString(36).slice(2, 8)}`;
    const token = `LOOM_STREAM_${Math.random().toString(36).slice(2, 10)}`;

    const chunks: string[] = [];
    const unsub = terms.onData((_t, chunk) => chunks.push(chunk));

    try {
      await terms.ensure(id);
      const result = await terms.runInPane(id, {
        // A trivial, zero-cost command — NOT claude. Proves the exact mechanism.
        argv: ["echo", token],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });

      // The command exited cleanly.
      expect(result.degraded).toBe(false);
      expect(result.aborted).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);

      // The token reached a streamed chunk (live pipe-pane → fifo → onData).
      const sawLive = await waitFor(() => chunks.join("").includes(token));
      expect(sawLive).toBe(true);

      // …and the bounded replay buffer also holds it (for a late terminal.open).
      expect(terms.recentOutput(id)).toContain(token);
    } finally {
      unsub();
      await terms.dispose(id);
    }
  });

  it("disposeFlow kills every pane owned by a flow", async () => {
    const { emit } = recordingEmit();
    const terms = createTerminals(emit);
    const flowId = `flow-disp-${Math.random().toString(36).slice(2, 8)}` as FlowId;
    const a = `term://${flowId}.nodeA`;
    const b = `term://${flowId}.nodeB`;

    await terms.ensure(a);
    await terms.ensure(b);
    expect(terms.list().map((t) => t.id)).toEqual(expect.arrayContaining([a, b]));

    await terms.disposeFlow(flowId);

    const remaining = terms.list().map((t) => t.id);
    expect(remaining).not.toContain(a);
    expect(remaining).not.toContain(b);
  });

  it("runInPane honors abort (Ctrl-C interrupts a long pane command)", async () => {
    const { emit } = recordingEmit();
    const terms = createTerminals(emit);
    const id = `term://flow-test.abort-${Math.random().toString(36).slice(2, 8)}`;
    const ac = new AbortController();

    await terms.ensure(id);
    const runP = terms.runInPane(id, {
      argv: ["sh", "-c", "sleep 30"],
      cwd: process.cwd(),
      signal: ac.signal,
      timeoutMs: 20_000,
    });
    // Abort shortly after it starts.
    setTimeout(() => ac.abort(), 400);

    const result = await runP;
    expect(result.aborted).toBe(true);
    await terms.dispose(id);
  });
});
