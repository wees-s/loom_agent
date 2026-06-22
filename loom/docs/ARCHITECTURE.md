# Loom — Arquitetura

Loom é um **control plane local** para orquestrar loops agênticos do Claude: criar/editar/observar/controlar fluxos de agentes que rodam em gatilhos, se ramificam, analisam, decidem, executam e realimentam — visualmente.

- **Entrega:** app **web local**. Engine Node + frontend React (Vite), ambos rodando do WSL, vistos no browser do Windows. (Sem Rust → sem Tauri.)
- **Linguagem:** TypeScript em tudo. Monorepo pnpm (`@loom/shared`, `@loom/engine`, `@loom/web`).
- **Alvo visual:** `Loom.dc.html` é a referência **definitiva** (porte 1:1).

## Princípio central

> **O event log (append-only) é a única fonte de verdade de runtime. A UI é uma projeção pura.** Replay e reconexão sem perda saem de graça. A **spec YAML** versionável é a fonte de verdade de topologia/prompt. **Nunca misture as duas camadas.**

## Layout do monorepo

```
loom/
  packages/
    shared/   # contratos: ids, models, catalog (44 tipos), domain, events, protocol, schemas (zod)
    engine/   # scheduler, runner, streamParser, guard, orchestrator, eventlog, blackboard, spec, auth, bridge(ws), main
    web/      # React + @xyflow/react (mecânica) + zustand; porte 1:1 do mockup
  flows/      # *.flow.yaml — specs versionáveis (daily-standup, content-review, inbox-triage, research-digest)
  blackboard/ # contextos compartilhados por fluxo (cwd dos agentes)
  data/       # event log node:sqlite
  scripts/    # seed.ts, dev.sh
  docs/       # este arquivo
```

## Decisões dos 8 problemas difíceis

### 1. Runner — como o engine executa cada nó-agente (TERMINAL-NATIVE 🖥️)
- **Loom é terminal-nativo:** um run-agente é uma sessão **`claude` REAL rodando dentro de um pane tmux**, transmitida AO VIVO. O modelo headless antigo (`claude -p --output-format stream-json`, invisível, sintetizado num event log) foi **substituído** — ele parecia "imaginário". Agora o usuário **vê o terminal** que cada agente usou.
- **Um terminal por (flowId,nodeId)** — id `term://<flow>.<node>`. O `RealRunner` chama `terminals.runInPane()`, que digita no pane (via `tmux send-keys`, **argv array — nunca string de shell**):
  ```
  claude -p "<prompt>" --model <m> --add-dir <winDir> --permission-mode acceptEdits --max-turns N
  ```
  com `cwd` = o blackboard do fluxo. Saída em **formato texto default** (legível no terminal — **NÃO** stream-json, que é feio num pane).
- **Streaming ao vivo:** `tmux pipe-pane -o "cat >> FIFO"` → um `fs.ReadStream` drena o FIFO incrementalmente → `terminals.onData` → a bridge emite `terminal.data {terminal, chunk}`. Um buffer de replay limitado (64 KB) alimenta um `terminal.open` tardio.
- **Conclusão + exit code:** a linha do pane termina com `; tmux wait-for -S <chan único>` (o runner bloqueia em `tmux wait-for <chan>`) e grava `$?` num env var de sessão recuperado via `show-environment`. Status do run = exit code (+ abort/timeout). Artefatos vêm de `produces[]` (alimenta a barreira).
- `auth.ts` faz **pre-flight no boot**: recusa iniciar ciclos até um health check `claude -p` passar.
- **TRADE-OFF honesto ⚠️:** saída texto default **perde a medição de token/custo ao vivo** (que só o stream-json dava). Em modo terminal o run reporta **custo coarse/zero** — os tetos de custo passam a ser **inteiramente** os HARD bounds: **admissão pré-gasto do guard** + **`--max-turns` (BELT)** + **timeout wall-clock por-run (SUSPENDERS)**. Não há mais abort por-run cravado num medidor de token ao vivo; confie nos três bounds acima.
- **Modo FAKE** (`LOOM_RUNNER=fake`): não chama claude nem toca tmux — escreve artefatos `produces[]` canônicos e emite `run.token`/`run.finished` sintéticos. Habilita dry-runs de custo zero + testes determinísticos.

### 2. Orquestração — execução do grafo
- **Um ciclo = uma passada topológica** sobre o DAG com **feedback edges CORTADAS** (acíclico por construção). Camadas de **Kahn** → fan-out dentro de um nível (3 analysts em paralelo).
- **JOIN = barreira de PRESENÇA de artefato:** upstream `run.ok` **E** todo artefato esperado (`produces[]`) existe com hash logado. Nó que não escreveu nada **falha a barreira**.
- **Isolamento do Synthesizer é ESTRUTURAL:** processo separado, filesystem escopado só aos artefatos, **não vê transcript dos pares** (`contextIsolation`). É o "sem viés" de verdade.
- Feedback edge chama `guard.requestNextCycle`, **nunca** re-invoca direto.
- **Recuperação de órfãos no boot:** dobra o log, marca runs inacabados como killed, re-planeja a partir da última barreira (idempotente em `flowId,cycle,nodeId`).

### 3. Segurança — loops descontrolados impossíveis por construção
- **Um único ponto de estrangulamento:** `guard.ts`. Invariante: ciclos só começam via `guard.requestNextCycle`; spawns só via `guard.requestSpawn → SpawnLease` (construtor do runner é privado).
- **Tetos HARD (os que de fato impedem custo descontrolado):**
  1. **Admissão PRÉ-GASTO por-fluxo (HARD):** `committedUsd + reservasEmVoo + worstCaseRunCost(model) <= caps` antes de qualquer spawn (worstCase = `maxOutput×outputPrice + inputOrçado`) → o cap **por-fluxo** (USD **e** tokens) só pode ser excedido pelo erro de estimativa de **um** run em voo, nunca por um loop. **`committedUsd/committedTokens` é REIDRATADO do event log no boot** (`eventlog.foldFlowSpend()` dobra o custo final de cada run terminado), então o teto por-fluxo **sobrevive a reinícios do engine** — um restart NÃO zera o gasto vitalício.
  2. **Abort por-run ao vivo (HARD):** `AbortController` cravado no medidor de tokens (`meterToken`) aborta o run no instante em que ele cruza o próprio cap; e se o **fluxo inteiro** cruzar um cap ao vivo, `killFlow`.
  3. **`maxCyclesPerArm` (HARD):** limite de re-armas de feedback dentro de um disparo. Junto com (1), são os dois tetos que de fato garantem terminação + custo finito.
- **Sinal ADVISORY (não é teto independente):**
  4. **Convergência por janela** sobre repetição de hash de artefato (`convergenceWindow`). É **ADVISORY**: para loops bem-comportados cedo, mas pode ser **derrotada por conteúdo não-determinístico** (um hash novo a cada ciclo). O contador de ciclos estéreis (`cyclesWithoutNewHash`) é assentado em **exatamente um lugar** (`requestNextCycle`, o portão de feedback) — `foldArtifactHash` só observa hashes, nunca incrementa (corrige o off-by-one de duplo-assentamento). **Nunca confie na convergência como única barreira**; ela é redundante a (1) e (3).
- **Kill switch (belt-and-suspenders — kill perfeito cruzando WSL→Windows é difícil):** o engine roda em WSL/Linux mas o filho é a `claude.exe` **Windows** autenticada lançada via interop, então usamos VÁRIOS mecanismos, **incondicionalmente** (nunca mais com `process.platform==="win32"` como guarda — isso era dead-code no engine WSL):
  1. **BELT:** o runner passa `--max-turns` no argv → qualquer órfão **se auto-termina** após N turnos mesmo se o kill falhar.
  2. **SUSPENDERS:** **timeout wall-clock por-run** no runner → interrompe o pane (Ctrl-C) e emite `run.finished {status:"timeout"}` se o run não terminar na janela.
  3. **Kill do terminal (alvo real no modo terminal):** `killFlow` aborta o `signal` de cada run (→ `runInPane` manda **Ctrl-C** ao pane) e então `terminals.disposeFlow(flowId)` faz **`tmux kill-session`** de todos os panes do fluxo. O guard registra cada terminal de run (`registerTerminal`) e o `setTerminalDisposer` injeta o `disposeFlow` no boot (evita ciclo de construção guard↔terminals). `flow.kill`/`flow.delete`/`stop` passam todos por esse caminho.
  4. **Kill em 3 frentes** (legado, ainda disparado para qualquer pid registrado): `tree-kill(SIGKILL)` + `kill(-pgid)` POSIX + `taskkill.exe /T /F` (reapa a `claude.exe` Win32 via interop), com **verificação pós-kill** `process.kill(pid,0)` → `log {color:"rose"}` (`kill.failed`) se sobreviver.
- **Caveat residual honesto:** kill cruzando a fronteira WSL→Windows **não é garantido** — o pid registrado é o lançador WSL, não necessariamente a `claude.exe` Win32 interop. Se o taskkill não a alcançar, ela vira órfã; o **gasto fica limitado por `--max-turns` + o timeout wall-clock**, e o `kill.failed` avisa. Não há (ainda) um reaper que correlacione a `claude.exe` real por nome/cwd.

#### Problemas conhecidos (LOW — documentados, não corrigidos agora)
- **Webhook sem auth:** `/webhook/:flowId/:event` não autentica. Amplificação de custo é **limitada pelo guard** (caps por-fluxo + `maxCyclesPerArm`), mas qualquer um na rede local pode disparar fluxos. Mitigar com token/HMAC quando sair do localhost.
- **`flow.play` após kill por budget:** retomar um fluxo morto por orçamento limpa a latch de kill mas o medidor por-fluxo já está **perto do cap reidratado** — o próximo run pode ser negado imediatamente na admissão. É seguro (não gasta além do cap), só confuso; idealmente a UI deveria avisar "perto do teto".
- **`RunCtx.lease` confiado por convenção:** o runner assume que a lease em `RunCtx` é válida (invariante de construção: só o orquestrador monta o `RunCtx` e só o guard cunha a lease). Não é **forçado por tipo** — a brand é phantom; um chamador malicioso interno poderia forjar. Aceitável porque tudo é in-process e a superfície é o próprio engine.

### 4. Persistência — duas camadas de verdade
- **Event log `node:sqlite`** append-only (rodar com `--experimental-sqlite`) = verdade de runtime; UI projeta. Isolado atrás de `eventlog.ts` → trocável por fold de JSONL se o flag experimental mudar.
- **YAML versionável** preservando comentários (`yaml` / eemeli) = verdade de topologia/prompt. `spec.save` valida (zod + acíclico), bumpa versão, snapshota e faz hot-reload.

### 5. Blackboard — contextos vinculados
- **Dir por-fluxo** = cwd do agente + `--add-dir`. **Single-writer-por-artefato** por topologia (`spec.save` faz lint de irmãos paralelos que compartilham arquivo gravável) + escrita atômica (temp→rename) + mutex por-path + **sha256 em toda escrita** (alimenta a barreira E a convergência). `term://N` roteia pro tmux.

### 6. Scheduler — daemon de gatilhos
- Um daemon in-process: **`croner`** para Agendado/Intervalo (`nextRun` real como Date), **`node:http`** `/webhook/:flowId/:event` para Webhook, **`runNow`** para Manual.
- Intervalo só re-arma **após o ciclo assentar** (sem overlap). **Sem backfill** de disparos perdidos (segurança de custo). Pause cancela timers; resume recomputa `nextRun`.

### 7. Bridge — WebSocket tipado
- Um único `/ws`. Uniões `ServerMessage | ClientCommand` em `@loom/shared`, **validadas por zod na borda** do engine. `PROTOCOL_VERSION=1`. `hello` traz `flows[]`, `models`, `catalog`, `terminals[]`, `sinceSeq`.
- Ordenado por `seq`; **reconexão sem perda** via replay `sinceSeq` do SQLite; **todo comando é ackado**. Ids `Brand`ados (`FlowId/NodeId/EdgeId/RunId`) por toda parte.

### 8. Terminais — `term://N` **e** `term://<flow>.<node>`
- **Dois formatos de id, um registro:** `term://N` (rail / linked-contexts) **e** `term://<flow>.<node>` (o terminal do run-agente). Qualquer id mapeia para um nome de sessão tmux seguro (`loom-term-<sanitizado>_<hash>`) — nem o nome da sessão nem nossos argv arrays jamais interpolam id cru numa string de shell (sempre `spawn("tmux", [array])`, nunca `sh -c`).
- **Sessões tmux reais** abertas como **login shell** (`bash -l`, PATH completo p/ node/claude no pane). Saída transmitida AO VIVO via `pipe-pane → FIFO → onData → terminal.data` (incremental) + buffer de replay limitado p/ `terminal.open` tardio.
- `runInPane(id, {argv, cwd, signal, timeoutMs})` é a **superfície de execução real** — roda o `claude` dentro do pane e resolve no exit. **Status DERIVADO** da posse de run do orquestrador/runner (scribe/executor/idle/busy), não de adivinhação do conteúdo do pane. `disposeFlow(flowId)` derruba todos os panes de um fluxo (caminho de kill). Contrato `Terminal` de 1ª classe em `hello`/`terminal.snapshot`; degrada graciosamente (status válido) se o tmux falhar na fronteira WSL.

## Registro de modelos

| Label (UI) | id real | input $/1M | output $/1M | max out |
|---|---|---|---|---|
| Claude Opus 4.1 | `claude-opus-4-8` | 5 | 25 | 128K |
| Claude Sonnet 4.5 | `claude-sonnet-4-6` | 3 | 15 | 64K |
| Claude Haiku 4 | `claude-haiku-4-5` | 1 | 5 | 64K |

## Mapa UI → backend

| UI (mockup) | Backend |
|---|---|
| pulsos/glow nos nós | `node.activated/deactivated` + `run.token` (ao vivo) |
| tokens / execuções recentes | `run.snapshot` + `run.*` events |
| status play/pause/kill | `flow.play/pause/kill` commands + `guard` |
| ciclo N / feedback | `cycle.*` + orquestrador |
| contextos vinculados | `blackboard.write` + `AgentNode.linkedContexts` |
| rail de terminais | `Terminal[]` em `hello` + `terminal.snapshot` |
| editar e salvar fluxo | `spec.save` → YAML versionado |
| log strip | `log` events |

## Fidelidade visual

React Flow é usado **só para a mecânica** (pan/zoom/seleção). Renderers de nó/edge **totalmente sobrescritos** com a matemática portada de `edgePath()`/`anchorPt()`/`tick()`: beziers para frente com sag/wobble; feedback edges com âncoras bottom→bottom + dip para baixo (os beziers padrão do React Flow não reproduzem isto); pulsos viajantes via `getPointAtLength`; glow via `sin(t·2.4+phase)`. **Tokens de tema verbatim** do mockup + o mesmo link de Google Fonts.

## Convenções de ambiente (WSL)

- Toolchain no WSL (Node em `~/.local/opt/node/bin`, em PATH só em **login shells** → use `bash -l`).
- `node:sqlite` exige `--experimental-sqlite` em runtime.
- **Comandos WSL não-triviais SEMPRE via arquivo de script** (`Write` no UNC `//wsl.localhost/Ubuntu/...` depois `wsl.exe -d Ubuntu -- bash -lc "sed -i 's/\r$//' ~/x.sh; bash -l ~/x.sh"`). Inline com `$()`/pipes corrompe.
- Ids persistentes do engine: `newId()` (crypto). `makeId()` só para temp da UI.
