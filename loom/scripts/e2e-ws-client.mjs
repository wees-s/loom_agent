// Loom LIVE E2E ws client — proves the exact UI<->engine path.
// Connects to the engine bridge /ws, awaits hello, subscribes to a flow,
// sends a flow.runNow ClientCommand, and asserts the command is acked AND
// that live events (cycle.started -> run.* -> cycle.ended) stream back.
//
// Usage: node scripts/e2e-ws-client.mjs <wsUrl> <flowId>
// Resolves `ws` from @loom/engine's node_modules (run from repo root).

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// Resolve `ws` from @loom/engine's installed deps (run from repo root/scripts).
const here = dirname(fileURLToPath(import.meta.url));
const enginePkgJson = resolve(here, "..", "packages", "engine", "package.json");
const require = createRequire(enginePkgJson);
const WebSocket = require("ws");

const url = process.argv[2] || "ws://127.0.0.1:8799/ws";
const flowId = process.argv[3] || "daily-standup";
const cmdId = "e2e-" + Math.random().toString(36).slice(2, 10);

const seen = {
  hello: false,
  ack: false,
  ackOk: false,
  cycleStarted: false,
  triggerFired: false,
  runStarted: 0,
  runToken: 0,
  runFinished: 0,
  cycleEnded: false,
  cycleEndedStatus: null,
  nodeActivated: 0,
};
const eventTypes = new Set();

let helloSinceSeq = 0;
const HARD_TIMEOUT_MS = 30_000;
let done = false;

function finish(code, why) {
  if (done) return;
  done = true;
  console.log("E2E_RESULT " + JSON.stringify({ why, ...seen, eventTypes: [...eventTypes].sort() }));
  try { ws.close(); } catch {}
  // Decide pass/fail.
  const pass =
    seen.hello &&
    seen.ack && seen.ackOk &&
    seen.cycleStarted &&
    seen.runStarted > 0 &&
    seen.runFinished > 0 &&
    seen.cycleEnded;
  if (code === undefined) code = pass ? 0 : 1;
  console.log(pass ? "E2E_VERDICT=PASS" : "E2E_VERDICT=FAIL");
  process.exit(code);
}

const hardTimer = setTimeout(() => finish(1, "hard-timeout"), HARD_TIMEOUT_MS);
hardTimer.unref?.();

const ws = new WebSocket(url);

ws.on("open", () => {
  console.log("WS_OPEN " + url);
});

ws.on("message", (data) => {
  let msg;
  try { msg = JSON.parse(data.toString("utf8")); } catch { return; }

  if (msg.t === "hello") {
    seen.hello = true;
    helloSinceSeq = msg.sinceSeq ?? 0;
    console.log(`HELLO protocol=${msg.protocolVersion} models=${msg.models?.length} catalog=${msg.catalog?.length} flows=${msg.flows?.length} sinceSeq=${helloSinceSeq}`);
    // 1) subscribe to the flow so the live-tail starts (UI does this first).
    ws.send(JSON.stringify({ t: "subscribe", flowId, sinceSeq: helloSinceSeq }));
    console.log(`SENT subscribe flowId=${flowId} sinceSeq=${helloSinceSeq}`);
    // 2) then fire runNow after a short beat so the subscription is registered.
    setTimeout(() => {
      ws.send(JSON.stringify({ t: "flow.runNow", cmdId, flowId }));
      console.log(`SENT flow.runNow cmdId=${cmdId} flowId=${flowId}`);
    }, 250);
    return;
  }

  if (msg.t === "flow.snapshot") {
    console.log(`FLOW_SNAPSHOT id=${msg.flow?.id} state=${msg.flow?.state} nodes=${msg.flow?.nodes?.length}`);
    return;
  }

  if (msg.t === "ack" && msg.cmdId === cmdId) {
    seen.ack = true;
    seen.ackOk = !!msg.ok;
    console.log(`ACK cmdId=${msg.cmdId} ok=${msg.ok}${msg.error ? " error=" + msg.error : ""}`);
    return;
  }

  if (msg.t === "event" && Array.isArray(msg.events)) {
    for (const stored of msg.events) {
      const ev = stored.event ?? stored;
      const type = ev.type;
      if (!type) continue;
      eventTypes.add(type);
      switch (type) {
        case "cycle.started": seen.cycleStarted = true; console.log(`EV cycle.started cycle=${ev.cycle}`); break;
        case "trigger.fired": seen.triggerFired = true; break;
        case "node.activated": seen.nodeActivated++; break;
        case "run.started": seen.runStarted++; console.log(`EV run.started #${seen.runStarted} node=${ev.nodeId} model=${ev.model}`); break;
        case "run.token": seen.runToken++; break;
        case "run.finished": seen.runFinished++; console.log(`EV run.finished #${seen.runFinished} status=${ev.status}`); break;
        case "cycle.ended":
          seen.cycleEnded = true;
          seen.cycleEndedStatus = ev.status;
          console.log(`EV cycle.ended status=${ev.status} cycle=${ev.cycle} totalUsd=${ev.totalUsd}`);
          // Give a brief grace for any trailing events, then finish.
          setTimeout(() => finish(undefined, "cycle.ended"), 400);
          break;
        default: break;
      }
    }
    return;
  }
});

ws.on("error", (err) => {
  console.log("WS_ERROR " + (err?.message || String(err)));
  finish(1, "ws-error");
});

ws.on("close", () => {
  if (!done) console.log("WS_CLOSE (premature)");
});
