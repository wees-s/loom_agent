import { describe, it, expect } from "vitest";
import type { TokenUsage } from "@loom/shared";
import { MODEL_REGISTRY } from "@loom/shared";
import type { StreamEvent } from "./internal.js";
import {
  costFromUsage,
  emptyUsage,
  addUsage,
  parseLine,
  createStreamParser,
  parseAll,
} from "./streamParser.js";

// -----------------------------------------------------------------------------
// Captured fixtures — verbatim NDJSON shapes the validated smoke test observed.
// -----------------------------------------------------------------------------

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "/home/wesley/WORKSPACE/loom/blackboard/daily-standup",
  session_id: "sess-abc-123",
  model: "claude-haiku-4-5",
  tools: ["Read", "Write"],
});

const THINKING_LINE = JSON.stringify({
  type: "system",
  subtype: "thinking_tokens",
  tokens: 4096,
});

const RATE_LIMIT_LINE = JSON.stringify({
  type: "rate_limit_event",
  retry_after: 3,
});

const ASSISTANT_TEXT_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_1",
    role: "assistant",
    content: [{ type: "text", text: "Resumo do standup pronto." }],
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 5000,
    },
  },
});

const ASSISTANT_TOOL_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_2",
    role: "assistant",
    content: [
      { type: "text", text: "Vou escrever o artefato." },
      {
        type: "tool_use",
        id: "tu_1",
        name: "Write",
        input: { file_path: "daily-log.md", content: "..." },
      },
      { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "x" } },
    ],
    usage: {
      input_tokens: 50,
      output_tokens: 80,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 6200,
    },
  },
});

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Standup resumido:\n  2 bloqueios novos, 3 itens concluídos.",
  total_cost_usd: 0.0123,
  duration_ms: 8421,
  usage: {
    input_tokens: 1250,
    output_tokens: 380,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 11200,
  },
});

const RESULT_NO_COST_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  duration_ms: 100,
  usage: {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
});

const RESULT_ERROR_LINE = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "tool failure",
  duration_ms: 200,
  usage: { input_tokens: 10, output_tokens: 0 },
});

const RESULT_MAX_TURNS_LINE = JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  duration_ms: 300,
  usage: { input_tokens: 10, output_tokens: 0 },
});

const FULL_TRANSCRIPT = [
  INIT_LINE,
  THINKING_LINE,
  RATE_LIMIT_LINE,
  ASSISTANT_TEXT_LINE,
  ASSISTANT_TOOL_LINE,
  RESULT_LINE,
].join("\n");

// -----------------------------------------------------------------------------

describe("usage arithmetic", () => {
  it("emptyUsage is all zeros", () => {
    expect(emptyUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("addUsage sums field-wise without mutating inputs", () => {
    const a: TokenUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    };
    const b: TokenUsage = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
    });
    expect(a.inputTokens).toBe(1); // unmutated
  });

  it("costFromUsage matches MODEL_REGISTRY pricing exactly", () => {
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    const p = MODEL_REGISTRY["claude-haiku-4-5"];
    const expected =
      p.inputPer1M + p.outputPer1M + p.cacheReadPer1M + p.cacheWritePer1M;
    expect(costFromUsage("claude-haiku-4-5", usage)).toBeCloseTo(expected, 9);
  });

  it("costFromUsage on empty usage is 0", () => {
    expect(costFromUsage("claude-opus-4-8", emptyUsage())).toBe(0);
  });
});

describe("parseLine", () => {
  it("returns null for blank / noise lines", () => {
    expect(parseLine("", "claude-haiku-4-5")).toBeNull();
    expect(parseLine("   ", "claude-haiku-4-5")).toBeNull();
    expect(parseLine("Loom CLI banner v2", "claude-haiku-4-5")).toBeNull();
    expect(parseLine("{not json", "claude-haiku-4-5")).toBeNull();
  });

  it("parses init", () => {
    const e = parseLine(INIT_LINE, "claude-haiku-4-5");
    expect(e).toEqual({
      kind: "init",
      sessionId: "sess-abc-123",
      cwd: "/home/wesley/WORKSPACE/loom/blackboard/daily-standup",
      model: "claude-haiku-4-5",
    });
  });

  it("parses thinking tokens", () => {
    expect(parseLine(THINKING_LINE, "claude-haiku-4-5")).toEqual({
      kind: "thinking",
      tokens: 4096,
    });
  });

  it("parses rate limit", () => {
    const e = parseLine(RATE_LIMIT_LINE, "claude-haiku-4-5");
    expect(e?.kind).toBe("rateLimit");
  });

  it("prefers the usage event for an assistant line", () => {
    const e = parseLine(ASSISTANT_TEXT_LINE, "claude-haiku-4-5");
    expect(e?.kind).toBe("usage");
    if (e?.kind === "usage") {
      expect(e.usage).toEqual({
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 5000,
        cacheWriteTokens: 100,
      });
      expect(e.costUsd).toBeGreaterThan(0);
    }
  });

  it("parses result with CLI total_cost_usd and status ok", () => {
    const e = parseLine(RESULT_LINE, "claude-haiku-4-5");
    expect(e?.kind).toBe("result");
    if (e?.kind === "result") {
      expect(e.status).toBe("ok");
      expect(e.totalCostUsd).toBeCloseTo(0.0123, 9);
      expect(e.durationMs).toBe(8421);
      expect(e.resultSummary).toContain("2 bloqueios novos");
      expect(e.usage.cacheReadTokens).toBe(11200);
    }
  });

  it("falls back to MODEL_REGISTRY cost when total_cost_usd is absent", () => {
    const e = parseLine(RESULT_NO_COST_LINE, "claude-sonnet-4-6");
    expect(e?.kind).toBe("result");
    if (e?.kind === "result") {
      const p = MODEL_REGISTRY["claude-sonnet-4-6"];
      expect(e.totalCostUsd).toBeCloseTo(p.inputPer1M + p.outputPer1M, 9);
    }
  });

  it("maps error_during_execution -> error and error_max_turns -> timeout", () => {
    const err = parseLine(RESULT_ERROR_LINE, "claude-haiku-4-5");
    expect(err?.kind === "result" && err.status).toBe("error");
    const mt = parseLine(RESULT_MAX_TURNS_LINE, "claude-haiku-4-5");
    expect(mt?.kind === "result" && mt.status).toBe("timeout");
  });
});

describe("parseAll (full transcript fan-out)", () => {
  it("emits every structured signal including both tool uses", () => {
    const events = parseAll(FULL_TRANSCRIPT, "claude-haiku-4-5");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("init");
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("rateLimit");
    expect(kinds).toContain("text");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("result");

    const toolUses = events.filter(
      (e): e is Extract<StreamEvent, { kind: "toolUse" }> =>
        e.kind === "toolUse",
    );
    expect(toolUses.map((t) => t.name)).toEqual(["Write", "Read"]);

    // text from the tool line is preserved as its own event
    const texts = events.filter(
      (e): e is Extract<StreamEvent, { kind: "text" }> => e.kind === "text",
    );
    expect(texts.map((t) => t.text)).toEqual([
      "Resumo do standup pronto.",
      "Vou escrever o artefato.",
    ]);

    // exactly one terminal result
    expect(events.filter((e) => e.kind === "result")).toHaveLength(1);
  });
});

describe("createStreamParser (incremental, split chunks)", () => {
  it("reassembles lines split mid-token across chunks", () => {
    const parser = createStreamParser("claude-haiku-4-5");
    const blob = FULL_TRANSCRIPT + "\n";
    const out: StreamEvent[] = [];
    // Feed one byte at a time (UTF-8 bytes) to stress the boundary logic.
    const bytes = new TextEncoder().encode(blob);
    for (const b of bytes) {
      out.push(...parser.push(new Uint8Array([b])));
    }
    out.push(...parser.end());

    expect(out.filter((e) => e.kind === "result")).toHaveLength(1);
    expect(out.filter((e) => e.kind === "init")).toHaveLength(1);
    expect(out.filter((e) => e.kind === "toolUse")).toHaveLength(2);
  });

  it("handles CRLF line endings (WSL->Windows bridge)", () => {
    const parser = createStreamParser("claude-haiku-4-5");
    const out = parser.push(INIT_LINE + "\r\n" + RESULT_LINE + "\r\n");
    out.push(...parser.end());
    expect(out[0]?.kind).toBe("init");
    expect(out.at(-1)?.kind).toBe("result");
  });

  it("end() flushes a trailing un-terminated line", () => {
    const parser = createStreamParser("claude-haiku-4-5");
    expect(parser.push(RESULT_LINE)).toHaveLength(0); // no newline yet
    const flushed = parser.end();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.kind).toBe("result");
  });

  it("skips interleaved non-JSON noise lines", () => {
    const parser = createStreamParser("claude-haiku-4-5");
    const out = parser.push(
      ["warming up...", INIT_LINE, "", "  ", RESULT_LINE].join("\n") + "\n",
    );
    out.push(...parser.end());
    expect(out.map((e) => e.kind)).toEqual(["init", "result"]);
  });
});
