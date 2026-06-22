# Example flows (opt-in)

A fresh Loom install ships with **zero flows** — the engine loads `flows/`, which
is empty by default, and the UI opens on a clean, empty state. This is on purpose:
Loom orchestrates **money-spending agents**, so nothing should run, arm a trigger,
or be able to spend until *you* explicitly create and play a flow.

These files are **reference examples**, not active flows. They are not loaded.

## Use one

Copy the example into the live `flows/` dir, then start the engine. It will load
as **paused / idle** — it only arms its trigger (and can spend) after you press
play in the UI (`flow.play`) or fire it manually (`flow.runNow`):

```bash
cp examples/daily-standup.flow.yaml flows/
# now start the engine; the flow appears in the rail, DORMANT, until you play it
```

To stop using it again, delete it from the UI (the spec is archived to
`data/deleted/`, never hard-removed) or just `rm flows/daily-standup.flow.yaml`.

## What's here

| File                          | What it is                                                        |
| ----------------------------- | ----------------------------------------------------------------- |
| `daily-standup.flow.yaml`     | The canonical 6-node loop (Scribe → 3 Analysts → Synthesizer → Executor, feedback to Scribe). |
| `content-review.flow.yaml`    | Content review pipeline.                                          |
| `inbox-triage.flow.yaml`      | Inbox triage flow.                                                |
| `research-digest.flow.yaml`   | Research digest flow.                                             |
| `smoke.flow.yaml`             | Minimal 2-agent **real** haiku flow for end-to-end release verification (a few cents). |

## Headless dry-run

The engine's one-shot CLI loads from `flows/`, so copy an example in first:

```bash
cp examples/smoke.flow.yaml flows/
LOOM_RUNNER=fake node --experimental-sqlite --import tsx packages/engine/src/main.ts --dry-run smoke
```
