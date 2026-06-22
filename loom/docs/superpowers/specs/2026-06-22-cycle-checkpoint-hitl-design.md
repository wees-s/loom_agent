# Checkpoint entre ciclos — Human-in-the-loop v1

**Data:** 2026-06-22
**Status:** design aprovado para plano
**Slice:** A (human-in-the-loop) do roadmap "democratizar + humanizar o gerenciamento de loops"
**Depende de:** Storyline (slice B) — é a superfície de revisão natural deste checkpoint

---

## 1. Problema

Hoje um loop do Loom é fire-and-forget: você aperta ▶ e os ciclos realimentam sozinhos até convergir, bater `maxCyclesPerArm` ou um teto. Não há ponto onde o humano dirige. Para "humanizar o gerenciamento desses loopings", o usuário precisa poder **revisar e aprovar** a continuação de um loop — ver o que o ciclo produziu (na Storyline) e decidir *continuar* ou *parar* antes de gastar o próximo ciclo.

## 2. Objetivo e não-objetivos

**Objetivo:** um **checkpoint opcional entre ciclos**. Num fluxo com feedback edges e modo "revisar cada ciclo" ligado, ao fim de cada ciclo o loop entra em estado **`aguardando`** e espera um comando explícito `flow.continue` (ou `pause`/`kill`) antes de realimentar. Em modo automático (default), o comportamento atual é preservado byte a byte.

**Critérios de sucesso:**
1. Com `reviewEachCycle = true`, após o ciclo N de um loop, o fluxo fica `aguardando`; nenhum spawn do ciclo N+1 acontece até `flow.continue`.
2. `flow.continue` retoma exatamente o arm já admitido pelo guard (sem re-rodar a admissão → sem dupla contagem de convergência).
3. `flow.pause` / `flow.kill` durante `aguardando` cancelam a continuação pendente com segurança.
4. Em modo automático (`reviewEachCycle` ausente/false), todos os testes atuais do orchestrator/guard continuam passando inalterados.
5. A UI mostra um banner de aprovação claro no topo da Storyline e um toggle "revisar cada ciclo".

**Não-objetivos (YAGNI v1):**
- Injeção de contexto/orientação no próximo ciclo (slice futuro "checkpoint + injeção").
- Nó de aprovação no meio do DAG (slice futuro).
- Pausa no meio de um ciclo (entre camadas) — o checkpoint é só na **fronteira de ciclo**.
- Timeout de espera — o fluxo aguarda indefinidamente; isso é **seguro** (nada arma/gasta enquanto aguarda).
- Aprovação para fluxos **sem feedback edges** — sem re-arm não há o que revisar (documentado).

## 3. Princípio de segurança

O checkpoint **só pode reduzir autonomia**. O guard (`requestNextCycle`) continua sendo o único portão que admite o próximo arm; o checkpoint apenas **adia a recursão** do orchestrator até o usuário aprovar. Em `reviewEachCycle`, um loop **nunca** gasta o próximo ciclo sem um `flow.continue` explícito. Não há caminho onde o checkpoint permita um gasto que o modo automático já não permitisse.

## 4. Arquitetura

Ponto de inserção: o bloco de feedback re-arm em `orchestrator.startCycle` (hoje `orchestrator.ts:577-634`).

```
startCycle(flow, cause, arm)
  … roda as camadas (inalterado) …
  feedback edges?
    └─ next = guard.requestNextCycle(...)        ← INALTERADO (admissão + convergência)
         ok?
          ├─ emit edge.fired + cycle.ended(done)  ← INALTERADO
          ├─ reviewEachCycle?
          │     ├─ SIM → emit cycle.awaitingApproval{nextArm}; flow.stateChanged "aguardando";
          │     │         pendingApprovals.set(flowId, {arm: next.arm, cause}); awaiting.add(flowId);
          │     │         return { status: "awaiting", cycle }                 ← NÃO recorre
          │     └─ NÃO → return await startCycle(flow, "feedback", next.arm)    ← comportamento atual
          └─ denied → converged / stopped (INALTERADO)

continueFlow(flowId)            ← NOVO (chamado pelo handler flow.continue)
  pending = pendingApprovals.get(flowId); if (!pending) return null
  pendingApprovals.delete(flowId); awaiting.delete(flowId)
  return startCycle(spec.get(flowId), "feedback", pending.arm)   ← retoma o arm já admitido
```

Estado novo no orchestrator (closures): `pendingApprovals: Map<string,{arm:number}>` e `awaiting: Set<string>`. `flow.pause`/`flow.kill` limpam ambos para o fluxo.

**Scheduler:** antes de disparar um trigger, hoje pula se `orchestrator.isRunning(flowId)`. Passa a pular também se `orchestrator.isAwaiting(flowId)` — um fluxo aguardando aprovação não recebe um disparo novo por cima.

## 5. Contratos (`@loom/shared`)

- **Evento** (`events.ts`): `| { type: "cycle.awaitingApproval"; flowId: FlowId; cycle: number; nextArm: number; at: number }`.
- **Estado** (`domain.ts`): `FlowState` ganha `"aguardando"`. (Conferir usos exaustivos: store fold, LeftRail label, composeSchedule — nenhum faz switch exaustivo que quebre, mas o label do rail recebe um caso novo.)
- **Comando** (`protocol.ts` + `schemas.ts`): `| { t: "flow.continue"; cmdId: string; flowId: FlowId }`, com entrada validada por zod (`zClientCommand`).
- **Spec** (`domain.ts` `Flow` + `schemas.ts` `zFlowSpec` + `EditableFlow`): campo opcional `reviewEachCycle?: boolean`. Default ausente = automático.
- **Narração** (`narration.ts`): `cycle.awaitingApproval` → linha `kind:"cycle"`, `tone:"warn"`, texto `"Ciclo N concluído — aguardando sua aprovação"`. `flow.stateChanged` continua retornando `null`.

## 6. Engine

- **`orchestrator.ts`:** registro de pendências + `continueFlow(flowId)` + `isAwaiting(flowId)`; ramo `reviewEachCycle` no re-arm; ler `reviewEachCycle` do flow (já vem no spec hot-reloaded via `spec.get`).
- **`bridge.ts`:** handler do comando `flow.continue` → `orchestrator.continueFlow(flowId)`; ack. `flow.pause`/`flow.kill` chamam um `orchestrator.clearAwaiting(flowId)` (ou reusam continue-cancel) além do que já fazem.
- **`spec.ts`:** serializa/desserializa `reviewEachCycle` no YAML (preservando comentários, como os demais campos); inclui no `DEFAULT`/round-trip.
- **`scheduler.ts`:** checagem `isAwaiting` no gate de disparo.
- **`orchestrator.recoverOrphans`:** ao dobrar o log no boot, normaliza fluxos projetados como `aguardando` → `ocioso` (a pendência in-memory se perdeu).

## 7. Web

- **`store.ts`:** ação `continue()` (emite `flow.continue`); projeção de `flow.stateChanged "aguardando"` (já cai no fold genérico de stateChanged — `running` vira false quando estado ≠ "rodando"); seletor/flag derivado `selectAwaiting(flow)` = `flow.state === "aguardando"`; toggle `setReviewEachCycle(on)` (optimista + `spec.save`, espelhando `setWorkDir`).
- **Banner de aprovação:** no topo da Storyline (ou logo acima dela), visível só quando `aguardando`: texto "Ciclo N concluído — aprove para continuar" + botões **Continuar ▶** / **Parar ■**. Reusa a Storyline como contexto de revisão.
- **Toggle "revisar cada ciclo":** no Inspector do fluxo (ou TopBar) — checkbox que chama `setReviewEachCycle`.

## 8. Erros e bordas

- `flow.continue` sem pendência → ack `{ok:false, error:"nada aguardando"}` (não quebra).
- `reviewEachCycle` ligado em fluxo **sem** feedback edges → nunca entra em `aguardando` (não há re-arm); documentado.
- Boot/recuperação de órfãos: a continuação pendente é in-memory e se perde num restart. Para o botão "Continuar" nunca ficar morto, `recoverOrphans` **normaliza** qualquer fluxo projetado como `aguardando` de volta para `ocioso` no boot (emite `flow.stateChanged "ocioso"`). Safe-by-default: nada retoma sozinho; o usuário dá play de novo se quiser. (Espelha "sem backfill de disparos perdidos".)
- `pause`/`kill` enquanto aguardando: limpam pendência + `awaiting`; estado vai pra `pausado`/`ocioso`.

## 9. Testes

1. **`@loom/shared`:** `narrateEvent(cycle.awaitingApproval)` → linha esperada; `zClientCommand` aceita `flow.continue` e rejeita malformado; `zFlowSpec` aceita `reviewEachCycle`.
2. **`@loom/engine` orchestrator:** com runner fake + `reviewEachCycle:true` num flow com feedback edge → após o 1º ciclo, status `awaiting`, **nenhum** run do próximo arm aconteceu, evento `cycle.awaitingApproval` emitido, estado `aguardando`. Depois `continueFlow` → o próximo arm roda. Com `reviewEachCycle:false` → comportamento atual (re-arma sozinho) — guard de não-regressão.
3. **`@loom/engine` orchestrator:** `pause`/`kill` durante awaiting limpa a pendência (continue depois é no-op).
4. **`@loom/web` store:** `continue()` emite o comando certo; fold de `stateChanged "aguardando"` deixa `running=false`; `setReviewEachCycle` faz spec.save com a flag.

## 10. Fora de escopo / próximos slices

- **Checkpoint + injeção de orientação** (campo de nota no banner que entra no prompt do próximo ciclo).
- **Nó de aprovação no DAG** (granularidade fina, pausa entre camadas).
- **Persistência da pendência** no event log (sobreviver a restart) — hoje in-memory por segurança.

## 11. Impacto na base

- Toca o orchestrator (ramo aditivo no re-arm + 3 métodos), a bridge (1 handler), o scheduler (1 checagem), o spec (1 campo round-trip), e contratos do shared (1 evento, 1 estado, 1 comando, 1 campo). Tudo aditivo; o caminho automático é preservado e coberto por testes de não-regressão. Sem mudança na lógica de admissão/custo do guard.
