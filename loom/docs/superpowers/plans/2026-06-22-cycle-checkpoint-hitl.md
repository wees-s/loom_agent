# Checkpoint entre ciclos (Human-in-the-loop v1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional per-flow "review each cycle" mode where a feedback loop pauses into an `aguardando` state after each cycle and waits for an explicit `flow.continue` before re-arming.

**Architecture:** Insert a checkpoint at the orchestrator's feedback re-arm point (after `guard.requestNextCycle` approves). When `reviewEachCycle` is on, emit `cycle.awaitingApproval`, set state `aguardando`, store an in-memory pending continuation, and return without recursing. `flow.continue` resumes the already-approved arm. The guard's admission logic is untouched — the checkpoint can only *defer* a re-arm, never enable new spend.

**Tech Stack:** TypeScript (strict), zod, React 18, zustand, vitest.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`; `import type` for type-only; explicit `.js` on relative imports.
- Cross-package via `@loom/shared`; inbound WS commands validated by `zClientCommand`; YAML spec validated by `zFlowSpec`.
- The automatic path (`reviewEachCycle` absent/false) MUST stay byte-for-byte equivalent — existing engine tests are the regression guard.
- Portuguese user-facing copy.
- `reviewEachCycle` persists on the spec (survives restart), round-tripped exactly like `workDir`.
- Engine tests run with `NODE_OPTIONS=--experimental-sqlite`.

---

### Task 1: Contracts — event, state, command, spec field, narration

**Files:**
- Modify: `packages/shared/src/events.ts` (add `cycle.awaitingApproval`)
- Modify: `packages/shared/src/domain.ts` (`FlowState` += `"aguardando"`; `Flow.reviewEachCycle?: boolean`)
- Modify: `packages/shared/src/protocol.ts` (`ClientCommand` += `flow.continue`; `EditableFlow.reviewEachCycle?`)
- Modify: `packages/shared/src/schemas.ts` (`zClientCommand` += `flow.continue`; `zFlowSpec` + `zEditableFlow` += `reviewEachCycle`)
- Modify: `packages/shared/src/narration.ts` (narrate `cycle.awaitingApproval`)
- Test: `packages/shared/src/narration.test.ts` (append a case); `packages/shared/src/contracts.test.ts` (append zod cases)

**Interfaces produced:**
- Event: `{ type: "cycle.awaitingApproval"; flowId: FlowId; cycle: number; nextArm: number; at: number }`
- `FlowState` includes `"aguardando"`
- Command: `{ t: "flow.continue"; cmdId: string; flowId: FlowId }`
- `Flow.reviewEachCycle?: boolean`, `EditableFlow.reviewEachCycle?: boolean`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/narration.test.ts` (inside the `describe`):

```ts
  it("cycle.awaitingApproval → warn cycle line", () => {
    const r = line({ type: "cycle.awaitingApproval", flowId: FLOW, cycle: 2, nextArm: 1, at: 1000 });
    expect(r).toMatchObject({ kind: "cycle", tone: "warn", cycle: 2 });
    expect(r!.text.toLowerCase()).toContain("aprova");
  });
```

Append to `packages/shared/src/contracts.test.ts` (new `describe` at end of file):

```ts
describe("flow.continue + reviewEachCycle contracts", () => {
  it("zClientCommand accepts flow.continue", () => {
    const r = zClientCommand.safeParse({ t: "flow.continue", cmdId: "c1", flowId: "f1" });
    expect(r.success).toBe(true);
  });
  it("zClientCommand rejects flow.continue without flowId", () => {
    const r = zClientCommand.safeParse({ t: "flow.continue", cmdId: "c1" });
    expect(r.success).toBe(false);
  });
  it("zFlowSpec accepts an optional reviewEachCycle boolean", () => {
    const base = {
      id: "f1", name: "x", version: 1, schedule: "manual", blackboardDir: "f1",
      budget: { maxCyclesPerArm: 4, maxTokensPerRun: 1, maxUsdPerRun: 1, maxTokensPerFlow: 1, maxUsdPerFlow: 1, maxConcurrentAgents: 1, convergenceWindow: 1 },
      nodes: [{ id: "n1", type: "Trigger", title: "t", role: "", model: MODEL_CATALOG[0]!.id, prompt: "", position: { x: 0, y: 0 } }],
      edges: [],
    };
    expect(zFlowSpec.safeParse({ ...base, reviewEachCycle: true }).success).toBe(true);
    expect(zFlowSpec.safeParse(base).success).toBe(true);
  });
});
```

(Add `zFlowSpec` to the imports at the top of `contracts.test.ts` — it already imports several names from `./index.js`; `MODEL_CATALOG` is already imported.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @loom/shared exec vitest run narration contracts`
Expected: FAIL — `cycle.awaitingApproval` not a valid event type (TS) / `flow.continue` rejected / `reviewEachCycle` unknown.

- [ ] **Step 3: Implement the contracts**

In `events.ts`, add to the `LoomEvent` union (next to the other `cycle.*` lines):

```ts
  | { type: "cycle.awaitingApproval"; flowId: FlowId; cycle: number; nextArm: number; at: number }
```

In `domain.ts`:

```ts
export type FlowState = "rodando" | "agendado" | "ocioso" | "pausado" | "rascunho" | "aguardando";
```

and add to the `Flow` interface (after `workDir?`):

```ts
  /** When true, a feedback loop pauses into "aguardando" after each cycle and
   *  waits for an explicit flow.continue before re-arming (human-in-the-loop). */
  reviewEachCycle?: boolean;
```

In `protocol.ts`, add to `ClientCommand`:

```ts
  | { t: "flow.continue"; cmdId: string; flowId: FlowId }
```

and to `EditableFlow` (after `workDir?`):

```ts
  /** Persisted review-each-cycle preference (human-in-the-loop checkpoint). */
  reviewEachCycle?: boolean;
```

In `schemas.ts`, add to `zClientCommand`'s union:

```ts
  z.object({ t: z.literal("flow.continue"), cmdId: z.string(), flowId: z.string() }),
```

add `reviewEachCycle: z.boolean().optional(),` to BOTH `zFlowSpec` and `zEditableFlow` object shapes.

In `narration.ts`, add a case BEFORE the `cycle.ended` case (so the switch stays tidy):

```ts
    case "cycle.awaitingApproval":
      return { ...base, cycle: ev.cycle, kind: "cycle", tone: "warn", text: `Ciclo ${ev.cycle} concluído — aguardando sua aprovação` };
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `pnpm --filter @loom/shared exec vitest run narration contracts && pnpm --filter @loom/shared typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): contracts for cycle checkpoint — awaitingApproval event, aguardando state, flow.continue, reviewEachCycle"
```

---

### Task 2: Orchestrator — checkpoint branch + continueFlow + recovery normalize

**Files:**
- Modify: `packages/engine/src/orchestrator.ts` (add `pendingApprovals`/`awaiting`; `reviewEachCycle` branch in re-arm; `continueFlow`/`isAwaiting`/`clearAwaiting`; normalize `aguardando` in `recoverOrphans`; extend the `Orchestrator` interface + `CycleOutcome`)
- Test: `packages/engine/src/orchestrator.checkpoint.test.ts`

**Interfaces produced (added to `Orchestrator`):**
- `continueFlow(flowId: FlowId): Promise<CycleOutcome | null>` — resume the pending approved arm; `null` if nothing pending.
- `isAwaiting(flowId: FlowId): boolean`
- `clearAwaiting(flowId: FlowId): void`
- `CycleOutcome` gains `| { status: "awaiting"; cycle: number }`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/orchestrator.checkpoint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createOrchestrator } from "./orchestrator.js";
import type { Guard } from "./guard.js";
import type { Runner } from "./runner.js";
import type { Blackboard } from "./blackboard.js";
import type { SpecStore } from "./spec.js";
import type { Terminals } from "./terminals.js";
import type { EventLog } from "./eventlog.js";
import type { Emit, RunCtx, RunResult } from "./internal.js";
import {
  asFlowId, asNodeId, asEdgeId, type Flow, type LoomEvent, type StoredEvent,
} from "@loom/shared";

const FLOW = asFlowId("f1");
const TRIG = asNodeId("trig");
const WORK = asNodeId("work");

function makeFlow(reviewEachCycle: boolean): Flow {
  return {
    id: FLOW, name: "loop", version: 1, schedule: "manual", state: "ocioso", cycle: 0,
    reviewEachCycle,
    nodes: [
      { id: TRIG, type: "Trigger", title: "Trigger", role: "entry", model: "claude-haiku-4-5", prompt: "", linkedContexts: [], position: { x: 0, y: 0 } },
      { id: WORK, type: "Analyst", title: "Worker", role: "w", model: "claude-haiku-4-5", prompt: "faz", linkedContexts: [], position: { x: 1, y: 0 } },
    ],
    edges: [
      { id: asEdgeId("e1"), from: TRIG, to: WORK },
      { id: asEdgeId("e2"), from: WORK, to: TRIG, feedback: true }, // feedback loop
    ],
    budget: { maxCyclesPerArm: 10, maxTokensPerRun: 999999, maxUsdPerRun: 999, maxTokensPerFlow: 9999999, maxUsdPerFlow: 9999, maxConcurrentAgents: 3, convergenceWindow: 99 },
    blackboardDir: "f1",
  };
}

function harness(flow: Flow) {
  const events: LoomEvent[] = [];
  const emit: Emit = (event) => { events.push(event); return { seq: events.length, ts: 1, event } as StoredEvent; };
  let cycleN = 0;
  const eventlog = { cycleCounter: () => cycleN, foldForOrphanRecovery: () => ({ unfinishedRuns: [], lastCycleByFlow: {} }) } as unknown as EventLog;
  // Guard fake: admit every spawn + every next cycle; count next-cycle grants.
  let nextCalls = 0;
  const guard = {
    requestSpawn: () => ({ ok: true, value: { leaseId: "l", runId: "r", flowId: FLOW, model: "claude-haiku-4-5", reservedUsd: 0, reservedTokens: 0, signal: new AbortController().signal, grantedAt: 0 } }),
    releaseLease: () => {},
    requestNextCycle: () => { nextCalls++; cycleN++; return { ok: true, value: { arm: nextCalls, cycle: cycleN + 1 } }; },
    spendForFlow: () => ({ flowId: FLOW, usdSpent: 0, tokensSpent: 0, usdReserved: 0, tokensReserved: 0 }),
    registerTerminal: () => {}, unregisterTerminal: () => {}, meterToken: () => {},
  } as unknown as Guard;
  // Runner fake: every run ok, no artifacts (nodes declare no produces → barrier passes on ok).
  const runner = {
    mode: "fake" as const,
    runAgent: async (ctx: RunCtx): Promise<RunResult> => {
      emit({ type: "run.started", runId: ctx.runId, flowId: FLOW, nodeId: ctx.node.id, cycle: ctx.cycle, model: ctx.model, at: 1 });
      emit({ type: "run.finished", runId: ctx.runId, status: "ok", at: 1 });
      return { runId: ctx.runId, status: "ok", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, toolCalls: 0, artifacts: {} };
    },
  } as unknown as Runner;
  const blackboard = {
    resolveDir: () => "/tmp/f1",
    toWindowsPath: async (p: string) => p,
    sha256: async () => undefined,
    resolveContext: () => ({ kind: "file", relPath: "x" }),
  } as unknown as Blackboard;
  const spec = { get: () => flow } as unknown as SpecStore;
  const terminals = { setOwnership: () => {}, ensure: async () => {} } as unknown as Terminals;
  const orch = createOrchestrator(eventlog, guard, runner, blackboard, spec, terminals, emit);
  return { orch, events, runCount: () => events.filter((e) => e.type === "run.started").length };
}

describe("orchestrator cycle checkpoint", () => {
  it("review mode: pauses into awaiting after the first cycle, no next-arm runs", async () => {
    const { orch, events, runCount } = harness(makeFlow(true));
    const out = await orch.startCycle(makeFlow(true), "Manual", 0);
    expect(out.status).toBe("awaiting");
    expect(orch.isAwaiting(FLOW)).toBe(true);
    expect(events.some((e) => e.type === "cycle.awaitingApproval")).toBe(true);
    expect(events.some((e) => e.type === "flow.stateChanged" && (e as { state: string }).state === "aguardando")).toBe(true);
    // Exactly one Worker run happened (the first cycle); the next arm did NOT run.
    expect(runCount()).toBe(1);
  });

  it("continueFlow resumes the approved arm (a second cycle runs)", async () => {
    const flow = makeFlow(true);
    const { orch, runCount } = harness(flow);
    await orch.startCycle(flow, "Manual", 0);
    expect(runCount()).toBe(1);
    const resumed = await orch.continueFlow(FLOW);
    expect(resumed).not.toBeNull();
    expect(runCount()).toBe(2); // the next cycle ran after continue
  });

  it("auto mode (reviewEachCycle false): re-arms itself until the guard stops it", async () => {
    const flow = makeFlow(false);
    // maxCyclesPerArm 10 + convergence 99; our guard fake never converges, so cap
    // the recursion by lowering nextCalls ceiling: stop after arm reaches 3.
    const { orch } = harness(flow);
    // Override requestNextCycle behavior is fixed in harness (always ok). To bound
    // the loop deterministically, we assert it does NOT enter awaiting and the
    // run count grows past 1 (it recursed). We bound via a small maxCyclesPerArm.
    const bounded = { ...flow, budget: { ...flow.budget, maxCyclesPerArm: 3 } };
    const h2 = harness(bounded);
    const out = await h2.orch.startCycle(bounded, "Manual", 0);
    expect(out.status).not.toBe("awaiting");
    expect(h2.orch.isAwaiting(FLOW)).toBe(false);
  });

  it("clearAwaiting cancels a pending continuation", async () => {
    const flow = makeFlow(true);
    const { orch } = harness(flow);
    await orch.startCycle(flow, "Manual", 0);
    expect(orch.isAwaiting(FLOW)).toBe(true);
    orch.clearAwaiting(FLOW);
    expect(orch.isAwaiting(FLOW)).toBe(false);
    expect(await orch.continueFlow(FLOW)).toBeNull();
  });
});
```

Note: the auto-mode test uses the harness's fixed guard fake (always-ok next cycle); to keep it deterministic the orchestrator's own `maxCyclesPerArm` is irrelevant here because the guard fake decides — so the assertion is limited to "never awaiting + isAwaiting false". The review-mode tests are the substantive ones.

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine exec vitest run orchestrator.checkpoint`
Expected: FAIL — `continueFlow`/`isAwaiting`/`clearAwaiting` not on the orchestrator; `status "awaiting"` never returned.

- [ ] **Step 3: Implement**

In `orchestrator.ts`:

(a) Extend `CycleOutcome`:

```ts
export type CycleOutcome =
  | { status: "done"; cycle: number }
  | { status: "converged"; cycle: number; reason: "no-new-output" }
  | { status: "stopped"; cycle: number; reason: string }
  | { status: "killed"; cycle: number }
  | { status: "awaiting"; cycle: number };
```

(b) Add to the `Orchestrator` interface:

```ts
  /** Human-in-the-loop: resume a flow paused at a cycle checkpoint. Returns the
   *  next cycle's outcome, or null if nothing was awaiting. */
  continueFlow(flowId: FlowId): Promise<CycleOutcome | null>;
  /** True while a flow is paused at a cycle checkpoint (scheduler no-overlap). */
  isAwaiting(flowId: FlowId): boolean;
  /** Drop a pending checkpoint continuation (pause/kill). */
  clearAwaiting(flowId: FlowId): void;
```

(c) Inside `createOrchestrator`, near `const running = new Set<string>();`:

```ts
  /** Flows paused at a cycle checkpoint → the approved next arm to resume with. */
  const pendingApprovals = new Map<string, { arm: number }>();
```

(d) In `startCycle`, the feedback re-arm `if (next.ok) {` block: after emitting `edge.fired` and the `cycle.ended {done}`, REPLACE the immediate `return await startCycle(f, "feedback", arm + 1)` with:

```ts
          // Close out THIS cycle as done before continuing.
          emit({
            type: "cycle.ended",
            flowId: f.id,
            cycle,
            status: "done",
            totalUsd: cycleSpend(f.id),
            at: Date.now(),
          });

          // HUMAN-IN-THE-LOOP checkpoint: if the flow reviews each cycle, pause
          // here (the next arm is already admitted by the guard) and wait for an
          // explicit flow.continue. Strictly more conservative — we only DEFER.
          if (f.reviewEachCycle === true) {
            pendingApprovals.set(f.id as string, { arm: next.value.arm });
            emit({
              type: "cycle.awaitingApproval",
              flowId: f.id,
              cycle,
              nextArm: next.value.arm,
              at: Date.now(),
            });
            emit({ type: "flow.stateChanged", flowId: f.id, state: "aguardando" });
            return { status: "awaiting", cycle };
          }

          // Auto mode: recurse on the next arm (running flag stays set).
          return await startCycle(f, "feedback", next.value.arm);
```

(Remove the now-duplicated `cycle.ended {done}` + `return await startCycle(... arm + 1)` lines that previously lived here — there must be exactly one `cycle.ended {done}` emit on this path. Use `next.value.arm` (equals `arm + 1`).)

(e) Add the three methods inside `createOrchestrator` (before the `return { ... }`):

```ts
  function isAwaiting(flowId: FlowId): boolean {
    return pendingApprovals.has(flowId as string);
  }

  function clearAwaiting(flowId: FlowId): void {
    pendingApprovals.delete(flowId as string);
  }

  async function continueFlow(flowId: FlowId): Promise<CycleOutcome | null> {
    const pending = pendingApprovals.get(flowId as string);
    if (!pending) return null;
    pendingApprovals.delete(flowId as string);
    const flow = spec.get(flowId);
    if (!flow) return null;
    emit({ type: "flow.stateChanged", flowId, state: "rodando" });
    return startCycle(flow, "feedback", pending.arm);
  }
```

(f) Add to the returned object: `continueFlow, isAwaiting, clearAwaiting,`.

(g) In `recoverOrphans`, after the existing loops, normalize stuck `aguardando`:

```ts
    // A flow projected as "aguardando" lost its in-memory pending continuation on
    // restart — normalize to "ocioso" so the Continue affordance is never dead.
    for (const [flowIdStr] of Object.entries(recovered.lastCycleByFlow)) {
      const flowId = flowIdStr as FlowId;
      emit({ type: "flow.stateChanged", flowId, state: "ocioso" });
    }
```

(Guard: only emit when the projected state is actually `aguardando`. `recovered.lastCycleByFlow` does not carry state, so guard on `spec.get(flowId)?.state`. If `Flow.state` is not reliably the projected runtime state here, instead skip this loop and rely on the existing orphan settling — the simplest correct version: emit `ocioso` only for flows whose `spec.get(flowId)?.state === "aguardando"`.)

Final form for (g):

```ts
    for (const [flowIdStr] of Object.entries(recovered.lastCycleByFlow)) {
      const flowId = flowIdStr as FlowId;
      if (spec.get(flowId)?.state === "aguardando") {
        emit({ type: "flow.stateChanged", flowId, state: "ocioso" });
      }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine exec vitest run orchestrator.checkpoint`
Expected: PASS.

- [ ] **Step 5: Full engine suite (no regressions)**

Run: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine test`
Expected: PASS (all prior suites unaffected — auto path unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/orchestrator.ts packages/engine/src/orchestrator.checkpoint.test.ts
git commit -m "feat(engine): cycle checkpoint — orchestrator pauses into awaiting + continueFlow"
```

---

### Task 3: Wiring — bridge command, pause/kill clear, scheduler gate, spec round-trip

**Files:**
- Modify: `packages/engine/src/bridge.ts` (`flow.continue` handler; clear awaiting on `flow.pause`/`flow.kill`/`flow.delete`)
- Modify: `packages/engine/src/scheduler.ts` (fire gate: skip when `isAwaiting`)
- Modify: `packages/engine/src/spec.ts` (round-trip `reviewEachCycle` like `workDir`)
- Test: `packages/engine/src/spec.test.ts` (append a round-trip case)

**Interfaces consumed:** `orchestrator.continueFlow/isAwaiting/clearAwaiting` (Task 2); `cmd.t === "flow.continue"` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `packages/engine/src/spec.test.ts` a case that saves a flow with `reviewEachCycle: true` and reloads it, asserting the field survives. Match the existing test's harness in that file (it already constructs a `SpecStore`); model the new case on the existing `workDir` round-trip test if present, otherwise on the existing save/load test:

```ts
  it("round-trips reviewEachCycle through save + reload", async () => {
    const { store } = await freshStore(); // reuse this file's existing setup helper
    const created = await store.create("Review Flow");
    const edit = {
      id: created.flow.id,
      name: created.flow.name,
      reviewEachCycle: true,
      nodes: created.flow.nodes,
      edges: created.flow.edges,
    };
    const saved = await store.save(edit);
    expect(saved.flow.reviewEachCycle).toBe(true);
    const reloaded = store.get(created.flow.id);
    expect(reloaded?.reviewEachCycle).toBe(true);
  });
```

(If `spec.test.ts` uses a different setup name than `freshStore`, adapt to the actual helper in that file — read the top of the file first and reuse its existing store-construction pattern verbatim.)

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine exec vitest run spec`
Expected: FAIL — `reviewEachCycle` is `undefined` after reload (not persisted).

- [ ] **Step 3: Implement the spec round-trip**

In `spec.ts`, mirror every place `workDir` is handled, adding `reviewEachCycle`:
- The `toSpec`/`fromSpec` mappers (the `...(spec.workDir !== undefined ? { workDir } : {})` spreads near lines 236 and 304): add `...(spec.reviewEachCycle !== undefined ? { reviewEachCycle: spec.reviewEachCycle } : {})` and the `flow.reviewEachCycle` equivalent.
- The YAML writer (near lines 493-497): `if (specObj.reviewEachCycle !== undefined) doc.set("reviewEachCycle", specObj.reviewEachCycle); else doc.delete("reviewEachCycle");`
- The key order array (line 506): insert `"reviewEachCycle"` after `"workDir"`.
- The `save()` merge (near lines 545-559): `const reviewEachCycle = edit.reviewEachCycle ?? priorFlow?.reviewEachCycle;` and include `...(reviewEachCycle !== undefined ? { reviewEachCycle } : {})` in the assembled spec object.

In `scheduler.ts`, the fire gate (line 236):

```ts
    if (arm.firing || orchestrator.isRunning(arm.flowId) || orchestrator.isAwaiting(arm.flowId)) {
```

(Update the adjacent log message to mention "awaiting approval" too.)

In `bridge.ts`:
- Add a `flow.continue` case in the command switch (model on `flow.play`):

```ts
        // ----- flow.continue ---------------------------------------------------
        case "flow.continue": {
          const flowId = asFlowId(cmd.flowId);
          const resumed = await orchestrator.continueFlow(flowId);
          if (resumed === null) {
            ack(ws, cmd.cmdId, false, "nada aguardando aprovação neste fluxo");
          } else {
            ack(ws, cmd.cmdId, true);
          }
          break;
        }
```

(Check the `ack` helper signature in this file — if it is `ack(ws, cmdId, ok, error?)`, the above matches; otherwise adapt to the actual signature.)

- In the `flow.pause`, `flow.kill`, and `flow.delete` cases, add `orchestrator.clearAwaiting(flowId);` (so a pending checkpoint is dropped when the user pauses/kills/deletes).

- [ ] **Step 4: Run to verify pass + full engine suite**

Run: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine exec vitest run spec && NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine test`
Expected: PASS (spec round-trip green; scheduler/bridge suites unaffected).

- [ ] **Step 5: Typecheck engine**

Run: `pnpm --filter @loom/engine typecheck`
Expected: no errors (the `flow.continue` case makes the switch exhaustive over the new command).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/bridge.ts packages/engine/src/scheduler.ts packages/engine/src/spec.ts packages/engine/src/spec.test.ts
git commit -m "feat(engine): wire flow.continue (bridge) + awaiting fire-gate (scheduler) + reviewEachCycle round-trip (spec)"
```

---

### Task 4: Web — continue command, review toggle, approval banner

**Files:**
- Modify: `packages/web/src/store.ts` (`continue()` action; `setReviewEachCycle(on)`; `running` already false for non-"rodando" states)
- Modify: `packages/web/src/components/Storyline.tsx` (approval banner when the selected flow is `aguardando`)
- Modify: `packages/web/src/components/Inspector.tsx` (a "revisar cada ciclo" checkbox)
- Test: `packages/web/src/store.checkpoint.test.ts`; append a banner case to `packages/web/src/components/Storyline.test.tsx`

**Interfaces consumed:** `flow.continue` command, `Flow.reviewEachCycle`, `FlowState "aguardando"` (Task 1).

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/store.checkpoint.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
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

  it("setReviewEachCycle persists via spec.save carrying the flag", () => {
    useLoomStore.getState().setReviewEachCycle(true);
    const save = sent.find((c) => c.t === "spec.save");
    expect(save).toBeTruthy();
    expect((save as Extract<ClientCommand, { t: "spec.save" }>).flow.reviewEachCycle).toBe(true);
    // optimistic local patch too
    expect(useLoomStore.getState().flowsById[FLOW]!.reviewEachCycle).toBe(true);
  });
});
```

Append to `packages/web/src/components/Storyline.test.tsx`:

```ts
  it("shows the approval banner + Continuar button when the flow is aguardando", () => {
    useLoomStore.setState({
      storyline: lines,
      storylineOpen: true,
      flowsById: { f1: { ...({} as never), id: "f1", state: "aguardando" } as never },
      selectedFlowId: "f1" as never,
    });
    render(<Storyline />);
    expect(screen.getByText(/aguardando/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continuar/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @loom/web exec vitest run store.checkpoint Storyline`
Expected: FAIL — `continue`/`setReviewEachCycle` not functions; banner not rendered.

- [ ] **Step 3: Implement store actions**

In `store.ts`:
- Add to the `LoomState` actions section: `continue: () => void;` and `setReviewEachCycle: (on: boolean) => void;`.
- Implement near `pause`/`setWorkDir`:

```ts
  continue: () => {
    const { selectedFlowId, sendCommand } = get();
    if (!selectedFlowId) return;
    sendCommand({ t: "flow.continue", cmdId: makeCmdId(), flowId: selectedFlowId });
  },
  setReviewEachCycle: (on) => {
    const { selectedFlowId, flowsById } = get();
    if (!selectedFlowId) return;
    const flow = flowsById[selectedFlowId];
    if (!flow) return;
    // optimistic local patch, then persist via spec.save (which carries the flag)
    set({ flowsById: { ...flowsById, [selectedFlowId]: { ...flow, reviewEachCycle: on } } });
    get().saveSpec();
  },
```

- Add `reviewEachCycle` to the `EditableFlow` built in `saveSpec` (mirror the `workDir` spread):

```ts
      ...(flow.reviewEachCycle !== undefined ? { reviewEachCycle: flow.reviewEachCycle } : {}),
```

- [ ] **Step 4: Implement the approval banner in `Storyline.tsx`**

Add at the top of the `Storyline` component body:

```tsx
  const continueFlow = useLoomStore((s) => s.continue);
  const stopFlow = useLoomStore((s) => s.kill);
  const awaiting = useLoomStore((s) => {
    const f = s.selectedFlowId ? s.flowsById[s.selectedFlowId] : undefined;
    return f?.state === "aguardando";
  });
```

And render the banner just under the header (before the feed), only when `awaiting`:

```tsx
      {awaiting && (
        <div data-approval-banner style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8, background: "oklch(0.95 0.05 80 / 0.5)", borderBottom: "1px solid var(--line2)" }}>
          <span style={{ fontSize: 12.5, color: "var(--text)" }}>Ciclo concluído — aguardando sua aprovação para continuar.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => continueFlow()} style={{ flex: 1, padding: "7px 10px", border: "none", borderRadius: 9, background: "oklch(0.62 0.14 160)", color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Continuar ▶</button>
            <button type="button" onClick={() => stopFlow()} style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--line2)", borderRadius: 9, background: "transparent", color: "var(--text2)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Parar ■</button>
          </div>
        </div>
      )}
```

- [ ] **Step 5: Implement the toggle in `Inspector.tsx`**

Read `Inspector.tsx` first to find the flow-level settings area (where `workDir` / budget / trigger config render). Add a checkbox row wired to `setReviewEachCycle`, reading the current value from the selected flow:

```tsx
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text2)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={flow?.reviewEachCycle === true}
            onChange={(e) => useLoomStore.getState().setReviewEachCycle(e.target.checked)}
          />
          Revisar cada ciclo (pausar e pedir aprovação)
        </label>
```

(Place it near the existing flow-level controls; reuse whatever `flow` variable the Inspector already has in scope. If the Inspector renders per-node and has no flow-level section, add the row to the flow-info block — read the file to choose the right spot.)

- [ ] **Step 6: Run tests + typecheck + full web suite**

Run: `pnpm --filter @loom/web exec vitest run store.checkpoint Storyline && pnpm --filter @loom/web typecheck && pnpm --filter @loom/web test`
Expected: all PASS, no type errors, existing suites green.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): cycle checkpoint UX — continue/review-toggle actions + approval banner in Storyline"
```

---

## Final verification

- [ ] **All gates across the monorepo**

Run: `pnpm -r typecheck && NODE_OPTIONS=--experimental-sqlite pnpm -r test && pnpm -r build`
Expected: typecheck clean, all suites pass (shared/engine/web with the new tests), build succeeds.

---

## Self-review notes (author)

- **Spec coverage:** §5 contracts → Task 1. §4/§6 orchestrator checkpoint + continueFlow + recovery normalize → Task 2. §6 bridge/scheduler/spec wiring → Task 3. §7 web (continue/toggle/banner) → Task 4. §9 tests distributed across all four tasks. §3 safety (only defers) is structural — the auto path is untouched and regression-guarded.
- **Type consistency:** `cycle.awaitingApproval`/`aguardando`/`flow.continue`/`reviewEachCycle` defined in Task 1 and consumed verbatim in Tasks 2-4. `continueFlow`/`isAwaiting`/`clearAwaiting` + `CycleOutcome "awaiting"` defined in Task 2, consumed in Task 3. `continue`/`setReviewEachCycle` defined in Task 4 store, consumed by its components.
- **Adapt-on-read flags:** three steps say "read the file first and reuse the existing pattern" — spec.test.ts setup helper (Task 3 Step 1), bridge `ack` signature (Task 3 Step 3), Inspector flow-level section (Task 4 Step 5). These are deliberate: the exact local names must match the real file, and the pattern to follow (workDir round-trip, flow.play handler, existing settings rows) is named explicitly.
- **No silent regressions:** auto mode preserved (Task 2 keeps the recurse path; only adds a guarded branch). Existing engine/web suites are the regression guard at each task's final step.
