// Diagnostic ws client: connect to a URL, wait for the first server message,
// retry until a deadline. Run from the repo root so `ws` resolves.
import { createRequire } from "node:module";
// `ws` is a dependency of @loom/engine; resolve it from there regardless of cwd.
const require = createRequire("/home/wesley/WORKSPACE/loom/packages/engine/index.js");
const WebSocket = require("ws");

const url = process.argv[2];
const deadlineMs = Number(process.argv[3] ?? 25000);
const start = Date.now();

function attempt() {
  const ws = new WebSocket(url);
  let got = false;
  const to = setTimeout(() => { try { ws.close(); } catch {} }, 3000);

  ws.on("message", (d) => {
    got = true;
    clearTimeout(to);
    let info = "?";
    try {
      const m = JSON.parse(d.toString());
      info = `t=${m.t}` + (m.t === "hello" ? ` protocol=${m.protocolVersion} flows=${m.flows?.length} models=${m.models?.length} catalog=${m.catalog?.length}` : "");
    } catch {}
    console.log(`OK  ${url}  -> first message ${info}`);
    try { ws.close(); } catch {}
    process.exit(0);
  });
  ws.on("error", () => {});
  ws.on("close", () => {
    clearTimeout(to);
    if (got) return;
    if (Date.now() - start > deadlineMs) {
      console.log(`FAIL ${url} (no message within ${deadlineMs}ms)`);
      process.exit(1);
    }
    setTimeout(attempt, 800);
  });
}
attempt();
