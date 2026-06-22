// Real current Claude model ids (verified June 2026) mapped to the mockup's friendly labels.
// Mockup labels: "Claude Opus 4.1" / "Claude Sonnet 4.5" / "Claude Haiku 4".
// Real ids:      claude-opus-4-8  / claude-sonnet-4-6   / claude-haiku-4-5.
export type ModelId =
  | "claude-opus-4-8"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5";

export interface ModelDef {
  /** Real Anthropic id passed to the CLI via --model. */
  id: ModelId;
  /** Friendly label shown in the picker (matches the mockup). */
  label: string;
}

export interface ModelPricing {
  id: ModelId;
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read tokens (~0.1x input). */
  cacheReadPer1M: number;
  /** USD per 1M cache-write tokens (~1.25x input, 5m ttl). */
  cacheWritePer1M: number;
  /** Hard output ceiling — feeds worstCaseRunCost in the pre-spend admission check. */
  maxOutputTokens: number;
}

// Server-driven model picker: shipped in the `hello` message.
export const MODEL_CATALOG: ModelDef[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.1" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4" },
];

// Pricing/limits for the pre-spend admission check + cost fallback when the CLI
// omits total_cost_usd. (Opus/Sonnet 1M ctx, Haiku 200K ctx; all stream-capable.)
export const MODEL_REGISTRY: Record<ModelId, ModelPricing> = {
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    maxOutputTokens: 128_000,
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
    maxOutputTokens: 64_000,
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 1.25,
    maxOutputTokens: 64_000,
  },
};

export function labelForModel(id: ModelId): string {
  return MODEL_CATALOG.find((m) => m.id === id)?.label ?? id;
}
