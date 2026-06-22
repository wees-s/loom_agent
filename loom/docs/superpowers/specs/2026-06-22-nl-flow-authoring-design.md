# Autoria em linguagem natural — geração de fluxo (slice C)

**Data:** 2026-06-22
**Status:** design aprovado para plano
**Slice:** C (autoria em linguagem natural) do roadmap "democratizar + humanizar o gerenciamento de loops"

---

## 1. Problema

Hoje criar um fluxo no Loom é montar o DAG nó a nó na UI: adicionar agentes, ligar arestas, escrever cada prompt, configurar trigger e feedback. Para "democratizar", o usuário deveria poder **descrever em linguagem natural** o que quer ("crie um loop que revisa PRs abertos e me manda um resumo") e receber um fluxo completo, editável, já montado.

## 2. Objetivo e não-objetivos

**Objetivo:** um gerador que, a partir de uma descrição em texto, produz um **fluxo completo** (nós com tipo/título/papel/prompt/model, arestas incluindo feedback, e um trigger), valida-o por zod, persiste pelo caminho existente (`spec.create` + `spec.save`) e o abre na UI.

**Critérios de sucesso:**
1. Em modo **fake** (default em dev/teste), `generate("...")` devolve um fluxo canônico determinístico, válido por `zGeneratedFlow`, persistido e visível na rail — custo zero.
2. `extractJsonFlow` recupera o JSON do fluxo da saída do `claude` (com ou sem cercas ```` ```json ````), e rejeita lixo sem lançar.
3. Um fluxo gerado inválido (schema) → erro claro no ack + `log`, sem criar fluxo quebrado.
4. Em modo **real**, a geração é uma única chamada `claude` bounded por `--max-turns` + timeout; nunca um loop.

**Não-objetivos (YAGNI v1):**
- Edição de fluxo existente por linguagem natural (slice futuro).
- Streaming de progresso da geração (ack ao concluir basta).
- Múltiplos candidatos / escolha entre variações.
- Geração de `workDir`, `linkedContexts` de terminal, ou budgets customizados — o gerado usa o `DEFAULT_BUDGET` e sandbox; o usuário ajusta depois.

## 3. Custo e segurança (este slice GASTA tokens)

Diferente dos slices A e B (projeções de custo zero), a geração **chama o `claude` de verdade**. Bounds:
- Uma única chamada one-shot, **`--max-turns` baixo** (default 1, env `LOOM_GENERATOR_MAX_TURNS`) + **timeout wall-clock** (default 90s, env `LOOM_GENERATOR_TIMEOUT_MS`).
- É **pré-fluxo**: não passa pelo guard (não há flowId ainda) e **não** conta no orçamento per-flow. O custo é o de uma resposta única, limitado pelos dois bounds acima. Documentado no README/ARCHITECTURE quando implementado.
- Modo **fake** não gasta nada. A seleção **herda `config.runnerMode`**: se `LOOM_RUNNER=fake`, o gerador também é fake (dry-runs coerentes). Sem env próprio em v1.

## 4. Arquitetura

```
UI: "✨ Gerar com IA" + textarea ──► store.generateFlow(prompt)  [generating=true]
        │  sendCommand
        ▼
bridge: case "flow.generate"
        │  await generator.generate(prompt)
        ▼
generator.ts  (fake | real)
   real: spawn claude -p "<SYSTEM + prompt>" --output-format json --max-turns N (timeout)
         → stdout → extractJsonFlow(text) → unknown
   fake: cannedFlow(prompt) → unknown
        │
        ▼  zGeneratedFlow.safeParse(unknown)
   valid?  ── no ──► ack(false, msg) + log(rose)
        │ yes
        ▼
   spec.create(name) → id ; spec.save({ id, name, nodes, edges, reviewEachCycle? })
        │  (reuses the VALIDATED path: acyclic + single-writer + ≥1 Trigger)
        ▼
   scheduler.armFlow(id) (dormant) ; broadcastAll(flow.snapshot) ; ack(true)
        ▼
   store folds flow.snapshot → flow appears in rail + auto-selected  [generating=false on ack]
```

Princípios respeitados: reusa o caminho de persistência validado (nunca cria spec inválida — `spec.save` já faz lint acíclico + single-writer + exige ≥1 Trigger); fake/real espelha o runner; o gerador é uma unidade pura na borda (parse+validate testável sem o CLI).

## 5. Contratos (`@loom/shared`)

- **Comando** (`protocol.ts` + `schemas.ts`): `{ t: "flow.generate"; cmdId: string; prompt: string }`, validado por `zClientCommand`.
- **Schema do gerado** (`schemas.ts`): `zGeneratedFlow` — o que o LLM DEVE emitir:
  ```
  {
    name: string,
    reviewEachCycle?: boolean,
    nodes: [{ id: string, type: <NodeTypeName>, title: string, role: string,
              prompt: string, model?: <ModelId>, produces?: string[],
              contextIsolation?: boolean, trigger?: <TriggerConfig>,
              position?: {x,y} }]  (≥1, ≥1 com type "Trigger"),
    edges: [{ from: string, to: string, feedback?: boolean }]
  }
  ```
  Validações: `type` ∈ catálogo; `model` ∈ catálogo (default sonnet se ausente/ inválido — coerção pós-parse, não falha); `from`/`to` referenciam ids de nós existentes (refine); pelo menos um Trigger (refine, espelha `zFlowSpec`).
- **Prompt de sistema** do gerador vive no engine (`generator.ts`), não no shared (é detalhe de runtime).

## 6. Engine

- **`generator.ts` (NOVO):**
  - `createGenerator(mode: "fake"|"real", emit): Generator` com `generate(prompt: string): Promise<{ ok: true; flow: GeneratedFlow } | { ok: false; error: string }>`.
  - `extractJsonFlow(raw: string): unknown | null` — pura: tira cercas markdown, acha o primeiro objeto `{...}` balanceado, `JSON.parse`; `null` se não achar/parsear. Exportada para teste.
  - real: spawn do `claude` modelado em `auth.ts` (mesmo bin, `--output-format json`, max-turns/timeout via `clampInt` de env); lê stdout; `extractJsonFlow`; coerção de model; valida `zGeneratedFlow`.
  - fake: `cannedFlow(prompt)` — um loop determinístico de 3 nós (Trigger → Analyst → Executor, com feedback) cujo título incorpora o prompt; válido por `zGeneratedFlow`.
- **`bridge.ts`:** `case "flow.generate"` → `await generator.generate` → em sucesso `spec.create` + `spec.save` + `scheduler.armFlow` + `broadcastAll(flow.snapshot)` + `ack(ok)`; em falha `ack(false, msg)` + `emit(log rose)`. Helper de mapeamento `generatedToEditable(gen, id)` (auto-grid de posições ausentes).
- **`main.ts`:** constrói o `generator` (mode = `config.runnerMode`) e injeta na bridge.
- **`config.ts`:** knobs `generatorMaxTurns`, `generatorTimeoutMs` (env, com defaults).

## 7. Web

- **`store.ts`:** estado `generating: boolean`; ação `generateFlow(prompt: string)` (envia `flow.generate`, seta `generating=true`); no `ack` (sucesso ou falha do cmd correspondente) → `generating=false` (e `lastError` em falha, como já faz). A flag é simples (não precisa casar cmdId em v1: qualquer ack/erro limpa).
- **UI:** um ponto de entrada **"✨ Gerar com IA"** — um campo de texto (na rail de fluxos, perto do "novo fluxo", ou um pequeno modal no overlay do canvas) com textarea + botão "Gerar". Enquanto `generating`, mostra estado de carregamento ("montando seu fluxo…"). Ao concluir, o `flow.snapshot` já cai no fold e auto-seleciona o novo fluxo (comportamento existente do store).

## 8. Erros e bordas

- `claude` indisponível / timeout (real) → `generate` retorna `{ok:false, error}` → ack false + log; nenhum fluxo criado.
- Saída sem JSON / JSON inválido → `extractJsonFlow` null → `{ok:false}`.
- Schema inválido (ex: zero Trigger, aresta apontando pra id inexistente) → `zGeneratedFlow` rejeita → `{ok:false}` com a mensagem do zod.
- Model fora do catálogo → coercido para o default (não falha).
- Posições ausentes → auto-grid determinístico (coluna por camada topológica simples, ou índice × offset).

## 9. Testes

1. **`@loom/shared`:** `zGeneratedFlow` aceita um payload válido; rejeita sem Trigger; rejeita aresta com `to` inexistente; `zClientCommand` aceita `flow.generate`.
2. **`@loom/engine` generator:** `extractJsonFlow` recupera JSON com e sem cercas e devolve null pra lixo; **fake** `generate` devolve um fluxo válido por `zGeneratedFlow` e determinístico; coerção de model inválido → default.
3. **`@loom/engine` bridge (opcional, leve):** `flow.generate` em modo fake cria o fluxo e faz broadcast de `flow.snapshot` (usando fakes de spec/scheduler do estilo já presente nos testes).
4. **`@loom/web` store:** `generateFlow` envia `flow.generate` com o prompt e seta `generating=true`; um `ack` limpa `generating`.

## 10. Fora de escopo / próximos slices

- Edição de fluxo existente por NL.
- Streaming de progresso / múltiplos candidatos.
- Restaurar métrica de custo (§7.1) — quando feito, a geração também poderia reportar seu custo.

## 11. Impacto na base

- Adições: 1 módulo no engine (`generator.ts`), 1 comando + 1 schema no shared, 1 handler na bridge, 1 wiring em main/config, 1 ação + 1 flag + 1 UI no web. Reusa `spec.create/save` (persistência validada) e o padrão fake/real do runner. Nada toca guard/orchestrator/eventlog.
