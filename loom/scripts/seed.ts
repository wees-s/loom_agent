// Seed script: validates the reference example flows (examples/*.flow.yaml) AND
// any live flows (flows/*.flow.yaml) against the shared zFlowSpec, then writes
// the daily blackboard seed files. flows/ is EMPTY by default (safe by default),
// so an empty live dir is NOT an error — we still validate examples/.
// Run via: pnpm seed   (node --experimental-sqlite --import tsx scripts/seed.ts)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { zFlowSpec, findForwardCycle } from "@loom/shared";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const flowsDir = join(repoRoot, "flows");
const examplesDir = join(repoRoot, "examples");
const blackboardRoot = join(repoRoot, "blackboard");

function flowFilesIn(dir: string): { dir: string; file: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".flow.yaml"))
    .map((file) => ({ dir, file }));
}

function validateFlows(): void {
  const files = [...flowFilesIn(examplesDir), ...flowFilesIn(flowsDir)];
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[seed] no flow specs found (flows/ empty + no examples/) — nothing to validate");
    return;
  }
  for (const { dir, file } of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    const doc = parse(raw);
    const spec = zFlowSpec.parse(doc);
    const cycle = findForwardCycle(spec.nodes, spec.edges);
    if (cycle) {
      throw new Error(`flow ${spec.id} has a forward cycle: ${cycle.join(" -> ")}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[seed] ok ${file} — ${spec.nodes.length} nodes, ${spec.edges.length} edges`,
    );
  }
}

function seedDailyBlackboard(): void {
  const daily = join(blackboardRoot, "daily");
  mkdirSync(daily, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(daily, "daily-log.md"),
    `# Daily Log — ${today}\n\n_(seed)_\n`,
  );
  writeFileSync(join(daily, "risks.md"), `# Riscos — ${today}\n\n_(seed)_\n`);
  writeFileSync(join(daily, "budget.csv"), `date,usd,tokens\n${today},0,0\n`);
  writeFileSync(
    join(daily, "metrics.json"),
    JSON.stringify({ date: today, cycles: 0, usd: 0 }, null, 2) + "\n",
  );
  writeFileSync(
    join(daily, "decision.md"),
    `# Decisão — ${today}\n\n_(seed)_\n`,
  );
  // eslint-disable-next-line no-console
  console.log(`[seed] wrote blackboard/daily seeds for ${today}`);
}

validateFlows();
seedDailyBlackboard();
// eslint-disable-next-line no-console
console.log("[seed] done");
