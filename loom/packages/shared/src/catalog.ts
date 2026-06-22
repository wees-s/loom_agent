// Exhaustive enumerated union of every node type in the mockup CATALOG (fidelity graft #5),
// replacing the open `string & {}`. New type = one entry here, no UI change.
export type NodeTypeName =
  // Padrões (recommended)
  | "Trigger" | "Analyst" | "Synthesizer" | "Executor"
  // Planejamento
  | "Planner" | "Strategist" | "Architect" | "Coordinator"
  // Análise
  | "Researcher" | "Investigator" | "Auditor" | "Critic"
  // Criação
  | "Writer" | "Designer" | "Ideator" | "Storyteller"
  // Execução
  | "Operator" | "Automator" | "Deployer" | "Integrator"
  // Controle
  | "Supervisor" | "Manager" | "Reviewer" | "Validator" | "Governor"
  // Especialização
  | "Coder" | "Debugger" | "Tester" | "Data Scientist" | "Security Analyst"
  | "Marketing Specialist" | "Sales Agent" | "Legal Advisor" | "Financial Analyst"
  // Comunicação
  | "Assistant" | "Negotiator" | "Interviewer" | "Teacher" | "Translator" | "Presenter"
  // Memória e Conhecimento
  | "Librarian" | "Knowledge Manager" | "Memory Keeper" | "Indexer";

export type CategoryName =
  | "Padrões" | "Planejamento" | "Análise" | "Criação" | "Execução"
  | "Controle" | "Especialização" | "Comunicação" | "Memória e Conhecimento";

// Orchestration-significant semantics, derived from type — the orchestrator reads this,
// never the label. Only the 4 Padrões map to a non-generic semantics.
export type NodeSemantics =
  | "trigger" | "analyst" | "synthesizer" | "executor" | "generic";

export interface NodeTypeDef {
  type: NodeTypeName;
  category: CategoryName;
  /** oklch(...) token from the mockup. */
  color: string;
  /** "Agente · Análise" etc — the typeLabel shown on the card. */
  label: string;
  /** tooltip / hover description. */
  desc: string;
  recommended?: boolean;
  isTrigger?: boolean;
  semantics: NodeSemantics;
}

// Exact oklch palette from the mockup.
const green = "oklch(0.64 0.13 160)";
const blue = "oklch(0.60 0.13 245)";
const violet = "oklch(0.56 0.15 292)";
const amber = "oklch(0.70 0.12 65)";
const cteal = "oklch(0.62 0.12 200)";
const crose = "oklch(0.60 0.15 25)";
const cindigo = "oklch(0.55 0.14 285)";
const cgrass = "oklch(0.64 0.13 148)";
const colive = "oklch(0.60 0.10 95)";

export const TYPE_COLORS = { green, blue, violet, amber } as const;

// Server-driven Add-Agent catalog: shipped in the `hello` message.
export const NODE_TYPE_CATALOG: NodeTypeDef[] = [
  // Padrões
  { type: "Trigger", category: "Padrões", color: green, label: "Trigger · Cron", desc: "Inicia o fluxo em horário ou evento (cron / gatilho).", recommended: true, isTrigger: true, semantics: "trigger" },
  { type: "Analyst", category: "Padrões", color: blue, label: "Agente · Análise", desc: "Analisa dados e contexto.", recommended: true, semantics: "analyst" },
  { type: "Synthesizer", category: "Padrões", color: violet, label: "Agente · Síntese", desc: "Combina informações sem viés.", recommended: true, semantics: "synthesizer" },
  { type: "Executor", category: "Padrões", color: amber, label: "Agente · Execução", desc: "Executa ações e fecha o ciclo.", recommended: true, semantics: "executor" },
  // Planejamento
  { type: "Planner", category: "Planejamento", color: cteal, label: "Agente · Planejamento", desc: "Divide objetivos em etapas.", semantics: "generic" },
  { type: "Strategist", category: "Planejamento", color: cteal, label: "Agente · Planejamento", desc: "Define estratégia de alto nível.", semantics: "generic" },
  { type: "Architect", category: "Planejamento", color: cteal, label: "Agente · Planejamento", desc: "Projeta sistemas e soluções.", semantics: "generic" },
  { type: "Coordinator", category: "Planejamento", color: cteal, label: "Agente · Planejamento", desc: "Distribui tarefas entre agentes.", semantics: "generic" },
  // Análise
  { type: "Researcher", category: "Análise", color: blue, label: "Agente · Análise", desc: "Busca informações.", semantics: "analyst" },
  { type: "Investigator", category: "Análise", color: blue, label: "Agente · Análise", desc: "Aprofunda em problemas específicos.", semantics: "analyst" },
  { type: "Auditor", category: "Análise", color: blue, label: "Agente · Análise", desc: "Verifica conformidade e qualidade.", semantics: "analyst" },
  { type: "Critic", category: "Análise", color: blue, label: "Agente · Análise", desc: "Procura falhas e riscos.", semantics: "analyst" },
  // Criação
  { type: "Writer", category: "Criação", color: violet, label: "Agente · Criação", desc: "Produz textos.", semantics: "generic" },
  { type: "Designer", category: "Criação", color: violet, label: "Agente · Criação", desc: "Cria conceitos visuais.", semantics: "generic" },
  { type: "Ideator", category: "Criação", color: violet, label: "Agente · Criação", desc: "Gera ideias.", semantics: "generic" },
  { type: "Storyteller", category: "Criação", color: violet, label: "Agente · Criação", desc: "Cria narrativas.", semantics: "generic" },
  // Execução
  { type: "Operator", category: "Execução", color: amber, label: "Agente · Execução", desc: "Opera sistemas externos.", semantics: "executor" },
  { type: "Automator", category: "Execução", color: amber, label: "Agente · Execução", desc: "Cria e executa automações.", semantics: "executor" },
  { type: "Deployer", category: "Execução", color: amber, label: "Agente · Execução", desc: "Publica aplicações.", semantics: "executor" },
  { type: "Integrator", category: "Execução", color: amber, label: "Agente · Execução", desc: "Conecta ferramentas e APIs.", semantics: "executor" },
  // Controle
  { type: "Supervisor", category: "Controle", color: crose, label: "Agente · Controle", desc: "Monitora outros agentes.", semantics: "generic" },
  { type: "Manager", category: "Controle", color: crose, label: "Agente · Controle", desc: "Gerencia equipes de agentes.", semantics: "generic" },
  { type: "Reviewer", category: "Controle", color: crose, label: "Agente · Controle", desc: "Revisa entregas.", semantics: "generic" },
  { type: "Validator", category: "Controle", color: crose, label: "Agente · Controle", desc: "Valida resultados.", semantics: "generic" },
  { type: "Governor", category: "Controle", color: crose, label: "Agente · Controle", desc: "Aplica regras e políticas.", semantics: "generic" },
  // Especialização
  { type: "Coder", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Escreve código.", semantics: "generic" },
  { type: "Debugger", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Encontra bugs.", semantics: "generic" },
  { type: "Tester", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Testa sistemas.", semantics: "generic" },
  { type: "Data Scientist", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Trabalha com dados.", semantics: "generic" },
  { type: "Security Analyst", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Analisa segurança.", semantics: "generic" },
  { type: "Marketing Specialist", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Marketing.", semantics: "generic" },
  { type: "Sales Agent", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Vendas.", semantics: "generic" },
  { type: "Legal Advisor", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Análise jurídica.", semantics: "generic" },
  { type: "Financial Analyst", category: "Especialização", color: cindigo, label: "Agente · Especialização", desc: "Finanças.", semantics: "generic" },
  // Comunicação
  { type: "Assistant", category: "Comunicação", color: cgrass, label: "Agente · Comunicação", desc: "Atendimento geral.", semantics: "generic" },
  { type: "Negotiator", category: "Comunicação", color: cgrass, label: "Agente · Comunicação", desc: "Negociações.", semantics: "generic" },
  { type: "Interviewer", category: "Comunicação", color: cgrass, label: "Agente · Comunicação", desc: "Conduz entrevistas.", semantics: "generic" },
  { type: "Teacher", category: "Comunicação", color: cgrass, label: "Agente · Comunicação", desc: "Ensina.", semantics: "generic" },
  { type: "Translator", category: "Comunicação", color: cgrass, label: "Agente · Comunicação", desc: "Traduz.", semantics: "generic" },
  { type: "Presenter", category: "Comunicação", color: cgrass, label: "Agente · Comunicação", desc: "Apresenta resultados.", semantics: "generic" },
  // Memória e Conhecimento
  { type: "Librarian", category: "Memória e Conhecimento", color: colive, label: "Agente · Memória e Conhecimento", desc: "Organiza conhecimento.", semantics: "generic" },
  { type: "Knowledge Manager", category: "Memória e Conhecimento", color: colive, label: "Agente · Memória e Conhecimento", desc: "Gerencia bases de conhecimento.", semantics: "generic" },
  { type: "Memory Keeper", category: "Memória e Conhecimento", color: colive, label: "Agente · Memória e Conhecimento", desc: "Mantém memória de longo prazo.", semantics: "generic" },
  { type: "Indexer", category: "Memória e Conhecimento", color: colive, label: "Agente · Memória e Conhecimento", desc: "Indexa documentos.", semantics: "generic" },
];

const BY_TYPE = new Map(NODE_TYPE_CATALOG.map((d) => [d.type, d]));
export function typeDef(type: NodeTypeName): NodeTypeDef {
  const d = BY_TYPE.get(type);
  if (!d) throw new Error(`Unknown node type: ${type}`);
  return d;
}
export function semanticsOf(type: NodeTypeName): NodeSemantics {
  return BY_TYPE.get(type)?.semantics ?? "generic";
}
