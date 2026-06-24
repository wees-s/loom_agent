# NL Flow Authoring (slice C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Generate a complete, editable flow from a natural-language description via a one-shot Claude call (real) or a canned flow (fake), validated by zod and persisted through the existing spec path.

**Architecture:** A new `generator.ts` engine module mirrors the runner's fake/real split. `flow.generate {prompt}` → `generator.generate()` → `zGeneratedFlow` validation → `spec.create` + `spec.save` → `flow.snapshot` broadcast. Pure `extractJsonFlow` recovers the JSON from the CLI output. Nothing touches guard/orchestrator/eventlog.

**Tech Stack:** TypeScript (strict), zod, node:child_process, React 18, zustand, vitest.

## Global Constraints

- `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`; `import type`; `.js` on relative imports.
- Inbound commands validated by `zClientCommand`; the generated flow validated by `zGeneratedFlow`; persistence reuses `spec.create`/`spec.save` (acyclic + single-writer + ≥1 Trigger lint).
- Generator mode inherits `config.runnerMode` (`LOOM_RUNNER=fake` → fake generator). Real call bounded by `--max-turns` (env `LOOM_GENERATOR_MAX_TURNS`, default 1) + wall-clock timeout (env `LOOM_GENERATOR_TIMEOUT_MS`, default 90000).
- Portuguese user-facing copy. No new runtime deps.
- Engine tests run with `NODE_OPTIONS=--experimental-sqlite`.

---

### Task 1: Contracts — `flow.generate` command + `zGeneratedFlow`

**Files:**
- Modify: `packages/shared/src/protocol.ts` (`ClientCommand` += `flow.generate`)
- Modify: `packages/shared/src/schemas.ts` (`zClientCommand` += `flow.generate`; new `zGeneratedFlow` + `GeneratedFlow` type)
- Test: `packages/shared/src/contracts.test.ts` (append cases)

**Produces:**
- `{ t: "flow.generate"; cmdId: string; prompt: string }`
- `zGeneratedFlow` (zod) + `export type GeneratedFlow = z.infer<typeof zGeneratedFlow>`

- [ ] **Step 1: Failing tests** — append to `contracts.test.ts`:

```ts
describe("flow.generate + zGeneratedFlow", () => {
  it("zClientCommand accepts flow.generate", () => {
    expect(zClientCommand.safeParse({ t: "flow.generate", cmdId: "c1", prompt: "faça um loop" }).success).toBe(true);
  });
  const good = {
    name: "Revisor de PRs",
    nodes: [
      { id: "t", type: "Trigger", title: "Cron", role: "entry", prompt: "" },
      { id: "a", type: "Analyst", title: "Analista", role: "analisa", prompt: "analise os PRs" },
    ],
    edges: [{ from: "t", to: "a" }],
  };
  it("zGeneratedFlow accepts a valid full flow", () => {
    expect(zGeneratedFlow.safeParse(good).success).toBe(true);
  });
  it("rejects a flow with no Trigger node", () => {
    const noTrig = { ...good, nodes: [good.nodes[1]] };
    expect(zGeneratedFlow.safeParse(noTrig).success).toBe(false);
  });
  it("rejects an edge referencing an unknown node id", () => {
    const badEdge = { ...good, edges: [{ from: "t", to: "ghost" }] };
    expect(zGeneratedFlow.safeParse(badEdge).success).toBe(false);
  });
});
```

(Add `zGeneratedFlow` to the imports from `./index.js` in `contracts.test.ts`.)

- [ ] **Step 2: Run → fail**: `pnpm --filter @loom/shared exec vitest run contracts` → FAIL (`zGeneratedFlow` undefined / `flow.generate` rejected).

- [ ] **Step 3: Implement**

`protocol.ts` — add to `ClientCommand`:
```ts
  | { t: "flow.generate"; cmdId: string; prompt: string }
```

`schemas.ts` — add the command to `zClientCommand`:
```ts
  z.object({ t: z.literal("flow.generate"), cmdId: z.string(), prompt: z.string().min(1) }),
```
and add the generated-flow schema (after `zEditableFlow`):
```ts
// What the NL generator (LLM) must emit. Node ids are payload-local (referenced
// by edges); model is optional (coerced to a default if absent/invalid before parse).
const zGeneratedNode = z.object({
  id: z.string().min(1),
  type: zNodeTypeName,
  title: z.string(),
  role: z.string(),
  prompt: z.string(),
  model: zModelId.optional(),
  produces: z.array(z.string()).optional(),
  contextIsolation: z.boolean().optional(),
  trigger: zTriggerConfig.optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export const zGeneratedFlow = z
  .object({
    name: z.string().min(1),
    reviewEachCycle: z.boolean().optional(),
    nodes: z.array(zGeneratedNode).min(1),
    edges: z.array(z.object({ from: z.string(), to: z.string(), feedback: z.boolean().optional() })),
  })
  .refine((f) => f.nodes.some((n) => n.type === "Trigger"), { message: "needs at least one Trigger node" })
  .refine(
    (f) => {
      const ids = new Set(f.nodes.map((n) => n.id));
      return f.edges.every((e) => ids.has(e.from) && ids.has(e.to));
    },
    { message: "every edge must reference existing node ids" },
  );
export type GeneratedFlow = z.infer<typeof zGeneratedFlow>;
```

- [ ] **Step 4: Run → pass + typecheck**: `pnpm --filter @loom/shared exec vitest run contracts && pnpm --filter @loom/shared typecheck` → PASS.

- [ ] **Step 5: Commit**: `git commit -m "feat(shared): contracts for NL flow authoring — flow.generate + zGeneratedFlow"`

---

### Task 2: Engine generator module (fake + real + extractJsonFlow)

**Files:**
- Create: `packages/engine/src/generator.ts`
- Modify: `packages/engine/src/main.ts` (`EngineConfig` generator knobs; `createGenerator` in `buildEngine`; add `generator` to `EngineDeps` + the returned object; pass to `createBridge`)
- Modify: `packages/engine/src/internal.ts` (add `generatorMaxTurns`/`generatorTimeoutMs` to the config type — same shape as `runnerMode` lives)
- Test: `packages/engine/src/generator.test.ts`

**Produces:**
- `createGenerator(mode: "fake"|"real", emit: Emit): Generator`
- `Generator.generate(prompt: string): Promise<{ ok: true; flow: GeneratedFlow } | { ok: false; error: string }>`
- `extractJsonFlow(raw: string): unknown | null` (exported, pure)

- [ ] **Step 1: Failing test** — `packages/engine/src/generator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createGenerator, extractJsonFlow } from "./generator.js";
import { zGeneratedFlow } from "@loom/shared";
import type { Emit } from "./internal.js";

const emit: Emit = (e) => ({ seq: 1, ts: 1, event: e }) as never;

describe("extractJsonFlow", () => {
  it("parses bare JSON", () => {
    expect(extractJsonFlow('{"name":"x"}')).toEqual({ name: "x" });
  });
  it("parses fenced ```json blocks", () => {
    expect(extractJsonFlow('blah\n```json\n{"name":"y"}\n```\ndone')).toEqual({ name: "y" });
  });
  it("finds the first balanced object amid prose", () => {
    expect(extractJsonFlow('Aqui está:\n{"name":"z","nodes":[]}\nfim')).toEqual({ name: "z", nodes: [] });
  });
  it("returns null for non-JSON garbage", () => {
    expect(extractJsonFlow("sem json aqui")).toBeNull();
  });
});

describe("fake generator", () => {
  it("returns a deterministic flow valid against zGeneratedFlow", async () => {
    const gen = createGenerator("fake", emit);
    const r = await gen.generate("revisa PRs e me avisa");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(zGeneratedFlow.safeParse(r.flow).success).toBe(true);
      expect(r.flow.nodes.some((n) => n.type === "Trigger")).toBe(true);
      expect(r.flow.name.toLowerCase()).toContain("revisa"); // incorporates the prompt
    }
  });
});
```

- [ ] **Step 2: Run → fail**: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine exec vitest run generator` → FAIL (module missing).

- [ ] **Step 3: Implement `generator.ts`**

```ts
// =============================================================================
// generator.ts [generator] — NL → full flow spec. Mirrors the runner's fake/real
// split. REAL spawns a one-shot `claude -p --output-format json` (bounded by
// --max-turns + a wall-clock timeout), extracts the JSON flow from its output,
// coerces an invalid/absent model to a default, and validates zGeneratedFlow.
// FAKE returns a deterministic 3-node loop derived from the prompt (zero cost).
// =============================================================================

import { spawn } from "node:child_process";
import {
  zGeneratedFlow, MODEL_CATALOG, type GeneratedFlow, type ModelId,
} from "@loom/shared";
import type { Emit } from "./internal.js";

export type GeneratorMode = "fake" | "real";

export interface Generator {
  readonly mode: GeneratorMode;
  generate(prompt: string): Promise<{ ok: true; flow: GeneratedFlow } | { ok: false; error: string }>;
}

const CLAUDE_BIN = process.env.LOOM_CLAUDE_BIN ?? "claude";
const GEN_MODEL: ModelId = "claude-sonnet-4-6";
const DEFAULT_MODEL: ModelId = "claude-sonnet-4-6";
const VALID_MODELS = new Set(MODEL_CATALOG.map((m) => m.id));

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
const MAX_TURNS = clampInt(process.env.LOOM_GENERATOR_MAX_TURNS, 1, 1, 10);
const TIMEOUT_MS = clampInt(process.env.LOOM_GENERATOR_TIMEOUT_MS, 90_000, 10_000, 10 * 60_000);

const SYSTEM = [
  "Você gera a especificação de um FLUXO de agentes para o Loom a partir de uma descrição.",
  "Responda APENAS com um objeto JSON (sem texto, sem cercas) com este formato:",
  '{ "name": string, "reviewEachCycle"?: boolean,',
  '  "nodes": [{ "id": string, "type": "Trigger"|"Analyst"|"Synthesizer"|"Executor"|..., "title": string,',
  '             "role": string, "prompt": string, "model"?: string, "produces"?: string[], "contextIsolation"?: boolean }],',
  '  "edges": [{ "from": id, "to": id, "feedback"?: boolean }] }',
  "Regras: exatamente UM nó type Trigger (entrada); ids curtos e únicos; arestas só entre ids existentes;",
  "uma feedback edge volta ao Trigger para fechar o loop; prompts claros e acionáveis em português.",
].join("\n");

/** Extract the first balanced top-level JSON object from CLI output. Pure. */
export function extractJsonFlow(raw: string): unknown | null {
  // Prefer a ```json fenced block if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = fenced ? [fenced[1]!, raw] : [raw];
  for (const text of candidates) {
    const start = text.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

/** Coerce an absent/invalid node model to the default (never fails validation). */
function coerceModels(obj: unknown): unknown {
  if (obj && typeof obj === "object" && Array.isArray((obj as { nodes?: unknown }).nodes)) {
    for (const n of (obj as { nodes: Record<string, unknown>[] }).nodes) {
      if (typeof n.model !== "string" || !VALID_MODELS.has(n.model as ModelId)) n.model = DEFAULT_MODEL;
    }
  }
  return obj;
}

export function createGenerator(mode: GeneratorMode, emit: Emit): Generator {
  return mode === "fake" ? new FakeGenerator() : new RealGenerator(emit);
}

class RealGenerator implements Generator {
  readonly mode = "real" as const;
  constructor(private readonly emit: Emit) {}

  async generate(prompt: string) {
    void this.emit;
    const argv = ["-p", `${SYSTEM}\n\nDescrição: ${prompt}`, "--output-format", "json", "--model", GEN_MODEL, "--max-turns", String(MAX_TURNS)];
    const out = await spawnClaude(argv);
    if (!out.ok) return { ok: false as const, error: out.error };
    // --output-format json wraps the assistant text in {type:"result", result:"..."};
    // the flow JSON is inside result. Try the whole stdout AND the result field.
    let envelopeResult: string | undefined;
    try { envelopeResult = (JSON.parse(out.stdout) as { result?: string }).result; } catch { /* not the envelope */ }
    const parsed = extractJsonFlow(envelopeResult ?? out.stdout);
    if (parsed === null) return { ok: false as const, error: "não consegui extrair um JSON de fluxo da resposta do claude" };
    const res = zGeneratedFlow.safeParse(coerceModels(parsed));
    if (!res.success) return { ok: false as const, error: `fluxo gerado inválido: ${res.error.issues.map((i) => i.message).join("; ")}` };
    return { ok: true as const, flow: res.data };
  }
}

class FakeGenerator implements Generator {
  readonly mode = "fake" as const;
  async generate(prompt: string) {
    const flow = {
      name: `${prompt}`.slice(0, 40) || "Fluxo gerado",
      nodes: [
        { id: "trigger", type: "Trigger", title: "Gatilho", role: "entry", prompt: "" },
        { id: "analyst", type: "Analyst", title: "Analista", role: "analisa o contexto", prompt: `Analise e resuma: ${prompt}`, model: DEFAULT_MODEL, produces: ["analise.md"] },
        { id: "executor", type: "Executor", title: "Executor", role: "age sobre a análise", prompt: "Aja conforme analise.md e registre o resultado.", model: DEFAULT_MODEL, produces: ["resultado.md"] },
      ],
      edges: [
        { from: "trigger", to: "analyst" },
        { from: "analyst", to: "executor" },
        { from: "executor", to: "trigger", feedback: true },
      ],
    };
    const res = zGeneratedFlow.safeParse(flow);
    return res.success ? { ok: true as const, flow: res.data } : { ok: false as const, error: "fake inválido" };
  }
}

/** One-shot claude spawn → stdout (modelled on auth.ts). Never rejects. */
function spawnClaude(argv: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `failed to spawn ${CLAUDE_BIN}: ${String(err)}` });
      return;
    }
    let stdout = "", stderr = "", settled = false;
    const finish = (v: { ok: true; stdout: string } | { ok: false; error: string }) => {
      if (settled) return; settled = true; clearTimeout(timer); resolve(v);
    };
    const timer = setTimeout(() => { try { child!.kill("SIGKILL"); } catch { /* */ } finish({ ok: false, error: `geração excedeu ${TIMEOUT_MS}ms` }); }, TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => { stdout += c; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => { stderr = (stderr + c).slice(-2000); });
    child.on("error", (err) => finish({ ok: false, error: `claude spawn error: ${String(err)}` }));
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, stdout });
      else finish({ ok: false, error: `claude saiu com código ${code ?? "?"}${stderr ? `: ${stderr.slice(0, 200)}` : ""}` });
    });
  });
}
```

- [ ] **Step 4: Wire into config + buildEngine**

In `main.ts` `buildConfig()` (the object near line 39 with `runnerMode`), no new fields needed (the generator reads its own env). In `buildEngine`, after the runner is created, add:
```ts
  const generator = createGenerator(config.runnerMode, emit);
```
Add `generator` to the returned `EngineDeps` object and to the `EngineDeps` type (in `internal.ts` or wherever `EngineDeps` is declared — read it; add `generator: Generator`). Import `createGenerator` + `type Generator` at the top of `main.ts`. (The `generatorMaxTurns`/`generatorTimeoutMs` config fields mentioned in the spec are NOT needed — the generator reads env directly like the runner does. Skip them.)

- [ ] **Step 5: Run → pass + typecheck**: `NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine exec vitest run generator && pnpm --filter @loom/engine typecheck`

(Typecheck will stay RED until Task 3 adds the `flow.generate` bridge case + `createBridge` generator param — acceptable; the generator unit tests pass here. Commit happens after Task 3 makes the package green.)

- [ ] **Step 6: Commit** (deferred — combined with Task 3, since engine typecheck needs the bridge wiring).

---

### Task 3: Bridge handler — generate → persist → broadcast

**Files:**
- Modify: `packages/engine/src/bridge.ts` (add `generator: Generator` param; `case "flow.generate"`; `generatedToEditable` helper)
- Modify: `packages/engine/src/main.ts` (pass `deps.generator` into `createBridge`)
- (No new test file — the logic lives in Task 2's generator; the handler is thin glue covered by typecheck + the full engine suite.)

- [ ] **Step 1: Implement the bridge handler**

Add `generator: Generator,` to the `createBridge` params (after `orchestrator`) and import `type Generator` from `./generator.js`. Update the `createBridge(...)` call in `main.ts` to pass `deps.generator` in the matching position.

Add the command case (model on `flow.create`):
```ts
        // ----- flow.generate --------------------------------------------------
        case "flow.generate": {
          const result = await generator.generate(cmd.prompt);
          if (!result.ok) {
            emit({ type: "log", flowId: asFlowId("—"), color: "rose", msg: `geração falhou: ${result.error}`, at: Date.now() });
            ack(ws, cmd.cmdId, false, result.error);
            break;
          }
          // Persist via the VALIDATED path: create a flow shell, then save the
          // generated topology onto it (acyclic + single-writer + ≥1 Trigger lint).
          const created = await spec.create(result.flow.name);
          const editable = generatedToEditable(result.flow, created.flow.id);
          const saved = await spec.save(editable);
          scheduler.armFlow(saved.flow.id); // dormant — safe by default
          broadcastAll({ t: "flow.snapshot", flow: saved.flow });
          ack(ws, cmd.cmdId, true);
          break;
        }
```

Add the mapper near the other helpers in `bridge.ts`:
```ts
/** Map a validated GeneratedFlow onto an EditableFlow for spec.save. Auto-grids
 *  any missing node positions so the canvas lays them out left-to-right. */
function generatedToEditable(gen: GeneratedFlow, id: FlowId): EditableFlow {
  const nodes = gen.nodes.map((n, i) => ({
    id: asNodeId(n.id),
    type: n.type as AgentNode["type"],
    title: n.title,
    role: n.role,
    model: (n.model ?? "claude-sonnet-4-6") as AgentNode["model"],
    prompt: n.prompt,
    linkedContexts: [] as string[],
    position: n.position ?? { x: 120 + i * 240, y: 200 },
    ...(n.produces ? { produces: n.produces } : {}),
    ...(n.trigger ? { trigger: n.trigger } : {}),
    ...(n.contextIsolation !== undefined ? { contextIsolation: n.contextIsolation } : {}),
  }));
  const edges = gen.edges.map((e, i) => ({
    id: asEdgeId(`e_${i}`),
    from: asNodeId(e.from),
    to: asNodeId(e.to),
    ...(e.feedback ? { feedback: e.feedback } : {}),
  }));
  return { id, name: gen.name, nodes, edges, ...(gen.reviewEachCycle !== undefined ? { reviewEachCycle: gen.reviewEachCycle } : {}) };
}
```

Add the needed imports to `bridge.ts` if missing: `type GeneratedFlow`, `type EditableFlow`, `type AgentNode`, `asEdgeId` (check the existing import block — `asFlowId`/`asNodeId` are already imported; add `asEdgeId`, `type AgentNode`, `type EditableFlow`, `type GeneratedFlow` from `@loom/shared`).

- [ ] **Step 2: Run typecheck + full engine suite**: `pnpm --filter @loom/engine typecheck && NODE_OPTIONS=--experimental-sqlite pnpm --filter @loom/engine test`
Expected: typecheck clean (switch now exhaustive over `flow.generate`); all suites pass.

- [ ] **Step 3: Commit** (Tasks 2 + 3 together): `git commit -m "feat(engine): NL flow generator (fake/real) + flow.generate bridge handler"`

---

### Task 4: Web — generate action + UI

**Files:**
- Modify: `packages/web/src/store.ts` (`generating: boolean`; `generateFlow(prompt)`; clear `generating` on `ack`/`error`)
- Create: `packages/web/src/components/GenerateFlow.tsx`
- Modify: `packages/web/src/components/LeftRail.tsx` (render `<GenerateFlow/>` near the new-flow control)
- Test: `packages/web/src/store.generate.test.ts`; `packages/web/src/components/GenerateFlow.test.tsx`

- [ ] **Step 1: Failing tests**

`packages/web/src/store.generate.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useLoomStore } from "./store";
import type { ClientCommand } from "@loom/shared";

describe("store generateFlow", () => {
  let sent: ClientCommand[];
  beforeEach(() => { sent = []; useLoomStore.setState({ sendCommand: (c) => sent.push(c), generating: false }); });

  it("sends flow.generate and sets generating", () => {
    useLoomStore.getState().generateFlow("revisa PRs");
    expect(sent.some((c) => c.t === "flow.generate" && c.prompt === "revisa PRs")).toBe(true);
    expect(useLoomStore.getState().generating).toBe(true);
  });

  it("clears generating on ack", () => {
    useLoomStore.setState({ generating: true });
    useLoomStore.getState().applyServerMessage({ t: "ack", cmdId: "x", ok: true });
    expect(useLoomStore.getState().generating).toBe(false);
  });
});
```

`packages/web/src/components/GenerateFlow.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GenerateFlow } from "./GenerateFlow";
import { useLoomStore } from "../store";
import type { ClientCommand } from "@loom/shared";

describe("<GenerateFlow/>", () => {
  let sent: ClientCommand[];
  beforeEach(() => { sent = []; useLoomStore.setState({ sendCommand: (c) => sent.push(c), generating: false }); });

  it("sends flow.generate with the typed prompt", () => {
    render(<GenerateFlow />);
    fireEvent.change(screen.getByPlaceholderText(/descreva/i), { target: { value: "um loop que revisa PRs" } });
    fireEvent.click(screen.getByRole("button", { name: /gerar/i }));
    expect(sent.some((c) => c.t === "flow.generate" && c.prompt === "um loop que revisa PRs")).toBe(true);
  });
});
```

- [ ] **Step 2: Run → fail**: `pnpm --filter @loom/web exec vitest run store.generate GenerateFlow`

- [ ] **Step 3: Implement store**

In `store.ts`: add `generating: boolean;` to `LoomState`, `generateFlow: (prompt: string) => void;` to actions, init `generating: false,`. Implement near `createFlow`:
```ts
  generateFlow: (prompt) => {
    const text = prompt.trim();
    if (!text) return;
    set({ generating: true });
    get().sendCommand({ t: "flow.generate", cmdId: makeCmdId(), prompt: text });
  },
```
In `applyServerMessage`, the `case "ack":` and `case "error":` branches — set `generating: false` (alongside the existing `lastError` handling). For `ack`: `set({ generating: false, ...(msg.ok ? {} : { lastError: msg.error ?? "command failed" }) });`. For `error`: add `generating: false` to the existing `set`.

- [ ] **Step 4: Implement `GenerateFlow.tsx`**

```tsx
import { useState, type CSSProperties } from "react";
import { useLoomStore } from "../store";

const BOX: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px" };

export function GenerateFlow() {
  const generateFlow = useLoomStore((s) => s.generateFlow);
  const generating = useLoomStore((s) => s.generating);
  const [prompt, setPrompt] = useState("");
  return (
    <div style={BOX} data-generate-flow>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text2)" }}>✨ Gerar com IA</div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Descreva o fluxo (ex: um loop que revisa PRs e me avisa)…"
        rows={3}
        disabled={generating}
        style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 12, borderRadius: 9, border: "1px solid var(--line)", background: "var(--input)", color: "var(--text2)", padding: "8px 10px", resize: "vertical" }}
      />
      <button
        type="button"
        disabled={generating || prompt.trim().length === 0}
        onClick={() => generateFlow(prompt)}
        style={{ padding: "8px 12px", border: "none", borderRadius: 9, background: "oklch(0.62 0.14 290)", color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: generating ? "default" : "pointer", opacity: generating || prompt.trim().length === 0 ? 0.6 : 1 }}
      >
        {generating ? "montando seu fluxo…" : "Gerar fluxo"}
      </button>
    </div>
  );
}

export default GenerateFlow;
```

- [ ] **Step 5: Mount in the LeftRail**

Read `LeftRail.tsx`, find where the flow list / "new flow" control renders, and add `<GenerateFlow />` there (import it). Reuse the existing rail section wrapper. (Adapt-on-read: match the rail's existing layout; place the generate box near the create-flow affordance.)

- [ ] **Step 6: Run → pass + typecheck + full web suite**: `pnpm --filter @loom/web exec vitest run store.generate GenerateFlow && pnpm --filter @loom/web typecheck && pnpm --filter @loom/web test`

- [ ] **Step 7: Commit**: `git commit -m "feat(web): NL flow authoring UI — generate-with-AI panel + generateFlow action"`

---

## Final verification

- [ ] `pnpm -r typecheck && NODE_OPTIONS=--experimental-sqlite pnpm -r test && pnpm -r build` → all green.

## Self-review notes

- **Spec coverage:** §5 contracts → Task 1. §6 generator + wiring → Task 2. §6 bridge persist/broadcast → Task 3. §7 web → Task 4. §9 tests across Tasks 1/2/4 (bridge glue covered by typecheck + suite, per §9 item 3 being "optional/leve"). §8 error paths handled in generator (`{ok:false}`) + bridge (ack false + log).
- **Type consistency:** `zGeneratedFlow`/`GeneratedFlow`/`flow.generate` (Task 1) consumed by generator (Task 2) + bridge mapper (Task 3) + store/UI (Task 4). `createGenerator`/`Generator`/`extractJsonFlow` (Task 2) consumed by bridge + main.
- **Deviation from spec:** dropped `generatorMaxTurns`/`generatorTimeoutMs` config fields — the generator reads env directly (like the runner), simpler and consistent.
- **Adapt-on-read:** `EngineDeps` type location (Task 2 Step 4), bridge import block (Task 3), LeftRail mount point (Task 4 Step 5). Pattern to follow named in each.
- **Untestable in sandbox:** the real claude spawn (no Windows claude). Covered only by `extractJsonFlow`/coercion/validation unit tests + the fake path; real is thin glue over the proven auth.ts spawn pattern.
