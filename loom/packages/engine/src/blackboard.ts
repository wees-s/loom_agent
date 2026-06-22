// =============================================================================
// blackboard.ts [blackboard] — per-flow context dir (the agent cwd).
//
// Atomic writes (temp+rename), sha256 per write (feeds the presence barrier AND
// convergence), a per-path async mutex so concurrent writers serialize, and
// `wslpath -w` translation so the runner can hand dirs/files to the Windows
// claude.exe. Emits blackboard.write {bytes, hash}. term://N references resolve
// to terminals (delegated to the terminals module).
//
// WORKDIR: a flow may declare an absolute workDir (a REAL user folder). When set,
// resolveDir returns resolve(workDir) and every fs op (atomicWrite/sha256/read/
// exists/list/resolveContext) operates relative to it, so the flow's agents read
// and write the user's actual files (RunCtx.flowDir = cwd, winFlowDir = --add-dir).
// When unset, the flow stays in its internal blackboardRoot/<blackboardDir>
// sandbox. EITHER WAY safeRelPath keeps `..` from escaping the base dir.
// =============================================================================

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { resolve, join, dirname, isAbsolute, relative, sep, posix } from "node:path";

import type { Flow, FlowId, NodeId } from "@loom/shared";
import type { Emit } from "./internal.js";
import type { Terminals } from "./terminals.js";

/** Result of an atomic write — also the payload of the blackboard.write event. */
export interface WriteResult {
  relPath: string;
  bytes: number;
  /** sha256 hex of the written content. */
  hash: string;
}

/** A resolved linkedContext entry: a file in the dir or a terminal handle. */
export type ResolvedContext =
  | { kind: "file"; relPath: string; absPath: string }
  | { kind: "terminal"; terminal: string }
  | { kind: "external"; ref: string }; // e.g. "#standup" channel — opaque label

export interface Blackboard {
  /** Absolute POSIX path of the flow's context dir (created if missing). */
  resolveDir(flow: Flow | FlowId): string;

  /** `wslpath -w <wslPath>` (spawned) → Windows path for claude --add-dir. */
  toWindowsPath(wslPath: string): Promise<string>;

  /**
   * Atomic write (temp file + rename) under the flow dir, serialized by a
   * per-(flow,relPath) mutex. Computes sha256, emits blackboard.write, returns
   * the result. `byNodeId` attributes the write for the event.
   */
  atomicWrite(
    flowId: FlowId,
    byNodeId: NodeId,
    relPath: string,
    content: string | Uint8Array,
  ): Promise<WriteResult>;

  /** sha256 hex of an existing file (null if it does not exist). */
  sha256(flowId: FlowId, relPath: string): Promise<string | null>;

  /** Read a file's contents (throws if missing). */
  read(flowId: FlowId, relPath: string): Promise<string>;

  /** True iff the relPath exists in the flow dir (barrier presence check). */
  exists(flowId: FlowId, relPath: string): Promise<boolean>;

  /** List relPaths under the flow dir (recursive, files only). */
  list(flowId: FlowId): Promise<string[]>;

  /** Resolve a linkedContexts entry (file | term://N | external label). */
  resolveContext(flowId: FlowId, ref: string): ResolvedContext;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** Treat a value as a Flow (vs a bare FlowId string). */
function isFlow(flow: Flow | FlowId): flow is Flow {
  return typeof flow === "object" && flow !== null && "id" in flow;
}

/** Sanitize a flow-relative path so it can NEVER escape the flow dir.
 *  Rejects absolute paths, `..` traversal, and normalizes separators. */
function safeRelPath(relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`blackboard: empty relPath`);
  }
  // Normalize both separator styles to POSIX before validating.
  const unified = relPath.replace(/\\/g, "/").trim();
  if (isAbsolute(unified) || unified.startsWith("/")) {
    throw new Error(`blackboard: absolute relPath not allowed: ${relPath}`);
  }
  // posix.normalize collapses `.` and `..`; reject if it still climbs out.
  const norm = posix.normalize(unified);
  if (norm === "." || norm === "" || norm.startsWith("..") || norm.includes("/../")) {
    throw new Error(`blackboard: relPath escapes flow dir: ${relPath}`);
  }
  return norm;
}

/** A single sanitized directory name (no separators, no traversal). */
function safeDirName(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, "_").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new Error(`blackboard: invalid dir name: ${name}`);
  }
  return cleaned;
}

function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
}

/** Recursively collect file paths (POSIX-relative to `base`). */
async function walkFiles(absDir: string, base: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const childAbs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(childAbs, base)));
    } else if (entry.isFile()) {
      // Express the relative path in POSIX form for a stable cross-tool contract.
      out.push(relative(base, childAbs).split(sep).join("/"));
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/**
 * Construct the blackboard rooted at `blackboardRoot`. `terminals` is used to
 * resolve term://N references; `emit` publishes blackboard.write.
 */
export function createBlackboard(
  blackboardRoot: string,
  terminals: Terminals,
  emit: Emit,
): Blackboard {
  const root = resolve(blackboardRoot);

  // FlowId -> relative dir name. A bare FlowId has no spec attached, so we learn
  // the (possibly custom) blackboardDir whenever a full Flow is resolved and
  // fall back to the flowId itself for ids we have not seen.
  const dirByFlow = new Map<string, string>();

  // FlowId -> absolute workDir (a REAL user folder). When present it WINS over the
  // internal blackboardDir sandbox: the flow's agents cwd into it + claude scopes
  // file access to it (--add-dir). Learned whenever a full Flow is resolved; a
  // bare FlowId we have not seen falls back to the sandbox (workDir undefined).
  const workDirByFlow = new Map<string, string>();

  // Per-(flow,relPath) async mutex: a chain of promises keyed by abs file path.
  // Each new operation appends to the tail; concurrent writers thus serialize
  // without ever blocking unrelated paths.
  const locks = new Map<string, Promise<unknown>>();

  function dirNameFor(flowId: FlowId): string {
    return dirByFlow.get(flowId) ?? safeDirName(flowId);
  }

  /**
   * The absolute BASE directory every relPath of a flow resolves under. This is
   * the single source of truth for "where the flow's files live":
   *   - workDir set  → resolve(workDir)        (a REAL user folder)
   *   - workDir unset → join(root, dirName)    (the internal sandbox)
   * safeRelPath still guarantees `..` can never escape this base in either mode.
   */
  function baseDirFor(flowId: FlowId): string {
    const wd = workDirByFlow.get(flowId);
    if (wd) return resolve(wd);
    return join(root, dirNameFor(flowId));
  }

  function resolveDir(flow: Flow | FlowId): string {
    let flowId: FlowId;
    if (isFlow(flow)) {
      flowId = flow.id;
      const dirName = flow.blackboardDir?.trim()
        ? safeDirName(flow.blackboardDir)
        : safeDirName(flow.id);
      dirByFlow.set(flowId, dirName);
      // Cache (or clear) the workDir from the freshest Flow we have seen.
      const wd = flow.workDir?.trim();
      if (wd) workDirByFlow.set(flowId, wd);
      else workDirByFlow.delete(flowId);
    } else {
      flowId = flow;
    }
    const abs = baseDirFor(flowId);
    // Fire-and-forget mkdir is unsafe (callers expect the dir to exist when the
    // path is handed to claude). Kick it off synchronously-enough: callers that
    // need the dir present go through async methods which mkdir again (idempotent).
    // recursive:true creates the workDir's parent chain too (first-use safety).
    void mkdir(abs, { recursive: true }).catch(() => {
      /* surfaced on the next fs op that actually touches the dir */
    });
    // Always return a POSIX-style absolute path (engine + claude expect POSIX).
    return abs.split(sep).join("/");
  }

  /** Resolve the absolute file path for (flowId, relPath), ensuring its parent
   *  directory exists. Returns both the abs path and the sanitized relPath. */
  async function absFileFor(
    flowId: FlowId,
    relPath: string,
  ): Promise<{ abs: string; rel: string; dir: string }> {
    const rel = safeRelPath(relPath);
    const dir = baseDirFor(flowId);
    const abs = join(dir, ...rel.split("/"));
    return { abs, rel, dir };
  }

  /** Serialize an operation behind any pending op on the same abs path. */
  function withLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    // Run after the previous op settles (success OR failure), so one failed
    // write never wedges the queue for that path.
    const next = prev.then(op, op);
    // Keep the chain alive but swallow rejections at the bookkeeping layer so an
    // unhandled rejection on the stored promise never crashes the process; the
    // real result/rejection still propagates to THIS caller via `next`.
    locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async function atomicWrite(
    flowId: FlowId,
    byNodeId: NodeId,
    relPath: string,
    content: string | Uint8Array,
  ): Promise<WriteResult> {
    const { abs, rel, dir } = await absFileFor(flowId, relPath);

    return withLock(abs, async () => {
      const targetDir = dirname(abs);
      await mkdir(targetDir, { recursive: true });

      const hash = sha256Hex(content);
      const bytes = byteLength(content);

      // temp file in the SAME directory => rename is atomic on the same fs.
      const tmp = join(
        targetDir,
        `.${posix.basename(rel)}.${process.pid}.${Date.now().toString(36)}.${Math.random()
          .toString(36)
          .slice(2, 8)}.tmp`,
      );
      try {
        await writeFile(tmp, content);
        await rename(tmp, abs);
      } catch (err) {
        // Best-effort cleanup of the temp file if the rename never happened.
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }

      emit({
        type: "blackboard.write",
        flowId,
        path: rel,
        byNodeId,
        bytes,
        hash,
        at: Date.now(),
      });

      return { relPath: rel, bytes, hash };
    });
  }

  async function sha256(flowId: FlowId, relPath: string): Promise<string | null> {
    const { abs } = await absFileFor(flowId, relPath);
    try {
      const buf = await readFile(abs);
      return sha256Hex(buf);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async function read(flowId: FlowId, relPath: string): Promise<string> {
    const { abs } = await absFileFor(flowId, relPath);
    return readFile(abs, "utf8");
  }

  async function exists(flowId: FlowId, relPath: string): Promise<boolean> {
    const { abs } = await absFileFor(flowId, relPath);
    try {
      const s = await stat(abs);
      return s.isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async function list(flowId: FlowId): Promise<string[]> {
    const dir = baseDirFor(flowId);
    const files = await walkFiles(dir, dir);
    return files.sort();
  }

  function toWindowsPath(wslPath: string): Promise<string> {
    return new Promise<string>((resolveP, rejectP) => {
      // argv ARRAY — never a shell string — to survive the WSL/Windows bridge.
      const child = spawn("wslpath", ["-w", wslPath], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let errOut = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        errOut += d.toString("utf8");
      });
      child.on("error", (err) => rejectP(err));
      child.on("close", (code) => {
        if (code === 0) {
          const win = out.replace(/\r?\n$/, "").trim();
          if (win.length === 0) {
            rejectP(new Error(`wslpath -w returned empty output for: ${wslPath}`));
            return;
          }
          resolveP(win);
        } else {
          rejectP(
            new Error(`wslpath -w failed (exit ${code ?? "null"}) for ${wslPath}: ${errOut.trim()}`),
          );
        }
      });
    });
  }

  function resolveContext(flowId: FlowId, ref: string): ResolvedContext {
    const trimmed = ref.trim();

    // term://N (or term://name) → delegate to the terminals registry.
    const termMatch = /^term:\/\/(.+)$/i.exec(trimmed);
    if (termMatch) {
      const suffix = termMatch[1]!.trim();
      // Canonical terminal id used across the engine/UI is "term://N".
      const terminal = `term://${suffix}`;
      return { kind: "terminal", terminal };
    }

    // External label (channel/integration), e.g. "#standup" — opaque to us.
    if (trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      return { kind: "external", ref: trimmed };
    }

    // Otherwise it is a file in the flow dir (workDir if set, else the sandbox).
    const rel = safeRelPath(trimmed);
    const abs = join(baseDirFor(flowId), ...rel.split("/"));
    return { kind: "file", relPath: rel, absPath: abs.split(sep).join("/") };
  }

  // `terminals` is wired so future term:// resolution can validate/ensure the
  // session; the current contract only needs the canonical id, but we keep the
  // dependency live (the orchestrator owns ensure()/ownership).
  void terminals;

  return {
    resolveDir,
    toWindowsPath,
    atomicWrite,
    sha256,
    read,
    exists,
    list,
    resolveContext,
  };
}
