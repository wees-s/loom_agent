// =============================================================================
// terminals.ts [terminals] — tmux-backed terminals (REAL execution surface).
//
// Loom is TERMINAL-NATIVE: an agent run is a REAL `claude` session running
// inside a real tmux pane, streamed live. This module owns those panes.
//
// Two id shapes share one registry:
//   • "term://N"            — rail/linked-context terminals (Terminal 1, 2, …).
//   • "term://<flow>.<node>" — the per-run terminal an agent run executes in.
// Every id maps to a tmux-safe session name (loom-term-<sanitized>+<hash>);
// neither tmux session names nor our argv arrays ever interpolate raw ids into a
// shell string (we spawn tmux with an ARGV ARRAY, never `sh -c`).
//
// ensure(id): create/attach the session (idempotent), start live pipe-pane
//   streaming. send(id,data): type into the pane. capturePane(id): snapshot.
//   runInPane(id,spec): run a command (the real claude argv) INSIDE the pane and
//   resolve with its exit code, using a unique `tmux wait-for` channel so we
//   never race a foreign signal. list()/get(): the Terminal registry. setOwnership
//   sets the orchestrator-derived status (scribe/executor/idle/busy) + emits
//   terminal.state. onData() feeds terminal.data. dispose(id)/disposeFlow(flowId)
//   tmux kill-session(s). recentOutput(id) replays the live buffer to a fresh
//   terminal.open. Degrades gracefully (status "idle") if tmux misbehaves across
//   the WSL boundary, but always keeps the wire contract intact.
// =============================================================================

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlowId, NodeId, Terminal, TerminalStatus } from "@loom/shared";
import type { Emit, Unsubscribe } from "./internal.js";

/** Streamed pane output the bridge relays as terminal.data. */
export type TerminalDataListener = (terminal: string, chunk: string) => void;

/** How a terminal id maps onto run-ownership (set by the orchestrator/runner). */
export interface TerminalOwnership {
  status: TerminalStatus; // "scribe" | "executor" | "idle" | "busy"
  meta: string;
  flowId?: FlowId;
  nodeId?: NodeId;
}

/** A command to run INSIDE a pane (the real claude invocation lives here). */
export interface PaneRunSpec {
  /** argv[0] + args — e.g. ["claude","-p","--model","haiku", …]. NOT a shell str. */
  argv: string[];
  /** cwd for the command (the flow blackboard dir). */
  cwd: string;
  /** Optional prompt/stdin written to the pane after the command starts (unused
   *  for `claude -p "<prompt>"` which carries the prompt as an argv arg). */
  input?: string;
  /** Abort the in-pane run (kills the session's running command). */
  signal?: AbortSignal;
  /** Hard wall-clock cap (ms) — interrupts the pane if exceeded. */
  timeoutMs?: number;
}

/** Outcome of a runInPane call. */
export interface PaneRunResult {
  /** Exit code of the command (null if it was interrupted/killed/timed out). */
  exitCode: number | null;
  /** True if the run was aborted via the signal. */
  aborted: boolean;
  /** True if the wall-clock timeout fired. */
  timedOut: boolean;
  /** True if the pane could not be brought up (degraded — never spawned claude). */
  degraded: boolean;
}

export interface Terminals {
  /** Create or attach the tmux session for `id` (idempotent). */
  ensure(id: string): Promise<Terminal>;

  /** Send raw input/keys to the pane (tmux send-keys via argv array). */
  send(id: string, data: string): Promise<void>;

  /**
   * Run `spec.argv` (the real claude command) INSIDE the pane and resolve when it
   * exits. Output streams live via the pane's pipe-pane (terminal.data). Honors
   * spec.signal (abort) and spec.timeoutMs (wall-clock). This is the REAL agent
   * execution surface — the pane shows readable claude output the user can watch.
   */
  runInPane(id: string, spec: PaneRunSpec): Promise<PaneRunResult>;

  /** Snapshot the current pane contents (tmux capture-pane). */
  capturePane(id: string): Promise<string>;

  /** The bounded live-output buffer, replayed to a fresh terminal.open. */
  recentOutput(id: string): string;

  /** The first-class Terminal registry (rail list + hello/terminal.snapshot). */
  list(): Terminal[];

  /** One terminal by id (null if not in the registry). */
  get(id: string): Terminal | null;

  /**
   * Set run-ownership-derived status (orchestrator authority, NOT guessed).
   * Updates the registry and emits terminal.state.
   */
  setOwnership(id: string, ownership: TerminalOwnership): void;

  /** Subscribe to live pane output (feeds terminal.data over the bridge). */
  onData(listener: TerminalDataListener): Unsubscribe;

  /** Kill the tmux session for `id` (best-effort; keeps the registry contract). */
  dispose(id: string): Promise<void>;

  /** Kill ALL of a flow's terminals (flow.kill / flow.delete / stop / guard). */
  disposeFlow(flowId: FlowId): Promise<void>;
}

// -----------------------------------------------------------------------------
// Id ↔ session mapping.
// -----------------------------------------------------------------------------

const ID_PREFIX = "term://";
const SESSION_PREFIX = "loom-term-";
/** tmux session names cannot contain "." or ":". Allow only this safe set. */
const SAFE_CHARS_RE = /[^A-Za-z0-9_]/g;

/** Default pane geometry; tmux needs a size when started detached. */
const PANE_WIDTH = 200;
const PANE_HEIGHT = 50;

/** Cap how much of the live pipe we buffer before flushing a chunk. */
const PIPE_FLUSH_BYTES = 8 * 1024;

/** Cap the per-terminal replay buffer (bytes) so a long run can't grow forever. */
const REPLAY_BUFFER_BYTES = 64 * 1024;

/** Grace after interrupting a pane command before we consider it killed (ms). */
const PANE_INTERRUPT_GRACE_MS = 1500;

interface TermEntry {
  /** Mutable, registry-facing terminal record (always present once registered). */
  terminal: Terminal;
  /** tmux session name (loom-term-…). */
  session: string;
  /** True once `ensure` has confirmed a live tmux session. */
  alive: boolean;
  /** True if tmux failed across the boundary; we keep the contract but go idle. */
  degraded: boolean;
  /** Live pane pipe wiring (pipe-pane → fifo → read stream), if streaming. */
  pipe?: PipeState;
  /** In-flight `ensure()` so concurrent callers share one bring-up. */
  ensuring?: Promise<Terminal>;
  /** Bounded ring of recent pane output, replayed on terminal.open. */
  replay: string;
  /** Monotonic counter for unique tmux wait-for channels per run. */
  runSeq: number;
}

interface PipeState {
  fifoDir: string;
  fifoPath: string;
  /** The fs read stream draining the fifo. */
  stop: () => Promise<void>;
}

/** Strip the "term://" prefix; everything after is the logical id body. */
function idBody(id: string): string {
  const trimmed = id.trim();
  if (!trimmed.startsWith(ID_PREFIX)) {
    throw new Error(`terminals: invalid id "${id}" (expected "term://…")`);
  }
  const body = trimmed.slice(ID_PREFIX.length).trim();
  if (body.length === 0) {
    throw new Error(`terminals: invalid id "${id}" (empty body)`);
  }
  return body;
}

/** Canonical "term://<body>" (so callers can pass loose whitespace). */
function canonicalId(id: string): string {
  return `${ID_PREFIX}${idBody(id)}`;
}

/**
 * Derive a tmux-safe, collision-resistant session name from any id body. We
 * sanitize the body to [A-Za-z0-9_] AND append a short sha of the raw body, so
 * two different bodies that sanitize to the same string still get distinct
 * sessions. tmux session names never contain "." / ":" this way.
 */
function sessionFor(id: string): string {
  const body = idBody(id);
  const safe = body.replace(SAFE_CHARS_RE, "_").slice(0, 48);
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  return `${SESSION_PREFIX}${safe}_${hash}`;
}

/** "term://flow-x.node-y" → {flowId:"flow-x", nodeId:"node-y"} when it parses. */
function ownerFromId(id: string): { flowId?: string; nodeId?: string } {
  let body: string;
  try {
    body = idBody(id);
  } catch {
    return {};
  }
  // Run terminals are "<flow>.<node>"; the flow id never contains a dot in our
  // scheme (newId() → "flow-<hex>"), so split on the FIRST dot.
  const dot = body.indexOf(".");
  if (dot <= 0 || dot >= body.length - 1) return {};
  return { flowId: body.slice(0, dot), nodeId: body.slice(dot + 1) };
}

/** Stable, human display title for a terminal id. */
function titleFor(id: string): string {
  const body = idBody(id);
  if (/^\d+$/.test(body)) return `Terminal ${body}`;
  const owner = ownerFromId(id);
  if (owner.nodeId) return owner.nodeId;
  return body;
}

/** Sort key so the rail keeps numeric terminals first, then run terminals. */
function sortKey(id: string): [number, string] {
  const body = idBody(id);
  if (/^\d+$/.test(body)) return [Number(body), ""];
  return [Number.MAX_SAFE_INTEGER, body];
}

/** Run a tmux subcommand with an ARGV ARRAY (never a shell string). */
function runTmux(
  args: string[],
  opts: { input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("tmux", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err) });
      return;
    }

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;

    const finish = (code: number, stderrExtra = "") => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errOut).toString("utf8") + stderrExtra,
      });
    };

    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => errOut.push(b));
    child.on("error", (err) => finish(127, String(err)));
    child.on("close", (code) => finish(code ?? 0));

    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {
        /* ignore EPIPE: tmux may close stdin early */
      });
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Quote one argv token for a POSIX shell. We build a single-quoted string and
 * escape embedded single quotes the standard way ('\'' ). The pane's shell (bash
 * -l, started by tmux) is what runs the resulting line; we never run `sh -c`
 * ourselves with interpolated user data — every tmux invocation is an argv array.
 */
function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/** Construct the terminals manager; `emit` publishes terminal.state. */
export function createTerminals(emit: Emit): Terminals {
  const registry = new Map<string, TermEntry>();
  const dataListeners = new Set<TerminalDataListener>();
  let disposed = false;

  function emitState(entry: TermEntry): void {
    emit({
      type: "terminal.state",
      terminal: entry.terminal.id,
      status: entry.terminal.status,
      meta: entry.terminal.meta,
    });
  }

  function fanoutData(entry: TermEntry, chunk: string): void {
    if (chunk.length === 0) return;
    // Append to the bounded replay ring so a late terminal.open can catch up.
    entry.replay = (entry.replay + chunk).slice(-REPLAY_BUFFER_BYTES);
    for (const l of dataListeners) {
      try {
        l(entry.terminal.id, chunk);
      } catch {
        /* a misbehaving listener must not break the pipe */
      }
    }
  }

  function makeEntry(id: string): TermEntry {
    const canonical = canonicalId(id);
    const owner = ownerFromId(canonical);
    const terminal: Terminal = {
      id: canonical,
      title: titleFor(canonical),
      status: "idle",
      meta: "idle",
    };
    if (owner.flowId) terminal.flowId = owner.flowId as FlowId;
    if (owner.nodeId) terminal.nodeId = owner.nodeId as NodeId;
    const entry: TermEntry = {
      terminal,
      session: sessionFor(canonical),
      alive: false,
      degraded: false,
      replay: "",
      runSeq: 0,
    };
    registry.set(canonical, entry);
    return entry;
  }

  function getEntry(id: string): TermEntry | null {
    let canonical: string;
    try {
      canonical = canonicalId(id);
    } catch {
      return null;
    }
    return registry.get(canonical) ?? null;
  }

  /**
   * Start streaming the live pane via `tmux pipe-pane` into a fifo we drain.
   * Best-effort: if any step fails the terminal still works, just without a live
   * feed (capturePane remains available as a fallback snapshot).
   */
  async function startPipe(entry: TermEntry): Promise<void> {
    if (entry.pipe || entry.degraded) return;

    let fifoDir: string | undefined;
    try {
      fifoDir = await mkdtemp(join(tmpdir(), "loom-term-"));
      const fifoPath = join(fifoDir, "pane.pipe");

      // node:fs has no mkfifo; create the FIFO via the coreutils binary.
      const mk = await new Promise<number>((resolve) => {
        const c = spawn("mkfifo", [fifoPath], { stdio: "ignore" });
        c.on("error", () => resolve(127));
        c.on("close", (code) => resolve(code ?? 0));
      });
      if (mk !== 0) throw new Error("mkfifo failed");

      // tmux pipe-pane runs the redirection via its OWN /bin/sh; the ">>" here is
      // interpreted by that sh, not by us building a shell string. The fifo path
      // is one we control (mkdtemp), so there is no untrusted-input surface.
      const pipeCmd = `cat >> ${shQuote(fifoPath)}`;
      const res = await runTmux([
        "pipe-pane",
        "-t",
        `${entry.session}:0.0`,
        "-o",
        pipeCmd,
      ]);
      if (res.code !== 0) throw new Error(`pipe-pane: ${res.stderr.trim()}`);

      // Open the read end. The fifo blocks until tmux opens the write end.
      const stream = createReadStream(fifoPath, { encoding: "utf8" });
      let buf = "";
      const flush = () => {
        if (buf.length === 0) return;
        const chunk = buf;
        buf = "";
        fanoutData(entry, chunk);
      };
      stream.on("data", (data: string | Buffer) => {
        buf += typeof data === "string" ? data : data.toString("utf8");
        if (buf.length >= PIPE_FLUSH_BYTES) flush();
        else queueMicrotask(flush);
      });
      stream.on("error", () => {
        /* fifo torn down during dispose — ignore */
      });

      const stop = async (): Promise<void> => {
        flush();
        await runTmux(["pipe-pane", "-t", `${entry.session}:0.0`]).catch(
          () => undefined,
        );
        stream.destroy();
        await rm(fifoDir!, { recursive: true, force: true }).catch(
          () => undefined,
        );
      };

      entry.pipe = { fifoDir, fifoPath, stop };
    } catch {
      if (fifoDir) {
        await rm(fifoDir, { recursive: true, force: true }).catch(() => undefined);
      }
      entry.pipe = undefined;
    }
  }

  async function stopPipe(entry: TermEntry): Promise<void> {
    const p = entry.pipe;
    entry.pipe = undefined;
    if (p) await p.stop().catch(() => undefined);
  }

  /**
   * Bring a tmux session up (idempotent). `has-session` first; if absent,
   * `new-session -d` with an argv array, started as a LOGIN shell (bash -l) so
   * node/claude resolve on PATH inside the pane. On any cross-boundary failure we
   * mark the entry degraded and keep the contract (status stays a valid value).
   */
  async function bringUp(entry: TermEntry): Promise<void> {
    const session = entry.session;

    const has = await runTmux(["has-session", "-t", session]);
    if (has.code === 0) {
      entry.alive = true;
      entry.degraded = false;
      await startPipe(entry);
      return;
    }

    const created = await runTmux([
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      String(PANE_WIDTH),
      "-y",
      String(PANE_HEIGHT),
      // Login shell → full PATH for node/claude inside the pane.
      "bash",
      "-l",
    ]);

    if (created.code === 0) {
      entry.alive = true;
      entry.degraded = false;
      // Disable the status line so capturePane/stream stay clean. Best-effort.
      await runTmux(["set-option", "-t", session, "status", "off"]).catch(
        () => undefined,
      );
      await startPipe(entry);
      return;
    }

    // Could not create — maybe it raced into existence between calls?
    const recheck = await runTmux(["has-session", "-t", session]);
    if (recheck.code === 0) {
      entry.alive = true;
      entry.degraded = false;
      await startPipe(entry);
      return;
    }

    // Genuine failure (no tmux / WSL boundary issue). Degrade gracefully.
    entry.alive = false;
    entry.degraded = true;
  }

  // ---- public surface -------------------------------------------------------

  async function ensure(id: string): Promise<Terminal> {
    if (disposed) throw new Error("terminals: manager disposed");
    const canonical = canonicalId(id);
    let entry = registry.get(canonical);
    const fresh = !entry;
    if (!entry) entry = makeEntry(canonical);

    if (entry.ensuring) return entry.ensuring;

    const work = (async () => {
      await bringUp(entry!);
      if (fresh) emitState(entry!);
      return entry!.terminal;
    })();

    entry.ensuring = work;
    try {
      return await work;
    } finally {
      entry.ensuring = undefined;
    }
  }

  async function send(id: string, data: string): Promise<void> {
    if (disposed) throw new Error("terminals: manager disposed");
    const entry = getEntry(id) ?? makeEntry(canonicalId(id));
    if (!entry.alive || entry.degraded) await bringUp(entry);
    if (!entry.alive || entry.degraded) return; // degraded: best-effort no-op.

    // -l sends `data` LITERALLY (no key-name interpretation); a separate Enter
    // submits it. Both go through an argv array — no shell string is constructed.
    const lit = await runTmux([
      "send-keys",
      "-t",
      `${entry.session}:0.0`,
      "-l",
      data,
    ]);
    if (lit.code !== 0) {
      entry.degraded = true;
      return;
    }
    await runTmux(["send-keys", "-t", `${entry.session}:0.0`, "Enter"]).catch(
      () => undefined,
    );
  }

  /**
   * Run a command INSIDE the pane and resolve when it exits.
   *
   * Mechanism (the proven one): build a single shell line
   *     cd <cwd> ; <claude argv…> ; tmux wait-for -S <chan>
   * send it to the pane with send-keys, then block on `tmux wait-for <chan>`.
   * The exit code is recovered by appending `; tmux set-environment` of `$?`;
   * we read it back via show-environment. Output streams live via pipe-pane.
   *
   * The argv tokens are POSIX-quoted; the LINE is interpreted by the pane's
   * bash, not by us spawning `sh -c` with interpolated data. Abort + timeout
   * send Ctrl-C (C-c) to interrupt the running claude, then signal the channel.
   */
  async function runInPane(id: string, spec: PaneRunSpec): Promise<PaneRunResult> {
    if (disposed) throw new Error("terminals: manager disposed");
    const entry = getEntry(id) ?? makeEntry(canonicalId(id));
    await ensure(entry.terminal.id);
    if (!entry.alive || entry.degraded) {
      return { exitCode: null, aborted: false, timedOut: false, degraded: true };
    }

    const seq = ++entry.runSeq;
    // Unique channels per run so a foreign signal never settles us early.
    const doneChan = `loom_done_${seq}_${process.pid}`;
    const rcVar = `LOOM_RC_${seq}`;
    const target = `${entry.session}:0.0`;

    // Build: cd <cwd> ; <argv…> ; rc=$? ; tmux set-environment <rcVar> $rc ;
    //        tmux wait-for -S <doneChan>
    const cmd = spec.argv.map(shQuote).join(" ");
    const line =
      `cd ${shQuote(spec.cwd)} && clear ; ${cmd} ; __rc=$? ; ` +
      `tmux set-environment -t ${shQuote(entry.session)} ${rcVar} $__rc ; ` +
      `tmux wait-for -S ${doneChan}`;

    // Type the whole line literally, then Enter to execute it.
    const litSend = await runTmux(["send-keys", "-t", target, "-l", line]);
    if (litSend.code !== 0) {
      entry.degraded = true;
      return { exitCode: null, aborted: false, timedOut: false, degraded: true };
    }
    await runTmux(["send-keys", "-t", target, "Enter"]).catch(() => undefined);

    // Optionally feed stdin to the pane (rarely needed; claude -p carries prompt).
    if (spec.input !== undefined && spec.input.length > 0) {
      await runTmux(["send-keys", "-t", target, "-l", spec.input]).catch(
        () => undefined,
      );
    }

    let aborted = false;
    let timedOut = false;

    // Interrupt the running command (Ctrl-C) and release the wait-for channel so
    // the blocking call below returns promptly.
    const interrupt = async (): Promise<void> => {
      await runTmux(["send-keys", "-t", target, "C-c"]).catch(() => undefined);
      // Give claude a moment to unwind, then force the channel.
      await new Promise((r) => setTimeout(r, PANE_INTERRUPT_GRACE_MS));
      await runTmux(["wait-for", "-S", doneChan]).catch(() => undefined);
    };

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      void interrupt();
    };

    const signal = spec.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    if (spec.timeoutMs && spec.timeoutMs > 0) {
      watchdog = setTimeout(() => {
        if (timedOut) return;
        timedOut = true;
        void interrupt();
      }, spec.timeoutMs);
      (watchdog as unknown as { unref?: () => void }).unref?.();
    }

    // Block until the pane signals completion (or interrupt forces it).
    await runTmux(["wait-for", doneChan]).catch(() => undefined);

    if (watchdog) clearTimeout(watchdog);
    if (signal) signal.removeEventListener("abort", onAbort);

    // Recover the command's exit code from the tmux session environment.
    let exitCode: number | null = null;
    const env = await runTmux(["show-environment", "-t", entry.session, rcVar]);
    if (env.code === 0) {
      const m = new RegExp(`^${rcVar}=(-?\\d+)`, "m").exec(env.stdout);
      if (m) exitCode = Number(m[1]);
    }
    // Tidy: drop the per-run env var so the session env doesn't accumulate.
    await runTmux(["set-environment", "-t", entry.session, "-u", rcVar]).catch(
      () => undefined,
    );

    return { exitCode, aborted, timedOut, degraded: false };
  }

  async function capturePane(id: string): Promise<string> {
    if (disposed) throw new Error("terminals: manager disposed");
    const entry = getEntry(id);
    if (!entry || !entry.alive || entry.degraded) return "";

    const res = await runTmux([
      "capture-pane",
      "-t",
      `${entry.session}:0.0`,
      "-p",
      "-J",
    ]);
    if (res.code !== 0) {
      entry.degraded = true;
      return "";
    }
    return res.stdout;
  }

  function recentOutput(id: string): string {
    const entry = getEntry(id);
    return entry ? entry.replay : "";
  }

  function list(): Terminal[] {
    return [...registry.values()]
      .map((e) => ({ ...e.terminal }))
      .sort((a, b) => {
        const [an, as] = sortKey(a.id);
        const [bn, bs] = sortKey(b.id);
        return an !== bn ? an - bn : as.localeCompare(bs);
      });
  }

  function get(id: string): Terminal | null {
    const entry = getEntry(id);
    return entry ? { ...entry.terminal } : null;
  }

  function setOwnership(id: string, ownership: TerminalOwnership): void {
    const canonical = canonicalId(id);
    let entry = registry.get(canonical);
    if (!entry) entry = makeEntry(canonical);

    const t = entry.terminal;
    const prevStatus = t.status;
    const prevMeta = t.meta;
    const prevFlow = t.flowId;
    const prevNode = t.nodeId;

    t.status = ownership.status;
    t.meta = ownership.meta;
    if (ownership.flowId !== undefined) t.flowId = ownership.flowId;
    if (ownership.nodeId !== undefined) t.nodeId = ownership.nodeId;
    // Note: we do NOT clear flowId/nodeId on idle — a per-run terminal keeps its
    // owning (flow,node) identity (parsed from the id) so disposeFlow can find it.

    const changed =
      prevStatus !== t.status ||
      prevMeta !== t.meta ||
      prevFlow !== t.flowId ||
      prevNode !== t.nodeId;

    if (changed) emitState(entry);
  }

  function onData(listener: TerminalDataListener): Unsubscribe {
    dataListeners.add(listener);
    return () => {
      dataListeners.delete(listener);
    };
  }

  async function dispose(id: string): Promise<void> {
    const entry = getEntry(id);
    if (!entry) return;

    await stopPipe(entry);
    await runTmux(["kill-session", "-t", entry.session]).catch(() => undefined);

    entry.alive = false;
    registry.delete(entry.terminal.id);

    emit({
      type: "terminal.state",
      terminal: entry.terminal.id,
      status: "idle",
      meta: "closed",
    });
  }

  async function disposeFlow(flowId: FlowId): Promise<void> {
    const fid = flowId as string;
    const victims = [...registry.values()].filter(
      (e) => (e.terminal.flowId as string | undefined) === fid,
    );
    // Kill each explicitly (no for-loop var pitfalls — one dispose per entry).
    await Promise.all(victims.map((e) => dispose(e.terminal.id)));
  }

  return {
    ensure,
    send,
    runInPane,
    capturePane,
    recentOutput,
    list,
    get,
    setOwnership,
    onData,
    dispose,
    disposeFlow,
  };
}
