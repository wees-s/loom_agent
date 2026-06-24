# Loom

**Loom é um control plane local para orquestrar loops agênticos do Claude.**
Você cria, edita, observa e controla *fluxos* de agentes que rodam em gatilhos
(agendados, webhooks, manuais), se ramificam, analisam, decidem, executam e
realimentam a si mesmos em ciclos — tudo visualmente, numa canvas interativa.

É um **engine** Node único que executa fluxos definidos como grafos de agentes,
mais um app **web** em React que renderiza a canvas ao vivo. Tudo é TypeScript
num monorepo pnpm (`@loom/shared`, `@loom/engine`, `@loom/web`).

> O código do projeto fica em [`loom/`](./loom). Este README é a porta de
> entrada (instalação e primeiros passos). Para o detalhamento técnico completo
> — modelo de segurança, design da canvas, modelo de custo — veja
> [`loom/README.md`](./loom/README.md) e
> [`loom/docs/ARCHITECTURE.md`](./loom/docs/ARCHITECTURE.md).

---

## Conceito em 30 segundos

- **Terminal-native:** cada execução de agente é uma sessão **real do `claude`
  rodando dentro de um pane do tmux** (um pane por `(fluxo, nó)`), transmitida ao
  vivo para a canvas. Você vê o terminal de verdade que cada agente usou.
- **Usa o `claude` CLI já autenticado** — sem novo login, sem API key para
  gerenciar.
- **Event-sourced:** a fonte da verdade em runtime é um log append-only em SQLite.
- **Seguro por padrão:** os fluxos começam vazios e os gatilhos ficam dormentes
  até você dar o play. Há guardrails rígidos contra *runaway cost* (limites de
  custo pré-gasto, `maxCyclesPerArm`, `--max-turns`, timeout por execução).

---

## Pré-requisitos

| Requisito | Versão | Por quê |
|---|---|---|
| **Node.js** | `>= 22.23.0` (veja `.nvmrc` = `22`) | usa `node:sqlite` (flag `--experimental-sqlite`) |
| **pnpm** | `11.8.0` | gerenciador do monorepo (fixado em `packageManager`) |
| **tmux** | qualquer recente | panes reais onde os agentes rodam |
| **Claude CLI** | autenticado e no `PATH` | o engine dirige o `claude` de verdade |

> **Ambiente:** o projeto foi pensado para rodar a partir do **WSL2 (Ubuntu)** e
> ser visualizado no **navegador do Windows**. O engine resolve o binário
> `claude` a partir do PATH do login shell.

Habilitar o pnpm via corepack (se ainda não tiver):

```bash
corepack enable
corepack prepare pnpm@11.8.0 --activate
```

---

## Instalação

```bash
cd loom
pnpm install   # resolve os refs workspace:* dos pacotes locais
```

---

## Rodando em desenvolvimento

Engine (porta **8787**) e web (porta **5173**) juntos:

```bash
# a partir de loom/
pnpm dev
```

Ou em dois terminais separados (mais controle):

```bash
pnpm --filter @loom/engine dev   # bridge HTTP + WebSocket em :8787
pnpm --filter @loom/web dev      # Vite em :5173 (faz proxy de /ws → :8787)
```

Depois abra **http://localhost:5173** no navegador.

---

## Verificação de qualidade

Os mesmos gates que o CI roda (todos precisam passar):

```bash
# a partir de loom/
pnpm -r typecheck   # tsc -b  (shared → engine → web)
pnpm -r test        # vitest  (shared: 16 testes, engine: 77)
pnpm -r build       # compila os 3 pacotes em sequência
```

---

## Rodar um fluxo sem a UI (headless)

```bash
# a partir de loom/
cp examples/smoke.flow.yaml flows/

# dry-run de custo ZERO (runner sintético — nada do claude real é chamado)
LOOM_RUNNER=fake pnpm --filter @loom/engine exec \
  node --experimental-sqlite --import tsx src/main.ts --dry-run smoke

# execução REAL com limites de custo (chama o claude de verdade)
LOOM_RUNNER_MAX_TURNS=3 LOOM_RUNNER_TIMEOUT_MS=120000 \
  node --experimental-sqlite --import tsx packages/engine/src/main.ts --dry-run smoke
```

---

## Variáveis de ambiente

Todas são **opcionais** com defaults sensatos. As principais:

| Variável | Default | Descrição |
|---|---|---|
| `LOOM_RUNNER` | `real` | `real` executa o `claude`; `fake` é sintético e zero-custo |
| `LOOM_RUNNER_MAX_TURNS` | `40` | máximo de turns por execução (kill switch) |
| `LOOM_RUNNER_TIMEOUT_MS` | `120000` | timeout de wall-clock por execução |
| `LOOM_CLAUDE_BIN` | `claude` | caminho/nome do binário do Claude CLI |
| `LOOM_AUTH_PROBE_MODEL` | `haiku` | modelo barato do health check pré-boot |
| `LOOM_DB` | `data/loom.db` | caminho do log SQLite (use `:memory:` em testes) |
| `LOOM_PORT` | `8787` | porta do bridge (HTTP + WebSocket + webhooks) |

> A lista completa (generator, kill grace period, etc.) está em
> [`loom/README.md`](./loom/README.md).

---

## Estrutura do repositório

```
loom/
├── packages/
│   ├── shared/   # contratos: tipos de nó, eventos, schemas zod, protocol WS
│   ├── engine/   # control plane: runner, guard, orchestrator, scheduler, eventlog…
│   └── web/      # SPA React + Vite (canvas via @xyflow/react, terminal via xterm)
├── flows/        # specs YAML versionáveis (vazio = seguro por padrão)
├── examples/     # fluxos de referência (smoke, daily-standup, content-review…)
├── blackboard/   # cwd compartilhado dos agentes por fluxo (gitignored)
├── data/         # event log SQLite + versionamento de specs (gitignored)
└── docs/         # ARCHITECTURE.md (design detalhado)
```

| Pacote | Papel |
|---|---|
| **`@loom/shared`** | contratos compartilhados entre engine e web |
| **`@loom/engine`** | execução de agentes em panes tmux, DAG + ciclos, scheduler, guardrails de custo, bridge WebSocket |
| **`@loom/web`** | canvas interativa, replay do event log, inspetor de nós |

---

## Scripts (a partir de `loom/`)

| Script | O que faz |
|---|---|
| `pnpm dev` | engine + web em watch mode simultaneamente |
| `pnpm dev:engine` / `pnpm dev:web` | sobe só um dos dois |
| `pnpm build` | compila shared → engine → web |
| `pnpm typecheck` | `tsc -b` nos 3 pacotes |
| `pnpm test` | roda os testes (vitest) |
| `pnpm lint` | eslint em `.ts`/`.tsx` |
| `pnpm format` | prettier |
| `pnpm seed` | popula dados de exemplo no SQLite |

---

## CI

O workflow em [`loom/.github/workflows/ci.yml`](./loom/.github/workflows/ci.yml)
roda em todo push para `main` e em todo PR: **install → typecheck → test →
build**. Não há etapa de deploy (é um control plane local).

---

## Segurança e custo

Em modo terminal o output padrão é **texto** (legível no pane), então **não há
medidor de custo ao vivo** — o custo é limitado pelos **bounds pré-gasto**
(admissão por pior-caso de execução, `maxCyclesPerArm`, `--max-turns` e o timeout
de wall-clock), não por um medidor em tempo real. O runner `fake` *mede* o custo
e serve para dry-runs de custo zero e testes. Detalhes na seção *Safety model* do
[`loom/README.md`](./loom/README.md).
