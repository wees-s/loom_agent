# Storyline — narração viva e legível da execução de um flow

**Data:** 2026-06-22
**Status:** design aprovado para plano
**Slice:** B (narração legível) do roadmap "democratizar + humanizar o gerenciamento de loops"
**Pré-requisito de visão:** divulgação progressiva — superfície humana, poder bruto embaixo

---

## 1. Problema

Hoje, observar um flow do Loom é técnico e cru. O usuário tem:

- a **LogStrip** (eventos coloridos: `cycle.started`, `budget.tripped`, …),
- o **TerminalPanel** (texto bruto do pane tmux, com ANSI),
- a aba **Execuções recentes** do Inspector (tokens / custo / tool calls / `resultSummary`).

Nada disso conta a **história** do que os agentes fizeram. Em modo terminal, o `resultSummary` é a *primeira linha* do tail do pane (`runner.ts:summarize`) — frequentemente ruído de ANSI/banner, não a conclusão do agente. Para "entender o que rola" e dar a sensação de algo vivo, falta uma **narrativa humana, cronológica e ao vivo**: *quem* fez *o quê*, com *qual* resultado, *quando*.

Este é o primeiro slice da visão maior (os outros — human-in-the-loop, autoria em linguagem natural, design system — viram specs próprios depois).

## 2. Objetivo e não-objetivos

**Objetivo:** uma **Storyline** — feed cronológico, agrupado por ciclo, em linguagem natural calma, que reconstrói a vida de um flow a partir do event log. É uma **projeção pura** (zero chamada de agente, zero custo de token, replay sem perda no reconnect), coerente com o princípio central da arquitetura ("a UI é uma projeção pura do log append-only").

**Critérios de sucesso:**
1. Ao rodar um flow (real ou fake), o usuário lê frases como *"Scribe analisou `daily-log.md` → escreveu `resumo.md` (2,3 kB) · há 4s"* sem precisar abrir o terminal.
2. Reconectar reconstrói a Storyline exatamente (mesma garantia `sinceSeq` do resto da UI).
3. `narrateEvent` tem testes unitários cobrindo todos os tipos de evento — fechando a lacuna de testes em `@loom/shared`.
4. O fold da Storyline tem teste no `store.ts` — fechando a lacuna de testes no front.

**Não-objetivos (YAGNI em v1):**
- Agente secundário de sumarização por IA (custo + complexidade — adiável).
- Persistência separada da narração (ela é derivada do log; nunca é fonte de verdade).
- Export / busca / filtros avançados (só agrupamento por ciclo em v1).
- Mudar o modelo de custo ou a métrica (isso é §7.1, fora deste slice).

## 3. Arquitetura

Fluxo de dados (tudo já existe exceto as 2 peças novas):

```
WebSocket /ws  ──►  store.applyServerMessage("event")
                         │  (fold ordenado por seq, já implementado)
                         ▼
                    foldEvent(state, ev, ts)        [store.ts — estendido]
                         │  para cada evento, chama:
                         ▼
                    narrateEvent(ev, lookupNode)    [@loom/shared/narration.ts — NOVO, puro]
                         │  → NarrationLine | null
                         ▼
                    state.storyline: NarrationLine[]  (buffer limitado, agrupado por ciclo)
                         │
                         ▼
                    <Storyline/>                    [web/components/Storyline.tsx — NOVO]
```

Princípios respeitados:
- **Projeção pura:** a Storyline não tem estado autoritativo; é derivada do log. Reconnect/replay reconstroem.
- **Unidades pequenas e testáveis:** `narrateEvent` é uma função pura sem dependência de React nem de store — testável isoladamente. O componente só renderiza.
- **Camadas não se misturam:** `narration.ts` vive em `@loom/shared` (conhecimento de domínio, como `semanticsOf`), consumido pelo front; não há lógica de negócio no componente.

## 4. Componentes (interfaces)

### 4.1 `@loom/shared/narration.ts` (NOVO, puro)

```ts
export interface NarrationLine {
  id: string;          // estável p/ React key: `${seq}` do StoredEvent
  cycle: number;       // p/ agrupar; -1 se o evento não tem ciclo
  at: number;          // epoch ms (p/ tempo relativo)
  kind: NarrationKind; // discrimina ícone/cor: "trigger"|"agent"|"artifact"|"cycle"|"budget"|"kill"|"system"
  actor?: string;      // título do nó/agente, quando houver ("Scribe")
  text: string;        // frase humana pronta ("analisou daily-log.md")
  tone: "neutral" | "good" | "warn" | "bad"; // p/ estética calma
  artifact?: { path: string; bytes?: number }; // chip opcional
}

export type NarrationKind =
  | "trigger" | "agent" | "artifact" | "cycle" | "budget" | "kill" | "system";

/** Mapeia 1 evento → 1 linha humana (ou null se não narrável). Puro. */
export function narrateEvent(
  ev: LoomEvent,
  seq: number,
  ts: number,
  lookupNode: (nodeId: NodeId) => { title: string; type: NodeTypeName } | undefined,
): NarrationLine | null;
```

Mapeamento por tipo de evento (resumo — a tabela completa vira tabela de teste):

| Evento | Narrativa | tone | kind |
|--------|-----------|------|------|
| `trigger.fired` | "{cause} disparou o fluxo" | neutral | trigger |
| `cycle.started` | "Ciclo {n} começou" | neutral | cycle |
| `node.activated` | "{actor} começou a trabalhar" | neutral | agent |
| `run.finished {ok, resultSummary}` | "{actor}: {resultSummary}" | good | agent |
| `run.finished {error/timeout/killed}` | "{actor} falhou: {error}" | bad/warn | agent |
| `blackboard.write` | "{actor} escreveu {path} ({bytes})" | good | artifact |
| `cycle.converged` | "Ciclo {n} convergiu (sem saída nova)" | neutral | cycle |
| `cycle.ended {stopped/killed}` | "Ciclo {n} parou: {status}" | warn/bad | cycle |
| `budget.tripped` | "Teto de {metric} atingido ({scope})" | warn | budget |
| `kill.requested` | "Fluxo interrompido ({by})" | bad | kill |
| `log` | a própria msg (cor → tone) | mapeado | system |
| `run.token` / `run.tool` / `run.output` / `node.deactivated` / `terminal.*` / `flow.*` / `auth.*` | `null` (não narrável — ruído ou já coberto) | — | — |

Eventos não mapeados retornam `null` (nunca quebra; novos tipos de evento só não aparecem até serem mapeados).

### 4.2 `store.ts` (ESTENDIDO)

- Novo campo de estado: `storyline: NarrationLine[]` (buffer limitado — ver §6).
- Dentro de `foldEvent`, após o `switch` atual, chamar `narrateEvent(ev, seq, ts, lookup)` e, se não-nulo, anexar à `storyline` (prepend ou append — ver §5). `lookup` resolve nó pelo flow selecionado em `flowsById`.
- `selectFlow` / `flow.removed`: limpar a `storyline` do flow anterior (mesma semântica de `activeNodeIds`).
- Selector `selectStoryline(s)` retornando o buffer (com sentinela estável p/ evitar o bug de referência nova documentado no `EMPTY_RUNS`).

### 4.3 `web/components/Storyline.tsx` (NOVO)

- Renderiza `selectStoryline` agrupado por `cycle` (cabeçalho "Ciclo N" como separador).
- Cada linha: ícone por `kind`, `actor` em destaque, `text`, chip de `artifact` se houver, tempo relativo ("há 4s") que atualiza.
- Cor sóbria por `tone` (good/warn/bad/neutral) — paleta calma, alinhada aos tokens de tema existentes (`theme/tokens.css`).
- Estado vazio amigável ("Nada rolando ainda — aperte ▶ para começar").
- Integração de layout: nova aba/painel ao lado do TerminalPanel (decisão de layout fica no plano; default: aba "Storyline" no mesmo dock do terminal).

### 4.4 `runner.ts` (BACKEND, pequeno)

Melhorar a captura do `resultSummary` em modo real: hoje `summarize()` pega a *primeira* linha não-vazia do tail do pane. Trocar por: a **última** região de texto significativa do agente (a conclusão), removendo ANSI, banners e prompts de shell. Isso dá conteúdo real para a linha `run.finished` da narração. Mudança localizada, testável, sem tocar guard/orchestrator.

## 5. Decisões de UX

- **Ordem:** mais recente no topo (como a LogStrip), mas agrupado por ciclo com o ciclo corrente no topo. (Alternativa cronológica crescente fica como ajuste fácil se preferir ao ver rodando.)
- **Tempo relativo** com re-render leve por intervalo (1 s) só enquanto o painel está visível.
- **Calma > densidade:** no máximo uma linha por evento; eventos de ruído viram `null`. Sem flood.

## 6. Erros, limites e performance

- `narrateEvent` nunca lança: entrada desconhecida → `null`; `nodeId` ausente → actor fallback ("um agente").
- **Buffer limitado:** manter no máximo os últimos `N` ciclos (default 20) **ou** `M` linhas (default 300), o que vier primeiro — descarte do mais antigo. Evita crescimento ilimitado em loops longos. Limite documentado (sem truncamento silencioso: um marcador "… ciclos anteriores ocultados" quando cortar).
- Fold continua O(1) por evento (append + corte amortizado), sem custo perceptível.

## 7. Testes

1. **`narration.test.ts` (`@loom/shared`):** uma asserção por tipo de evento (frase esperada + tone + kind), incluindo os que retornam `null`. Tabela-driven. — fecha lacuna de testes no shared.
2. **`store` storyline test (`@loom/web`):** dado uma sequência de `StoredEvent` (trigger → cycle → activated → write → finished → cycle.ended), o fold produz a Storyline esperada, na ordem certa, agrupada por ciclo; e `flow.removed`/`selectFlow` limpam. — fecha lacuna de testes no front.
3. **`runner` summarize test:** dado um tail de pane com ANSI + banner + conclusão, `summarize` retorna a conclusão limpa.

## 8. Fora de escopo / próximos slices

- **A — Human-in-the-loop:** pausa por aprovação + injeção de contexto (mexe no orchestrator/guard).
- **C — Autoria em linguagem natural:** meta-agente que gera o spec.
- **D — Design system / estética viva** completa (este slice já entrega um naco calmo, mas o sistema visual amplo é spec próprio).
- **§7.1 — restaurar métrica de custo:** quando feito, a narração ganha de graça linhas de custo/token por run.

## 9. Impacto na base existente

- Adições: 1 módulo em shared, 1 componente em web, 1 campo + lógica no store, 1 ajuste no runner.
- Sem mudança em contratos do event log (`events.ts`), no guard, no orchestrator, no scheduler ou no eventlog. Risco baixo, totalmente aditivo.
