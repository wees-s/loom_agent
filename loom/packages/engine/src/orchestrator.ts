// =============================================================================
// orchestrator.ts [orchestrator] — startCycle(flow, cause).
//
// Build the DAG with feedback edges CUT (acyclic); Kahn layering; within a layer
// fan out runs concurrently, bounded by the guard semaphore (maxConcurrentAgents).
// JOIN = artifact-presence barrier: a downstream node runs only when ALL upstream
// runs are ok AND every expected produces[] artifact exists with a logged hash
// (a node that wrote nothing FAILS the barrier). contextIsolation nodes
// (Synthesizer/Reviewer) run scoped to artifacts only — never peer transcripts.
// After the terminal layer, feedback edges call guard.requestNextCycle ->
// startCycle(arm+1) if ok, else emit cycle.ended/cycle.converged.
//
// Orphan recovery on boot: fold the event log, mark unfinished runs killed,
// replan from the last barrier (idempotent on flowId,cycle,nodeId).
//
// Emits cycle.* / run.* / node.* / edge.* through the event log.
// =============================================================================

import {
  newId,
  asRunId,
  asNodeId,
  semanticsOf,
  type Flow,
  type FlowId,
  type NodeId,
  type EdgeId,
  type RunId,
  type AgentNode,
  type Edge,
  type RunStatus,
  type ModelId,
} from "@loom/shared";
import type { CycleCause, Emit, RunCtx, RunResult } from "./internal.js";
import type { EventLog } from "./eventlog.js";
import type { Guard } from "./guard.js";
import type { Runner } from "./runner.js";
import type { Blackboard, ResolvedContext } from "./blackboard.js";
import type { SpecStore } from "./spec.js";
import type { Terminals } from "./terminals.js";

/** Kahn layering result over the forward (feedback-cut) DAG. */
export interface LayeredPlan {
  flowId: FlowId;
  /** layers[i] = node ids that may run concurrently once layer i-1 joined. */
  layers: NodeId[][];
  /** Feedback edges removed to make the DAG acyclic (re-armed post-terminal). */
  feedbackEdges: { from: NodeId; to: NodeId }[];
}

export type CycleOutcome =
  | { status: "done"; cycle: number }
  | { status: "converged"; cycle: number; reason: "no-new-output" }
  | { status: "stopped"; cycle: number; reason: string }
  | { status: "killed"; cycle: number };

export interface Orchestrator {
  /** Pure planner: build the feedback-cut DAG + Kahn layers for a flow. */
  plan(flow: Flow): LayeredPlan;

  /**
   * Run one full cycle: layer-by-layer fan-out (guard-semaphore bounded), the
   * artifact-presence JOIN barrier between layers, then feedback re-arm via
   * guard.requestNextCycle. Emits cycle.started/…/cycle.ended (or converged).
   */
  startCycle(flow: Flow, cause: CycleCause, arm?: number): Promise<CycleOutcome>;

  /**
   * Boot orphan recovery: fold the log (eventlog.foldForOrphanRecovery), mark
   * unfinished runs killed, and replan flows from their last barrier. Idempotent
   * on (flowId, cycle, nodeId).
   */
  recoverOrphans(): Promise<void>;

  /** True while a cycle is in flight for the flow (scheduler no-overlap guard). */
  isRunning(flowId: FlowId): boolean;
}

// -----------------------------------------------------------------------------
// Internal helpers — small, pure, and test-friendly.
// -----------------------------------------------------------------------------

/** Per-node outcome tracked across a cycle to drive the presence barrier. */
type NodeOutcome =
  | { state: "ok"; runId?: RunId }
  | { state: "failed"; runId?: RunId; reason: string }
  | { state: "skipped"; reason: string }
  | { state: "killed"; runId?: RunId };

/** Worst-case input-token budget handed to the guard pre-spend admission.
 *  The runner's true input usage is metered live via run.token; this is only
 *  the conservative reservation seed so the guard can do the cap math. */
const DEFAULT_EST_INPUT_TOKENS = 32_000;

/** Status values that satisfy the upstream side of the JOIN barrier. */
function isOkStatus(s: RunStatus): boolean {
  return s === "ok";
}

export function createOrchestrator(
  eventlog: EventLog,
  guard: Guard,
  runner: Runner,
  blackboard: Blackboard,
  spec: SpecStore,
  terminals: Terminals,
  emit: Emit,
): Orchestrator {
  /** Flows with a cycle currently in flight (scheduler no-overlap guard). */
  const running = new Set<string>();

  // ---------------------------------------------------------------------------
  // PLAN — feedback-cut DAG + Kahn layering.
  // ---------------------------------------------------------------------------

  function plan(flow: Flow): LayeredPlan {
    const nodeIds = flow.nodes.map((n) => n.id);
    const known = new Set<string>(nodeIds);

    const feedbackEdges: { from: NodeId; to: NodeId }[] = [];
    const forward: Edge[] = [];
    for (const e of flow.edges) {
      // Defensive: skip dangling edges (spec.lint normally rejects these, but
      // the orchestrator must never crash on a malformed in-memory flow).
      if (!known.has(e.from) || !known.has(e.to)) continue;
      if (e.feedback) {
        feedbackEdges.push({ from: e.from, to: e.to });
      } else {
        forward.push(e);
      }
    }

    // Kahn layering over the forward (acyclic-by-construction) edge set.
    const indegree = new Map<string, number>();
    const adj = new Map<string, NodeId[]>();
    for (const id of nodeIds) {
      indegree.set(id, 0);
      adj.set(id, []);
    }
    for (const e of forward) {
      adj.get(e.from)!.push(e.to);
      indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    }

    const layers: NodeId[][] = [];
    let frontier: NodeId[] = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
    const placed = new Set<string>();

    while (frontier.length > 0) {
      // Stable order within a layer (spec declaration order) for determinism.
      const layer = frontier
        .filter((id) => !placed.has(id))
        .sort((a, b) => nodeIds.indexOf(a) - nodeIds.indexOf(b));
      for (const id of layer) placed.add(id);
      layers.push(layer);

      const next: NodeId[] = [];
      for (const id of layer) {
        for (const to of adj.get(id) ?? []) {
          const d = (indegree.get(to) ?? 0) - 1;
          indegree.set(to, d);
          if (d === 0) next.push(to);
        }
      }
      frontier = next;
    }

    // Any node not placed indicates a forward cycle (spec.lint should have
    // rejected it). Append the stragglers as a final layer so the planner is
    // total rather than dropping nodes silently.
    const leftover = nodeIds.filter((id) => !placed.has(id));
    if (leftover.length > 0) layers.push(leftover);

    return { flowId: flow.id, layers, feedbackEdges };
  }

  // ---------------------------------------------------------------------------
  // PROMPT ASSEMBLY — structural context isolation.
  //
  // The prompt is system framing + the node prompt + the resolved linkedContexts.
  // For contextIsolation nodes we include ONLY file/artifact references and the
  // node's own produces[]; we NEVER inject peer transcripts (the engine keeps
  // transcripts out of prompts entirely — agents read artifacts off the shared
  // blackboard dir). The isolation guarantee is therefore: an isolated node's
  // prompt references artifacts only, terminals/external channels are dropped.
  // ---------------------------------------------------------------------------

  function describeContext(ctx: ResolvedContext): string {
    switch (ctx.kind) {
      case "file":
        return `- arquivo: ${ctx.relPath}`;
      case "terminal":
        return `- terminal: ${ctx.terminal}`;
      case "external":
        return `- canal externo: ${ctx.ref}`;
    }
  }

  function assemblePrompt(flow: Flow, node: AgentNode, cycle: number, arm: number): string {
    const isolated = node.contextIsolation === true;
    const lines: string[] = [];
    lines.push(`# Loom — ${flow.name} · ciclo ${cycle} · braço ${arm}`);
    lines.push(`Você é o agente "${node.title}" (${node.type}). Papel: ${node.role}`);
    lines.push(
      `O diretório de trabalho é o blackboard do fluxo; leia e escreva artefatos lá.`,
    );
    if (node.produces && node.produces.length > 0) {
      lines.push(`Você DEVE escrever: ${node.produces.join(", ")}.`);
    }

    const contexts: ResolvedContext[] = [];
    for (const ref of node.linkedContexts) {
      const resolved = blackboard.resolveContext(flow.id, ref);
      // Structural isolation: isolated nodes see ONLY file artifacts.
      if (isolated && resolved.kind !== "file") continue;
      contexts.push(resolved);
    }
    if (contexts.length > 0) {
      lines.push(isolated ? "Contextos (somente artefatos):" : "Contextos ligados:");
      for (const ctx of contexts) lines.push(describeContext(ctx));
    }
    if (isolated) {
      lines.push(
        "Restrição: baseie-se EXCLUSIVAMENTE nos artefatos listados. Não invente " +
          "fatos e não assuma transcrições de outros agentes.",
      );
    }

    lines.push("---");
    lines.push(node.prompt.trim());
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // BARRIER — artifact-presence JOIN.
  //
  // A node may run only when every forward (non-feedback) predecessor is `ok`
  // AND each predecessor's expected produces[] artifact exists with a logged
  // hash. A predecessor that wrote nothing it was expected to → fails the
  // barrier for everything downstream of it.
  // ---------------------------------------------------------------------------

  async function predecessorSatisfiesBarrier(
    flow: Flow,
    predId: NodeId,
    outcome: NodeOutcome | undefined,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!outcome || outcome.state !== "ok") {
      return { ok: false, reason: `upstream ${predId} não concluiu com ok` };
    }
    const predNode = flow.nodes.find((n) => n.id === predId);
    if (!predNode) return { ok: false, reason: `upstream ${predId} desconhecido` };

    // Triggers and any node without a declared produces[] contribute no artifact
    // gate (a trigger is a pure entry point). Their `ok` outcome is sufficient.
    const expected = predNode.produces ?? [];
    for (const relPath of expected) {
      const hash = await blackboard.sha256(flow.id, relPath);
      if (!hash) {
        return {
          ok: false,
          reason: `artefato esperado ausente: ${relPath} (de ${predId})`,
        };
      }
    }
    return { ok: true };
  }

  async function barrierFor(
    flow: Flow,
    nodeId: NodeId,
    forwardPreds: Map<string, NodeId[]>,
    outcomes: Map<string, NodeOutcome>,
  ): Promise<{ ok: boolean; reason?: string }> {
    const preds = forwardPreds.get(nodeId) ?? [];
    for (const pred of preds) {
      const r = await predecessorSatisfiesBarrier(flow, pred, outcomes.get(pred));
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // EDGE / TERMINAL bookkeeping.
  // ---------------------------------------------------------------------------

  function fireForwardEdgesFrom(flow: Flow, from: NodeId, cycle: number): void {
    for (const e of flow.edges) {
      if (e.feedback) continue;
      if (e.from !== from) continue;
      emit({ type: "edge.fired", flowId: flow.id, edgeId: e.id, cycle });
    }
  }

  /** term://N linked contexts the node owns become "busy" while it runs. */
  function nodeTerminals(node: AgentNode): string[] {
    return node.linkedContexts.filter((c) => c.startsWith("term://"));
  }

  function claimTerminals(flow: Flow, node: AgentNode): void {
    for (const term of nodeTerminals(node)) {
      const semantics = semanticsOf(node.type);
      const status =
        semantics === "executor" ? "executor" : semantics === "analyst" ? "scribe" : "busy";
      try {
        terminals.setOwnership(term, {
          status,
          meta: node.title,
          flowId: flow.id,
          nodeId: node.id,
        });
      } catch {
        // terminals degrade gracefully; never let ownership bookkeeping abort a run.
      }
    }
  }

  function releaseTerminals(node: AgentNode): void {
    for (const term of nodeTerminals(node)) {
      try {
        terminals.setOwnership(term, { status: "idle", meta: "idle" });
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // RUN ONE NODE — admission (guard lease) + spawn (runner) + bookkeeping.
  // ---------------------------------------------------------------------------

  async function runNode(
    flow: Flow,
    node: AgentNode,
    cycle: number,
    arm: number,
  ): Promise<NodeOutcome> {
    const runId = asRunId(newId("run-"));
    const model: ModelId = node.model;

    // Pre-spend admission — the ONLY way to obtain spawn permission.
    const decision = guard.requestSpawn({
      flowId: flow.id,
      runId,
      nodeId: node.id,
      model,
      estInputTokens: DEFAULT_EST_INPUT_TOKENS,
    });

    if (!decision.ok) {
      // The guard already emitted budget.tripped where appropriate; record the
      // skip in the log so the projection can show why the node didn't run.
      emit({
        type: "log",
        flowId: flow.id,
        color: "amber",
        msg: `nó ${node.title} negado pelo guard: ${decision.reason} (${decision.detail})`,
        at: Date.now(),
      });
      return { state: "skipped", reason: `${decision.reason}: ${decision.detail}` };
    }

    const lease = decision.value;

    const flowDir = blackboard.resolveDir(flow);
    let winFlowDir = flowDir;
    try {
      winFlowDir = await blackboard.toWindowsPath(flowDir);
    } catch {
      // Path translation failures are non-fatal; the runner falls back on cwd.
      winFlowDir = flowDir;
    }

    const prompt = assemblePrompt(flow, node, cycle, arm);

    // One terminal per (flow,node): the real claude session runs inside it and
    // the user watches it live. The runner claims/releases ownership + streams.
    const runTerminalId = `term://${String(flow.id)}.${String(node.id)}`;

    const runCtx: RunCtx = {
      runId,
      flowId: flow.id,
      flow,
      node,
      cycle,
      arm,
      flowDir,
      winFlowDir,
      runTerminalId,
      prompt,
      model,
      lease,
      signal: lease.signal,
    };

    // Visual + projection bookkeeping. run.started/run.finished are emitted BY
    // THE RUNNER (per its contract); the orchestrator owns node.* and edge.*.
    emit({ type: "node.activated", flowId: flow.id, nodeId: node.id, runId, cycle });
    claimTerminals(flow, node);

    let result: RunResult;
    try {
      result = await runner.runAgent(runCtx);
    } catch (err) {
      // The runner contract says it always settles the lease, but if it throws
      // before that we must not leak the slot/reservation.
      const message = err instanceof Error ? err.message : String(err);
      try {
        guard.releaseLease(lease, { runId, usdSpent: 0, tokensSpent: 0 });
      } catch {
        /* lease already released by the runner */
      }
      emit({
        type: "run.finished",
        runId,
        status: "error",
        error: message,
        at: Date.now(),
      });
      emit({ type: "node.deactivated", flowId: flow.id, nodeId: node.id, runId });
      releaseTerminals(node);
      return { state: "failed", runId, reason: message };
    } finally {
      // node.deactivated for the success path is emitted below after we know the
      // status; the catch above handles the error path's deactivation.
    }

    emit({ type: "node.deactivated", flowId: flow.id, nodeId: node.id, runId });
    releaseTerminals(node);

    if (result.status === "killed") return { state: "killed", runId };
    if (isOkStatus(result.status)) {
      // Forward edges out of this node "fire" once it settles ok.
      fireForwardEdgesFrom(flow, node.id, cycle);
      return { state: "ok", runId };
    }
    return {
      state: "failed",
      runId,
      reason: result.error ?? `status ${result.status}`,
    };
  }

  /** Run a layer with bounded concurrency (the guard semaphore). The guard's
   *  own admission already rejects over-cap spawns; this bound keeps us from
   *  even attempting more than maxConcurrentAgents at once (tidy fan-out). */
  async function runLayerBounded(
    flow: Flow,
    nodes: AgentNode[],
    cycle: number,
    arm: number,
    outcomes: Map<string, NodeOutcome>,
  ): Promise<void> {
    const budget = flow.budget;
    const limit = Math.max(1, budget.maxConcurrentAgents);
    let cursor = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const idx = cursor++;
        if (idx >= nodes.length) return;
        const node = nodes[idx]!;
        const outcome = await runNode(flow, node, cycle, arm);
        outcomes.set(node.id, outcome);
      }
    }

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(limit, nodes.length); i++) workers.push(worker());
    await Promise.all(workers);
  }

  // ---------------------------------------------------------------------------
  // START CYCLE — the core orchestration loop for one trigger firing / re-arm.
  // ---------------------------------------------------------------------------

  async function startCycle(
    flow: Flow,
    cause: CycleCause,
    arm = 0,
  ): Promise<CycleOutcome> {
    // Prefer the freshest in-memory spec if the store has it (hot-reload safe).
    const live = spec.get(flow.id);
    const f = live ?? flow;

    const flowKey = f.id as string;
    const isReentrant = running.has(flowKey);
    if (!isReentrant) running.add(flowKey);

    // Cycle numbering: continue from the event log's counter on the first arm of
    // a fresh firing; feedback re-arms (arm>0) keep advancing the same counter.
    const cycle = eventlog.cycleCounter(f.id) + 1;
    const now = Date.now();

    try {
      emit({ type: "cycle.started", flowId: f.id, cycle, at: now });
      emit({ type: "flow.stateChanged", flowId: f.id, state: "rodando" });

      const layered = plan(f);
      const byId = new Map<string, AgentNode>(f.nodes.map((n) => [n.id, n]));

      // Forward predecessor map for the barrier.
      const forwardPreds = new Map<string, NodeId[]>();
      for (const n of f.nodes) forwardPreds.set(n.id, []);
      for (const e of f.edges) {
        if (e.feedback) continue;
        if (!forwardPreds.has(e.to)) continue;
        forwardPreds.get(e.to)!.push(e.from);
      }

      const outcomes = new Map<string, NodeOutcome>();
      let killed = false;

      // Mark Trigger nodes satisfied (pure entry points: they run no agent but
      // pass the barrier with state "ok"). NOTE: trigger.fired is emitted by the
      // SCHEDULER (the trigger authority — it carries the real cause and owns the
      // no-overlap drop); emitting it here too double-counted trigger.fired on
      // EVERY cycle (2x per cycle in the event log / UI). Do NOT emit it here.
      void cause;
      for (const n of f.nodes) {
        if (semanticsOf(n.type) === "trigger") {
          outcomes.set(n.id, { state: "ok" });
        }
      }

      // Walk layers in order; within each layer fan out (bounded), then JOIN.
      for (const layer of layered.layers) {
        if (killed) break;

        // Resolve which nodes in this layer are actually runnable: skip triggers
        // (already settled) and apply the artifact-presence barrier.
        const runnable: AgentNode[] = [];
        for (const id of layer) {
          const node = byId.get(id);
          if (!node) continue;
          if (semanticsOf(node.type) === "trigger") continue; // already ok
          if (outcomes.has(id)) continue; // recovered/idempotent

          const gate = await barrierFor(f, id, forwardPreds, outcomes);
          if (!gate.ok) {
            outcomes.set(id, { state: "skipped", reason: gate.reason ?? "barreira" });
            emit({
              type: "log",
              flowId: f.id,
              color: "slate",
              msg: `nó ${node.title} pulado: ${gate.reason ?? "barreira não satisfeita"}`,
              at: Date.now(),
            });
            continue;
          }
          runnable.push(node);
        }

        if (runnable.length > 0) {
          await runLayerBounded(f, runnable, cycle, arm, outcomes);
        }

        // A killed run anywhere aborts the remaining layers of this cycle.
        for (const node of runnable) {
          if (outcomes.get(node.id)?.state === "killed") killed = true;
        }
      }

      if (killed) {
        emit({
          type: "cycle.ended",
          flowId: f.id,
          cycle,
          status: "killed",
          totalUsd: cycleSpend(f.id),
          at: Date.now(),
        });
        emit({ type: "flow.stateChanged", flowId: f.id, state: "pausado" });
        return { status: "killed", cycle };
      }

      // ---- Feedback re-arm: gate the next arm through the guard ----
      if (layered.feedbackEdges.length > 0) {
        const next = guard.requestNextCycle({ flowId: f.id, arm, cycle });
        if (next.ok) {
          // The feedback edge(s) "fire" visually before the re-arm.
          for (const fe of layered.feedbackEdges) {
            const edge = f.edges.find(
              (e) => e.feedback && e.from === fe.from && e.to === fe.to,
            );
            if (edge) emit({ type: "edge.fired", flowId: f.id, edgeId: edge.id, cycle });
          }
          // Close out THIS cycle as done before recursing into the next arm.
          emit({
            type: "cycle.ended",
            flowId: f.id,
            cycle,
            status: "done",
            totalUsd: cycleSpend(f.id),
            at: Date.now(),
          });
          // Recurse on the next arm (running flag stays set: re-entrant call).
          return await startCycle(f, "feedback", arm + 1);
        }

        // Denied: translate the guard's reason into a converged/stopped outcome.
        if (next.reason === "converged") {
          emit({
            type: "cycle.converged",
            flowId: f.id,
            cycle,
            reason: "no-new-output",
            at: Date.now(),
          });
          emit({
            type: "cycle.ended",
            flowId: f.id,
            cycle,
            status: "converged",
            totalUsd: cycleSpend(f.id),
            at: Date.now(),
          });
          emit({ type: "flow.stateChanged", flowId: f.id, state: "ocioso" });
          return { status: "converged", cycle, reason: "no-new-output" };
        }

        // maxCyclesPerArm / killed / paused / cap — a clean stop with a reason.
        emit({
          type: "cycle.ended",
          flowId: f.id,
          cycle,
          status: next.reason === "flow_killed" ? "killed" : "stopped",
          totalUsd: cycleSpend(f.id),
          at: Date.now(),
        });
        emit({ type: "flow.stateChanged", flowId: f.id, state: "ocioso" });
        if (next.reason === "flow_killed") return { status: "killed", cycle };
        return { status: "stopped", cycle, reason: `${next.reason}: ${next.detail}` };
      }

      // No feedback edges: the cycle is simply done.
      emit({
        type: "cycle.ended",
        flowId: f.id,
        cycle,
        status: "done",
        totalUsd: cycleSpend(f.id),
        at: Date.now(),
      });
      emit({ type: "flow.stateChanged", flowId: f.id, state: "ocioso" });
      return { status: "done", cycle };
    } finally {
      if (!isReentrant) running.delete(flowKey);
    }
  }

  /** Best-effort total spend for the flow (for cycle.ended.totalUsd). */
  function cycleSpend(flowId: FlowId): number {
    try {
      return guard.spendForFlow(flowId).usdSpent;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // ORPHAN RECOVERY — fold the log, kill unfinished runs, replan idempotently.
  // ---------------------------------------------------------------------------

  async function recoverOrphans(): Promise<void> {
    const recovered = eventlog.foldForOrphanRecovery();

    // 1. Mark every run that started but never finished as killed. This is
    //    idempotent: re-running over a log that already has the run.finished
    //    {killed} simply appends another (the projection folds last-writer).
    for (const run of recovered.unfinishedRuns) {
      emit({
        type: "run.finished",
        runId: run.id,
        status: "killed",
        error: "órfão recuperado no boot",
        at: Date.now(),
      });
      emit({
        type: "node.deactivated",
        flowId: run.flowId,
        nodeId: run.nodeId,
        runId: run.id,
      });
      // Release any terminal a recovered run might still own (best-effort).
      const flow = spec.get(run.flowId);
      const node = flow?.nodes.find((n) => n.id === run.nodeId);
      if (node) releaseTerminals(node);
    }

    // 2. Close out any flow that had a dangling open cycle. We do NOT auto-replan
    //    a fresh cycle here (cost safety + no missed-fire backfill, mirroring the
    //    scheduler): we settle the interrupted cycle as killed so the projection
    //    is consistent and the scheduler can re-arm on its own schedule. This is
    //    idempotent on (flowId, cycle): a flow whose last cycle already ended is
    //    left untouched.
    for (const [flowIdStr, lastCycle] of Object.entries(recovered.lastCycleByFlow)) {
      const flowId = flowIdStr as FlowId;
      const hadOrphan = recovered.unfinishedRuns.some(
        (r) => (r.flowId as string) === flowIdStr,
      );
      if (!hadOrphan) continue; // its last cycle settled cleanly — nothing to do.
      emit({
        type: "cycle.ended",
        flowId,
        cycle: lastCycle,
        status: "killed",
        totalUsd: cycleSpend(flowId),
        at: Date.now(),
      });
      emit({ type: "flow.stateChanged", flowId, state: "ocioso" });
      emit({
        type: "log",
        flowId,
        color: "rose",
        msg: `ciclo ${lastCycle} recuperado como killed no boot (runs órfãos)`,
        at: Date.now(),
      });
    }
  }

  function isRunning(flowId: FlowId): boolean {
    return running.has(flowId as string);
  }

  return { plan, startCycle, recoverOrphans, isRunning };
}

// Re-export id coercions used in tests that drive the orchestrator with raw ids.
export { asNodeId };
export type { EdgeId };
