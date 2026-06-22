# Loom

**Loom is a local control plane for orchestrating agentic Claude loops** — you
create, edit, observe and control flows of agents that run on triggers, branch,
analyse, decide, execute and feed back into themselves, all visually. It is a
single Node **engine** that runs flows defined as graphs of agents, plus a React
**web** app that renders the live canvas. Everything is TypeScript in a pnpm
monorepo (`@loom/shared`, `@loom/engine`, `@loom/web`); it runs from WSL and is
viewed in the Windows browser. No Rust, no Tauri — just a web app.

Each agent node shells out to the **already-authenticated Windows `claude` CLI**
(`--output-format stream-json`), one child process per run, so there is no new
login and no API key to manage. A run's real token usage and `costUsd` flow back
over a typed WebSocket and are projected onto the canvas in real time.

## What the UI looks like (screenshot-free)

A single dark, full-bleed workspace, ported 1:1 from the `Loom.dc.html` mockup:

- **Top bar** — current flow name + schedule, the global play / pause / kill
  controls, cycle counter, the live token/cost meter, and theme toggle.
- **Left rail** — the list of flows (each with its state: rodando / agendado /
  ocioso / pausado / rascunho and next-run time), plus a **terminals rail**
  (`term://N` ↔ real tmux sessions) whose status (scribe / executor / idle /
  busy) is derived from which node currently owns the run.
- **Canvas (center)** — the agent graph. React Flow drives only the mechanics
  (pan / zoom / selection); node and edge rendering is fully overridden with the
  ported math: forward bezier edges with sag/wobble, **feedback edges** that arc
  bottom-to-bottom back to a trigger, travelling pulses along firing edges, and
  per-node glow that breathes while a node is activated. Add agents from a
  server-driven catalog of 44 node types.
- **Inspector (right)** — per-node detail: role/prompt editing, model picker,
  linked contexts, the trigger config, and recent runs (tokens, cost, tool
  calls, result summary). Saving an edit versions the YAML spec.
- **Log strip (bottom)** — the colour-coded runtime event log (trigger fired,
  cycle started/ended, budget tripped, kill requested, etc.).

The UI holds **no authoritative state of its own**: it is a pure projection of
the engine's append-only event log, so a reconnect replays losslessly from the
last seq.

## Architecture (summary)

Full design rationale (the 8 hard problems, the model registry, the UI→backend
map) lives in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. In brief:

- **Two layers of truth, never mixed.** The **append-only event log**
  (`node:sqlite`, run with `--experimental-sqlite`) is the single source of
  runtime truth; the UI is a pure projection of it. The **versioned YAML spec**
  (`flows/*.flow.yaml`) is the source of truth for topology and prompts.
- **Runner.** Shells out to the Windows-authed `claude` CLI with an argv ARRAY +
  prompt over STDIN (survives the Git Bash → wsl.exe → Windows bridge); a single
  stream-json adapter turns NDJSON into tokens / tool calls / text / cost.
- **Orchestration.** One cycle = one topological pass over the DAG with feedback
  edges CUT (acyclic by construction); Kahn layers fan out in parallel; the JOIN
  between layers is an **artifact-presence barrier** (a node that wrote nothing
  fails the barrier). Feedback edges re-arm the next cycle only through the guard.
- **Bridge.** One typed WebSocket `/ws`; `ServerMessage | ClientCommand` unions
  defined in `@loom/shared` and validated by zod at the engine boundary; every
  command is acked; reconnect replays from `sinceSeq`.
- **Scheduler.** An in-process trigger daemon: `croner` for Scheduled/Interval,
  `node:http` `/webhook/:flowId/:event` for Webhook, `runNow` for Manual. **Safe
  by default: boot is inert** — loaded flows register their triggers as DORMANT
  and arm NOTHING; a flow only arms (and can spend) after the user explicitly
  plays it (`flow.play`) or fires it (`flow.runNow`); pause/kill disarm it again.
  No backfill of missed fires (a cost-safety choice); interval re-arms only after
  a cycle settles (no overlap).

| Package        | Role                                                          |
| -------------- | ------------------------------------------------------------ |
| `@loom/shared` | Contracts (ids, domain, events, protocol, zod schemas, catalog) |
| `@loom/engine` | Control plane (eventlog, scheduler, runner, orchestrator, guard, bridge, auth, blackboard, spec, terminals) |
| `@loom/web`    | React SPA (React Flow canvas, zustand store) — 1:1 mockup port |

## How to run

Requirements: Node ≥ 22.23 (on PATH in **login** shells), pnpm 11.8, and the
authenticated Windows `claude` CLI reachable from WSL on PATH. `node:sqlite`
needs `--experimental-sqlite` at runtime (already baked into the dev/start
scripts).

```bash
pnpm install            # resolve the workspace (workspace:* is local)

# Run the two halves (two terminals, or `pnpm dev` for both at once):
pnpm --filter @loom/engine dev    # control plane on :8787 (ws + webhook)
pnpm --filter @loom/web dev       # Vite dev server on :5173 (proxies /ws → :8787)
```

Then open **http://localhost:5173** in the Windows browser. (Vite's dev server
binds so it is reachable across the WSL/Windows boundary and proxies the
WebSocket to the engine, so no CORS or port juggling is needed.)

Quality gates (all green):

```bash
pnpm -r typecheck       # tsc -b across the 3 project refs
pnpm -r build           # shared → engine → web
pnpm -r test            # vitest (shared 16, engine 77; web has no unit suite yet)
```

A flow can also be exercised headless with the engine's one-shot CLI. The engine
loads from `flows/` (empty by default), so copy an example in first:

```bash
# Zero-cost dry run with the synthetic runner (no claude calls):
cp examples/daily-standup.flow.yaml flows/
LOOM_RUNNER=fake pnpm --filter @loom/engine exec \
  node --experimental-sqlite --import tsx src/main.ts --dry-run daily-standup

# One REAL cycle (spawns the authed claude CLI); examples/smoke.flow.yaml is a
# tiny two-node haiku flow built for exactly this. Bound spend with these env knobs:
cp examples/smoke.flow.yaml flows/
LOOM_RUNNER_MAX_TURNS=3 LOOM_RUNNER_TIMEOUT_MS=120000 \
  node --experimental-sqlite --import tsx packages/engine/src/main.ts --dry-run smoke
```

## Safety model

Runaway-cost loops are meant to be **impossible by construction**, funnelled
through a single chokepoint (`guard.ts`): cycles only begin via
`guard.requestNextCycle`, and spawns only via `guard.requestSpawn → SpawnLease`.

**Safe by default:** a flow is **un-armed** until you explicitly start it. The
guard denies *every* spawn for an un-armed flow (`flow_not_armed`), and the
scheduler registers a loaded flow's triggers as **dormant** on boot (no cron, no
interval timer, no webhook fire). Only `flow.play` / `flow.runNow` arm a flow;
`flow.pause` / `flow.kill` disarm it. So a restart never auto-runs anything, and a
freshly-loaded flow cannot spend a cent until you press play.

**Hard bounds (the ones that actually cap cost):**

1. **`maxCyclesPerArm`** — a hard ceiling on feedback re-arms within one trigger
   firing. Guarantees termination of a feedback loop.
2. **Per-flow caps (USD *and* tokens)** — enforced by **pre-spend admission**:
   `committedUsd + reservations-in-flight + worstCaseRunCost(model) ≤ cap`
   *before* any spawn. The per-flow cap can only be exceeded by the estimation
   error of a single in-flight run, never by a loop. `committedUsd/Tokens` is
   **rehydrated from the event log on boot**, so the lifetime per-flow ceiling
   **survives an engine restart** (a restart does not reset spend to zero).
3. **Live per-run abort** — an `AbortController` wired into the token meter kills
   a run the instant it crosses its own cap; crossing a *flow* cap kills the flow.
4. **Kill switch** — `--max-turns` on the CLI (BELT), a per-run wall-clock
   timeout (SUSPENDERS), and a three-pronged kill (tree-kill SIGKILL + POSIX
   `kill(-pgid)` + `taskkill.exe /T /F`) with post-kill verification.

**Advisory (not an independent bound):** convergence detection stops a loop early
when N cycles produce no new artifact hash. It is **redundant** to bounds (1) and
(3) and can be defeated by non-deterministic content — never rely on it alone.

### Honest caveat: kill across the WSL→Windows boundary is NOT guaranteed

The engine runs in WSL/Linux but the agent child is the **Windows** `claude.exe`
launched via interop. The PID we register is the WSL-side launcher, not
necessarily the Win32 process. If `taskkill.exe` doesn't reach the real
`claude.exe`, it can **orphan**; spend is then bounded only by `--max-turns` +
the wall-clock timeout, and the engine emits a `kill.failed` (`log {color:"rose"}`)
so the operator knows. There is no reaper that correlates the real `claude.exe`
by name/cwd. Also: the child is spawned `detached` (its own process group), which
is harmless on the happy path (it always exits via close/abort/watchdog).

### Known issues (LOW — documented, not fixed)

- **Webhook has no auth.** `/webhook/:flowId/:event` is unauthenticated. Cost
  amplification is bounded by the guard (per-flow caps + `maxCyclesPerArm`), but
  anyone on the local network can trigger flows. Add a token/HMAC before exposing
  beyond localhost.
- **`flow.play` after a budget kill** resumes against the near-cap rehydrated
  meter, so the next run may be **denied immediately** at admission. Safe (never
  spends past the cap), just potentially confusing — the UI should warn when near
  the ceiling.
- **`RunCtx.lease` is trusted by convention.** The runner assumes the lease in
  `RunCtx` is valid (only the orchestrator builds `RunCtx`, only the guard mints
  the lease). It is not type-enforced (the brand is phantom). Acceptable because
  everything is in-process and the only surface is the engine itself.

## Layout

- `flows/` — versioned YAML specs (topology/prompt truth). **Empty by default** —
  a fresh install ships **zero flows** (safe by default: nothing runs/arms/spends
  until you create and play one). The engine loads this dir; an empty dir = a
  clean, empty UI.
- `examples/` — **opt-in** reference flows (daily-standup, content-review,
  inbox-triage, research-digest, smoke). They are **not loaded**. Copy one into
  `flows/` to use it (see `examples/README.md`); it loads paused/idle and only
  arms after you play it.
- `data/` — runtime event log (SQLite, gitignored) + `data/deleted/` (archived
  specs from flow deletes — never hard-removed) + `data/spec_versions/`.
- `blackboard/` — per-flow linked context = the agents' cwd (gitignored).
- `scripts/` — `seed.ts`, `dev.sh`, plus the `e2e-ws-client.mjs` /
  `dump-events.mjs` verification helpers.
- `docs/ARCHITECTURE.md` — the definitive design document.
