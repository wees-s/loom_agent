# Storyline (narração viva) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a live, human-readable, cycle-grouped narrative ("Storyline") of a flow's execution, derived purely from the existing append-only event log.

**Architecture:** A pure `narrateEvent` function in `@loom/shared` maps each `LoomEvent` to a human sentence (`NarrationLine`) or `null`. The web store folds those lines into a bounded `storyline[]` buffer as it already folds events. A new `<Storyline/>` panel renders them. One small backend tweak improves the per-run summary the narration shows. Fully additive — no changes to the event log contract, guard, orchestrator, scheduler, or eventlog.

**Tech Stack:** TypeScript (strict), React 18, zustand, vitest, @testing-library/react.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` (from `tsconfig.base.json`) — use `import type` for type-only imports; guard array index access.
- Cross-package imports go through `@loom/shared` (the barrel `packages/shared/src/index.ts`); engine/web import from `"@loom/shared"`, intra-shared imports use `"./x.js"` (NodeNext: explicit `.js` extension on relative imports).
- Tests are co-located `*.test.ts` / `*.test.tsx` next to source, using `vitest` (`import { describe, it, expect } from "vitest"`).
- No new runtime dependencies.
- Portuguese user-facing copy (matches existing UI).
- Engine tests run with `NODE_OPTIONS=--experimental-sqlite` (CI already sets this); the runner test here touches no sqlite but run it the same way for consistency.

---

### Task 1: `narrateEvent` pure module in `@loom/shared`

**Files:**
- Create: `packages/shared/src/narration.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./narration.js";`)
- Test: `packages/shared/src/narration.test.ts`

**Interfaces:**
- Consumes: `LoomEvent` (events.ts), `NodeId`/`RunId` (ids.ts), `NodeTypeName` (catalog.ts) — all from intra-shared `./*.js`.
- Produces:
  - `interface NarrationLine { id: string; cycle: number; at: number; kind: NarrationKind; actor?: string; text: string; tone: "neutral"|"good"|"warn"|"bad"; artifact?: { path: string; bytes?: number } }`
  - `type NarrationKind = "trigger"|"agent"|"artifact"|"cycle"|"budget"|"kill"|"system"`
  - `interface NarrationCtx { node(id: NodeId): { title: string; type: NodeTypeName } | undefined; runNode(runId: RunId): NodeId | undefined }`
  - `function narrateEvent(ev: LoomEvent, seq: number, ts: number, ctx: NarrationCtx): NarrationLine | null`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/narration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { narrateEvent, type NarrationCtx } from "./index.js";
import { asNodeId, asRunId, asFlowId, asEdgeId } from "./index.js";
import type { LoomEvent } from "./index.js";

const NODE = asNodeId("n1");
const RUN = asRunId("r1");
const FLOW = asFlowId("f1");

const ctx: NarrationCtx = {
  node: (id) => (id === NODE ? { title: "Scribe", type: "Analyst" } : undefined),
  runNode: (rid) => (rid === RUN ? NODE : undefined),
};

function line(ev: LoomEvent) {
  return narrateEvent(ev, 7, 1000, ctx);
}

describe("narrateEvent", () => {
  it("trigger.fired (scheduled) → trigger line", () => {
    const r = line({ type: "trigger.fired", flowId: FLOW, nodeId: NODE, cause: "Agendado", at: 1000 });
    expect(r).toMatchObject({ kind: "trigger", tone: "neutral", id: "7", cycle: -1 });
    expect(r!.text).toContain("disparou");
  });

  it("trigger.fired (feedback) → re-arm wording", () => {
    const r = line({ type: "trigger.fired", flowId: FLOW, nodeId: NODE, cause: "feedback", at: 1000 });
    expect(r!.text.toLowerCase()).toContain("realimentou");
  });

  it("cycle.started → cycle line carrying its own cycle number", () => {
    const r = line({ type: "cycle.started", flowId: FLOW, cycle: 3, at: 1000 });
    expect(r).toMatchObject({ kind: "cycle", cycle: 3 });
    expect(r!.text).toContain("3");
  });

  it("node.activated → agent started, actor resolved", () => {
    const r = line({ type: "node.activated", flowId: FLOW, nodeId: NODE, runId: RUN, cycle: 2 });
    expect(r).toMatchObject({ kind: "agent", actor: "Scribe", cycle: 2, tone: "neutral" });
  });

  it("run.finished ok → good, actor via runNode, uses resultSummary", () => {
    const r = line({ type: "run.finished", runId: RUN, status: "ok", resultSummary: "2 riscos novos", at: 1000 });
    expect(r).toMatchObject({ kind: "agent", actor: "Scribe", tone: "good" });
    expect(r!.text).toContain("2 riscos novos");
  });

  it("run.finished error → bad with error text", () => {
    const r = line({ type: "run.finished", runId: RUN, status: "error", error: "claude saiu com código 1", at: 1000 });
    expect(r).toMatchObject({ tone: "bad" });
    expect(r!.text).toContain("código 1");
  });

  it("run.finished timeout/killed → warn", () => {
    expect(line({ type: "run.finished", runId: RUN, status: "timeout", at: 1000 })!.tone).toBe("warn");
    expect(line({ type: "run.finished", runId: RUN, status: "killed", at: 1000 })!.tone).toBe("warn");
  });

  it("blackboard.write → artifact chip with bytes", () => {
    const r = line({ type: "blackboard.write", flowId: FLOW, path: "resumo.md", byNodeId: NODE, bytes: 2300, hash: "abc", at: 1000 });
    expect(r).toMatchObject({ kind: "artifact", actor: "Scribe", tone: "good" });
    expect(r!.artifact).toEqual({ path: "resumo.md", bytes: 2300 });
  });

  it("cycle.converged → neutral cycle line", () => {
    const r = line({ type: "cycle.converged", flowId: FLOW, cycle: 4, reason: "no-new-output", at: 1000 });
    expect(r).toMatchObject({ kind: "cycle", cycle: 4 });
    expect(r!.text.toLowerCase()).toContain("convergiu");
  });

  it("cycle.ended done → null (noise), stopped → warn, killed → bad", () => {
    expect(line({ type: "cycle.ended", flowId: FLOW, cycle: 1, status: "done", totalUsd: 0, at: 1000 })).toBeNull();
    expect(line({ type: "cycle.ended", flowId: FLOW, cycle: 1, status: "stopped", totalUsd: 0, at: 1000 })!.tone).toBe("warn");
    expect(line({ type: "cycle.ended", flowId: FLOW, cycle: 1, status: "killed", totalUsd: 0, at: 1000 })!.tone).toBe("bad");
  });

  it("budget.tripped → warn budget line", () => {
    const r = line({ type: "budget.tripped", flowId: FLOW, scope: "flow", metric: "usd", limit: 20 });
    expect(r).toMatchObject({ kind: "budget", tone: "warn" });
  });

  it("kill.requested → bad", () => {
    const r = line({ type: "kill.requested", flowId: FLOW, by: "user", at: 1000 });
    expect(r).toMatchObject({ kind: "kill", tone: "bad" });
  });

  it("log maps color → tone", () => {
    expect(line({ type: "log", flowId: FLOW, color: "rose", msg: "x", at: 1000 })!.tone).toBe("bad");
    expect(line({ type: "log", flowId: FLOW, color: "amber", msg: "x", at: 1000 })!.tone).toBe("warn");
  });

  it("unknown node id → actor fallback, never throws", () => {
    const r = line({ type: "node.activated", flowId: FLOW, nodeId: asNodeId("missing"), runId: RUN, cycle: 1 });
    expect(r!.actor).toBeUndefined();
    expect(r!.text.length).toBeGreaterThan(0);
  });

  it("noise events return null", () => {
    expect(line({ type: "run.started", runId: RUN, flowId: FLOW, nodeId: NODE, cycle: 1, model: "claude-sonnet-4-6", at: 1000 })).toBeNull();
    expect(line({ type: "node.deactivated", flowId: FLOW, nodeId: NODE, runId: RUN })).toBeNull();
    expect(line({ type: "run.token", runId: RUN, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0 })).toBeNull();
    expect(line({ type: "edge.fired", flowId: FLOW, edgeId: asEdgeId("e1"), cycle: 1 })).toBeNull();
    expect(line({ type: "terminal.state", terminal: "term://1", status: "idle", meta: "" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loom/shared exec vitest run narration`
Expected: FAIL — `narrateEvent is not a function` / import error (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/narration.ts`:

```ts
// =============================================================================
// narration.ts — PURE event → human sentence mapper for the Storyline view.
//
// No side effects, no React, no store. Maps one LoomEvent to one NarrationLine
// (a ready-to-render human line) or null when the event is noise / already
// covered by another line. Kept in @loom/shared so it is unit-testable and so
// the engine could reuse it later. cycle = the event's own cycle, or -1 when the
// event carries none (the store stamps -1 with the running cycle counter).
// =============================================================================

import type { LoomEvent } from "./events.js";
import type { NodeId, RunId } from "./ids.js";
import type { NodeTypeName } from "./catalog.js";

export type NarrationTone = "neutral" | "good" | "warn" | "bad";

export type NarrationKind =
  | "trigger" | "agent" | "artifact" | "cycle" | "budget" | "kill" | "system";

export interface NarrationLine {
  id: string;          // stable React key — the StoredEvent seq as a string
  cycle: number;       // event's own cycle, or -1 (store stamps with running cycle)
  at: number;          // epoch ms (relative-time rendering)
  kind: NarrationKind;
  actor?: string;      // node/agent title when applicable
  text: string;        // ready human sentence (without the actor prefix)
  tone: NarrationTone;
  artifact?: { path: string; bytes?: number };
}

export interface NarrationCtx {
  node(id: NodeId): { title: string; type: NodeTypeName } | undefined;
  runNode(runId: RunId): NodeId | undefined;
}

/** Map a `log` event color to a tone (mirrors the engine's color conventions). */
function toneFromColor(color: string): NarrationTone {
  if (color === "rose") return "bad";
  if (color === "amber") return "warn";
  if (color === "green") return "good";
  return "neutral";
}

/** Human label for a finished run's failure status. */
function failTone(status: string): NarrationTone {
  if (status === "error" || status === "budget_exceeded") return "bad";
  return "warn"; // timeout | killed | anything else non-ok
}

export function narrateEvent(
  ev: LoomEvent,
  seq: number,
  ts: number,
  ctx: NarrationCtx,
): NarrationLine | null {
  const id = String(seq);
  const base = { id, at: ts } as const;

  switch (ev.type) {
    case "trigger.fired": {
      const text =
        ev.cause === "feedback"
          ? "realimentou o ciclo"
          : `${ev.cause} disparou o fluxo`;
      return { ...base, cycle: -1, kind: "trigger", tone: "neutral", text };
    }
    case "cycle.started":
      return { ...base, cycle: ev.cycle, kind: "cycle", tone: "neutral", text: `Ciclo ${ev.cycle} começou` };
    case "cycle.converged":
      return { ...base, cycle: ev.cycle, kind: "cycle", tone: "neutral", text: `Ciclo ${ev.cycle} convergiu — sem saída nova` };
    case "cycle.ended": {
      if (ev.status === "done" || ev.status === "converged") return null; // noise / dup
      const tone: NarrationTone = ev.status === "killed" ? "bad" : "warn";
      return { ...base, cycle: ev.cycle, kind: "cycle", tone, text: `Ciclo ${ev.cycle} parou (${ev.status})` };
    }
    case "node.activated": {
      const actor = ctx.node(ev.nodeId)?.title;
      return { ...base, cycle: ev.cycle, kind: "agent", tone: "neutral", ...(actor ? { actor } : {}), text: actor ? "começou a trabalhar" : "um agente começou a trabalhar" };
    }
    case "run.finished": {
      const nodeId = ctx.runNode(ev.runId);
      const actor = nodeId ? ctx.node(nodeId)?.title : undefined;
      if (ev.status === "ok") {
        const text = ev.resultSummary ?? "concluiu";
        return { ...base, cycle: -1, kind: "agent", tone: "good", ...(actor ? { actor } : {}), text };
      }
      const detail = ev.error ?? ev.status;
      return { ...base, cycle: -1, kind: "agent", tone: failTone(ev.status), ...(actor ? { actor } : {}), text: `falhou: ${detail}` };
    }
    case "blackboard.write": {
      const actor = ctx.node(ev.byNodeId)?.title;
      return {
        ...base, cycle: -1, kind: "artifact", tone: "good",
        ...(actor ? { actor } : {}),
        text: `escreveu ${ev.path}`,
        artifact: { path: ev.path, bytes: ev.bytes },
      };
    }
    case "budget.tripped": {
      const metric = ev.metric === "usd" ? "custo" : ev.metric === "tokens" ? "tokens" : "ciclos";
      const scope = ev.scope === "run" ? "do run" : ev.scope === "flow" ? "do fluxo" : "de ciclos";
      return { ...base, cycle: -1, kind: "budget", tone: "warn", text: `teto de ${metric} ${scope} atingido (${ev.limit})` };
    }
    case "kill.requested":
      return { ...base, cycle: -1, kind: "kill", tone: "bad", text: `fluxo interrompido (${ev.by})` };
    case "log":
      return { ...base, cycle: -1, kind: "system", tone: toneFromColor(ev.color), text: ev.msg };
    // Noise / already covered elsewhere → no line.
    case "run.started":
    case "run.token":
    case "run.tool":
    case "run.output":
    case "node.deactivated":
    case "edge.fired":
    case "terminal.state":
    case "flow.upserted":
    case "flow.removed":
    case "flow.spec.changed":
    case "flow.stateChanged":
    case "auth.state":
      return null;
    default:
      return null;
  }
}
```

Add to `packages/shared/src/index.ts` (after the existing exports):

```ts
export * from "./narration.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @loom/shared exec vitest run narration`
Expected: PASS (all `narrateEvent` cases green).

- [ ] **Step 5: Typecheck shared**

Run: `pnpm --filter @loom/shared typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/narration.ts packages/shared/src/narration.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): narrateEvent — pure event→human-line mapper for Storyline"
```

---

### Task 2: Better per-run summary in the runner

**Files:**
- Modify: `packages/engine/src/runner.ts` (the `summarize` function ~lines 101-110; add `export`)
- Test: `packages/engine/src/runner.test.ts`

**Interfaces:**
- Produces: `export function summarize(text: string): string | undefined` — now returns the LAST meaningful line of pane text (the agent's conclusion), ANSI-stripped, instead of the first line.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/runner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { summarize } from "./runner.js";

describe("summarize", () => {
  it("returns the last meaningful line (the conclusion), not the first", () => {
    const pane = [
      "\x1b[2m$ claude -p ...\x1b[0m",
      "Welcome to Claude Code",
      "",
      "Analisei o log e encontrei 2 riscos novos.",
    ].join("\n");
    expect(summarize(pane)).toBe("Analisei o log e encontrei 2 riscos novos.");
  });

  it("strips ANSI escapes", () => {
    expect(summarize("\x1b[32mpronto\x1b[0m")).toBe("pronto");
  });

  it("skips trailing shell prompt lines", () => {
    const pane = ["resultado final aqui", "$ "].join("\n");
    expect(summarize(pane)).toBe("resultado final aqui");
  });

  it("returns undefined for empty / whitespace-only input", () => {
    expect(summarize("   \n  \n")).toBeUndefined();
  });

  it("truncates very long lines with an ellipsis", () => {
    const long = "x".repeat(300);
    const out = summarize(long)!;
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine exec vitest run runner`
Expected: FAIL — `summarize` is not exported (import error) OR first/last assertion mismatch.

- [ ] **Step 3: Write minimal implementation**

In `packages/engine/src/runner.ts`, replace the existing `summarize` function with:

```ts
/** Last meaningful line of pane text (the agent's conclusion), ANSI-stripped,
 *  trimmed and truncated, for the recent-runs / Storyline label. Exported for
 *  unit testing. */
export function summarize(text: string): string | undefined {
  // Strip ANSI escapes so the summary stays readable.
  const noAnsi = text.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = noAnsi
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== "$" && !l.startsWith("$ "));
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  return last.length > SUMMARY_MAX
    ? last.slice(0, SUMMARY_MAX - 1).trimEnd() + "…"
    : last;
}
```

(The `SUMMARY_MAX = 160` constant already exists above this function — reuse it. Only the body and the `export` change; remove the old first-line version.)

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine exec vitest run runner`
Expected: PASS.

- [ ] **Step 5: Run the full engine suite (no regressions)**

Run: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine test`
Expected: PASS (existing suites unaffected — `summarize` is internal to result labelling).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/runner.ts packages/engine/src/runner.test.ts
git commit -m "feat(engine): summarize returns the agent's conclusion (last line), not the first"
```

---

### Task 3: Storyline projection in the web store

**Files:**
- Modify: `packages/web/src/store.ts` (add `storyline` state, fold narration in the `"event"` case, clear on `selectFlow` + `flow.removed`, add selector)
- Test: `packages/web/src/store.storyline.test.ts`

**Interfaces:**
- Consumes: `narrateEvent`, `NarrationLine`, `NarrationCtx` from `@loom/shared` (Task 1).
- Produces:
  - `LoomState.storyline: NarrationLine[]`
  - `selectStoryline(s: LoomState): NarrationLine[]`
  - constant `STORYLINE_MAX = 300` (module-local)

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/store.storyline.test.ts`:

```ts
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
    // trigger + cycle + activated + write + finished = 5 narratable lines
    expect(lines.map((l) => l.kind)).toEqual(["trigger", "cycle", "agent", "artifact", "agent"]);
    // run.finished (cycle -1 in the event) is stamped with the running cycle (1)
    expect(lines[4]!.cycle).toBe(1);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loom/web exec vitest run store.storyline`
Expected: FAIL — `selectStoryline` is not exported / `storyline` undefined.

- [ ] **Step 3: Write minimal implementation**

In `packages/web/src/store.ts`:

(a) Extend the imports from `@loom/shared` to add the narration types/fn. Add to the existing `import type { ... }` block: `NarrationLine`. Add to the existing value `import { ... }` block: `narrateEvent`. (Add `type NarrationCtx` to the type import block too.)

(b) Add the buffer cap constant near the other module constants (after `DEFAULT_MODEL`):

```ts
/** Max Storyline lines retained (bounded buffer; oldest dropped). */
const STORYLINE_MAX = 300;
```

(c) Add `storyline: NarrationLine[];` to the `LoomState` interface (in the "log strip + cycle" section) and initialize `storyline: [],` in the `create<LoomState>` initial state (next to `logs: [],`).

(d) In `applyServerMessage`, `case "event":`, thread a storyline buffer through the fold loop. Replace the loop + `set(...)` with:

```ts
        let working = get();
        let maxSeq = working.lastSeq;
        let activeTerm: string | null = null;
        let storyline = working.storyline;
        const events = [...msg.events].sort((a, b) => a.seq - b.seq);
        for (const stored of events) {
          if (stored.seq <= working.lastSeq) continue; // already folded
          const ev = stored.event;
          if (
            ev.type === "terminal.state" &&
            (ev.status === "busy" || ev.status === "scribe" || ev.status === "executor")
          ) {
            activeTerm = ev.terminal;
          }
          const patch = foldEvent(working, ev, stored.ts);
          working = { ...working, ...patch } as LoomState;
          // Storyline: pure projection of the same event stream.
          const ctx: NarrationCtx = {
            node: (id) => {
              const fid = working.selectedFlowId;
              const flow = fid ? working.flowsById[fid] : undefined;
              const n = flow?.nodes.find((x) => x.id === id);
              return n ? { title: n.title, type: n.type } : undefined;
            },
            runNode: (rid) => working.runNode[rid],
          };
          const nl = narrateEvent(ev, stored.seq, stored.ts, ctx);
          if (nl) {
            const stamped = nl.cycle === -1 ? { ...nl, cycle: working.cycle } : nl;
            storyline = [...storyline, stamped].slice(-STORYLINE_MAX);
          }
          if (stored.seq > maxSeq) maxSeq = stored.seq;
        }
        set({
          flowsById: working.flowsById,
          flows: working.flows,
          runsByNode: working.runsByNode,
          activeNodeIds: working.activeNodeIds,
          activeEdgeIds: working.activeEdgeIds,
          runNode: working.runNode,
          terminals: working.terminals,
          logs: working.logs,
          cycle: working.cycle,
          running: working.running,
          selectedFlowId: working.selectedFlowId,
          selectedNodeId: working.selectedNodeId,
          selectedEdgeId: working.selectedEdgeId,
          storyline,
          lastSeq: maxSeq,
        });
```

(e) In `foldEvent`, the `case "flow.removed":` block, when it clears the selection (inside the `if (state.selectedFlowId === ev.flowId)` branch), add `patch.storyline = [];`.

(f) In the `selectFlow` action's `set({...})`, add `storyline: [],` (clearing the previous flow's narrative, alongside the `activeNodeIds`/`activeEdgeIds` clears).

(g) Add the selector near the other selectors at the bottom of the file:

```ts
export const selectStoryline = (s: LoomState): NarrationLine[] => s.storyline;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @loom/web exec vitest run store.storyline`
Expected: PASS.

- [ ] **Step 5: Typecheck web**

Run: `pnpm --filter @loom/web typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/store.ts packages/web/src/store.storyline.test.ts
git commit -m "feat(web): fold a bounded Storyline projection from the event stream"
```

---

### Task 4: `<Storyline/>` panel + App integration

**Files:**
- Create: `packages/web/src/components/Storyline.tsx`
- Modify: `packages/web/src/store.ts` (add `storylineOpen` UI flag + `toggleStoryline` action)
- Modify: `packages/web/src/App.tsx` (render the panel in the middle row)
- Test: `packages/web/src/components/Storyline.test.tsx`

**Interfaces:**
- Consumes: `selectStoryline` + `storylineOpen`/`toggleStoryline` from the store; `NarrationLine`/`NarrationKind` from `@loom/shared`.
- Produces: `export function Storyline(): JSX.Element` (self-wired to the store).

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/Storyline.test.tsx`:

```tsx
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
    expect(screen.getByText(/Ciclo 1/)).toBeInTheDocument();
  });

  it("shows a friendly empty state when there is nothing yet", () => {
    useLoomStore.setState({ storyline: [] });
    render(<Storyline />);
    expect(screen.getByText(/Nada rolando ainda/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loom/web exec vitest run Storyline`
Expected: FAIL — cannot find module `./Storyline` / `storylineOpen` undefined.

- [ ] **Step 3: Add the UI flag + action to the store**

In `packages/web/src/store.ts`:
- Add `storylineOpen: boolean;` to `LoomState` (in the UI-state section near `railOpen`).
- Add `toggleStoryline: () => void;` to the actions section near `setRailOpen`.
- Initialize `storylineOpen: true,` in the initial state (near `railOpen: false,`).
- Implement the action near `setRailOpen`:

```ts
  toggleStoryline: () => set((s) => ({ storylineOpen: !s.storylineOpen })),
```

- [ ] **Step 4: Write the component**

Create `packages/web/src/components/Storyline.tsx`:

```tsx
import { type CSSProperties, useMemo } from "react";
import { useLoomStore, selectStoryline } from "../store";
import type { NarrationLine, NarrationKind, NarrationTone } from "@loom/shared";

/* ════════════════════════════════════════════════════════════════════════
 * Storyline — a calm, human, live narrative of the selected flow's run.
 * Pure projection of store.storyline (folded from the event log). Grouped by
 * cycle, newest cycle first. No authoritative state of its own.
 * ════════════════════════════════════════════════════════════════════════ */

const PANEL_STYLE: CSSProperties = {
  width: 300,
  flex: "none",
  display: "flex",
  flexDirection: "column",
  borderRadius: 15,
  background: "var(--glass)",
  backdropFilter: "blur(22px) saturate(1.4)",
  WebkitBackdropFilter: "blur(22px) saturate(1.4)",
  border: "1px solid var(--glass-border)",
  boxShadow: "0 10px 40px -16px rgba(30,55,45,0.18),inset 0 1px 0 rgba(255,255,255,0.7)",
  overflow: "hidden",
};

const HEADER_STYLE: CSSProperties = {
  padding: "11px 15px",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: "-.01em",
  color: "var(--text)",
  borderBottom: "1px solid var(--line2)",
};

const FEED_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "8px 12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const CYCLE_HEADER_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10.5,
  color: "var(--muted2)",
  margin: "12px 0 4px",
};

const TONE_DOT: Record<NarrationTone, string> = {
  neutral: "var(--line2)",
  good: "oklch(0.62 0.14 160)",
  warn: "oklch(0.78 0.13 80)",
  bad: "oklch(0.62 0.18 25)",
};

const KIND_ICON: Record<NarrationKind, string> = {
  trigger: "⚡", agent: "●", artifact: "✎", cycle: "↻", budget: "⚠", kill: "■", system: "·",
};

function relTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m}min`;
  return `há ${Math.round(m / 60)}h`;
}

function Line({ line }: { line: NarrationLine }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5, lineHeight: 1.45 }}>
      <span style={{ color: TONE_DOT[line.tone], flex: "none", fontSize: 11 }}>{KIND_ICON[line.kind]}</span>
      <span style={{ flex: 1, minWidth: 0, color: "var(--text2)" }}>
        {line.actor && <strong style={{ color: "var(--text)" }}>{line.actor} </strong>}
        {line.text}
        {line.artifact && (
          <span style={{ marginLeft: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "var(--muted)" }}>
            {line.artifact.path}
            {typeof line.artifact.bytes === "number" ? ` · ${formatBytes(line.artifact.bytes)}` : ""}
          </span>
        )}
      </span>
      <span style={{ flex: "none", fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: "var(--muted)" }}>
        {relTime(line.at)}
      </span>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} kB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function Storyline() {
  const storyline = useLoomStore(selectStoryline);
  const open = useLoomStore((s) => s.storylineOpen);

  // Group by cycle, newest cycle first (lines within a cycle stay chronological).
  const groups = useMemo(() => {
    const byCycle = new Map<number, NarrationLine[]>();
    for (const l of storyline) {
      const arr = byCycle.get(l.cycle);
      if (arr) arr.push(l);
      else byCycle.set(l.cycle, [l]);
    }
    return [...byCycle.entries()].sort((a, b) => b[0] - a[0]);
  }, [storyline]);

  if (!open) return null;

  return (
    <div style={PANEL_STYLE} data-storyline>
      <div style={HEADER_STYLE}>Storyline</div>
      <div style={FEED_STYLE}>
        {storyline.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 12.5, padding: "20px 4px", lineHeight: 1.5 }}>
            Nada rolando ainda — aperte ▶ para começar e acompanhe aqui o que cada agente faz.
          </div>
        ) : (
          groups.map(([cycle, lines]) => (
            <div key={cycle}>
              <div style={CYCLE_HEADER_STYLE}>{cycle > 0 ? `Ciclo ${cycle}` : "Início"}</div>
              {lines.map((l) => (
                <Line key={l.id} line={l} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default Storyline;
```

- [ ] **Step 5: Integrate into the App layout**

In `packages/web/src/App.tsx`:
- Add the import near the other component imports: `import { Storyline } from "./components/Storyline";`
- In the middle row, render `<Storyline />` immediately after `<Inspector />`:

```tsx
          <Inspector />
          <Storyline />
```

- [ ] **Step 6: Run the component test to verify it passes**

Run: `pnpm --filter @loom/web exec vitest run Storyline`
Expected: PASS.

- [ ] **Step 7: Typecheck + full web suite**

Run: `pnpm --filter @loom/web typecheck && pnpm --filter @loom/web test`
Expected: no type errors; all web tests pass (including the existing App.interaction + TerminalPanel suites).

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/Storyline.tsx packages/web/src/components/Storyline.test.tsx packages/web/src/store.ts packages/web/src/App.tsx
git commit -m "feat(web): Storyline panel — live human narrative of a flow's run"
```

---

## Final verification

- [ ] **Run all gates across the monorepo**

Run: `pnpm -r typecheck && NODE_OPTIONS=--experimental-sqlite pnpm -r test && pnpm -r build`
Expected: typecheck clean, all suites pass (shared now includes narration, web includes store.storyline + Storyline, engine includes runner), build succeeds.

---

## Self-review notes (author)

- **Spec coverage:** §4.1 narration module → Task 1. §4.2 store projection → Task 3. §4.3 component → Task 4. §4.4 runner summary → Task 2. §7 tests → Tasks 1/2/3/4 each ship their tests (closes the shared + store coverage gaps from review_loom.md). §6 bounded buffer → Task 3 `STORYLINE_MAX` + cap test. §5 UX (newest cycle first, grouping, relative time) → Task 4.
- **Type consistency:** `NarrationLine`/`NarrationKind`/`NarrationTone`/`NarrationCtx`/`narrateEvent` defined in Task 1 and consumed verbatim in Tasks 3 & 4. `selectStoryline` defined in Task 3, consumed in Task 4. `summarize` exported in Task 2.
- **Layout decision (resolved):** Storyline renders as a fixed 300px glass panel after the Inspector in the middle row, toggleable via `storylineOpen` (default open). Canvas `flex:1` absorbs the width. A wiring of the toggle button into TopBar/Inspector is deferred to the D (estética) slice — the flag + action exist now so it is one line to wire later.
- **No placeholders:** every code step shows complete code; every run step shows the command + expected result.
