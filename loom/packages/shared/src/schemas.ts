import { z } from "zod";
import { NODE_TYPE_CATALOG } from "./catalog.js";
import { MODEL_CATALOG } from "./models.js";

// zod is the single definition at the trust boundary (YAML spec + inbound WS commands).
// TS domain types are authored in domain.ts; these schemas validate at the edges and
// stay in sync via the explicit-union enums below.

const nodeTypeNames = NODE_TYPE_CATALOG.map((d) => d.type) as [string, ...string[]];
const modelIds = MODEL_CATALOG.map((m) => m.id) as [string, ...string[]];

export const zNodeTypeName = z.enum(nodeTypeNames);
export const zModelId = z.enum(modelIds);

export const zTriggerConfig = z.object({
  kind: z.enum(["Agendado", "Intervalo", "Webhook", "Manual"]),
  freq: z.enum(["Diário", "Dias úteis", "Semanal", "Mensal"]).optional(),
  time: z.string().optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  interval: z.enum(["30 s", "1 min", "5 min", "15 min", "1 h", "6 h"]).optional(),
  event: z.string().optional(),
});

export const zAgentNode = z.object({
  id: z.string(),
  type: zNodeTypeName,
  title: z.string(),
  role: z.string(),
  model: zModelId,
  prompt: z.string(),
  linkedContexts: z.array(z.string()).default([]),
  position: z.object({ x: z.number(), y: z.number() }),
  produces: z.array(z.string()).optional(),
  trigger: zTriggerConfig.optional(),
  schedule: z.string().optional(),
  contextIsolation: z.boolean().optional(),
});

export const zEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  feedback: z.boolean().optional(),
  phase: z.number().optional(),
});

export const zFlowBudget = z.object({
  maxCyclesPerArm: z.number().int().positive(),
  maxTokensPerRun: z.number().int().positive(),
  maxUsdPerRun: z.number().positive(),
  maxTokensPerFlow: z.number().int().positive(),
  maxUsdPerFlow: z.number().positive(),
  maxConcurrentAgents: z.number().int().positive(),
  convergenceWindow: z.number().int().positive(),
});

// The YAML flow spec (topology/prompt source of truth).
export const zFlowSpec = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().nonnegative(),
  schedule: z.string(),
  blackboardDir: z.string(),
  /** Optional absolute path to a REAL user folder the agents run in (cwd + --add-dir). */
  workDir: z.string().optional(),
  reviewEachCycle: z.boolean().optional(),
  budget: zFlowBudget,
  nodes: z.array(zAgentNode).min(1).refine(
    (ns) => ns.some((n) => n.type === "Trigger"),
    { message: "A flow needs at least one Trigger node." },
  ),
  edges: z.array(zEdge),
});
export type FlowSpec = z.infer<typeof zFlowSpec>;

// Inbound WS command validation (engine boundary).
export const zEditableFlow = z.object({
  id: z.string(),
  name: z.string(),
  /** Optional absolute path to a REAL user folder the agents run in; persisted by spec.save. */
  workDir: z.string().optional(),
  reviewEachCycle: z.boolean().optional(),
  nodes: z.array(zAgentNode),
  edges: z.array(zEdge),
});

// What the NL generator (LLM) must emit. Node ids are payload-local (referenced
// by edges); model is optional (coerced to a default before parse if invalid).
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

export const zClientCommand = z.discriminatedUnion("t", [
  z.object({ t: z.literal("subscribe"), flowId: z.string(), sinceSeq: z.number().optional() }),
  z.object({ t: z.literal("flow.play"), cmdId: z.string(), flowId: z.string() }),
  z.object({ t: z.literal("flow.pause"), cmdId: z.string(), flowId: z.string() }),
  z.object({ t: z.literal("flow.kill"), cmdId: z.string(), flowId: z.string() }),
  z.object({ t: z.literal("flow.runNow"), cmdId: z.string(), flowId: z.string(), triggerNodeId: z.string().optional() }),
  z.object({ t: z.literal("flow.create"), cmdId: z.string(), name: z.string() }),
  z.object({ t: z.literal("flow.delete"), cmdId: z.string(), flowId: z.string() }),
  z.object({ t: z.literal("flow.continue"), cmdId: z.string(), flowId: z.string() }),
  z.object({ t: z.literal("flow.generate"), cmdId: z.string(), prompt: z.string().min(1) }),
  z.object({ t: z.literal("spec.save"), cmdId: z.string(), flow: zEditableFlow }),
  z.object({ t: z.literal("setTrigger"), cmdId: z.string(), flowId: z.string(), nodeId: z.string(), trigger: zTriggerConfig }),
  z.object({ t: z.literal("node.subscribe"), cmdId: z.string(), flowId: z.string(), nodeId: z.string() }),
  z.object({ t: z.literal("terminal.open"), cmdId: z.string(), terminal: z.string() }),
  z.object({ t: z.literal("terminal.input"), cmdId: z.string(), terminal: z.string(), data: z.string() }),
]);

/** Acyclic check over forward (non-feedback) edges — used by spec.save to reject bad topology. */
export function findForwardCycle(
  nodes: { id: string }[],
  edges: { from: string; to: string; feedback?: boolean }[],
): string[] | null {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) if (!e.feedback) adj.get(e.from)?.push(e.to);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const dfs = (u: string): boolean => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        cycle = stack.slice(stack.indexOf(v));
        return true;
      }
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    stack.pop();
    color.set(u, BLACK);
    return false;
  };
  for (const n of nodes) if (color.get(n.id) === WHITE && dfs(n.id)) break;
  return cycle;
}
