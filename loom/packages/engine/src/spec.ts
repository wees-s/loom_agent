// =============================================================================
// spec.ts [spec] — YAML <-> Flow (the topology/prompt source of truth).
//
// load(): parse + validate via zFlowSpec (zod, @loom/shared) + acyclic
// forward-cycle check (feedback edges excluded). save(): comment-preserving
// (yaml package), bump version, snapshot the prior version to a spec_versions
// area, hot-reload. listFlows() from flows/*.flow.yaml. Lint on save: parallel
// sibling nodes (same Kahn layer) must not both declare the same writable
// produces[] artifact (single-writer invariant).
//
// WORKDIR: load/save round-trip the optional absolute workDir (a REAL user folder
// the flow's agents run in). spec.save persists EditableFlow.workDir; on save we
// mkdir -p the workDir so it exists before the first run hands it to claude.
// =============================================================================

import { promises as fs } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";

import {
  asFlowId,
  asNodeId,
  asEdgeId,
  newId,
  findForwardCycle,
  zFlowSpec,
} from "@loom/shared";
import type {
  Flow,
  FlowId,
  FlowSpec,
  EditableFlow,
  AgentNode,
  Edge,
  FlowBudget,
  FlowState,
} from "@loom/shared";
import { parseDocument, Document, isMap, isSeq } from "yaml";

import type { Emit } from "./internal.js";

// -----------------------------------------------------------------------------
// Public types (pinned by the spine — kept verbatim).
// -----------------------------------------------------------------------------

/** A lint problem found on save (single-writer / topology / schema). */
export interface SpecLintIssue {
  code:
    | "duplicate_writer"   // two same-layer siblings declare the same produces[]
    | "forward_cycle"      // non-feedback edges form a cycle
    | "dangling_edge"      // edge references an unknown node id
    | "no_trigger";        // flow has no Trigger node
  message: string;
  nodeIds?: string[];
  path?: string;           // the offending artifact relPath, for duplicate_writer
}

export class SpecValidationError extends Error {
  readonly issues: SpecLintIssue[];
  constructor(issues: SpecLintIssue[]) {
    super(`spec invalid: ${issues.map((i) => i.code).join(", ")}`);
    this.name = "SpecValidationError";
    this.issues = issues;
  }
}

/** Result of a successful save: the reloaded Flow + the file it landed in. */
export interface SaveResult {
  flow: Flow;
  filePath: string;
  version: number;
  /** Path of the snapshot of the PRIOR version (null on first save). */
  snapshotPath: string | null;
}

/** Result of a delete: the id removed + where the YAML was archived (never rm'd). */
export interface DeleteResult {
  flowId: FlowId;
  /** Where the flow's YAML was MOVED to (archive, not a hard delete). Null if the
   *  flow had no on-disk file (e.g. created in-memory and never saved). */
  archivedPath: string | null;
}

export interface SpecStore {
  /** Parse + validate one *.flow.yaml into a runtime Flow (throws on invalid). */
  load(filePath: string): Promise<Flow>;

  /** Load every flows/*.flow.yaml (skips files that fail to parse, logs them). */
  listFlows(): Promise<Flow[]>;

  /** Currently-loaded flow by id (from the in-memory cache; null if unknown). */
  get(flowId: FlowId): Flow | null;

  /** All currently-loaded flows. */
  all(): Flow[];

  /**
   * Persist an EditableFlow: lint (single-writer + acyclic + schema), snapshot
   * the prior version, bump version, write comment-preserving YAML, hot-reload
   * the in-memory Flow, and emit flow.spec.changed + flow.upserted.
   * Throws SpecValidationError if lint fails.
   */
  save(edit: EditableFlow): Promise<SaveResult>;

  /** Create a new minimal flow (single Trigger) from a name; persists + loads. */
  create(name: string): Promise<SaveResult>;

  /**
   * Delete a flow: ARCHIVE its YAML (move into a `deleted/` area — never a hard
   * `rm`, so a fat-finger is recoverable) and drop it from the in-memory cache.
   * Idempotent: deleting an unknown / already-deleted id is a no-op that returns
   * `{ archivedPath: null }`. The CALLER (bridge) is responsible for disarming +
   * killing the flow and emitting flow.removed BEFORE/AFTER this; spec.delete only
   * owns the on-disk + cache state.
   */
  delete(flowId: FlowId): Promise<DeleteResult>;

  /** Pure lint pass over a candidate spec (no I/O) — also used by tests. */
  lint(spec: FlowSpec): SpecLintIssue[];
}

// -----------------------------------------------------------------------------
// Defaults applied when a freshly-created or editable flow lacks a budget/etc.
// (Kept local so spec.ts typechecks in isolation; mirrors config.DEFAULT_BUDGET.)
// -----------------------------------------------------------------------------

const DEFAULT_BUDGET: FlowBudget = {
  maxCyclesPerArm: 4,
  maxTokensPerRun: 200_000,
  maxUsdPerRun: 2,
  maxTokensPerFlow: 2_000_000,
  maxUsdPerFlow: 20,
  maxConcurrentAgents: 3,
  convergenceWindow: 2,
};

/** A freshly-loaded flow's runtime fields default to idle; eventlog projects truth. */
const DEFAULT_STATE: FlowState = "ocioso";

const FLOW_GLOB_SUFFIX = ".flow.yaml";

// -----------------------------------------------------------------------------
// Internal cache record — keeps the on-disk path + the last raw text so save()
// can produce a comment-preserving diff and snapshot the prior version exactly.
// -----------------------------------------------------------------------------

interface CacheEntry {
  flow: Flow;
  filePath: string;
  /** Raw YAML text last read/written for this flow (drives comment preservation). */
  rawText: string;
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/** Turn a slug/name into a filesystem-safe flow id fragment. */
function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `flow-${newId().slice(0, 8)}`;
}

/**
 * Kahn layering over FORWARD (non-feedback) edges. Returns the layer index of
 * every node id. Nodes that are part of a forward cycle (and thus never reach
 * in-degree 0) are dropped — the forward_cycle lint reports those separately.
 */
function kahnLayers(
  nodes: { id: string }[],
  edges: { from: string; to: string; feedback?: boolean }[],
): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (e.feedback) continue;
    if (!ids.has(e.from) || !ids.has(e.to)) continue; // dangling — reported elsewhere
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const layer = new Map<string, number>();
  // Seed with all in-degree-0 nodes (layer 0).
  let frontier: string[] = [];
  for (const n of nodes) {
    if ((indeg.get(n.id) ?? 0) === 0) {
      frontier.push(n.id);
      layer.set(n.id, 0);
    }
  }
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const u of frontier) {
      const lu = layer.get(u)!;
      for (const v of adj.get(u) ?? []) {
        const cand = lu + 1;
        // A node's layer is the longest path from a source — guarantees true
        // siblings (same depth) share a layer for the single-writer check.
        if (cand > (layer.get(v) ?? -1)) layer.set(v, cand);
        const d = (indeg.get(v) ?? 0) - 1;
        indeg.set(v, d);
        if (d === 0) next.push(v);
      }
    }
    frontier = next;
  }
  return layer;
}

// -----------------------------------------------------------------------------
// Spec <-> Flow conversion
// -----------------------------------------------------------------------------

/** Build the runtime Flow from a validated spec (runtime state defaults). */
function specToFlow(spec: FlowSpec): Flow {
  return {
    id: asFlowId(spec.id),
    name: spec.name,
    version: spec.version,
    schedule: spec.schedule,
    state: DEFAULT_STATE,
    cycle: 0,
    nodes: spec.nodes.map(coerceNode),
    edges: spec.edges.map(coerceEdge),
    budget: { ...spec.budget },
    blackboardDir: spec.blackboardDir,
    ...(spec.workDir !== undefined ? { workDir: spec.workDir } : {}),
  };
}

/** Cast a zod-validated node into the branded-id AgentNode (runtime no-op). */
function coerceNode(n: FlowSpec["nodes"][number]): AgentNode {
  const node: AgentNode = {
    id: asNodeId(n.id),
    type: n.type as AgentNode["type"],
    title: n.title,
    role: n.role,
    model: n.model as AgentNode["model"],
    prompt: n.prompt,
    linkedContexts: n.linkedContexts ?? [],
    position: { x: n.position.x, y: n.position.y },
  };
  if (n.produces !== undefined) node.produces = n.produces;
  if (n.trigger !== undefined) node.trigger = n.trigger;
  if (n.schedule !== undefined) node.schedule = n.schedule;
  if (n.contextIsolation !== undefined) node.contextIsolation = n.contextIsolation;
  return node;
}

function coerceEdge(e: FlowSpec["edges"][number]): Edge {
  const edge: Edge = {
    id: asEdgeId(e.id),
    from: asNodeId(e.from),
    to: asNodeId(e.to),
  };
  if (e.feedback !== undefined) edge.feedback = e.feedback;
  if (e.phase !== undefined) edge.phase = e.phase;
  return edge;
}

/** Plain JS object (no brands) for serialization / zod re-validation. */
function nodeToPlain(n: AgentNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: n.id,
    type: n.type,
    title: n.title,
    role: n.role,
    model: n.model,
    prompt: n.prompt,
    linkedContexts: n.linkedContexts ?? [],
    position: { x: n.position.x, y: n.position.y },
  };
  if (n.produces !== undefined) out.produces = n.produces;
  if (n.trigger !== undefined) out.trigger = n.trigger;
  if (n.schedule !== undefined) out.schedule = n.schedule;
  if (n.contextIsolation !== undefined) out.contextIsolation = n.contextIsolation;
  return out;
}

function edgeToPlain(e: Edge): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, from: e.from, to: e.to };
  if (e.feedback !== undefined) out.feedback = e.feedback;
  if (e.phase !== undefined) out.phase = e.phase;
  return out;
}

/** A whole Flow → the FlowSpec-shaped plain object (drops runtime state/cycle). */
function flowToSpecObject(flow: Flow): Record<string, unknown> {
  return {
    id: flow.id,
    name: flow.name,
    version: flow.version,
    schedule: flow.schedule,
    blackboardDir: flow.blackboardDir,
    ...(flow.workDir !== undefined ? { workDir: flow.workDir } : {}),
    budget: { ...flow.budget },
    nodes: flow.nodes.map(nodeToPlain),
    edges: flow.edges.map(edgeToPlain),
  };
}

// =============================================================================
// Store implementation
// =============================================================================

export function createSpecStore(
  flowsDir: string,
  specVersionsDir: string,
  emit: Emit,
): SpecStore {
  const cache = new Map<string, CacheEntry>();

  // ---------------------------------------------------------------------------
  // Pure lint pass (no I/O). Order: schema-derived structural checks first.
  // ---------------------------------------------------------------------------
  function lint(spec: FlowSpec): SpecLintIssue[] {
    const issues: SpecLintIssue[] = [];
    const nodeIds = new Set(spec.nodes.map((n) => n.id));

    // 1. no_trigger — at least one Trigger node.
    if (!spec.nodes.some((n) => n.type === "Trigger")) {
      issues.push({
        code: "no_trigger",
        message: "O fluxo precisa de pelo menos um nó Trigger.",
      });
    }

    // 2. dangling_edge — every edge endpoint must exist.
    for (const e of spec.edges) {
      const missing: string[] = [];
      if (!nodeIds.has(e.from)) missing.push(e.from);
      if (!nodeIds.has(e.to)) missing.push(e.to);
      if (missing.length > 0) {
        issues.push({
          code: "dangling_edge",
          message: `Aresta ${e.id} referencia nó(s) inexistente(s): ${missing.join(", ")}.`,
          nodeIds: missing,
        });
      }
    }

    // 3. forward_cycle — non-feedback edges must be acyclic.
    const cyc = findForwardCycle(spec.nodes, spec.edges);
    if (cyc && cyc.length > 0) {
      issues.push({
        code: "forward_cycle",
        message: `Ciclo entre arestas não-feedback: ${cyc.join(" → ")}. Marque a aresta de retorno como feedback: true.`,
        nodeIds: cyc,
      });
    }

    // 4. duplicate_writer — single-writer invariant. Two nodes in the SAME Kahn
    //    layer (true parallel siblings) must not both declare the same produces[]
    //    artifact. Different layers are fine: there a clear happens-before exists.
    //    Skip the layering if the graph has a forward cycle (layers undefined).
    if (!cyc) {
      const layers = kahnLayers(spec.nodes, spec.edges);
      // artifact relPath -> Map<layerIndex, nodeId[]>
      const byArtifact = new Map<string, Map<number, string[]>>();
      for (const n of spec.nodes) {
        const layer = layers.get(n.id);
        if (layer === undefined) continue; // unreachable / cyclic — skip
        for (const art of n.produces ?? []) {
          let perLayer = byArtifact.get(art);
          if (!perLayer) {
            perLayer = new Map<number, string[]>();
            byArtifact.set(art, perLayer);
          }
          const writers = perLayer.get(layer) ?? [];
          writers.push(n.id);
          perLayer.set(layer, writers);
        }
      }
      for (const [art, perLayer] of byArtifact) {
        for (const [, writers] of perLayer) {
          if (writers.length > 1) {
            issues.push({
              code: "duplicate_writer",
              message: `Múltiplos nós paralelos gravam o mesmo artefato "${art}": ${writers.join(", ")}. Apenas um escritor por artefato na mesma camada.`,
              nodeIds: writers,
              path: art,
            });
          }
        }
      }
    }

    return issues;
  }

  // ---------------------------------------------------------------------------
  // load — read + parse + zod-validate + acyclic check; cache + return Flow.
  // ---------------------------------------------------------------------------
  async function load(filePath: string): Promise<Flow> {
    const abs = resolve(filePath);
    const rawText = await fs.readFile(abs, "utf8");
    const parsed = parseDocument(rawText);
    if (parsed.errors.length > 0) {
      throw new Error(
        `YAML parse error in ${abs}: ${parsed.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const json = parsed.toJS({ maxAliasCount: 100 });
    const result = zFlowSpec.safeParse(json);
    if (!result.success) {
      throw new SpecValidationError([
        {
          code: "no_trigger", // generic schema failure surfaced via the issue list
          message: `Spec inválida em ${abs}: ${result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        },
      ]);
    }
    const spec = result.data;

    // Topology lint (forward-cycle is hard-required even on load).
    const issues = lint(spec).filter((i) => i.code === "forward_cycle" || i.code === "dangling_edge");
    if (issues.length > 0) throw new SpecValidationError(issues);

    const flow = specToFlow(spec);
    cache.set(flow.id, { flow, filePath: abs, rawText });
    return flow;
  }

  // ---------------------------------------------------------------------------
  // listFlows — load every flows/*.flow.yaml; skip (and log) the broken ones.
  // ---------------------------------------------------------------------------
  async function listFlows(): Promise<Flow[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(flowsDir);
    } catch {
      return [];
    }
    const files = entries
      .filter((f) => f.endsWith(FLOW_GLOB_SUFFIX))
      .sort()
      .map((f) => join(flowsDir, f));

    const flows: Flow[] = [];
    for (const file of files) {
      try {
        flows.push(await load(file));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "log",
          flowId: asFlowId(basename(file, FLOW_GLOB_SUFFIX)),
          color: "red",
          msg: `Falha ao carregar spec ${basename(file)}: ${msg}`,
          at: Date.now(),
        });
      }
    }
    return flows;
  }

  function get(flowId: FlowId): Flow | null {
    return cache.get(flowId)?.flow ?? null;
  }

  function all(): Flow[] {
    return [...cache.values()].map((e) => e.flow);
  }

  // ---------------------------------------------------------------------------
  // Comment-preserving YAML patch: start from the prior Document (if any) so
  // comments survive; overwrite topology-bearing fields with the new values.
  // ---------------------------------------------------------------------------
  function renderYaml(priorText: string | null, specObj: Record<string, unknown>): string {
    let doc: Document;
    if (priorText !== null) {
      doc = parseDocument(priorText);
      if (doc.errors.length > 0) doc = new Document(); // corrupt prior → fresh
    } else {
      doc = new Document();
    }
    // Patch scalars in place to preserve their surrounding comments.
    doc.set("id", specObj.id);
    doc.set("name", specObj.name);
    doc.set("version", specObj.version);
    doc.set("schedule", specObj.schedule);
    doc.set("blackboardDir", specObj.blackboardDir);
    // workDir is optional: set it when present, delete it when cleared so the
    // YAML never carries a stale workDir after a user removes it.
    if (specObj.workDir !== undefined) doc.set("workDir", specObj.workDir);
    else doc.delete("workDir");
    // budget/nodes/edges are wholesale-replaced (their internal structure is the
    // edit payload); top-level field comments are still preserved by the patch.
    doc.set("budget", specObj.budget);
    doc.set("nodes", specObj.nodes);
    doc.set("edges", specObj.edges);

    // Keep a stable, readable key order if this was a brand-new document.
    if (priorText === null && isMap(doc.contents)) {
      const order = ["id", "name", "version", "schedule", "blackboardDir", "workDir", "budget", "nodes", "edges"];
      doc.contents.items.sort(
        (a, b) =>
          order.indexOf(String((a.key as { value?: unknown })?.value ?? a.key)) -
          order.indexOf(String((b.key as { value?: unknown })?.value ?? b.key)),
      );
    }

    return doc.toString({ lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" });
  }

  // ---------------------------------------------------------------------------
  // save — lint, snapshot prior, bump version, write comment-preserving YAML,
  // hot-reload, emit events. Merges the editable subset onto the prior flow so
  // budget/schedule/blackboardDir/version baseline are preserved.
  // ---------------------------------------------------------------------------
  async function save(edit: EditableFlow): Promise<SaveResult> {
    const flowId = asFlowId(edit.id);
    const prior = cache.get(flowId);

    // Merge: editable fields (name/nodes/edges) over the prior flow's
    // non-editable baseline (budget/schedule/blackboardDir/version).
    const priorFlow = prior?.flow;
    const baseVersion = priorFlow?.version ?? 0;
    const nextVersion = baseVersion + 1;

    // Fill in any missing node/edge ids (UI temp nodes) with persistent ids.
    const nodes = edit.nodes.map((n) => {
      const id = n.id && n.id.length > 0 ? n.id : newId("n_");
      return nodeToPlain({ ...n, id: asNodeId(id) });
    });
    const edges = edit.edges.map((e) => {
      const id = e.id && e.id.length > 0 ? e.id : newId("e_");
      return edgeToPlain({ ...e, id: asEdgeId(id) });
    });

    // workDir: the edit is authoritative (the UI persists it). Fall back to the
    // prior flow's value when the editable payload omits it so a partial save
    // never silently drops a configured workDir. A trimmed-empty string clears it.
    const editWorkDir = edit.workDir?.trim();
    const workDir =
      edit.workDir !== undefined
        ? editWorkDir && editWorkDir.length > 0
          ? editWorkDir
          : undefined
        : priorFlow?.workDir;

    const specObj: Record<string, unknown> = {
      id: edit.id,
      name: edit.name,
      version: nextVersion,
      schedule: priorFlow?.schedule ?? edit.name,
      blackboardDir: priorFlow?.blackboardDir ?? slugify(edit.name),
      ...(workDir !== undefined ? { workDir } : {}),
      budget: priorFlow ? { ...priorFlow.budget } : { ...DEFAULT_BUDGET },
      nodes,
      edges,
    };

    // Validate the merged candidate against the schema, then lint.
    const parsed = zFlowSpec.safeParse(specObj);
    if (!parsed.success) {
      throw new SpecValidationError([
        {
          code: "no_trigger",
          message: `Spec inválida: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        },
      ]);
    }
    const candidate = parsed.data;
    const issues = lint(candidate);
    if (issues.length > 0) throw new SpecValidationError(issues);

    // --- Snapshot the PRIOR on-disk version (best-effort, before overwrite). ---
    let snapshotPath: string | null = null;
    const filePath = prior?.filePath ?? join(flowsDir, `${edit.id}${FLOW_GLOB_SUFFIX}`);
    if (prior) {
      try {
        await fs.mkdir(specVersionsDir, { recursive: true });
        snapshotPath = join(
          specVersionsDir,
          `${edit.id}.v${baseVersion}${FLOW_GLOB_SUFFIX}`,
        );
        await fs.writeFile(snapshotPath, prior.rawText, "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "log",
          flowId,
          color: "amber",
          msg: `Não foi possível snapshotar a versão anterior (${baseVersion}): ${msg}`,
          at: Date.now(),
        });
        snapshotPath = null;
      }
    }

    // --- Write comment-preserving YAML atomically (temp + rename). ---
    const yamlText = renderYaml(prior?.rawText ?? null, specObj);
    await fs.mkdir(flowsDir, { recursive: true });
    const tmp = `${filePath}.tmp-${newId().slice(0, 8)}`;
    await fs.writeFile(tmp, yamlText, "utf8");
    await fs.rename(tmp, filePath);

    // --- Ensure the workDir exists on first use (mkdir -p). The flow's agents
    // cwd into it + claude scopes to it, so it MUST exist before the first run.
    // Best-effort: a path we cannot create (perms) is surfaced, not fatal — the
    // blackboard re-mkdirs on the next fs op too. ---
    if (workDir !== undefined) {
      try {
        await fs.mkdir(workDir, { recursive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "log",
          flowId,
          color: "amber",
          msg: `Não foi possível criar o workDir "${workDir}": ${msg}`,
          at: Date.now(),
        });
      }
    }

    // --- Hot-reload the in-memory Flow from the freshly-validated candidate. ---
    const flow = specToFlow(candidate);
    // Preserve any already-projected runtime state/cycle from the prior flow so a
    // save mid-run does not visually reset the node (eventlog stays the truth).
    if (priorFlow) {
      flow.state = priorFlow.state;
      flow.cycle = priorFlow.cycle;
    }
    cache.set(flow.id, { flow, filePath, rawText: yamlText });

    // --- Emit spec/flow change events. ---
    emit({ type: "flow.spec.changed", flowId, version: nextVersion });
    emit({ type: "flow.upserted", flowId, flow });

    return { flow, filePath, version: nextVersion, snapshotPath };
  }

  // ---------------------------------------------------------------------------
  // create — minimal single-Trigger flow from a name; persists + loads.
  // ---------------------------------------------------------------------------
  async function create(name: string): Promise<SaveResult> {
    const trimmed = name.trim() || "Novo Fluxo";
    let id = slugify(trimmed);
    // Avoid clobbering an existing flow id.
    if (cache.has(asFlowId(id))) id = `${id}-${newId().slice(0, 6)}`;

    const triggerNode: AgentNode = {
      id: asNodeId("trigger"),
      type: "Trigger",
      title: "Gatilho",
      role: "Inicia o fluxo.",
      model: "claude-haiku-4-5",
      prompt: "",
      linkedContexts: [],
      position: { x: 80, y: 200 },
      trigger: { kind: "Manual" },
    };

    const specObj: Record<string, unknown> = {
      id,
      name: trimmed,
      version: 0, // save() bumps to 1
      schedule: "Manual",
      blackboardDir: id,
      budget: { ...DEFAULT_BUDGET },
      nodes: [nodeToPlain(triggerNode)],
      edges: [],
    };

    // Validate the skeleton up front (defensive — should always pass).
    const parsed = zFlowSpec.safeParse(specObj);
    if (!parsed.success) {
      throw new SpecValidationError([
        {
          code: "no_trigger",
          message: `Falha ao criar fluxo: ${parsed.error.issues
            .map((i) => i.message)
            .join("; ")}`,
        },
      ]);
    }

    // Seed the cache as a version-0 baseline so save() snapshots/bumps cleanly,
    // then route through save() for the single write+emit path.
    const seedFlow = specToFlow(parsed.data);
    const filePath = join(flowsDir, `${id}${FLOW_GLOB_SUFFIX}`);
    const header = `# ${trimmed} — criado por Loom.\n`;
    cache.set(seedFlow.id, { flow: seedFlow, filePath, rawText: header });

    return save({
      id: seedFlow.id,
      name: seedFlow.name,
      nodes: seedFlow.nodes,
      edges: seedFlow.edges,
    });
  }

  // ---------------------------------------------------------------------------
  // delete — archive the YAML (move, never rm) + drop from the cache.
  //
  // The archive dir lives next to the spec_versions area (data/deleted), so a
  // deleted flow is recoverable by hand. We move with a timestamped name to avoid
  // clobbering a previous deletion of a re-created same-id flow. If the rename
  // fails (e.g. cross-device), fall back to copy+unlink. Cache is always cleared.
  // ---------------------------------------------------------------------------
  async function del(flowId: FlowId): Promise<DeleteResult> {
    const entry = cache.get(flowId);
    // Always drop from the in-memory cache first so get()/all() stop returning it
    // even if the archive move below fails — the flow must vanish from runtime.
    cache.delete(flowId);

    if (!entry) {
      // Unknown or already-deleted id, or an in-memory flow never written to disk.
      return { flowId, archivedPath: null };
    }

    // data/deleted lives beside data/spec_versions (specVersionsDir = .../data/spec_versions).
    const deletedDir = join(dirname(specVersionsDir), "deleted");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivedPath = join(
      deletedDir,
      `${String(flowId)}.${stamp}${FLOW_GLOB_SUFFIX}`,
    );

    try {
      await fs.mkdir(deletedDir, { recursive: true });
      await fs.rename(entry.filePath, archivedPath);
    } catch (renameErr) {
      // Cross-device rename or a partially-missing source — try copy+unlink, and
      // if even that fails, archive the last-known raw text so nothing is lost.
      try {
        await fs.copyFile(entry.filePath, archivedPath);
        await fs.unlink(entry.filePath);
      } catch {
        try {
          await fs.writeFile(archivedPath, entry.rawText, "utf8");
          // Best-effort remove the original if it still exists.
          await fs.rm(entry.filePath, { force: true });
        } catch (writeErr) {
          const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          const r = renameErr instanceof Error ? renameErr.message : String(renameErr);
          emit({
            type: "log",
            flowId,
            color: "amber",
            msg: `Falha ao arquivar a spec ao excluir o fluxo (${r}; ${msg}). Removido só da memória.`,
            at: Date.now(),
          });
          return { flowId, archivedPath: null };
        }
      }
    }

    return { flowId, archivedPath };
  }

  return { load, listFlows, get, all, save, create, delete: del, lint };
}
