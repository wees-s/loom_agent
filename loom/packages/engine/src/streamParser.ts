// =============================================================================
// streamParser.ts [streamParser] — PURE NDJSON adapter for claude stream-json.
//
// ⚠️ LEGACY (mostly unused on the real path). The terminal-native RealRunner uses
// default TEXT output and does NOT parse stream-json, so the full NDJSON parser
// below (createStreamParser/parseLine/StreamEvent handling) is currently dead on
// the production path — only the small cost helpers `emptyUsage`/`costFromUsage`
// are still consumed (by the FakeRunner). `auth.ts` has its own inline reader.
// Kept intact (not deleted) because it is the natural building block for the
// planned metering fix: parse the real session's final cost/usage and feed
// guard.meterToken to re-activate the per-flow accumulation + live abort. See
// README "Safety model" follow-up and review_loom.md §7.1 / §7.2.
//
// No side effects. Consumes raw NDJSON lines and surfaces structured StreamEvents
// the runner turns into LoomEvents. Computes costUsd from MODEL_REGISTRY pricing
// when the CLI omits total_cost_usd. Unit-testable on captured fixtures.
//
// Observed NDJSON shapes (from the validated smoke test):
//   {type:"system",subtype:"init",cwd,session_id,...}
//   {type:"system",subtype:"thinking_tokens",...}
//   {type:"rate_limit_event",...}
//   {type:"assistant",message:{...,content:[{type:"text",text},{type:"tool_use",name,...}],
//        usage:{input_tokens,cache_creation_input_tokens,cache_read_input_tokens,output_tokens}}}
//   {type:"result",...,subtype,is_error,result,total_cost_usd,duration_ms,usage}
//
// The CLI streams one JSON object per line. Lines may arrive split across stdout
// chunks (createStreamParser buffers), and stray non-JSON noise is skipped.
// =============================================================================

import type { ModelId, TokenUsage, RunStatus } from "@loom/shared";
import { MODEL_REGISTRY } from "@loom/shared";
import type { StreamEvent } from "./internal.js";

// -----------------------------------------------------------------------------
// Cost / usage arithmetic
// -----------------------------------------------------------------------------

/** Cost from token usage via MODEL_REGISTRY (the total_cost_usd fallback). */
export function costFromUsage(model: ModelId, usage: TokenUsage): number {
  const p = MODEL_REGISTRY[model];
  // Defensive: unknown model id => no pricing => zero (caller may still get
  // total_cost_usd from the CLI on result events).
  if (!p) return 0;
  const cost =
    (usage.inputTokens * p.inputPer1M +
      usage.outputTokens * p.outputPer1M +
      usage.cacheReadTokens * p.cacheReadPer1M +
      usage.cacheWriteTokens * p.cacheWritePer1M) /
    1_000_000;
  // Never surface negative / NaN noise to the meter.
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/** Empty/zeroed usage accumulator (exported so the runner can seed a meter). */
export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Add two usage records field-wise (monotonic accumulation across chunks). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

// -----------------------------------------------------------------------------
// Raw-shape helpers (defensive: the CLI is an external contract, treat as unknown)
// -----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Coerce an unknown JSON number-ish value to a finite non-negative integer. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Map a claude raw `usage` object onto our TokenUsage. The CLI uses
 * snake_case (input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens). cache_creation_input_tokens == our cacheWriteTokens.
 */
function usageFromRaw(raw: unknown): TokenUsage {
  if (!isRecord(raw)) return emptyUsage();
  return {
    inputTokens: num(raw["input_tokens"]),
    outputTokens: num(raw["output_tokens"]),
    cacheReadTokens: num(raw["cache_read_input_tokens"]),
    cacheWriteTokens: num(raw["cache_creation_input_tokens"]),
  };
}

/**
 * Map a `result` event's subtype/is_error onto our RunStatus. The CLI emits
 * subtype "success" | "error_during_execution" | "error_max_turns" (max_turns
 * is treated as a timeout-class terminal). is_error is the authoritative flag.
 */
function statusFromResult(raw: Record<string, unknown>): RunStatus {
  const subtype = str(raw["subtype"]);
  const isError = raw["is_error"] === true;
  if (subtype === "error_max_turns") return "timeout";
  if (isError || (subtype !== undefined && subtype !== "success")) return "error";
  return "ok";
}

/**
 * Derive a short recent-runs label from a result event: prefer the trailing
 * `result` text, trimmed to one line; fall back to undefined. The runner may
 * override this with the last artifact summary.
 */
function summaryFromResult(raw: Record<string, unknown>): string | undefined {
  const result = str(raw["result"]);
  if (result === undefined) return undefined;
  const firstLine = result.replace(/\s+/g, " ").trim();
  if (firstLine.length === 0) return undefined;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

/**
 * Extract assistant text from a message's content blocks, concatenated.
 * Returns "" if there is no text block.
 */
function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (isRecord(block) && block["type"] === "text") {
      const t = str(block["text"]);
      if (t) out += t;
    }
  }
  return out;
}

/**
 * Extract every tool_use block from a message's content as toolUse events.
 */
function toolUsesFromContent(content: unknown, at: number): StreamEvent[] {
  if (!Array.isArray(content)) return [];
  const events: StreamEvent[] = [];
  for (const block of content) {
    if (isRecord(block) && block["type"] === "tool_use") {
      const name = str(block["name"]) ?? "unknown";
      events.push({ kind: "toolUse", name, at, raw: block });
    }
  }
  return events;
}

// -----------------------------------------------------------------------------
// parseLine — single NDJSON line -> zero-or-one *primary* StreamEvent.
//
// NOTE: an `assistant` line can legitimately carry MULTIPLE structured signals
// (text + N tool uses + a usage delta). parseLine() preserves the historic
// "zero-or-one" return shape by surfacing the most salient single event:
//   - usage (if the message carried a usage delta) — drives metering/abort,
//   - else the first tool use, else the text, else unknown.
// The streaming parser (parseEventsForObject, used by createStreamParser and
// parseAll) emits the FULL fan-out so nothing is dropped downstream.
// -----------------------------------------------------------------------------

/**
 * Parse a SINGLE NDJSON line into zero-or-one StreamEvent.
 * Returns null for blank lines / non-JSON noise (caller skips). The `model`
 * is needed to compute the cost fallback on usage/result events.
 */
export function parseLine(line: string, model: ModelId): StreamEvent | null {
  const obj = parseJsonLine(line);
  if (obj === null) return null;
  const events = parseEventsForObject(obj, model);
  if (events.length === 0) return null;
  // Prefer a usage event if present (it's the metering signal); else the last
  // event (result), else the first. We scan for usage first.
  const usage = events.find((e) => e.kind === "usage");
  if (usage) return usage;
  const result = events.find((e) => e.kind === "result");
  if (result) return result;
  return events[0] ?? null;
}

/** Parse one trimmed line into a JSON object, or null if blank / not JSON. */
function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  // The CLI emits one JSON object per line. Non-`{` lines are CLI noise
  // (banners, log prefixes) — skip them rather than throwing.
  if (trimmed[0] !== "{") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/**
 * Turn ONE parsed NDJSON object into the FULL list of StreamEvents it implies.
 * This is the canonical fan-out used by the streaming parser and parseAll.
 */
function parseEventsForObject(
  obj: Record<string, unknown>,
  model: ModelId,
): StreamEvent[] {
  const type = str(obj["type"]);

  switch (type) {
    case "system":
      return parseSystem(obj);

    case "rate_limit_event":
      return [{ kind: "rateLimit", raw: obj }];

    case "assistant":
      return parseAssistant(obj, model);

    case "user":
      // tool_result echoes back in a user turn — carries no metering/text we
      // surface; treat as unknown so the runner can log if desired.
      return [{ kind: "unknown", raw: obj }];

    case "result":
      return [parseResult(obj, model)];

    default:
      return [{ kind: "unknown", raw: obj }];
  }
}

function parseSystem(obj: Record<string, unknown>): StreamEvent[] {
  const subtype = str(obj["subtype"]);
  if (subtype === "init") {
    return [
      {
        kind: "init",
        sessionId: str(obj["session_id"]) ?? "",
        cwd: str(obj["cwd"]) ?? "",
        ...(str(obj["model"]) !== undefined
          ? { model: str(obj["model"]) }
          : {}),
      },
    ];
  }
  if (subtype === "thinking_tokens") {
    // The thinking budget arrives under a couple of possible keys depending on
    // CLI version; probe the common ones.
    const tokens =
      num(obj["tokens"]) ||
      num(obj["thinking_tokens"]) ||
      num(obj["budget_tokens"]);
    return [{ kind: "thinking", tokens }];
  }
  return [{ kind: "unknown", raw: obj }];
}

function parseAssistant(
  obj: Record<string, unknown>,
  model: ModelId,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const message = obj["message"];
  if (!isRecord(message)) return [{ kind: "unknown", raw: obj }];

  const content = message["content"];

  // 1) text block(s) -> a single text event (concatenated).
  const text = textFromContent(content);
  if (text.length > 0) {
    events.push({ kind: "text", text });
  }

  // 2) tool_use block(s) -> one toolUse event each, timestamped at parse time.
  events.push(...toolUsesFromContent(content, Date.now()));

  // 3) usage delta -> a usage event with the cost fallback.
  if (isRecord(message["usage"])) {
    const usage = usageFromRaw(message["usage"]);
    events.push({
      kind: "usage",
      usage,
      costUsd: costFromUsage(model, usage),
    });
  }

  if (events.length === 0) {
    return [{ kind: "unknown", raw: obj }];
  }
  return events;
}

function parseResult(
  obj: Record<string, unknown>,
  model: ModelId,
): StreamEvent {
  const usage = usageFromRaw(obj["usage"]);
  const cliCost = obj["total_cost_usd"];
  // total_cost_usd comes free from the CLI; fall back to MODEL_REGISTRY pricing
  // only when the CLI omits it (or hands us a non-positive value).
  const totalCostUsd =
    typeof cliCost === "number" && Number.isFinite(cliCost) && cliCost > 0
      ? cliCost
      : costFromUsage(model, usage);
  const summary = summaryFromResult(obj);
  return {
    kind: "result",
    status: statusFromResult(obj),
    totalCostUsd,
    durationMs: num(obj["duration_ms"]),
    usage,
    ...(summary !== undefined ? { resultSummary: summary } : {}),
  };
}

// -----------------------------------------------------------------------------
// Incremental streaming parser
// -----------------------------------------------------------------------------

/**
 * Stateful, incremental parser for a streamed stdout: feed arbitrary chunks
 * (which may split mid-line), drain complete StreamEvents. `end()` flushes any
 * trailing buffered line. Used by the runner to pipe child stdout.
 */
export interface StreamParser {
  /** Feed a stdout chunk; returns the StreamEvents completed by this chunk. */
  push(chunk: string | Uint8Array): StreamEvent[];
  /** Flush a trailing un-terminated line (if any). */
  end(): StreamEvent[];
}

export function createStreamParser(model: ModelId): StreamParser {
  // Buffer holds the partial trailing line between chunks. We split on "\n"
  // and keep the last (possibly incomplete) fragment in `buffer`.
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  function toText(chunk: string | Uint8Array): string {
    if (typeof chunk === "string") return chunk;
    // stream:true so multi-byte chars split across chunks are not corrupted.
    return decoder.decode(chunk, { stream: true });
  }

  function drainLine(line: string): StreamEvent[] {
    const obj = parseJsonLine(line);
    if (obj === null) return [];
    return parseEventsForObject(obj, model);
  }

  return {
    push(chunk: string | Uint8Array): StreamEvent[] {
      buffer += toText(chunk);
      const out: StreamEvent[] = [];
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        // Strip a trailing \r (Windows CRLF crossing the WSL bridge).
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        out.push(...drainLine(line));
        nl = buffer.indexOf("\n");
      }
      return out;
    },
    end(): StreamEvent[] {
      // Flush any decoder-internal bytes, then the trailing line.
      buffer += decoder.decode();
      const line = buffer;
      buffer = "";
      return drainLine(line);
    },
  };
}

/** Convenience for fixtures/tests: parse a full NDJSON blob into all events. */
export function parseAll(ndjson: string, model: ModelId): StreamEvent[] {
  const parser = createStreamParser(model);
  const out = parser.push(ndjson);
  out.push(...parser.end());
  return out;
}
