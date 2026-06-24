// =============================================================================
// scheduler.ts [scheduler] — in-process trigger daemon.
//
// Per flow Trigger node:
//   - croner for Agendado (freq Diário/Dias úteis/Semanal/Mensal + time) and
//     Intervalo (5min/15min/1h/6h), re-arming Intervalo ONLY after the cycle
//     settles (no overlap).
//   - a node:http listener for Webhook at /webhook/:flowId/:event.
//   - runNow(flowId, triggerNodeId?) for Manual.
// Computes the real nextRun Date and emits nextRun. Honors per-flow pause
// (cancel timers) / resume (recompute). NO missed-fire backfill (cost safety).
// On fire, starts a cycle via guard + orchestrator.
//
// The webhook listener SHARES the node:http server with the bridge's WebSocket
// (createHttpServer here; bridge attaches /ws to the same server).
// =============================================================================

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import {
  asNodeId,
  type Flow,
  type FlowId,
  type NodeId,
  type AgentNode,
  type TriggerConfig,
  type Freq,
  type IntervalChoice,
} from "@loom/shared";
import { Cron } from "croner";
import type { CycleCause, Emit } from "./internal.js";
import type { Guard } from "./guard.js";
import type { Orchestrator } from "./orchestrator.js";
import type { SpecStore } from "./spec.js";

/** A live arm for one Trigger node (what the daemon tracks per trigger). */
export interface ArmedTrigger {
  flowId: FlowId;
  nodeId: NodeId;
  config: TriggerConfig;
  /** Next scheduled fire (null for Webhook/Manual). */
  nextRun: Date | null;
  paused: boolean;
}

// -----------------------------------------------------------------------------
// Internal per-trigger record. We keep the spec-level info plus whatever timer
// resource backs it (a croner Cron for Agendado, a setTimeout handle for
// Intervalo, or nothing for Webhook/Manual).
// -----------------------------------------------------------------------------
interface TriggerArm {
  flowId: FlowId;
  nodeId: NodeId;
  config: TriggerConfig;
  paused: boolean;
  /** croner job for Agendado (also used purely as a nextRun calculator). */
  cron: Cron | null;
  /** Manual setTimeout handle for Intervalo (re-armed only after settle). */
  timer: ReturnType<typeof setTimeout> | null;
  /** Cached next fire, recomputed on (re)arm; null for Webhook/Manual. */
  nextRun: Date | null;
  /** True while this arm's cycle is being fired (no-overlap guard). */
  firing: boolean;
}

/** The local timezone string the scheduler computes schedules in. */
const LOCAL_TZ =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Interval choice → milliseconds. */
const INTERVAL_MS: Record<IntervalChoice, number> = {
  "30 s": 30_000,
  "1 min": 60_000,
  "5 min": 5 * 60_000,
  "15 min": 15 * 60_000,
  "1 h": 60 * 60_000,
  "6 h": 6 * 60 * 60_000,
};

export interface Scheduler {
  /** The shared node:http server (webhook + the bridge's /ws upgrade target). */
  readonly httpServer: HttpServer;

  /** Start listening on `port` (webhook + ws share it) and arm all triggers. */
  start(port: number): Promise<void>;

  /** Arm/re-arm every Trigger node of a flow from its current spec. */
  armFlow(flowId: FlowId): void;

  /** Cancel all timers for a flow (flow.pause). */
  pauseFlow(flowId: FlowId): void;

  /** Recompute + re-arm timers for a flow (flow.resume), emitting nextRun. */
  resumeFlow(flowId: FlowId): void;

  /** Manual fire: start a cycle now (Manual trigger or a specific trigger). */
  runNow(flowId: FlowId, triggerNodeId?: NodeId): Promise<void>;

  /** Current next-run for a flow's trigger node (backs node.subscribe → nextRun reply). */
  nextRunFor(flowId: FlowId, nodeId: NodeId): Date | null;

  /** Snapshot of all armed triggers (debug / status). */
  armed(): ArmedTrigger[];

  /** Stop the daemon: clear timers, close the http server. */
  stop(): Promise<void>;
}

/**
 * Build the scheduler. Creates the shared node:http server. On fire it goes
 * through guard (admission) + orchestrator.startCycle; Intervalo re-arms only
 * after orchestrator.isRunning(flow) clears (no overlap); no backfill.
 */
export function createScheduler(
  guard: Guard,
  orchestrator: Orchestrator,
  spec: SpecStore,
  emit: Emit,
): Scheduler {
  // (flowId, nodeId) -> live arm. One trigger node per flow => one arm. The key
  // MUST be composite: trigger node ids are only unique WITHIN a flow (every seed
  // flow ships a node literally id'd "trigger"), so keying on nodeId alone made
  // armFlow() of one flow clobber another's arm — runNow/nextRunFor would then
  // resolve to the WRONG flow. The space-separated composite avoids that.
  const arms = new Map<string, TriggerArm>();
  const armKey = (flowId: FlowId, nodeId: NodeId): string =>
    `${String(flowId)} ${String(nodeId)}`;
  let started = false;
  let closed = false;

  const httpServer: HttpServer = createServer(handleHttp);

  // ---------------------------------------------------------------------------
  // Logging helper — surfaces scheduler activity on the event log strip.
  // ---------------------------------------------------------------------------
  function log(flowId: FlowId, color: string, msg: string): void {
    emit({ type: "log", flowId, color, msg, at: Date.now() });
  }

  /**
   * Emit the computed nextRun for a trigger node. There is no dedicated
   * `nextRun` LoomEvent (it is a bridge reply via nextRunFor); we surface it as
   * a visible log line so the change is observable in the runtime log.
   */
  function emitNextRun(arm: TriggerArm): void {
    const iso = arm.nextRun ? arm.nextRun.toISOString() : "—";
    log(
      arm.flowId,
      "#7aa2f7",
      `nextRun ${arm.config.kind} ${String(arm.nodeId)} → ${iso}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Spec lookup helpers.
  // ---------------------------------------------------------------------------
  function triggerNodes(flow: Flow): AgentNode[] {
    return flow.nodes.filter((n) => n.type === "Trigger" && n.trigger);
  }

  function nodeOf(flowId: FlowId, nodeId: NodeId): AgentNode | null {
    const flow = spec.get(flowId);
    if (!flow) return null;
    return flow.nodes.find((n) => n.id === nodeId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Cron-pattern synthesis for Agendado.
  //
  // croner pattern: "sec min hour dayOfMonth month dayOfWeek".
  // We always pin seconds to 0 and parse HH:MM from config.time (default 09:00).
  //   Diário      → every day at HH:MM
  //   Dias úteis  → Mon–Fri at HH:MM
  //   Semanal     → on config.weekday (0=Sun..6=Sat, default Mon) at HH:MM
  //   Mensal      → on day-of-month config.weekday (1..31, default 1) at HH:MM
  // ---------------------------------------------------------------------------
  function parseHourMinute(time: string | undefined): { h: number; m: number } {
    const fallback = { h: 9, m: 0 };
    if (!time) return fallback;
    const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (!match) return fallback;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
      return fallback;
    }
    return { h, m };
  }

  function cronPatternFor(config: TriggerConfig): string {
    const { h, m } = parseHourMinute(config.time);
    const freq: Freq = config.freq ?? "Diário";
    switch (freq) {
      case "Diário":
        return `0 ${m} ${h} * * *`;
      case "Dias úteis":
        // Monday(1) through Friday(5).
        return `0 ${m} ${h} * * 1-5`;
      case "Semanal": {
        const dow =
          typeof config.weekday === "number" && config.weekday >= 0 && config.weekday <= 6
            ? config.weekday
            : 1; // default Monday
        return `0 ${m} ${h} * * ${dow}`;
      }
      case "Mensal": {
        // weekday doubles as day-of-month for Mensal (per domain.ts contract).
        const dom =
          typeof config.weekday === "number" && config.weekday >= 1 && config.weekday <= 31
            ? config.weekday
            : 1; // default 1st of the month
        return `0 ${m} ${h} ${dom} * *`;
      }
      default:
        return `0 ${m} ${h} * * *`;
    }
  }

  // ---------------------------------------------------------------------------
  // Firing — the single path from "a trigger went off" to a started cycle.
  // Honors no-overlap (orchestrator.isRunning + per-arm firing flag), per-flow
  // pause, and goes through the orchestrator (which drives the guard for the
  // actual spawn admission). NO backfill: a fire is dropped (logged) if the
  // flow is already busy.
  // ---------------------------------------------------------------------------
  async function fire(arm: TriggerArm, cause: CycleCause, force = false): Promise<void> {
    if (closed) return;
    // A scheduled/webhook fire on a paused (dormant) arm is dropped — boot leaves
    // every arm paused, so nothing auto-fires. `force` is set ONLY by runNow, an
    // explicit user/API action that is itself a play signal; it may fire a dormant
    // trigger but never bypasses the guard's own kill/budget/auth admission inside
    // orchestrator.startCycle.
    if (arm.paused && !force) {
      log(arm.flowId, "#e0af68", `trigger ${String(arm.nodeId)} paused — skip ${cause}`);
      return;
    }
    if (arm.firing || orchestrator.isRunning(arm.flowId) || orchestrator.isAwaiting(arm.flowId)) {
      // No-overlap + no-backfill: a still-running cycle — or one paused at a
      // human-in-the-loop checkpoint (awaiting approval) — swallows this fire.
      log(
        arm.flowId,
        "#e0af68",
        `${cause} fire dropped (cycle in flight or awaiting approval) — no backfill`,
      );
      return;
    }

    const flow = spec.get(arm.flowId);
    if (!flow) {
      log(arm.flowId, "#f7768e", `trigger fired but flow ${arm.flowId} not loaded`);
      return;
    }

    arm.firing = true;
    emit({
      type: "trigger.fired",
      flowId: arm.flowId,
      nodeId: arm.nodeId,
      cause,
      at: Date.now(),
    });

    try {
      await orchestrator.startCycle(flow, cause);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log(arm.flowId, "#f7768e", `cycle failed to start (${cause}): ${detail}`);
    } finally {
      arm.firing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Intervalo arming — a managed self-rescheduling timeout. We re-arm ONLY
  // after the prior cycle has fully settled (fire() awaited + isRunning clear),
  // so two Intervalo cycles can never overlap. nextRun is recomputed from "now"
  // at each arm, so missed windows are never backfilled.
  // ---------------------------------------------------------------------------
  function armIntervalo(arm: TriggerArm): void {
    const choice = arm.config.interval;
    if (!choice) {
      log(arm.flowId, "#f7768e", `Intervalo trigger ${String(arm.nodeId)} missing interval`);
      arm.nextRun = null;
      return;
    }
    const ms = INTERVAL_MS[choice];
    clearArmTimer(arm);
    arm.nextRun = new Date(Date.now() + ms);

    const tick = (): void => {
      if (closed || arm.paused) return;
      arm.timer = null;
      void (async () => {
        await fire(arm, "Intervalo");
        // Re-arm ONLY after the cycle has settled (no overlap). If the flow is
        // somehow still running (e.g. feedback arms), wait it out before the
        // next interval window — without backfilling the missed window.
        if (closed || arm.paused) {
          arm.nextRun = null;
          return;
        }
        await waitUntilIdle(arm.flowId);
        if (closed || arm.paused) {
          arm.nextRun = null;
          return;
        }
        armIntervalo(arm);
        emitNextRun(arm);
      })();
    };

    arm.timer = setTimeout(tick, ms);
    // Allow the process to exit even with an interval pending (mirrors croner unref).
    if (typeof arm.timer === "object" && arm.timer && "unref" in arm.timer) {
      (arm.timer as { unref: () => void }).unref();
    }
  }

  /** Poll until the flow is no longer running a cycle (orchestrator settles). */
  function waitUntilIdle(flowId: FlowId): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (closed || !orchestrator.isRunning(flowId)) {
          resolve();
          return;
        }
        const t = setTimeout(check, 250);
        if (typeof t === "object" && t && "unref" in t) {
          (t as { unref: () => void }).unref();
        }
      };
      check();
    });
  }

  // ---------------------------------------------------------------------------
  // Agendado arming — a croner job. croner both computes nextRun and fires the
  // callback on schedule. The callback still respects the no-overlap guard via
  // fire(); a missed window is never backfilled (croner only fires forward).
  // ---------------------------------------------------------------------------
  function armAgendado(arm: TriggerArm): void {
    disposeCron(arm);
    const pattern = cronPatternFor(arm.config);
    try {
      const cron = new Cron(
        pattern,
        { name: `${arm.flowId}:${String(arm.nodeId)}`, timezone: LOCAL_TZ, unref: true },
        () => {
          void fire(arm, "Agendado");
        },
      );
      arm.cron = cron;
      arm.nextRun = cron.nextRun();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log(
        arm.flowId,
        "#f7768e",
        `Agendado pattern '${pattern}' rejected: ${detail}`,
      );
      arm.cron = null;
      arm.nextRun = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Arm a single trigger node from its config. Webhook/Manual hold no timer
  // (nextRun null); they fire reactively (HTTP route / runNow).
  // ---------------------------------------------------------------------------
  function armOne(arm: TriggerArm): void {
    switch (arm.config.kind) {
      case "Agendado":
        armAgendado(arm);
        break;
      case "Intervalo":
        armIntervalo(arm);
        break;
      case "Webhook":
      case "Manual":
        arm.nextRun = null;
        break;
      default:
        arm.nextRun = null;
    }
    emitNextRun(arm);
  }

  // ---------------------------------------------------------------------------
  // Timer teardown helpers.
  // ---------------------------------------------------------------------------
  function disposeCron(arm: TriggerArm): void {
    if (arm.cron) {
      arm.cron.stop();
      arm.cron = null;
    }
  }
  function clearArmTimer(arm: TriggerArm): void {
    if (arm.timer) {
      clearTimeout(arm.timer);
      arm.timer = null;
    }
  }
  function disposeArm(arm: TriggerArm): void {
    disposeCron(arm);
    clearArmTimer(arm);
    arm.nextRun = null;
  }

  // ---------------------------------------------------------------------------
  // Public: armFlow — rebuild every trigger arm from the current spec. Drops
  // arms for trigger nodes that no longer exist (after a spec.save).
  // ---------------------------------------------------------------------------
  function armFlow(flowId: FlowId): void {
    const flow = spec.get(flowId);
    if (!flow) {
      log(flowId, "#f7768e", `armFlow: flow ${flowId} not loaded`);
      return;
    }

    const wanted = triggerNodes(flow);
    const wantedKeys = new Set(wanted.map((n) => armKey(flowId, n.id)));

    // Tear down arms whose trigger node disappeared from this flow.
    for (const [key, arm] of arms) {
      if (arm.flowId === flowId && !wantedKeys.has(key)) {
        disposeArm(arm);
        arms.delete(key);
      }
    }

    for (const node of wanted) {
      const key = armKey(flowId, node.id);
      const config = node.trigger as TriggerConfig;
      const existing = arms.get(key);
      // SAFE BY DEFAULT: a never-before-seen arm starts PAUSED (dormant). A flow
      // only goes live when the user explicitly plays it (flow.play → resumeFlow),
      // never merely by being loaded/created/spec-saved. We DO preserve a known
      // arm's existing paused state across a re-arm (a spec.save on a flow the user
      // already played must not silently disarm it, nor wake a paused one).
      const paused = existing?.paused ?? true;
      // Reset the arm cleanly before re-arming.
      if (existing) disposeArm(existing);
      const arm: TriggerArm = {
        flowId,
        nodeId: node.id,
        config,
        paused,
        cron: null,
        timer: null,
        nextRun: null,
        firing: false,
      };
      arms.set(key, arm);
      if (!paused) {
        armOne(arm);
      } else {
        // Keep it tracked but dormant; resume (flow.play) will arm it.
        emitNextRun(arm);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public: pauseFlow — cancel every timer for the flow, mark arms paused. The
  // guard's own admission pause is set by the bridge/guard; here we only own the
  // trigger timers (cost safety: a paused flow never auto-fires).
  // ---------------------------------------------------------------------------
  function pauseFlow(flowId: FlowId): void {
    let touched = false;
    for (const arm of arms.values()) {
      if (arm.flowId !== flowId) continue;
      arm.paused = true;
      disposeArm(arm);
      touched = true;
    }
    if (touched) log(flowId, "#e0af68", `triggers paused`);
  }

  // ---------------------------------------------------------------------------
  // Public: resumeFlow — recompute + re-arm, emitting fresh nextRun. NO
  // backfill: nextRun is computed forward from "now".
  // ---------------------------------------------------------------------------
  function resumeFlow(flowId: FlowId): void {
    let touched = false;
    for (const arm of arms.values()) {
      if (arm.flowId !== flowId) continue;
      arm.paused = false;
      armOne(arm);
      touched = true;
    }
    if (touched) log(flowId, "#9ece6a", `triggers resumed`);
  }

  // ---------------------------------------------------------------------------
  // Public: runNow — manual fire. With a triggerNodeId, fires that specific
  // trigger's cause; otherwise prefers a Manual trigger, else the first trigger.
  // Bypasses the schedule but NOT the no-overlap/guard path inside fire().
  // ---------------------------------------------------------------------------
  async function runNow(flowId: FlowId, triggerNodeId?: NodeId): Promise<void> {
    const flow = spec.get(flowId);
    if (!flow) {
      log(flowId, "#f7768e", `runNow: flow ${flowId} not loaded`);
      return;
    }

    // Resolve which arm/node this manual fire is attributed to.
    let arm: TriggerArm | undefined;
    if (triggerNodeId) {
      arm = arms.get(armKey(flowId, triggerNodeId));
      if (!arm) {
        // Trigger exists in spec but wasn't armed (e.g. flow never started):
        // synthesize an ephemeral arm so runNow still works.
        const node = nodeOf(flowId, triggerNodeId);
        if (node?.trigger) {
          arm = ephemeralArm(flowId, triggerNodeId, node.trigger);
        }
      }
    } else {
      const triggers = triggerNodes(flow);
      const manual = triggers.find((n) => n.trigger?.kind === "Manual");
      const chosen = manual ?? triggers[0];
      if (chosen) {
        arm =
          arms.get(armKey(flowId, chosen.id)) ??
          ephemeralArm(flowId, chosen.id, chosen.trigger as TriggerConfig);
      }
    }

    if (!arm) {
      // No trigger node at all — still allow a manual cycle attributed to the flow.
      arm = ephemeralArm(flowId, asNodeId("manual"), { kind: "Manual" });
    }

    // A manual fire always carries the "Manual" cause regardless of the trigger
    // node's configured kind (it's an explicit user/API action). It is `force`d
    // so a dormant (boot-paused) trigger still fires on an explicit runNow — the
    // guard still gates the actual spawn (kill/budget/auth) inside startCycle.
    await fire(arm, "Manual", true);
  }

  function ephemeralArm(flowId: FlowId, nodeId: NodeId, config: TriggerConfig): TriggerArm {
    return {
      flowId,
      nodeId,
      config,
      paused: false,
      cron: null,
      timer: null,
      nextRun: null,
      firing: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Public: nextRunFor / armed.
  // ---------------------------------------------------------------------------
  function nextRunFor(flowId: FlowId, nodeId: NodeId): Date | null {
    return arms.get(armKey(flowId, nodeId))?.nextRun ?? null;
  }

  function armed(): ArmedTrigger[] {
    return [...arms.values()].map((arm) => ({
      flowId: arm.flowId,
      nodeId: arm.nodeId,
      config: arm.config,
      nextRun: arm.nextRun,
      paused: arm.paused,
    }));
  }

  // ---------------------------------------------------------------------------
  // HTTP webhook listener: POST/GET /webhook/:flowId/:event.
  // The bridge attaches its /ws upgrade to this same server (start() leaves the
  // server listening; bridge.attach wires the 'upgrade' event). Any non-webhook
  // request is answered 404 here so the server is self-contained pre-bridge.
  // ---------------------------------------------------------------------------
  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    // Strip query string; normalize.
    const path = url.split("?")[0] ?? "/";
    const parts = path.split("/").filter(Boolean); // ["webhook", flowId, event]

    if (parts[0] !== "webhook") {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    const flowIdRaw = parts[1] ? decodeURIComponent(parts[1]) : "";
    const eventName = parts[2] ? decodeURIComponent(parts[2]) : "";
    if (!flowIdRaw) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "missing_flow" }));
      return;
    }
    const flowId = flowIdRaw as FlowId;

    // Drain the body (we don't require it, but must consume it to free the socket).
    req.resume();

    // Find a matching Webhook trigger: same flow, kind Webhook, event matches
    // (empty configured event = wildcard for this flow).
    const matches = [...arms.values()].filter(
      (a) =>
        a.flowId === flowId &&
        a.config.kind === "Webhook" &&
        (!a.config.event || a.config.event === eventName || !eventName),
    );

    if (matches.length === 0) {
      // Flow not loaded OR no webhook trigger for this event → 404 (no fire).
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "no_webhook_trigger", flowId, event: eventName }));
      return;
    }

    // Ack the webhook immediately; fire asynchronously (don't block the HTTP
    // response on a full agent cycle). Honors no-overlap inside fire().
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, fired: matches.map((m) => String(m.nodeId)) }));

    for (const arm of matches) {
      void fire(arm, "Webhook");
    }
  }

  // ---------------------------------------------------------------------------
  // Public: start — open the shared http server and register every loaded flow's
  // triggers as DORMANT (paused) arms.
  //
  // SAFE BY DEFAULT (cost guarantee): boot is INERT. We do NOT arm any cron job,
  // interval timer, or webhook fire on boot — a freshly-loaded flow holds no live
  // timer and cannot spend a cent until the user explicitly plays it (flow.play →
  // resumeFlow) or fires it (flow.runNow → runNow). We still REGISTER the arms so
  // nextRunFor / the rail know the flow's triggers exist, but every arm starts
  // `paused: true` (no cron, no timer, nextRun null). This makes a runaway loop on
  // an unattended restart impossible: nothing auto-fires.
  // ---------------------------------------------------------------------------
  function start(port: number): Promise<void> {
    if (started) return Promise.resolve();
    started = true;
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        httpServer.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        httpServer.removeListener("error", onError);
        // Register every loaded flow's triggers as DORMANT (paused) arms — boot
        // arms NOTHING live. armFlow honors the per-arm `paused` flag, and a
        // never-before-seen arm defaults to paused (see armFlow), so this is inert.
        for (const flow of spec.all()) {
          armFlow(flow.id);
        }
        log(
          spec.all()[0]?.id ?? ("system" as FlowId),
          "#9ece6a",
          `scheduler listening on :${port} (webhook /webhook/:flowId/:event); ` +
            `${arms.size} trigger(s) registered DORMANT — none armed until flow.play/runNow`,
        );
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port);
    });
  }

  // ---------------------------------------------------------------------------
  // Public: stop — tear down all timers + close the http server.
  // ---------------------------------------------------------------------------
  function stop(): Promise<void> {
    closed = true;
    for (const arm of arms.values()) disposeArm(arm);
    arms.clear();
    return new Promise<void>((resolve) => {
      // Only close if it was ever listening; close() on an unlistened server errors.
      if (!httpServer.listening) {
        resolve();
        return;
      }
      httpServer.close(() => resolve());
    });
  }

  // Reference guard so an unused-import/param lint never trips even if a future
  // refactor stops touching it directly here (the orchestrator owns spawn
  // admission; the scheduler defers to it on every fire).
  void guard;

  return {
    httpServer,
    start,
    armFlow,
    pauseFlow,
    resumeFlow,
    runNow,
    nextRunFor,
    armed,
    stop,
  };
}
