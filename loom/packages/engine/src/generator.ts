// =============================================================================
// generator.ts [generator] — NL → full flow spec. Mirrors the runner's fake/real
// split. REAL spawns a one-shot `claude -p --output-format json` (bounded by
// --max-turns + a wall-clock timeout), extracts the JSON flow from its output,
// coerces an invalid/absent model to a default, and validates zGeneratedFlow.
// FAKE returns a deterministic 3-node loop derived from the prompt (zero cost).
//
// This SPENDS tokens in REAL mode (unlike the rest of the engine's free
// projections). It is pre-flow: there is no flowId yet, so it does NOT pass the
// guard and does NOT count against any per-flow budget. Cost is bounded purely by
// --max-turns + the wall-clock timeout. See docs/.../nl-flow-authoring-design.md.
// =============================================================================

import { spawn } from "node:child_process";

import {
  zGeneratedFlow,
  MODEL_CATALOG,
  type GeneratedFlow,
  type ModelId,
} from "@loom/shared";
import type { Emit } from "./internal.js";

export type GeneratorMode = "fake" | "real";

export interface Generator {
  readonly mode: GeneratorMode;
  generate(
    prompt: string,
  ): Promise<{ ok: true; flow: GeneratedFlow } | { ok: false; error: string }>;
}

const CLAUDE_BIN = process.env.LOOM_CLAUDE_BIN ?? "claude";
const GEN_MODEL: ModelId = "claude-sonnet-4-6";
const DEFAULT_MODEL: ModelId = "claude-sonnet-4-6";
const VALID_MODELS = new Set<string>(MODEL_CATALOG.map((m) => m.id));

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
  '  "nodes": [{ "id": string, "type": "Trigger"|"Analyst"|"Synthesizer"|"Executor", "title": string,',
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
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break; // malformed — try the next candidate
          }
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
      if (typeof n.model !== "string" || !VALID_MODELS.has(n.model)) n.model = DEFAULT_MODEL;
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
    const argv = [
      "-p",
      `${SYSTEM}\n\nDescrição: ${prompt}`,
      "--output-format",
      "json",
      "--model",
      GEN_MODEL,
      "--max-turns",
      String(MAX_TURNS),
    ];
    const out = await spawnClaude(argv);
    if (!out.ok) return { ok: false as const, error: out.error };
    // --output-format json wraps the assistant text in {type:"result", result:"…"};
    // the flow JSON is inside `result`. Try the result field AND the raw stdout.
    let envelopeResult: string | undefined;
    try {
      envelopeResult = (JSON.parse(out.stdout) as { result?: string }).result;
    } catch {
      /* not the envelope — fall back to raw stdout */
    }
    const parsed = extractJsonFlow(envelopeResult ?? out.stdout);
    if (parsed === null) {
      return { ok: false as const, error: "não consegui extrair um JSON de fluxo da resposta do claude" };
    }
    const res = zGeneratedFlow.safeParse(coerceModels(parsed));
    if (!res.success) {
      return {
        ok: false as const,
        error: `fluxo gerado inválido: ${res.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    return { ok: true as const, flow: res.data };
  }
}

class FakeGenerator implements Generator {
  readonly mode = "fake" as const;
  async generate(prompt: string) {
    const flow = {
      name: prompt.trim().slice(0, 40) || "Fluxo gerado",
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
function spawnClaude(
  argv: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(CLAUDE_BIN, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `failed to spawn ${CLAUDE_BIN}: ${String(err)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (v: { ok: true; stdout: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `geração excedeu ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      stderr = (stderr + c).slice(-2000);
    });
    child.on("error", (err) => finish({ ok: false, error: `claude spawn error: ${String(err)}` }));
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, stdout });
      else finish({ ok: false, error: `claude saiu com código ${code ?? "?"}${stderr ? `: ${stderr.slice(0, 200)}` : ""}` });
    });
  });
}
