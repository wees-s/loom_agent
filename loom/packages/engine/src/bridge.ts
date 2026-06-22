// =============================================================================
// bridge.ts [bridge] — WebSocket server at /ws (ws package), sharing the
// node:http server with the scheduler's webhook listener.
//
// On connect: send hello {protocolVersion, serverTime, flows: FlowSummary[],
//   models: MODEL_CATALOG, catalog: NODE_TYPE_CATALOG, terminals: Terminal[],
//   sinceSeq}.
// On subscribe{flowId, sinceSeq?}: replay StoredEvents from eventlog.readSince
//   then live-tail.
// Handle ClientCommand validated inbound via zod (zClientCommand):
//   flow.play/pause/kill (guard+scheduler), flow.runNow, flow.create, spec.save
//   (spec.save + reload + flow.snapshot), setTrigger, node.subscribe (reply
//   run.snapshot + nextRun), terminal.open/input.
// ACK EVERY command by cmdId. Events ordered by seq; reconnect is lossless.
// =============================================================================

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { Emit, Unsubscribe } from "./internal.js";
import type { EventLog } from "./eventlog.js";
import type { SpecStore } from "./spec.js";
import type { Scheduler } from "./scheduler.js";
import type { Guard } from "./guard.js";
import type { Terminals } from "./terminals.js";
import type { Orchestrator } from "./orchestrator.js";
import type { Generator } from "./generator.js";

import {
  MODEL_CATALOG,
  NODE_TYPE_CATALOG,
  PROTOCOL_VERSION,
  zClientCommand,
  asFlowId,
  asNodeId,
  asEdgeId,
} from "@loom/shared";
import type {
  ServerMessage,
  StoredEvent,
  FlowId,
  NodeId,
  AgentNode,
  Edge,
  EditableFlow,
  GeneratedFlow,
} from "@loom/shared";

// =============================================================================
// Public interface
// =============================================================================

export interface Bridge {
  /** Attach the ws server to the shared http server's `upgrade` at path /ws. */
  attach(httpServer: HttpServer): void;

  /** Number of currently-connected clients (status/debug). */
  clientCount(): number;

  /** Close all sockets and the ws server (engine shutdown). */
  close(): Promise<void>;
}

// =============================================================================
// Internal per-client state
// =============================================================================

interface ClientState {
  /** Subscribed flows: flowId → sinceSeq cursor for that flow's replay. */
  subscriptions: Map<string, number>;
  /** Unsub handle for the eventlog live-tail. Null until the first subscribe. */
  unsubEvents: Unsubscribe | null;
  /** Unsub handle for terminal.data. Null until first attach. */
  unsubTerminal: Unsubscribe | null;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Build the bridge. It reads projections from `eventlog` (summaries + replay),
 * routes validated ClientCommands to spec/scheduler/guard/terminals/orchestrator,
 * live-tails eventlog + terminals.onData to subscribers, and acks every command.
 */
/** Map a validated GeneratedFlow onto an EditableFlow for spec.save. Auto-grids
 *  any missing node positions so the canvas lays them out left-to-right. */
function generatedToEditable(gen: GeneratedFlow, id: FlowId): EditableFlow {
  const nodes = gen.nodes.map((n, i) => ({
    id: asNodeId(n.id),
    type: n.type as AgentNode["type"],
    title: n.title,
    role: n.role,
    model: (n.model ?? "claude-sonnet-4-6") as AgentNode["model"],
    prompt: n.prompt,
    linkedContexts: [] as string[],
    position: n.position ?? { x: 120 + i * 240, y: 200 },
    ...(n.produces ? { produces: n.produces } : {}),
    ...(n.trigger ? { trigger: n.trigger } : {}),
    ...(n.contextIsolation !== undefined ? { contextIsolation: n.contextIsolation } : {}),
  }));
  const edges = gen.edges.map((e, i) => ({
    id: asEdgeId(`e_${i}`),
    from: asNodeId(e.from),
    to: asNodeId(e.to),
    ...(e.feedback ? { feedback: e.feedback } : {}),
  }));
  return {
    id,
    name: gen.name,
    nodes,
    edges,
    ...(gen.reviewEachCycle !== undefined ? { reviewEachCycle: gen.reviewEachCycle } : {}),
  };
}

export function createBridge(
  eventlog: EventLog,
  spec: SpecStore,
  scheduler: Scheduler,
  guard: Guard,
  terminals: Terminals,
  orchestrator: Orchestrator,
  generator: Generator,
  emit: Emit,
): Bridge {
  // The ws server instance. Created eagerly; attached lazily via attach().
  const wss = new WebSocketServer({ noServer: true });
  let closed = false;

  // Per-client bookkeeping: ws → state.
  const clients = new Map<WebSocket, ClientState>();

  // -------------------------------------------------------------------------
  // Serialisation helpers
  // -------------------------------------------------------------------------

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closed mid-send; ignore — the close event will clean up.
    }
  }

  // -------------------------------------------------------------------------
  // Hello message: full state snapshot sent on every fresh connection.
  // -------------------------------------------------------------------------

  function sendHello(ws: WebSocket): void {
    const sinceSeq = eventlog.latestSeq();
    const msg: ServerMessage = {
      t: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverTime: new Date().toISOString(),
      flows: eventlog.projectFlowSummaries(),
      models: MODEL_CATALOG,
      catalog: NODE_TYPE_CATALOG,
      terminals: terminals.list(),
      sinceSeq,
    };
    send(ws, msg);
  }

  // -------------------------------------------------------------------------
  // Live-tail: subscribe the client to the eventlog + terminal data streams.
  // Called the first time a client sends any subscribe command.
  // -------------------------------------------------------------------------

  function ensureLiveTail(ws: WebSocket, state: ClientState): void {
    // eventlog live-tail — fan out ALL events to every subscriber (clients that
    // subscribed to specific flows filter below).
    if (!state.unsubEvents) {
      state.unsubEvents = eventlog.subscribe((stored) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Only relay if this client has a subscription that covers this event's flow.
        // For events without a flowId (e.g. auth.state, terminal.state) we relay
        // unconditionally since the client needs global system events.
        const ev = stored.event;
        const flowId: string | undefined =
          "flowId" in ev ? (ev as { flowId: string }).flowId : undefined;

        const subscribed = state.subscriptions.size > 0;
        const matchesFlow =
          !flowId ||
          state.subscriptions.has(flowId) ||
          // auth.state / terminal.state / log (system-wide) events go to all subscribers.
          ev.type === "auth.state" ||
          ev.type === "terminal.state";

        if (subscribed && matchesFlow) {
          send(ws, { t: "event", events: [stored] });
        }
      });
    }

    // terminal.data live-tail. Once armed (the client subscribed to a flow OR
    // opened a terminal) we relay every pane chunk — terminals are a global rail
    // surface, not scoped to a single flow subscription.
    if (!state.unsubTerminal) {
      state.unsubTerminal = terminals.onData((terminal, chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        send(ws, { t: "terminal.data", terminal, chunk });
      });
    }
  }

  // -------------------------------------------------------------------------
  // subscribe handler: replay stored events then arm live tail.
  // -------------------------------------------------------------------------

  function handleSubscribe(
    ws: WebSocket,
    state: ClientState,
    flowId: FlowId,
    sinceSeq: number,
  ): void {
    state.subscriptions.set(flowId as string, sinceSeq);
    ensureLiveTail(ws, state);

    // Replay stored events for this flow since the client's cursor.
    const stored: StoredEvent[] = eventlog.readSince(sinceSeq).filter((se) => {
      const ev = se.event;
      const fid = "flowId" in ev ? (ev as { flowId: string }).flowId : undefined;
      return !fid || fid === (flowId as string);
    });

    if (stored.length > 0) {
      send(ws, { t: "event", events: stored });
    }

    // Also send the current flow snapshot (hot topology).
    const flow = spec.get(flowId);
    if (flow) {
      send(ws, { t: "flow.snapshot", flow });
    }
  }

  // -------------------------------------------------------------------------
  // ack helper
  // -------------------------------------------------------------------------

  function ack(ws: WebSocket, cmdId: string, ok: boolean, error?: string): void {
    send(ws, { t: "ack", cmdId, ok, error });
  }

  // -------------------------------------------------------------------------
  // Command dispatcher — one branch per ClientCommand variant.
  // -------------------------------------------------------------------------

  async function handleCommand(ws: WebSocket, raw: unknown): Promise<void> {
    // zod-validate the inbound command at the trust boundary.
    const parsed = zClientCommand.safeParse(raw);
    if (!parsed.success) {
      // If we can extract a cmdId, ack with the error; otherwise send an error msg.
      const cmdId = (raw as { cmdId?: unknown }).cmdId;
      if (typeof cmdId === "string") {
        ack(ws, cmdId, false, `invalid command: ${parsed.error.message}`);
      } else {
        send(ws, {
          t: "error",
          code: "invalid_command",
          message: parsed.error.message,
        });
      }
      return;
    }

    const cmd = parsed.data;
    const state = clients.get(ws);
    if (!state) return; // client already disconnected

    // subscribe is special: no cmdId, drives live tail + replay.
    if (cmd.t === "subscribe") {
      const flowId = asFlowId(cmd.flowId);
      handleSubscribe(ws, state, flowId, cmd.sinceSeq ?? 0);
      return;
    }

    // Every other command carries cmdId; wrap in try/catch and ack.
    try {
      switch (cmd.t) {
        // ----- flow.play -------------------------------------------------------
        case "flow.play": {
          const flowId = asFlowId(cmd.flowId);
          // EXPLICIT START: arm the guard (a freshly-loaded flow is un-armed and
          // cannot spend until this), clear pause, and wake the scheduler's
          // dormant triggers (resumeFlow arms cron/interval forward from now).
          guard.setFlowArmed(flowId, true);
          guard.setFlowPaused(flowId, false);
          scheduler.resumeFlow(flowId);
          emit({
            type: "flow.stateChanged",
            flowId,
            state: "ocioso",
          });
          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- flow.pause ------------------------------------------------------
        case "flow.pause": {
          const flowId = asFlowId(cmd.flowId);
          // Pause DISARMS: the flow returns to the inert, safe-by-default state —
          // no trigger fires and no spawn is admitted until the user plays again.
          guard.setFlowArmed(flowId, false);
          guard.setFlowPaused(flowId, true);
          scheduler.pauseFlow(flowId);
          orchestrator.clearAwaiting(flowId);
          emit({
            type: "flow.stateChanged",
            flowId,
            state: "pausado",
          });
          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- flow.kill -------------------------------------------------------
        case "flow.kill": {
          const flowId = asFlowId(cmd.flowId);
          // killFlow disarms the guard; also disarm the scheduler triggers.
          await guard.killFlow(flowId, "user");
          scheduler.pauseFlow(flowId);
          orchestrator.clearAwaiting(flowId);
          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- flow.generate --------------------------------------------------
        case "flow.generate": {
          // NL authoring: a meta-agent (real) or a canned flow (fake) produces a
          // validated GeneratedFlow, which we persist via the SAME validated path
          // as a hand-built flow (spec.create + spec.save → acyclic + single-writer
          // + ≥1 Trigger lint). Bounded one-shot cost; pre-flow, so no guard/budget.
          const result = await generator.generate(cmd.prompt);
          if (!result.ok) {
            emit({ type: "log", flowId: asFlowId("—"), color: "rose", msg: `geração falhou: ${result.error}`, at: Date.now() });
            ack(ws, cmd.cmdId, false, result.error);
            break;
          }
          const created = await spec.create(result.flow.name);
          const editable = generatedToEditable(result.flow, created.flow.id);
          const saved = await spec.save(editable);
          scheduler.armFlow(saved.flow.id); // dormant — safe by default
          broadcastAll({ t: "flow.snapshot", flow: saved.flow });
          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- flow.continue --------------------------------------------------
        case "flow.continue": {
          const flowId = asFlowId(cmd.flowId);
          // Human-in-the-loop: resume a flow paused at a cycle checkpoint. The
          // orchestrator holds the already-admitted next arm; null means nothing
          // was awaiting (e.g. after a restart lost the in-memory pending).
          const resumed = await orchestrator.continueFlow(flowId);
          if (resumed === null) {
            // Unstick the projected state so the UI's "aguardando" doesn't linger
            // with a dead Continue button, then report the no-op.
            emit({ type: "flow.stateChanged", flowId, state: "ocioso" });
            ack(ws, cmd.cmdId, false, "nada aguardando aprovação neste fluxo");
          } else {
            ack(ws, cmd.cmdId, true);
          }
          break;
        }

        // ----- flow.runNow ----------------------------------------------------
        case "flow.runNow": {
          const flowId = asFlowId(cmd.flowId);
          const triggerNodeId = cmd.triggerNodeId
            ? asNodeId(cmd.triggerNodeId)
            : undefined;
          // runNow is an EXPLICIT start: arm the guard for this single manual
          // cycle (the scheduler force-fires a dormant trigger; the guard still
          // gates the spawn on budget/auth). Fire-and-forget — the client tracks
          // progress via event replay; ack immediately after dispatch.
          guard.setFlowArmed(flowId, true);
          void scheduler.runNow(flowId, triggerNodeId);
          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- flow.create ----------------------------------------------------
        case "flow.create": {
          const result = await spec.create(cmd.name);
          // Register the new flow's triggers in the scheduler as DORMANT (armFlow
          // defaults a never-seen arm to paused) — a freshly-created flow is inert
          // and does not arm/fire until the user explicitly plays it.
          scheduler.armFlow(result.flow.id);
          // Broadcast the new flow spec + upsert to all connected clients.
          broadcastAll({ t: "flow.snapshot", flow: result.flow });
          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- flow.delete ----------------------------------------------------
        case "flow.delete": {
          const flowId = asFlowId(cmd.flowId);
          // 1. DISARM + KILL first so no trigger fires and no run survives the
          //    delete (kill aborts live runs + disarms the guard).
          await guard.killFlow(flowId, "user");
          guard.setFlowArmed(flowId, false);
          scheduler.pauseFlow(flowId);
          orchestrator.clearAwaiting(flowId);
          // 2. Archive the YAML (never hard-rm) + drop from the spec cache.
          const result = await spec.delete(flowId);
          // 3. Emit the removal so every client's projection drops the flow from
          //    the rail (and clears it if it was selected). flow.removed is folded
          //    in the eventlog projection + the web store.
          emit({ type: "flow.removed", flowId, at: Date.now() });
          ack(ws, cmd.cmdId, true);
          // 4. Surface where it was archived (operator can recover by hand).
          if (result.archivedPath) {
            emit({
              type: "log",
              flowId,
              color: "#7aa2f7",
              msg: `fluxo excluído — spec arquivada em ${result.archivedPath}`,
              at: Date.now(),
            });
          }
          break;
        }

        // ----- spec.save ------------------------------------------------------
        case "spec.save": {
          const editableFlow = cmd.flow;
          const flowId = asFlowId(editableFlow.id);

          // The zod schema validates nodes/edges but returns plain strings for ids.
          // Coerce them to branded types so spec.save's type contract is satisfied.
          const coercedNodes: AgentNode[] = editableFlow.nodes.map((n) => ({
            ...n,
            id: asNodeId(n.id),
            type: n.type as AgentNode["type"],
            model: n.model as AgentNode["model"],
          }));
          const coercedEdges: Edge[] = editableFlow.edges.map((e) => ({
            ...e,
            id: asEdgeId(e.id),
            from: asNodeId(e.from),
            to: asNodeId(e.to),
          }));

          const result = await spec.save({
            id: flowId,
            name: editableFlow.name,
            nodes: coercedNodes,
            edges: coercedEdges,
          });

          // Re-arm triggers with the updated spec.
          scheduler.armFlow(flowId);

          // Push the hot-reloaded flow to ALL clients.
          broadcastAll({ t: "flow.snapshot", flow: result.flow });

          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- setTrigger -----------------------------------------------------
        case "setTrigger": {
          const flowId = asFlowId(cmd.flowId);
          const nodeId = asNodeId(cmd.nodeId);
          const flow = spec.get(flowId);
          if (!flow) {
            ack(ws, cmd.cmdId, false, `flow ${cmd.flowId} not loaded`);
            break;
          }

          // Patch the trigger on the node, then persist through spec.save.
          const updatedNodes = flow.nodes.map((n) => {
            if (n.id === nodeId) {
              return { ...n, trigger: cmd.trigger };
            }
            return n;
          });

          const result = await spec.save({
            id: flowId,
            name: flow.name,
            nodes: updatedNodes,
            edges: flow.edges,
          });

          // Re-arm the updated trigger.
          scheduler.armFlow(flowId);

          // Push the updated flow snapshot.
          broadcastAll({ t: "flow.snapshot", flow: result.flow });

          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- node.subscribe -------------------------------------------------
        case "node.subscribe": {
          const nodeId = asNodeId(cmd.nodeId);
          const flowId = asFlowId(cmd.flowId);

          // Ensure the client is subscribed to this flow's event stream.
          if (!state.subscriptions.has(flowId as string)) {
            handleSubscribe(ws, state, flowId, eventlog.latestSeq());
          }

          // Reply with recent runs snapshot.
          const runs = eventlog.recentRuns(nodeId);
          send(ws, { t: "run.snapshot", nodeId, runs });

          // Reply with next scheduled run.
          const nextRun = scheduler.nextRunFor(flowId, nodeId);
          send(ws, {
            t: "nextRun",
            nodeId,
            iso: nextRun ? nextRun.toISOString() : null,
          });

          ack(ws, cmd.cmdId, true);
          break;
        }

        // ----- terminal.open --------------------------------------------------
        case "terminal.open": {
          try {
            const term = await terminals.ensure(cmd.terminal);
            // Ensure this client is on the terminal.data live-tail even if it has
            // not subscribed to a flow yet (so it sees future chunks).
            ensureLiveTail(ws, state);
            // Push the updated terminal list to all clients.
            broadcastAll({ t: "terminal.snapshot", terminals: terminals.list() });
            // Replay what we have so the client catches up to the live stream:
            // prefer the bounded live buffer (incremental pane output we already
            // streamed), falling back to a one-shot capture-pane snapshot.
            const replay = terminals.recentOutput(term.id);
            const initial =
              replay.length > 0 ? replay : await terminals.capturePane(term.id);
            if (initial.length > 0) {
              send(ws, { t: "terminal.data", terminal: term.id, chunk: initial });
            }
            ack(ws, cmd.cmdId, true);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ack(ws, cmd.cmdId, false, `terminal.open failed: ${message}`);
          }
          break;
        }

        // ----- terminal.input -------------------------------------------------
        case "terminal.input": {
          try {
            await terminals.send(cmd.terminal, cmd.data);
            ack(ws, cmd.cmdId, true);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ack(ws, cmd.cmdId, false, `terminal.input failed: ${message}`);
          }
          break;
        }

        default: {
          // Exhaustiveness guard — TypeScript will catch unhandled variants at
          // compile time; this branch handles unexpected runtime shapes.
          const exhaustive: never = cmd;
          void exhaustive;
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only commands with cmdId reach here.
      if ("cmdId" in cmd && typeof cmd.cmdId === "string") {
        ack(ws, cmd.cmdId, false, message);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast to every connected client.
  // -------------------------------------------------------------------------

  function broadcastAll(msg: ServerMessage): void {
    for (const ws of clients.keys()) {
      send(ws, msg);
    }
  }

  // -------------------------------------------------------------------------
  // Subscribe this bridge to the global eventlog for broadcasted system events
  // (auth.state, terminal.state) that all clients should receive regardless of
  // per-flow subscriptions.
  // -------------------------------------------------------------------------

  // Subscribe to terminal data to broadcast to clients even without a flow sub.
  const _globalTermUnsub = terminals.onData((terminal, chunk) => {
    // Individual client unsubTerminal handlers handle per-client filtering.
    // This no-op reference keeps the pattern consistent; actual relay happens
    // per-client in ensureLiveTail.
    void terminal;
    void chunk;
  });
  void _globalTermUnsub; // Bridge lives for the engine lifetime; no teardown needed.

  // Subscribe to eventlog for global system events to broadcast to ALL clients
  // (not just those subscribed to a specific flow).
  const _globalEvUnsub = eventlog.subscribe((stored) => {
    const ev = stored.event;
    // System-wide events broadcast to all open connections.
    if (ev.type === "auth.state" || ev.type === "terminal.state") {
      broadcastAll({ t: "event", events: [stored] });
    }
  });
  void _globalEvUnsub;

  // -------------------------------------------------------------------------
  // WebSocket connection lifecycle.
  // -------------------------------------------------------------------------

  wss.on("connection", (ws: WebSocket) => {
    if (closed) {
      ws.close(1001, "server shutting down");
      return;
    }

    const state: ClientState = {
      subscriptions: new Map(),
      unsubEvents: null,
      unsubTerminal: null,
    };
    clients.set(ws, state);

    // Immediately send the hello snapshot.
    sendHello(ws);

    ws.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString("utf8")
              : Buffer.concat(data as Buffer[]).toString("utf8"),
        );
      } catch {
        send(ws, {
          t: "error",
          code: "parse_error",
          message: "message is not valid JSON",
        });
        return;
      }
      void handleCommand(ws, raw);
    });

    ws.on("close", () => {
      const st = clients.get(ws);
      if (st) {
        st.unsubEvents?.();
        st.unsubTerminal?.();
        clients.delete(ws);
      }
    });

    ws.on("error", (err) => {
      // Log non-fatally; the close event will clean up.
      emit({
        type: "log",
        flowId: "system" as FlowId,
        color: "#f7768e",
        msg: `ws client error: ${err instanceof Error ? err.message : String(err)}`,
        at: Date.now(),
      });
    });
  });

  wss.on("error", (err) => {
    emit({
      type: "log",
      flowId: "system" as FlowId,
      color: "#f7768e",
      msg: `ws server error: ${err instanceof Error ? err.message : String(err)}`,
      at: Date.now(),
    });
  });

  // -------------------------------------------------------------------------
  // Public Bridge interface
  // -------------------------------------------------------------------------

  function attach(httpServer: HttpServer): void {
    httpServer.on("upgrade", (request, socket, head) => {
      const url = request.url ?? "";
      const pathname = url.split("?")[0] ?? "";
      if (pathname !== "/ws") {
        // Not our path — let the request fall through (or destroy for a clean 404).
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
  }

  function clientCount(): number {
    return clients.size;
  }

  function close(): Promise<void> {
    closed = true;
    // Cleanly close all client sockets.
    for (const [ws, state] of clients) {
      state.unsubEvents?.();
      state.unsubTerminal?.();
      try {
        ws.close(1001, "server shutting down");
      } catch {
        /* ignore already-closed */
      }
    }
    clients.clear();

    return new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { attach, clientCount, close };
}

// Re-export for callers that need the NodeId coercion without importing @loom/shared.
export type { FlowId, NodeId };
