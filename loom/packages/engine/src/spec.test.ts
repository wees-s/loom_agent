// =============================================================================
// spec.test.ts — spec store: delete() ARCHIVES the YAML (never hard-rm) + drops
// it from the cache, listFlows() handles ZERO flows gracefully, and create()
// round-trips. Uses a real temp dir (the store does real fs I/O).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpecStore, type SpecStore } from "./spec.js";
import type { Emit } from "./internal.js";
import { asFlowId, type LoomEvent, type StoredEvent } from "@loom/shared";

function makeEmitter(): { events: LoomEvent[]; emit: Emit } {
  const events: LoomEvent[] = [];
  const emit: Emit = (event) => {
    events.push(event);
    return { seq: events.length, ts: Date.now(), event } as StoredEvent;
  };
  return { events, emit };
}

let root: string;
let flowsDir: string;
let dataDir: string;
let specVersionsDir: string;
let deletedDir: string;
let store: SpecStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "loom-spec-"));
  flowsDir = join(root, "flows");
  dataDir = join(root, "data");
  specVersionsDir = join(dataDir, "spec_versions");
  deletedDir = join(dataDir, "deleted");
  await fs.mkdir(flowsDir, { recursive: true });
  store = createSpecStore(flowsDir, specVersionsDir, makeEmitter().emit);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

describe("spec — listFlows handles ZERO flows", () => {
  it("returns [] for an empty flows dir (no throw)", async () => {
    expect(await store.listFlows()).toEqual([]);
    expect(store.all()).toEqual([]);
  });

  it("returns [] for a missing flows dir", async () => {
    const missing = createSpecStore(join(root, "nope"), specVersionsDir, makeEmitter().emit);
    expect(await missing.listFlows()).toEqual([]);
  });
});

describe("spec — delete() archives the YAML (never hard-rm) + drops from cache", () => {
  it("moves the on-disk YAML into data/deleted and removes it from flows/ + cache", async () => {
    const { flow } = await store.create("My Flow");
    const id = flow.id;

    // It exists on disk + in cache before delete.
    const before = await listDir(flowsDir);
    expect(before.some((f) => f.endsWith(".flow.yaml"))).toBe(true);
    expect(store.get(id)).not.toBeNull();

    const result = await store.delete(id);

    // Cache no longer knows the flow.
    expect(store.get(id)).toBeNull();
    expect(store.all().find((f) => f.id === id)).toBeUndefined();

    // The flows/ dir no longer has the spec (it was MOVED, not copied).
    const afterFlows = await listDir(flowsDir);
    expect(afterFlows.some((f) => f.endsWith(".flow.yaml"))).toBe(false);

    // The archive exists under data/deleted and is non-empty (recoverable).
    expect(result.archivedPath).not.toBeNull();
    const archived = await listDir(deletedDir);
    expect(archived.length).toBe(1);
    const archivedRaw = await fs.readFile(result.archivedPath as string, "utf8");
    expect(archivedRaw.length).toBeGreaterThan(0);
    expect(archivedRaw).toContain("My Flow");
  });

  it("is idempotent: deleting an unknown / already-deleted id is a no-op", async () => {
    const r1 = await store.delete(asFlowId("does-not-exist"));
    expect(r1.archivedPath).toBeNull();

    const { flow } = await store.create("Once");
    await store.delete(flow.id);
    const r2 = await store.delete(flow.id); // second delete
    expect(r2.archivedPath).toBeNull();
    expect(store.get(flow.id)).toBeNull();
  });

  it("after delete, listFlows() no longer loads the archived flow", async () => {
    const { flow } = await store.create("Gone");
    await store.delete(flow.id);
    // A fresh store over the same flows dir loads nothing (archive lives elsewhere).
    const fresh = createSpecStore(flowsDir, specVersionsDir, makeEmitter().emit);
    expect(await fresh.listFlows()).toEqual([]);
  });
});

describe("spec — workDir round-trips through save/load + is mkdir'd on save", () => {
  it("save(EditableFlow) persists workDir to YAML, hot-reloads it, and a fresh store reloads it", async () => {
    const { flow } = await store.create("WD Flow");
    const workDir = join(root, "real-user-folder", "nested");

    // The user configures a REAL folder and saves.
    const { flow: saved } = await store.save({
      id: flow.id,
      name: flow.name,
      workDir,
      nodes: flow.nodes,
      edges: flow.edges,
    });

    // Hot-reloaded in-memory flow carries it.
    expect(saved.workDir).toBe(workDir);
    expect(store.get(flow.id)?.workDir).toBe(workDir);

    // It was mkdir'd on save (exists before the first run hands it to claude).
    const st = await fs.stat(workDir);
    expect(st.isDirectory()).toBe(true);

    // Persisted to the YAML on disk (the topology source of truth).
    const files = await fs.readdir(flowsDir);
    const yamlFile = files.find((f) => f.endsWith(".flow.yaml"));
    expect(yamlFile).toBeDefined();
    const raw = await fs.readFile(join(flowsDir, yamlFile as string), "utf8");
    expect(raw).toContain("workDir:");
    expect(raw).toContain(workDir);

    // A fresh store over the same flows dir reloads workDir from YAML.
    const fresh = createSpecStore(flowsDir, specVersionsDir, makeEmitter().emit);
    const reloaded = await fresh.listFlows();
    expect(reloaded.find((f) => f.id === flow.id)?.workDir).toBe(workDir);
  });

  it("round-trips reviewEachCycle through save + reload", async () => {
    const { flow } = await store.create("Review Flow");
    const { flow: saved } = await store.save({
      id: flow.id,
      name: flow.name,
      reviewEachCycle: true,
      nodes: flow.nodes,
      edges: flow.edges,
    });
    expect(saved.reviewEachCycle).toBe(true);
    expect(store.get(flow.id)?.reviewEachCycle).toBe(true);

    // Persisted to YAML + reloaded by a fresh store.
    const files = await fs.readdir(flowsDir);
    const yamlFile = files.find((f) => f.endsWith(".flow.yaml"));
    const raw = await fs.readFile(join(flowsDir, yamlFile as string), "utf8");
    expect(raw).toContain("reviewEachCycle: true");
    const fresh = createSpecStore(flowsDir, specVersionsDir, makeEmitter().emit);
    const reloaded = await fresh.listFlows();
    expect(reloaded.find((f) => f.id === flow.id)?.reviewEachCycle).toBe(true);
  });

  it("clearing workDir (empty string) removes it from the YAML on the next save", async () => {
    const { flow } = await store.create("WD Clear");
    const workDir = join(root, "to-be-cleared");
    await store.save({ id: flow.id, name: flow.name, workDir, nodes: flow.nodes, edges: flow.edges });
    expect(store.get(flow.id)?.workDir).toBe(workDir);

    // Save again with an empty workDir → cleared.
    const { flow: cleared } = await store.save({
      id: flow.id,
      name: flow.name,
      workDir: "",
      nodes: flow.nodes,
      edges: flow.edges,
    });
    expect(cleared.workDir).toBeUndefined();

    const files = await fs.readdir(flowsDir);
    const yamlFile = files.find((f) => f.endsWith(".flow.yaml"));
    const raw = await fs.readFile(join(flowsDir, yamlFile as string), "utf8");
    expect(raw).not.toContain("workDir:");
  });
});
