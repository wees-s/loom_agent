# Revisor Master — Feedback

**Projeto:** Loom (`@loom/shared`, `@loom/engine`, `@loom/web`)
**Data:** 2026-06-22
**Categoria:** MVP / interno — com maturidade de git/CI ainda em nível de protótipo (1 autor, 1 commit, sem CI, não deployado)
**Stack principal:** TypeScript (strict) em monorepo pnpm · Node ≥22.23 + `node:sqlite` · React 18 + @xyflow/react + zustand (web) · zod (contratos) · tmux/WSL→Windows interop (runtime do agente)

---

## 1. Entendimento do projeto

Loom é um **control plane local** para orquestrar "loops agênticos" do Claude. Você monta visualmente um **grafo de agentes** (um DAG), onde cada nó é um agente com papel/prompt/modelo, e arestas ligam quem alimenta quem. Gatilhos (agendado, intervalo, webhook, manual) disparam **ciclos**: uma passada topológica sobre o grafo, com agentes rodando em paralelo por camada e realimentando o próprio fluxo via **feedback edges**. Tudo é observável ao vivo num canvas React.

A peça que define o projeto: cada nó-agente **não chama uma API** — ele abre uma **sessão `claude` real dentro de um pane tmux**, transmitida ao vivo para a UI. Isso aproveita o `claude` CLI já autenticado no Windows (via interop WSL→Windows), então não há API key para gerenciar nem novo login. O usuário literalmente vê o terminal que cada agente usou.

A arquitetura tem duas fontes de verdade que **nunca se misturam**: (1) um **event log append-only** em SQLite, que é a única verdade de runtime — a UI é uma projeção pura dele, então reconexão/replay são sem perda; e (2) as **specs YAML versionadas** (`flows/*.flow.yaml`), verdade de topologia e prompt. A comunicação engine↔web é um único WebSocket tipado com uniões validadas por zod na borda.

O ponto mais maduro do design é o **modelo de segurança de custo**: a ideia é que loops de custo descontrolado sejam "impossíveis por construção", funilados por um único `guard.ts`. Há quatro tetos (admissão pré-gasto por-fluxo, abort ao vivo por-run, `maxCyclesPerArm`, e convergência advisory) e um kill switch em várias frentes para lidar com a fronteira WSL→Windows.

**Pra quem:** uso interno/pessoal do autor — automações agênticas rodando da máquina WSL. Não é um produto multiusuário nem está exposto à internet (webhook é localhost, sem auth — documentado).

**O que não consegui verificar diretamente:** não consegui rodar os quality gates (`pnpm -r test/typecheck/build`). O ambiente desta sessão tem **Node 20.20.2** e **pnpm fora do PATH**, e `node_modules` não está instalado; o projeto exige Node ≥22.23. Então as afirmações de "todos os testes verdes" no README **não foram confirmadas por mim** — assumo de boa-fé, mas marco como não-verificado.

---

## 2. Estado atual / Andamento

- **Idade:** dias — primeiro (e único) commit em 2026-06-22, mesma data de hoje.
- **Atividade:** 1 commit (`first commit`), 1 autor (Wesley / techpumpmidia-ops). Working tree limpo, na `main`, sincronizado com `origin/main`.
- **Branch ativa:** `main` (sem branches de feature).
- **Features completas (pelo código lido):** event log + projeção; planner DAG com layering de Kahn e feedback-cut; barreira de presença de artefato; guard com admissão pré-gasto, leases, semáforo de concorrência, kill-registry e arming safe-by-default; scheduler (croner/webhook/manual) dormante no boot; runner terminal-native (real) + runner fake determinístico; blackboard com `safeRelPath`, escrita atômica, sha256 e single-writer lint; recuperação de órfãos no boot; bridge WS com ack + replay `sinceSeq`; SPA React com canvas portado 1:1, store zustand como projeção, inspector, terminais xterm.
- **Em andamento / lacunas inferidas:** sem `run.token` no modo real → **medição de custo ao vivo desligada** (ver §7.1); `streamParser` parece legado do modo headless antigo (ver §7.2); web sem suíte de testes além de 2 arquivos de interação/terminal; sem CI.
- **TODOs/FIXMEs/HACKs:** **zero** no código de produção (grep limpo). Incomum e positivo — as pendências estão documentadas em prosa no README/ARCHITECTURE, não espalhadas como dívida solta.
- **Código morto suspeito:** `streamParser.ts` (382 linhas) + `streamParser.test.ts` (329) — o parser NDJSON completo não é mais consumido pelo runner real (ver §7.2). O kill em 3 frentes por PID (`killPid`) é "legado, ainda disparado" por reconhecimento próprio, já que o modo terminal mata por `tmux kill-session`, não por PID.

---

## 3. Arquitetura & estrutura

Monorepo pnpm com 3 pacotes e dependência estritamente em camadas (`web → shared ← engine`):

```
@loom/shared   contratos puros, sem runtime
  ids (branded) · models (registry de preço) · catalog (44 tipos de nó)
  domain · events (LoomEvent) · protocol (ServerMessage|ClientCommand) · schemas (zod)
        ▲                                   ▲
        │ importa contratos                 │ importa contratos
@loom/engine                          @loom/web
  main → monta tudo                     App + componentes (Canvas/Inspector/…)
  eventlog (SQLite, fonte de verdade)   store (zustand) = PROJEÇÃO do event log
  guard (chokepoint de segurança)       wsClient (transporte WS, reconexão)
  orchestrator (DAG/Kahn/barreira)
  scheduler · runner · terminals
  blackboard · spec (YAML+zod) · auth
            └──── WebSocket /ws tipado ────┘
```

**Padrões usados, e bem:**
- **Event sourcing + CQRS-lite:** append-only log como verdade; UI e meters são folds. Bem isolado atrás de `eventlog.ts`.
- **Single chokepoint / capability:** spawn só via `guard.requestSpawn → SpawnLease`; o runner não consegue spawnar sem a lease. É um *capability pattern* — bom design de segurança.
- **Branded types** (`FlowId/NodeId/RunId/EdgeId`) em toda parte → erros de id viram erros de compilação.
- **Injeção de dependência por construtor** em todo o engine (`createGuard`, `createOrchestrator`, …) → testável, e os 7 arquivos de teste comprovam.
- **Quebra de ciclo de construção** guard↔terminals via `setTerminalDisposer` injetado no boot — detalhe que mostra cuidado.

**Inconsistências reais (não estéticas):** a principal é entre o que o **README** descreve (modo headless stream-json com métrica de custo) e o que o **código + ARCHITECTURE.md** realmente fazem (terminal-native, sem métrica). Ver §7.1 e §7.3.

---

## 4. Dados & schemas

- **Não há banco relacional/ORM.** A persistência é o event log em `node:sqlite` (uma tabela append-only de eventos com `seq` monotônico) + arquivos YAML versionados. Para o domínio do projeto, isso é a escolha **certa** — não force Postgres/Prisma aqui.
- **Contratos fortes:** `domain.ts` define `Flow/AgentNode/Edge/FlowBudget/Run/…` com tipos precisos; `schemas.ts` (zod) valida na borda do WS e no `spec.save`. `events.ts` é uma união discriminada limpa — a espinha dorsal do event sourcing.
- **Integridade de artefatos:** toda escrita no blackboard é atômica (temp→rename), com mutex por-path, `sha256` logado, e **lint de single-writer** (irmãos paralelos não podem compartilhar arquivo gravável). `safeRelPath` rejeita `..` e paths absolutos — proteção real contra traversal. Sólido.
- **Versionamento de spec:** `spec.save` valida (zod + aciclicidade), bumpa versão, faz snapshot em `data/spec_versions/` e arquiva deletados em `data/deleted/` (nunca hard-remove). Boa higiene.
- **Observação menor:** o `cycle` do `blackboard.write` é resolvido pelo `eventlog.cycleCounter(flowId)` no momento do fold (o evento não carrega o ciclo). Funciona, mas acopla o fold de convergência ao contador projetado — frágil se a ordem de eventos mudar. Baixo impacto hoje.

---

## 5. Qualidade

| Dimensão | Status | Nota |
|----------|--------|------|
| Testes | ⚠️ | 7 arquivos, ~2.8k linhas de teste no engine (guard.test.ts sozinho tem 1.587 — cobre o caminho crítico de custo a fundo). Shared tem contracts.test. **Web quase sem testes** (só App.interaction + TerminalPanel). README cita 16+77 verdes — **não verifiquei** (Node 20 no ambiente, gates não rodaram). |
| Docs | ✅ | Excepcional para o tamanho. `ARCHITECTURE.md` é honesto sobre os próprios trade-offs e caveats. README detalhado. Comentários explicam o *porquê*, não o *o quê*. |
| Linter/format | ✅ | ESLint 9 + typescript-eslint + Prettier configurados; scripts `lint`/`format` presentes. |
| Tipagem | ✅ | `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`. Branded ids. Tipagem séria. |
| Tratamento de erro | ✅ | Degradação graciosa consistente (terminais que falham na fronteira WSL nunca abortam um run; folds que falham no boot não travam o guard). `try/catch` com intenção clara, não engolido por preguiça. |
| Logging | ⚠️ | Eventos `log {color}` para a UI são bons como telemetria de runtime, mas não há logging estruturado server-side persistente fora do event log. Para um control plane local, aceitável. |
| Segurança | ⚠️ | Sem segredos hardcoded (grep limpo — aproveita o `claude` já autenticado). `safeRelPath` protege o FS. **Webhook sem auth** (documentado, localhost). O risco real não é vazamento — é **custo** (ver §7.1). |

---

## 6. Pontos fortes

Lista honesta — este é um projeto acima da média:

1. **Documentação de verdade.** `ARCHITECTURE.md` explica os 8 problemas difíceis e **admite as próprias fraquezas** (kill cruzando WSL→Windows não é garantido; convergência é advisory). Cultura de engenharia honesta — raro.
2. **Event sourcing feito direito.** Append-only + projeção pura + replay `sinceSeq` = reconexão sem perda de graça. A UI não tem estado autoritativo próprio.
3. **Segurança como capability pattern.** O runner *não consegue* spawnar sem lease do guard. Isso é design, não convenção (com o caveat do §7.1).
4. **Safe-by-default.** Boot inerte: fluxos carregam dormentes, nada arma/gasta até um play explícito. Restart nunca auto-roda nada.
5. **Cobertura pesada no ponto crítico.** O guard — onde um bug custa dinheiro real — tem 1.587 linhas de teste.
6. **Disciplina de tipos.** `strict` + `noUncheckedIndexedAccess` + branded ids elimina classes inteiras de bug.
7. **Zero dívida solta.** Nenhum TODO/FIXME/HACK no código de produção.

---

## 7. Riscos / problemas reais

Ordenados por impacto. Formato: **o quê** | **por que importa aqui** | **esforço**.

### 7.1 — O teto de custo "por-fluxo" está efetivamente INERTE no modo real (terminal) · **ALTO** · esforço **M**

Este é o achado mais importante, e é sobre dinheiro.

- **O quê:** no modo `real` (terminal-native, o modo de produção), o `RealRunner` **nunca emite `run.token`** e fecha cada run com `costUsd: 0` e `usage: emptyUsage()` (`runner.ts:286-296`). Logo `guard.meterToken()` **nunca é chamado** no caminho real — só o `FakeRunner` o chama. Consequências em cadeia:
  - O **abort ao vivo por-run (teto #2)** está morto no modo real — não há medidor para cruzar o cap.
  - `releaseLease` comita `finalSpend.usdSpent = 0`, então `committedUsd` do fluxo **nunca cresce**. O `foldFlowSpend` no boot também só soma custos de runs terminados — que são 0.
  - Na admissão por-fluxo, o cheque vira `0 (committed) + reservas-em-voo + worstCase ≤ cap`. Como o committed nunca acumula, **o cap por-fluxo só limita os runs concorrentes em voo, nunca o gasto acumulado ao longo de ciclos**.
- **Por que importa aqui:** a afirmação central do README ("o cap por-fluxo só pode ser excedido pelo erro de estimativa de um run em voo, nunca por um loop" + "sobrevive a reinícios") **não vale no modo real**. O gasto vitalício real de um loop de feedback é limitado por `maxCyclesPerArm × maxConcurrentAgents × custo-por-run(--max-turns)` + timeout wall-clock — **não** pelo `maxUsdPerFlow`. Para um loop longo, o teto de USD que você configura por fluxo simplesmente não dispara. O `ARCHITECTURE.md` (decisão #1) **reconhece isso honestamente** ("perde a medição de token/custo ao vivo… confie nos HARD bounds: admissão + --max-turns + timeout"), mas o README ainda vende o cap por-fluxo como ativo.
- **Como mitigar (qualquer um destes):**
  1. **Restaurar a métrica** rodando o `claude` com um sidecar `--output-format stream-json` em paralelo ao pane legível (ou parsear o `cost`/usage do final da sessão) e chamar `meterToken`. Isso ressuscita os tetos #1 e #2 e reaproveita o `streamParser` (§7.2). Esforço M.
  2. Se aceitar não ter métrica: **dimensionar os HARD bounds como o teto de fato** — ou seja, escolher `maxCyclesPerArm`, `maxConcurrentAgents` e `--max-turns` sabendo que **são eles** que limitam o custo, e **alinhar o README/UI** para não prometer um cap de USD que não morde. Esforço S (config + docs).

### 7.2 — `streamParser` (≈700 linhas com teste) é código morto no caminho real · **MÉDIO** · esforço **S**

- **O quê:** `streamParser.ts` (382) + `streamParser.test.ts` (329) implementam o parser NDJSON do stream-json. O `RealRunner` usa saída texto default e **não parseia stream**; só importa `emptyUsage`/`costFromUsage` do módulo. O `auth.ts` tem seu *próprio* leitor inline de stream-json (por desacoplamento, declarado). Então o parser completo é legado do modo headless antigo.
- **Por que importa aqui:** ~700 linhas mantidas que confundem quem lê ("então tem métrica de token?") e mascaram o §7.1. É dívida de remoção, não de funcionalidade.
- **Como mitigar:** ou **deletar** (mover helpers `emptyUsage/costFromUsage` para um util pequeno), ou **reaproveitar** como a peça que reimplementa a métrica (§7.1, opção 1). Decidir um dos dois.

### 7.3 — README contradiz o código e o ARCHITECTURE.md · **MÉDIO** · esforço **S**

- **O quê:** o README (linhas 11-14) diz que os agentes rodam `--output-format stream-json` e que "real token usage e costUsd fluem de volta… projetados no canvas em tempo real". O runner real faz o oposto (texto default, custo zero). O `ARCHITECTURE.md` decisão #1 já diz que o modo headless stream-json foi **substituído**.
- **Por que importa aqui:** os dois documentos canônicos discordam. Um leitor (ou você daqui a 3 meses) que confiar no README vai acreditar que a métrica funciona — e tomar decisões de custo erradas.
- **Como mitigar:** reescrever a intro e a §"Safety model" do README para refletir o modo terminal-native e o caveat do §7.1. Fonte única de verdade.

### 7.4 — Itens LOW já documentados pelo autor · **BAIXO** · esforço **S cada**

Reconheço que já estão listados — registro para completude:
- **Webhook sem auth** (`/webhook/:flowId/:event`). Mitigado em custo pelo guard, mas qualquer um na rede local dispara. Token/HMAC antes de sair do localhost.
- **`flow.play` após kill por budget** pode negar o próximo run imediatamente (medidor perto do cap reidratado). UI deveria avisar.
- **`RunCtx.lease` confiado por convenção** (brand phantom, não forçado por tipo). Aceitável in-process.

### 7.5 — Ambiente desta sessão não roda o projeto · **BAIXO (operacional)** · esforço **S**

- **O quê:** Node 20.20.2 nesta sessão WSL, mas `engines` exige ≥22.23; pnpm fora do PATH; sem `node_modules`. Não consegui validar `typecheck/test/build`.
- **Por que importa:** "verde no meu README" ≠ "verde em qualquer checkout". Sem CI, isso só é pego manualmente.
- **Como mitigar:** ver §8 curto prazo (CI mínimo + nota de setup do Node 22 via nvm/`.nvmrc` já existe com `22`).

---

## 8. Melhorias sugeridas (calibradas)

### Curto prazo (faria essa semana)
- **Decidir o destino da métrica de custo (§7.1).** É a decisão #1. Ou reativa o `meterToken` no modo real (sidecar stream-json), ou assume os HARD bounds como teto oficial e ajusta config + docs. Não deixe a ambiguidade — é a única coisa aqui que custa dinheiro de verdade.
- **Sincronizar README ↔ código (§7.3).** 1-2 horas. Fonte única de verdade sobre como o runner funciona e o que limita custo.
- **CI mínimo (§7.5).** Um workflow GitHub Actions: `node 22 → pnpm install → pnpm -r typecheck && pnpm -r test`. Pega regressão antes do merge. Esforço S.

### Médio prazo (próximo mês)
- **Resolver o `streamParser` (§7.2):** deletar ou reaproveitar.
- **Alguns testes de web no caminho crítico:** o fold do `store.ts` (projeção do event log) é a peça mais lógica do frontend e hoje está praticamente sem teste. 3-4 testes de `foldEvent` cobrindo `flow.removed` (limpeza de seleção), `run.finished` e ordenação por `seq` já valem muito. Esforço S-M.
- **UI: aviso de "perto do teto"** (§7.4) quando o fluxo retoma com medidor reidratado próximo do cap.

### Longo prazo / quando crescer
- **Auth no webhook** — só quando/se sair do localhost.
- **Reaper que correlaciona `claude.exe` por nome/cwd** — só se órfãos cruzando WSL→Windows virarem dor real e recorrente. Hoje os HARD bounds cobrem.

**Explicitamente NÃO recomendado agora:**
- **Não** troque `node:sqlite` por Postgres/ORM — o event log append-only é a escolha certa para o domínio; banco relacional seria over-engineering.
- **Não** quebre o monorepo em serviços/microsserviços — é um control plane local de 1 usuário; in-process é a arquitetura correta.
- **Não** force tipar a brand da lease (§7.4) — o custo de eliminar a brand phantom não compensa numa superfície in-process.
- **Não** persiga 100% de cobertura na web nem testes E2E de browser agora — o ROI está nos testes do `store.ts`, não em Playwright.

---

## 9. Escalabilidade

O eixo de "escala" aqui **não é tráfego de usuários** (é 1 usuário, local) — é **custo de tokens e número de ciclos/agentes por fluxo**. Análise honesta no nível atual e no próximo patamar:

- **Hoje:** funciona para fluxos com dezenas de nós e poucos ciclos. O semáforo `maxConcurrentAgents` limita o fan-out por camada; o event log SQLite aguenta tranquilamente o volume de eventos de um uso pessoal.
- **Gargalo real ao crescer (10×):** **custo**, não throughput. Se você criar um loop de feedback agressivo (alto `maxCyclesPerArm` + concorrência), o §7.1 significa que o gasto pode subir além do que o `maxUsdPerFlow` sugere proteger. **Esse é o gargalo de escala que importa** — resolva o §7.1 antes de rodar loops longos sem supervisão.
- **Segundo gargalo (menor):** o event log cresce append-only sem compactação/snapshot. Para uso pessoal, irrelevante por anos. Se um dia o replay `sinceSeq` ficar lento no boot, aí sim pensar em snapshots periódicos — não antes.
- **Não é gargalo:** WS, projeção da UI, parsing de YAML, blackboard. Tudo dimensionado de sobra para 1 usuário.

Não há cenário de "1000×" relevante aqui — é uma ferramenta local. Otimizar para isso seria desperdício.

---

## 10. Próximo passo recomendado

**Resolver o §7.1 — o teto de custo por-fluxo no modo real.** Concretamente: decida agora se vai (a) reativar `meterToken` parseando o custo/usage da sessão `claude` real (reusando o `streamParser`), ou (b) tratar `maxCyclesPerArm` + `--max-turns` + timeout como o teto oficial e reescrever README/UI para parar de prometer um cap de USD que não dispara. É a única pendência do projeto que, ignorada, pode custar dinheiro de verdade num loop noturno — e tudo o mais (limpar `streamParser`, sincronizar docs) decorre dessa decisão.
