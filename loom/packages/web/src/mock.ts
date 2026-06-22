import type { Flow, AgentNode, Edge, FlowSummary, Terminal, Run, ModelId } from "@loom/shared";
import { asFlowId, asNodeId, asEdgeId, asRunId, typeDef } from "@loom/shared";
import { useLoomStore, type LogEntry } from "./store";

/* ────────────────────────────────────────────────────────────────────────
 * Mock seed — ports this.graphs.daily (Daily Standup Loop) from Loom.dc.html
 * so the UI is fully viewable WITHOUT the engine. The store starts in "mock"
 * mode; the first `hello` from the ws client flips it to "live".
 *
 * Only the daily flow gets full topology (nodes/edges/positions/runs). The
 * other three appear in the rail as FlowSummary stubs (matching flowMeta),
 * exactly like the mockup's collapsed-state rail.
 * ──────────────────────────────────────────────────────────────────────── */

const green = "oklch(0.64 0.13 160)";
const blue = "oklch(0.60 0.13 245)";
const violet = "oklch(0.56 0.15 292)";
const amber = "oklch(0.70 0.12 65)";

const SONNET: ModelId = "claude-sonnet-4-6";

const FLOW_ID = asFlowId("daily");

let runSeq = 0;
function mkRun(nodeId: string, status: Run["status"], summary: string, model: ModelId): Run {
  runSeq += 1;
  return {
    id: asRunId(`mock_run_${runSeq}`),
    flowId: FLOW_ID,
    nodeId: asNodeId(nodeId),
    cycle: 14,
    status,
    model,
    startedAt: Date.now() - runSeq * 1000,
    endedAt: Date.now() - runSeq * 1000 + 800,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    toolCalls: 0,
    resultSummary: summary,
  };
}

interface NodeSeed {
  id: string;
  type: AgentNode["type"];
  title: string;
  role: string;
  prompt: string;
  contexts: string[];
  position: { x: number; y: number };
  schedule?: string;
  trigger?: AgentNode["trigger"];
  produces?: string[];
}

const NODE_SEEDS: NodeSeed[] = [
  {
    id: "scribe",
    type: "Trigger",
    title: "Scribe",
    role: "Escreve o log diário do projeto",
    prompt:
      "Resuma o estado do projeto desde ontem, liste o que mudou e registre em daily-log.md para os analistas.",
    contexts: ["daily-log.md", "#standup", "repo/main"],
    position: { x: 44, y: 212 },
    trigger: { kind: "Agendado", freq: "Diário", time: "09:00" },
    produces: ["daily-log.md"],
  },
  {
    id: "a1",
    type: "Analyst",
    title: "Analyst — Risco",
    role: "Avalia riscos e bloqueios",
    prompt: "Leia o log do dia, identifique riscos novos e classifique severidade.",
    contexts: ["daily-log.md", "risks.md"],
    position: { x: 356, y: 48 },
    schedule: "Disparado pelo Scribe",
    produces: ["risks.md"],
  },
  {
    id: "a2",
    type: "Analyst",
    title: "Analyst — Custo",
    role: "Estima custo e esforço",
    prompt: "Estime custo e esforço das mudanças do dia e sinalize estouros de orçamento.",
    contexts: ["daily-log.md", "budget.csv"],
    position: { x: 356, y: 212 },
    schedule: "Disparado pelo Scribe",
    produces: ["budget.csv"],
  },
  {
    id: "a3",
    type: "Analyst",
    title: "Analyst — Impacto",
    role: "Pesa impacto no usuário",
    prompt: "Pese o impacto das mudanças na experiência do usuário e nas métricas-chave.",
    contexts: ["daily-log.md", "metrics.json"],
    position: { x: 356, y: 376 },
    schedule: "Disparado pelo Scribe",
    produces: ["metrics.json"],
  },
  {
    id: "synth",
    type: "Synthesizer",
    title: "Synthesizer",
    role: "Consolida sem viés",
    prompt:
      "Receba os 3 relatórios, remova viés e duplicidade, e produza uma recomendação única e priorizada.",
    contexts: ["risks.md", "budget.csv", "metrics.json"],
    position: { x: 640, y: 212 },
    schedule: "Após os 3 analysts",
    produces: ["decision.md"],
  },
  {
    id: "exec",
    type: "Executor",
    title: "Executor",
    role: "Aplica e devolve ao Scribe",
    prompt:
      "Aplique a decisão aprovada, abra as tarefas e devolva o resultado ao Scribe para validar o ciclo.",
    contexts: ["decision.md", "repo/main", "term://2"],
    position: { x: 812, y: 212 },
    schedule: "Após o Synthesizer",
  },
];

const EDGE_SEEDS: Edge[] = [
  { id: asEdgeId("e1"), from: asNodeId("scribe"), to: asNodeId("a1"), phase: 0 },
  { id: asEdgeId("e2"), from: asNodeId("scribe"), to: asNodeId("a2"), phase: 0.9 },
  { id: asEdgeId("e3"), from: asNodeId("scribe"), to: asNodeId("a3"), phase: 1.7 },
  { id: asEdgeId("e4"), from: asNodeId("a1"), to: asNodeId("synth"), phase: 0.4 },
  { id: asEdgeId("e5"), from: asNodeId("a2"), to: asNodeId("synth"), phase: 1.3 },
  { id: asEdgeId("e6"), from: asNodeId("a3"), to: asNodeId("synth"), phase: 2.1 },
  { id: asEdgeId("e7"), from: asNodeId("synth"), to: asNodeId("exec"), phase: 0.6 },
  { id: asEdgeId("e8"), from: asNodeId("exec"), to: asNodeId("scribe"), phase: 1.0, feedback: true },
];

const RUN_SEEDS: Record<string, Run[]> = {
  scribe: [mkRun("scribe", "ok", "Log gerado", SONNET), mkRun("scribe", "ok", "Log gerado", SONNET)],
  a1: [mkRun("a1", "ok", "2 riscos novos", SONNET), mkRun("a1", "ok", "1 risco novo", SONNET)],
  a2: [mkRun("a2", "ok", "Custo dentro", SONNET), mkRun("a2", "ok", "Custo +8%", SONNET)],
  a3: [mkRun("a3", "ok", "Impacto alto", SONNET), mkRun("a3", "ok", "Impacto médio", SONNET)],
  synth: [mkRun("synth", "ok", "1 recomendação", SONNET)],
  exec: [mkRun("exec", "ok", "3 tarefas abertas", SONNET)],
};

function buildDailyFlow(): Flow {
  const nodes: AgentNode[] = NODE_SEEDS.map((s) => {
    const def = typeDef(s.type);
    const base: AgentNode = {
      id: asNodeId(s.id),
      type: s.type,
      title: s.title,
      role: s.role,
      model: SONNET,
      prompt: s.prompt,
      linkedContexts: s.contexts,
      position: s.position,
      contextIsolation: def.semantics === "synthesizer",
    };
    if (s.produces) base.produces = s.produces;
    if (s.trigger) base.trigger = s.trigger;
    if (s.schedule) base.schedule = s.schedule;
    return base;
  });

  return {
    id: FLOW_ID,
    name: "Daily Standup Loop",
    version: 1,
    schedule: "09:00",
    state: "rodando",
    cycle: 14,
    nodes,
    edges: EDGE_SEEDS,
    budget: {
      maxCyclesPerArm: 3,
      maxTokensPerRun: 200_000,
      maxUsdPerRun: 2,
      maxTokensPerFlow: 2_000_000,
      maxUsdPerFlow: 20,
      maxConcurrentAgents: 4,
      convergenceWindow: 2,
    },
    blackboardDir: "daily",
  };
}

/* Rail stubs for the other 3 flows (matches flowMeta in the mockup). */
const OTHER_SUMMARIES: FlowSummary[] = [
  { id: asFlowId("review"), name: "Content Review", schedule: "14:00", state: "agendado", cycle: 0, agents: 5, connections: 6, triggers: 1 },
  { id: asFlowId("triage"), name: "Inbox Triage", schedule: "a cada 2h", state: "ocioso", cycle: 0, agents: 4, connections: 4, triggers: 1 },
  { id: asFlowId("digest"), name: "Research Digest", schedule: "sex 17:00", state: "pausado", cycle: 0, agents: 4, connections: 4, triggers: 1 },
];

const TERMINALS: Terminal[] = [
  { id: "term://1", title: "term://1", status: "scribe", meta: "scribe" },
  { id: "term://2", title: "term://2", status: "executor", meta: "executor" },
  { id: "term://3", title: "term://3", status: "idle", meta: "idle" },
];

function seedLogs(): LogEntry[] {
  const now = Date.now();
  const fmt = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
  return [
    { time: fmt(now - 2000), color: green, msg: "scribe › escreveu daily-log.md" },
    { time: fmt(now - 8000), color: amber, msg: "executor › aplicou e devolveu ao scribe" },
    { time: fmt(now - 14000), color: violet, msg: "synthesizer › consolidou sem viés" },
    { time: fmt(now - 20000), color: blue, msg: "analysts › 3 análises em paralelo" },
  ];
}

/**
 * Populate the store with the daily-standup flow. Idempotent; safe to call at
 * bootstrap. Leaves `connection: "mock"` — the ws `hello` flips it to "live".
 */
export function seedMockStore(): void {
  const flow = buildDailyFlow();
  const summary: FlowSummary = {
    id: flow.id,
    name: flow.name,
    schedule: flow.schedule,
    state: flow.state,
    cycle: flow.cycle,
    agents: flow.nodes.length,
    connections: flow.edges.length,
    triggers: flow.nodes.filter((n) => n.type === "Trigger").length,
  };

  const runsByNode: Record<string, Run[]> = {};
  for (const [nodeId, runs] of Object.entries(RUN_SEEDS)) runsByNode[asNodeId(nodeId)] = runs;

  useLoomStore.setState({
    connection: "mock",
    flows: [summary, ...OTHER_SUMMARIES],
    flowsById: { [flow.id]: flow },
    selectedFlowId: flow.id,
    selectedNodeId: asNodeId("scribe"),
    selectedEdgeId: null,
    terminals: TERMINALS,
    runsByNode,
    logs: seedLogs(),
    cycle: flow.cycle,
    running: true,
    // mockup's daily flow starts mid-cycle with the scribe stage lit
    activeNodeIds: new Set<string>(["scribe"]),
    activeEdgeIds: new Set<string>(["e1", "e2", "e3"]),
  });
}
