// Dump the Loom event log from a sqlite db for inspection.
// Usage: node --experimental-sqlite scripts/dump-events.mjs <dbFile>
import { DatabaseSync } from "node:sqlite";

const dbFile = process.argv[2];
if (!dbFile) { console.error("usage: dump-events.mjs <dbFile>"); process.exit(2); }

const db = new DatabaseSync(dbFile);
const rows = db.prepare("SELECT seq, ts, type, json FROM events ORDER BY seq ASC").all();

let totalUsd = 0;
let totalTokens = 0;
const finals = {}; // runId -> {usage, costUsd}

for (const r of rows) {
  const ev = JSON.parse(r.json);
  switch (ev.type) {
    case "run.started":
      console.log(`#${r.seq} run.started node=${ev.nodeId} model=${ev.model} cycle=${ev.cycle}`);
      break;
    case "run.token": {
      const u = ev.usage;
      finals[ev.runId] = { usage: u, costUsd: ev.costUsd };
      console.log(`#${r.seq} run.token run=${ev.runId} in=${u.inputTokens} out=${u.outputTokens} cacheR=${u.cacheReadTokens} cacheW=${u.cacheWriteTokens} costUsd=${ev.costUsd}`);
      break;
    }
    case "run.tool":
      console.log(`#${r.seq} run.tool run=${ev.runId} tool=${ev.tool?.name}`);
      break;
    case "run.finished":
      console.log(`#${r.seq} run.finished run=${ev.runId} status=${ev.status}${ev.resultSummary ? " summary=" + JSON.stringify(ev.resultSummary) : ""}${ev.error ? " error=" + JSON.stringify(ev.error.slice(0,200)) : ""}`);
      break;
    case "cycle.started":
      console.log(`#${r.seq} cycle.started cycle=${ev.cycle}`);
      break;
    case "cycle.ended":
      console.log(`#${r.seq} cycle.ended cycle=${ev.cycle} status=${ev.status} totalUsd=${ev.totalUsd}`);
      break;
    case "blackboard.write":
      console.log(`#${r.seq} blackboard.write path=${ev.path} bytes=${ev.bytes} hash=${ev.hash?.slice(0,12)} by=${ev.byNodeId}`);
      break;
    case "trigger.fired":
      console.log(`#${r.seq} trigger.fired node=${ev.nodeId} cause=${ev.cause}`);
      break;
    case "budget.tripped":
      console.log(`#${r.seq} budget.tripped scope=${ev.scope} metric=${ev.metric} limit=${ev.limit}`);
      break;
    case "auth.state":
      console.log(`#${r.seq} auth.state ok=${ev.ok} detail=${ev.detail}`);
      break;
    case "log":
      console.log(`#${r.seq} log[${ev.color}] ${ev.msg}`);
      break;
    case "kill.requested":
      console.log(`#${r.seq} kill.requested by=${ev.by}`);
      break;
    default:
      // node.activated/deactivated/edge.fired/flow.* — quieter
      break;
  }
}

for (const [runId, f] of Object.entries(finals)) {
  const u = f.usage;
  totalUsd += f.costUsd || 0;
  totalTokens += (u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens);
}

console.log("=====================================================");
console.log(`REAL_TOTAL_COST_USD=${totalUsd}`);
console.log(`REAL_TOTAL_TOKENS=${totalTokens}`);
console.log(`EVENT_ROWS=${rows.length}`);
db.close();
