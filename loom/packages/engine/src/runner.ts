// =============================================================================
// runner.ts [runner] — runAgent(runCtx) -> RunResult.
//
// Loom is TERMINAL-NATIVE. The orchestrator mints the SpawnLease via guard and
// hands it in on RunCtx (the runner CANNOT spawn without it). The runner ALWAYS
// settles that lease via guard.releaseLease, whatever the outcome.
//
// REAL mode: launches a REAL `claude` session INSIDE a tmux pane (one terminal
//   per (flowId,nodeId): id "term://<flow>.<node>"), via terminals.runInPane:
//     claude -p "<prompt>" --model <m> --add-dir <winDir>
//            --permission-mode acceptEdits --max-turns N
//   running with cwd = the flow work dir. The pane shows the REAL, readable
//   claude output (default text format, NOT stream-json), streamed live to the
//   UI as terminal.data. The run status comes from the pane command's exit code
//   (+ abort/timeout); artifacts come from produces[] (feeds the barrier).
//
//   TRADE-OFF (honest): default text output means NO live token/cost metering.
//   We therefore lean entirely on the HARD bounds — guard pre-spend admission,
//   --max-turns (BELT), and the per-run wall-clock timeout (SUSPENDERS). The run
//   reports coarse/zero cost; the per-run cap is enforced by admission + the turn
//   ceiling, not by a live meter (which terminal mode cannot provide).
//
// FAKE mode (env LOOM_RUNNER=fake → config.runnerMode="fake"): does NOT call
//   claude and never touches tmux — writes each node.produces[] artifact with
//   deterministic canned content to the blackboard and emits synthetic run.token
//   + run.finished, enabling zero-cost dry runs and tests. Honors runCtx.signal.
// =============================================================================

import type { RunStatus, TokenUsage } from "@loom/shared";

import type { RunCtx, RunResult, Emit } from "./internal.js";
import type { Guard } from "./guard.js";
import type { Blackboard } from "./blackboard.js";
import type { Terminals } from "./terminals.js";
import { emptyUsage, costFromUsage } from "./streamParser.js";

export type RunnerMode = "real" | "fake";

export interface Runner {
  readonly mode: RunnerMode;

  /**
   * Execute one agent run. Requires `runCtx.lease` (minted by guard). Emits
   * run.started, run.finished (REAL mode also streams the live pane as
   * terminal.data via the terminals manager). Honors runCtx.signal for
   * mid-flight abort. Always settles the lease.
   */
  runAgent(runCtx: RunCtx): Promise<RunResult>;
}

// -----------------------------------------------------------------------------
// Tunables / constants.
// -----------------------------------------------------------------------------

/** Name of the Windows-authed CLI; resolves from WSL via PATH inside the pane. */
const CLAUDE_BIN = "claude";

/** Max chars of captured pane text kept for the recent-runs summary label. */
const SUMMARY_MAX = 160;

/**
 * BELT (kill-switch defense-in-depth): hard turn ceiling handed to the claude
 * CLI. Even if a pane orphan survives kill-session across the WSL→Windows
 * boundary, --max-turns guarantees it SELF-TERMINATES after a bounded number of
 * agent turns instead of spending unbounded tokens. Overridable via env.
 */
const MAX_TURNS = clampInt(process.env.LOOM_RUNNER_MAX_TURNS, 40, 1, 1_000);

/**
 * SUSPENDERS (kill-switch defense-in-depth): per-run WALL-CLOCK timeout (ms). A
 * run that has not exited within this window is interrupted (Ctrl-C in the pane)
 * and settled as status "timeout". This bounds wall-clock spend even if
 * --max-turns somehow fails to fire. In terminal mode (no live token meter) this
 * + --max-turns + the guard's pre-spend admission are the ONLY cost bounds.
 */
const WALL_CLOCK_TIMEOUT_MS = clampInt(
  process.env.LOOM_RUNNER_TIMEOUT_MS,
  20 * 60_000, // 20 minutes
  10_000,
  6 * 60 * 60_000,
);

/** Parse an env integer, clamped to [min,max], falling back to `dflt`. */
function clampInt(
  raw: string | undefined,
  dflt: number,
  min: number,
  max: number,
): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function totalTokens(u: TokenUsage): number {
  return (
    u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
  );
}

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

/**
 * Build the runner. `mode` is "fake" when env LOOM_RUNNER=fake (resolved in
 * config). REAL mode drives a real claude inside a tmux pane via `terminals`.
 */
export function createRunner(
  mode: RunnerMode,
  guard: Guard,
  blackboard: Blackboard,
  terminals: Terminals,
  emit: Emit,
): Runner {
  return mode === "fake"
    ? new FakeRunner(guard, blackboard, emit)
    : new RealRunner(guard, blackboard, terminals, emit);
}

// -----------------------------------------------------------------------------
// Shared run bookkeeping — collects the artifacts a run actually wrote so the
// RunResult feeds the orchestrator's presence barrier, regardless of mode.
// -----------------------------------------------------------------------------

/**
 * Read back the hashes of the node's declared `produces[]` artifacts from the
 * blackboard. Only artifacts that actually exist (with a hash) are included — a
 * node that wrote nothing yields {} and FAILS the downstream barrier by design.
 */
async function collectArtifacts(
  blackboard: Blackboard,
  runCtx: RunCtx,
): Promise<Record<string, string>> {
  const produces = runCtx.node.produces ?? [];
  const artifacts: Record<string, string> = {};
  for (const relPath of produces) {
    try {
      const hash = await blackboard.sha256(runCtx.flowId, relPath);
      if (hash) artifacts[relPath] = hash;
    } catch {
      // Missing/unreadable artifact → simply absent from the map.
    }
  }
  return artifacts;
}

// =============================================================================
// REAL runner — runs a real claude session inside a tmux pane.
// =============================================================================

class RealRunner implements Runner {
  readonly mode = "real" as const;

  constructor(
    private readonly guard: Guard,
    private readonly blackboard: Blackboard,
    private readonly terminals: Terminals,
    private readonly emit: Emit,
  ) {}

  async runAgent(runCtx: RunCtx): Promise<RunResult> {
    const { runId, flowId, node, cycle, model, signal, runTerminalId } = runCtx;

    this.emit({
      type: "run.started",
      runId,
      flowId,
      nodeId: node.id,
      cycle,
      model,
      at: Date.now(),
    });

    // Aborted before we even start → killed, no spawn.
    if (signal.aborted) {
      return this.settle(runCtx, {
        status: "killed",
        usage: emptyUsage(),
        costUsd: 0,
        toolCalls: 0,
        resultSummary: "abortado antes do spawn",
        artifacts: await collectArtifacts(this.blackboard, runCtx),
      });
    }

    // The REAL claude argv. Default text output (readable in the pane); NOT
    // stream-json (which is ugly in a terminal and which we no longer parse).
    const argv = [
      CLAUDE_BIN,
      "-p",
      runCtx.prompt,
      "--model",
      model,
      "--add-dir",
      runCtx.winFlowDir,
      "--permission-mode",
      "acceptEdits",
      // BELT: bound the run so an un-reapable pane orphan self-terminates.
      "--max-turns",
      String(MAX_TURNS),
    ];

    // Ensure the pane exists + claim it as busy so the rail + terminal.state show
    // the live agent. Best-effort: terminals degrade gracefully.
    try {
      await this.terminals.ensure(runTerminalId);
      this.terminals.setOwnership(runTerminalId, {
        status: "busy",
        meta: `${node.title} · ciclo ${cycle}`,
        flowId,
        nodeId: node.id,
      });
    } catch {
      /* terminal bring-up failure must not abort the run; runInPane re-checks */
    }

    // Register the terminal with the guard so flow.kill can tmux kill-session it
    // (terminal mode has no child PID we own; the session IS the kill target).
    this.guard.registerTerminal(flowId, runId, runTerminalId);

    let pane;
    try {
      pane = await this.terminals.runInPane(runTerminalId, {
        argv,
        cwd: runCtx.flowDir,
        signal,
        timeoutMs: WALL_CLOCK_TIMEOUT_MS,
      });
    } finally {
      this.guard.unregisterTerminal(runId);
    }

    // Derive status from the pane outcome.
    let status: RunStatus;
    if (pane.aborted) status = "killed";
    else if (pane.timedOut) status = "timeout";
    else if (pane.degraded) status = "error";
    else if (pane.exitCode === 0) status = "ok";
    else status = "error";

    // Read the tail of the pane for a human summary (no token metering here).
    let paneTail = "";
    try {
      paneTail = await this.terminals.capturePane(runTerminalId);
    } catch {
      /* best-effort summary only */
    }

    const artifacts = await collectArtifacts(this.blackboard, runCtx);
    let resultSummary = summarize(paneTail) ?? artifactSummary(artifacts);

    const error =
      status === "error"
        ? pane.degraded
          ? "terminal indisponível (tmux degradado) — claude não foi lançado"
          : `claude saiu com código ${pane.exitCode ?? "?"}`
        : status === "timeout"
          ? `run excedeu o timeout wall-clock (${WALL_CLOCK_TIMEOUT_MS} ms)`
          : status === "killed"
            ? "run abortado pelo guard"
            : undefined;

    if (!resultSummary && error) resultSummary = error;

    // Release the terminal ownership back to idle (the pane stays alive so the
    // user can still inspect it; flow.kill/delete/dispose tears it down).
    try {
      this.terminals.setOwnership(runTerminalId, {
        status: "idle",
        meta: status === "ok" ? "concluído" : status,
        flowId,
        nodeId: node.id,
      });
    } catch {
      /* ignore */
    }

    return this.settle(runCtx, {
      status,
      // No live token meter in terminal mode → coarse/zero usage. The HARD bounds
      // (admission + --max-turns + wall-clock) are what cap spend here.
      usage: emptyUsage(),
      costUsd: 0,
      toolCalls: 0,
      ...(resultSummary !== undefined ? { resultSummary } : {}),
      ...(error !== undefined ? { error } : {}),
      artifacts,
    });
  }

  /** Emit run.finished, release the lease with the final spend, build RunResult. */
  private settle(runCtx: RunCtx, parts: Omit<RunResult, "runId">): RunResult {
    const result: RunResult = { runId: runCtx.runId, ...parts };
    finalizeRun(this.guard, this.emit, runCtx, result);
    return result;
  }
}

// =============================================================================
// FAKE runner — deterministic, zero-cost. Writes canned artifacts, never spawns.
// =============================================================================

class FakeRunner implements Runner {
  readonly mode = "fake" as const;

  constructor(
    private readonly guard: Guard,
    private readonly blackboard: Blackboard,
    private readonly emit: Emit,
  ) {}

  async runAgent(runCtx: RunCtx): Promise<RunResult> {
    const { runId, flowId, node, cycle, model, signal } = runCtx;

    this.emit({
      type: "run.started",
      runId,
      flowId,
      nodeId: node.id,
      cycle,
      model,
      at: Date.now(),
    });

    if (signal.aborted) {
      const result: RunResult = {
        runId,
        status: "killed",
        usage: emptyUsage(),
        costUsd: 0,
        toolCalls: 0,
        resultSummary: "abortado (fake)",
        artifacts: {},
      };
      finalizeRun(this.guard, this.emit, runCtx, result);
      return result;
    }

    // Write each declared artifact with deterministic canned content.
    const produces = node.produces ?? [];
    const artifacts: Record<string, string> = {};
    let lastContent = "";
    for (const relPath of produces) {
      const content = cannedArtifact(runCtx, relPath);
      lastContent = content;
      try {
        const write = await this.blackboard.atomicWrite(
          flowId,
          node.id,
          relPath,
          content,
        );
        artifacts[write.relPath] = write.hash;
      } catch {
        // Blackboard refusal (e.g. single-writer lint) — skip; barrier handles it.
      }
    }

    // Synthetic, deterministic usage so the guard meter + cost math exercise.
    const usage: TokenUsage = {
      inputTokens: estimateTokens(runCtx.prompt),
      outputTokens: estimateTokens(lastContent) || 64,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const costUsd = costFromUsage(model, usage);

    this.emit({ type: "run.token", runId, usage, costUsd });
    this.guard.meterToken(runId, costUsd, totalTokens(usage));

    const resultSummary =
      summarize(lastContent) ?? artifactSummary(artifacts) ?? "run fake ok";

    const result: RunResult = {
      runId,
      status: "ok",
      usage,
      costUsd,
      toolCalls: 0,
      resultSummary,
      artifacts,
    };
    finalizeRun(this.guard, this.emit, runCtx, result);
    return result;
  }
}

// =============================================================================
// Helpers shared by both runners.
// =============================================================================

/**
 * Emit run.finished and release the guard lease with the run's final spend.
 * The lease MUST always be released exactly once, on every code path.
 */
function finalizeRun(
  guard: Guard,
  emit: Emit,
  runCtx: RunCtx,
  result: RunResult,
): void {
  emit({
    type: "run.finished",
    runId: result.runId,
    status: result.status,
    ...(result.resultSummary !== undefined
      ? { resultSummary: result.resultSummary }
      : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    at: Date.now(),
  });

  guard.releaseLease(runCtx.lease, {
    runId: result.runId,
    usdSpent: result.costUsd,
    tokensSpent: totalTokens(result.usage),
  });
}

/** Deterministic per-(run,artifact) canned content for FAKE mode. */
function cannedArtifact(runCtx: RunCtx, relPath: string): string {
  const { node, flowId, cycle, arm } = runCtx;
  return [
    `# ${node.title} — ${relPath}`,
    ``,
    `> Conteúdo canônico (modo fake do runner) — sem chamada ao claude.`,
    ``,
    `- flow: ${String(flowId)}`,
    `- node: ${String(node.id)} (${node.type})`,
    `- cycle: ${cycle}`,
    `- arm: ${arm}`,
    `- role: ${node.role}`,
    ``,
    `## Saída simulada`,
    ``,
    `Este artefato determinístico permite dry-runs de custo zero e testes`,
    `reproduzíveis da barreira de presença do orquestrador.`,
    ``,
  ].join("\n");
}

/** Cheap, deterministic token estimate (~4 chars/token) for FAKE metering. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Fallback recent-runs label derived from the artifacts a run wrote. */
function artifactSummary(
  artifacts: Record<string, string>,
): string | undefined {
  const paths = Object.keys(artifacts);
  if (paths.length === 0) return undefined;
  if (paths.length === 1) return `escreveu ${paths[0]}`;
  return `escreveu ${paths.length} artefatos`;
}
