// =============================================================================
// narration.ts — PURE event → human sentence mapper for the Storyline view.
//
// No side effects, no React, no store. Maps one LoomEvent to one NarrationLine
// (a ready-to-render human line) or null when the event is noise / already
// covered by another line. Kept in @loom/shared so it is unit-testable and so
// the engine could reuse it later. cycle = the event's own cycle, or -1 when the
// event carries none (the store stamps -1 with the running cycle counter).
// =============================================================================

import type { LoomEvent } from "./events.js";
import type { NodeId, RunId } from "./ids.js";
import type { NodeTypeName } from "./catalog.js";

export type NarrationTone = "neutral" | "good" | "warn" | "bad";

export type NarrationKind =
  | "trigger" | "agent" | "artifact" | "cycle" | "budget" | "kill" | "system";

export interface NarrationLine {
  id: string;          // stable React key — the StoredEvent seq as a string
  cycle: number;       // event's own cycle, or -1 (store stamps with running cycle)
  at: number;          // epoch ms (relative-time rendering)
  kind: NarrationKind;
  actor?: string;      // node/agent title when applicable
  text: string;        // ready human sentence (without the actor prefix)
  tone: NarrationTone;
  artifact?: { path: string; bytes?: number };
}

export interface NarrationCtx {
  node(id: NodeId): { title: string; type: NodeTypeName } | undefined;
  runNode(runId: RunId): NodeId | undefined;
}

/** Map a `log` event color to a tone (mirrors the engine's color conventions). */
function toneFromColor(color: string): NarrationTone {
  if (color === "rose") return "bad";
  if (color === "amber") return "warn";
  if (color === "green") return "good";
  return "neutral";
}

/** Tone for a finished run's failure status. */
function failTone(status: string): NarrationTone {
  if (status === "error" || status === "budget_exceeded") return "bad";
  return "warn"; // timeout | killed | anything else non-ok
}

export function narrateEvent(
  ev: LoomEvent,
  seq: number,
  ts: number,
  ctx: NarrationCtx,
): NarrationLine | null {
  const id = String(seq);
  const base = { id, at: ts } as const;

  switch (ev.type) {
    case "trigger.fired": {
      const text =
        ev.cause === "feedback"
          ? "realimentou o ciclo"
          : `${ev.cause} disparou o fluxo`;
      return { ...base, cycle: -1, kind: "trigger", tone: "neutral", text };
    }
    case "cycle.started":
      return { ...base, cycle: ev.cycle, kind: "cycle", tone: "neutral", text: `Ciclo ${ev.cycle} começou` };
    case "cycle.converged":
      return { ...base, cycle: ev.cycle, kind: "cycle", tone: "neutral", text: `Ciclo ${ev.cycle} convergiu — sem saída nova` };
    case "cycle.ended": {
      if (ev.status === "done" || ev.status === "converged") return null; // noise / dup
      const tone: NarrationTone = ev.status === "killed" ? "bad" : "warn";
      return { ...base, cycle: ev.cycle, kind: "cycle", tone, text: `Ciclo ${ev.cycle} parou (${ev.status})` };
    }
    case "node.activated": {
      const actor = ctx.node(ev.nodeId)?.title;
      return {
        ...base, cycle: ev.cycle, kind: "agent", tone: "neutral",
        ...(actor ? { actor } : {}),
        text: actor ? "começou a trabalhar" : "um agente começou a trabalhar",
      };
    }
    case "run.finished": {
      const nodeId = ctx.runNode(ev.runId);
      const actor = nodeId ? ctx.node(nodeId)?.title : undefined;
      if (ev.status === "ok") {
        const text = ev.resultSummary ?? "concluiu";
        return { ...base, cycle: -1, kind: "agent", tone: "good", ...(actor ? { actor } : {}), text };
      }
      const detail = ev.error ?? ev.status;
      return { ...base, cycle: -1, kind: "agent", tone: failTone(ev.status), ...(actor ? { actor } : {}), text: `falhou: ${detail}` };
    }
    case "blackboard.write": {
      const actor = ctx.node(ev.byNodeId)?.title;
      return {
        ...base, cycle: -1, kind: "artifact", tone: "good",
        ...(actor ? { actor } : {}),
        text: `escreveu ${ev.path}`,
        artifact: { path: ev.path, bytes: ev.bytes },
      };
    }
    case "budget.tripped": {
      const metric = ev.metric === "usd" ? "custo" : ev.metric === "tokens" ? "tokens" : "ciclos";
      const scope = ev.scope === "run" ? "do run" : ev.scope === "flow" ? "do fluxo" : "de ciclos";
      return { ...base, cycle: -1, kind: "budget", tone: "warn", text: `teto de ${metric} ${scope} atingido (${ev.limit})` };
    }
    case "kill.requested":
      return { ...base, cycle: -1, kind: "kill", tone: "bad", text: `fluxo interrompido (${ev.by})` };
    case "log":
      return { ...base, cycle: -1, kind: "system", tone: toneFromColor(ev.color), text: ev.msg };
    // Noise / already covered elsewhere → no line.
    case "run.started":
    case "run.token":
    case "run.tool":
    case "run.output":
    case "node.deactivated":
    case "edge.fired":
    case "terminal.state":
    case "flow.upserted":
    case "flow.removed":
    case "flow.spec.changed":
    case "flow.stateChanged":
    case "auth.state":
      return null;
    default:
      return null;
  }
}
