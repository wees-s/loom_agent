// =============================================================================
// blackboard.test.ts — per-flow context dir, with the workDir override.
//
// Two modes, one contract:
//   - workDir UNSET → the flow lives in the internal blackboardRoot/<dir> sandbox.
//   - workDir SET   → resolveDir + atomicWrite/sha256/read/exists/list/resolveContext
//                     all operate inside the REAL user folder (resolve(workDir)),
//                     and NOTHING is written under blackboardRoot for that flow.
// safeRelPath keeps `..` from escaping the base dir in EITHER mode.
//
// Uses real temp dirs (the blackboard does real fs I/O). Terminals is a stub —
// these tests never touch term:// resolution.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlackboard, type Blackboard } from "./blackboard.js";
import type { Terminals } from "./terminals.js";
import type { Emit } from "./internal.js";
import {
  asFlowId,
  asNodeId,
  type Flow,
  type LoomEvent,
  type StoredEvent,
} from "@loom/shared";

function makeEmitter(): { events: LoomEvent[]; emit: Emit } {
  const events: LoomEvent[] = [];
  const emit: Emit = (event) => {
    events.push(event);
    return { seq: events.length, ts: Date.now(), event } as StoredEvent;
  };
  return { events, emit };
}

/** The blackboard only uses `terminals` for term:// refs; none here exercise it. */
const stubTerminals = {} as unknown as Terminals;

/** A minimal Flow carrying an optional workDir (everything else is filler). */
function makeFlow(id: string, workDir?: string): Flow {
  return {
    id: asFlowId(id),
    name: id,
    version: 1,
    schedule: "Manual",
    state: "ocioso",
    cycle: 0,
    nodes: [],
    edges: [],
    budget: {
      maxCyclesPerArm: 1,
      maxTokensPerRun: 1,
      maxUsdPerRun: 1,
      maxTokensPerFlow: 1,
      maxUsdPerFlow: 1,
      maxConcurrentAgents: 1,
      convergenceWindow: 1,
    },
    blackboardDir: id,
    ...(workDir !== undefined ? { workDir } : {}),
  };
}

let root: string; // blackboardRoot (the internal sandbox)
let userFolder: string; // a REAL user folder, OUTSIDE the sandbox
let bb: Blackboard;

beforeEach(async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "loom-bb-"));
  root = join(base, "blackboard");
  userFolder = join(base, "WORKSPACE", "meu-projeto");
  await fs.mkdir(root, { recursive: true });
  bb = createBlackboard(root, stubTerminals, makeEmitter().emit);
});

afterEach(async () => {
  // root and userFolder share the same mkdtemp base; remove its parent.
  await fs.rm(join(root, ".."), { recursive: true, force: true });
});

describe("blackboard — default sandbox (no workDir)", () => {
  it("resolveDir lands under blackboardRoot and writes go there", async () => {
    const flow = makeFlow("sandbox-flow");
    const dir = bb.resolveDir(flow);
    expect(dir.startsWith(root.split("\\").join("/"))).toBe(true);

    const w = await bb.atomicWrite(flow.id, asNodeId("n1"), "out.md", "hi");
    expect(w.relPath).toBe("out.md");
    expect(await bb.read(flow.id, "out.md")).toBe("hi");

    // It physically lives in the sandbox, not anywhere else.
    const onDisk = await fs.readFile(join(root, "sandbox-flow", "out.md"), "utf8");
    expect(onDisk).toBe("hi");
  });
});

describe("blackboard — workDir override (a REAL user folder)", () => {
  it("resolveDir returns resolve(workDir) and creates it (incl. missing parents)", async () => {
    const flow = makeFlow("wd-flow", userFolder);
    const dir = bb.resolveDir(flow);
    expect(dir).toBe(userFolder.split("\\").join("/"));
    // resolveDir kicks off mkdir fire-and-forget; the first awaited fs op (any
    // write) guarantees the recursive dir — including the missing WORKSPACE parent.
    await bb.atomicWrite(flow.id, asNodeId("n1"), "touch.md", "x");
    const st = await fs.stat(userFolder);
    expect(st.isDirectory()).toBe(true);
  });

  it("atomicWrite/read/sha256/exists/list all operate INSIDE the workDir", async () => {
    const flow = makeFlow("wd-flow", userFolder);
    bb.resolveDir(flow); // teach the blackboard this flow's workDir

    const w = await bb.atomicWrite(flow.id, asNodeId("n1"), "NOTAS.md", "linha real");
    expect(w.relPath).toBe("NOTAS.md");

    // The file is in the REAL user folder...
    const real = await fs.readFile(join(userFolder, "NOTAS.md"), "utf8");
    expect(real).toBe("linha real");

    // ...and the blackboard reads it back from there.
    expect(await bb.read(flow.id, "NOTAS.md")).toBe("linha real");
    expect(await bb.exists(flow.id, "NOTAS.md")).toBe(true);
    expect(await bb.sha256(flow.id, "NOTAS.md")).toBe(w.hash);
    expect(await bb.list(flow.id)).toContain("NOTAS.md");

    // NOTHING was written under blackboardRoot for this flow.
    await expect(fs.stat(join(root, "wd-flow"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a bare FlowId resolves to the workDir once a Flow has taught it", async () => {
    const flow = makeFlow("wd-flow", userFolder);
    bb.resolveDir(flow);
    await bb.atomicWrite(flow.id, asNodeId("n1"), "a.txt", "x");
    // Subsequent ops by id (the orchestrator passes flow.id around) hit workDir.
    expect(await bb.read(asFlowId("wd-flow"), "a.txt")).toBe("x");
  });

  it("safeRelPath still blocks `..` escape from the workDir", async () => {
    const flow = makeFlow("wd-flow", userFolder);
    bb.resolveDir(flow);
    await expect(
      bb.atomicWrite(flow.id, asNodeId("n1"), "../escape.md", "nope"),
    ).rejects.toThrow(/escape/i);
    await expect(bb.read(flow.id, "../../etc/passwd")).rejects.toThrow();
    // The sibling outside the workDir was never created.
    await expect(fs.stat(join(userFolder, "..", "escape.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resolveContext maps a file ref to a path inside the workDir", () => {
    const flow = makeFlow("wd-flow", userFolder);
    bb.resolveDir(flow);
    const ctx = bb.resolveContext(flow.id, "docs/spec.md");
    expect(ctx.kind).toBe("file");
    if (ctx.kind === "file") {
      expect(ctx.absPath).toBe(join(userFolder, "docs", "spec.md").split("\\").join("/"));
    }
  });
});
