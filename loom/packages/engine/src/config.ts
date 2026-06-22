import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// packages/engine/src → repo root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..", "..");

export const PATHS = {
  repoRoot: REPO_ROOT,
  dataDir: resolve(REPO_ROOT, "data"),
  dbFile: resolve(REPO_ROOT, "data", "loom.db"),
  flowsDir: resolve(REPO_ROOT, "flows"),
  blackboardRoot: resolve(REPO_ROOT, "blackboard"),
} as const;

export const PORTS = {
  bridge: 8787,
} as const;

// Default per-flow ceilings applied when a spec omits an explicit budget.
export const DEFAULT_BUDGET = {
  maxCyclesPerArm: 4,
  maxTokensPerRun: 200_000,
  maxUsdPerRun: 2,
  maxTokensPerFlow: 2_000_000,
  maxUsdPerFlow: 20,
  maxConcurrentAgents: 3,
  convergenceWindow: 2,
} as const;

/** WSL → Windows path translation for the Windows-side claude CLI (e.g. /home/x → \\\\wsl... ).
 *  Real translation lands with the runner; this is the seam the runner will call. */
export function toWinPath(posixPath: string): string {
  // /mnt/c/Users/... → C:\Users\...
  const mnt = /^\/mnt\/([a-z])\/(.*)$/.exec(posixPath);
  if (mnt) {
    const drive = mnt[1]!.toUpperCase();
    const rest = mnt[2]!.replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  // anything under the WSL filesystem is reachable via the UNC share.
  return `\\\\wsl.localhost\\Ubuntu${posixPath.replace(/\//g, "\\")}`;
}
