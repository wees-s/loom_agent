// =============================================================================
// auth.ts [auth] — boot pre-flight health check for the Windows claude CLI.
//
// Spawns a tiny `claude -p "<probe>" --output-format stream-json --verbose
// --model haiku` from WSL, resolves {ok, detail}, and emits auth.state.
// NON-FATAL at boot (warn + allow boot), but guard MUST refuse to start cycles
// until auth is ok (guard reads `isReady()`).
//
// Design notes:
//  - `claude` resolves from WSL to the already-authed Windows CLI (OAuth login;
//    apiKeySource "none"). We spawn with an ARGV ARRAY (never a shell string) and
//    feed the probe prompt over STDIN to survive the Git Bash → wsl.exe → Windows
//    bridge and argv-length limits.
//  - permissionMode is left at "default": the health probe asks NOTHING that
//    triggers a tool call, so it will not prompt/hang. We additionally pass
//    --max-turns 1 and disallow tools defensively so the probe stays read-only
//    and bounded.
//  - We parse the stream-json NDJSON inline (a tiny self-contained reader rather
//    than depending on streamParser) so auth has no cross-module runtime coupling
//    and can health-check even before peer modules land. Success = the CLI emits
//    a terminal `result` event (or at minimum a `system/init` handshake) on a
//    clean exit; failure = non-zero exit, spawn error, timeout, or an explicit
//    auth/login error in the stream.
//  - preflight ALWAYS resolves (never rejects): boot is non-fatal. Failures are
//    captured in {ok:false, detail} and emitted as auth.state so the UI/log sees
//    them; guard then keeps cycles closed until a later preflight succeeds.
// =============================================================================

import { spawn } from "node:child_process";
import type { Emit } from "./internal.js";

// -----------------------------------------------------------------------------
// Public contract (pinned). Re-declared here so the module typechecks in
// isolation and matches the spine's auth.ts summary exactly.
// -----------------------------------------------------------------------------

export interface AuthStatus {
  ok: boolean;
  /** Human-readable reason, e.g. "claude v2.1.183, oauth" or the failure text. */
  detail: string;
  /** When the last health check completed (epoch ms). */
  checkedAt: number;
}

export interface AuthService {
  /**
   * Run the health-check spawn (haiku, tiny prompt), emit auth.state, cache the
   * result. Resolves even on failure (non-fatal at boot). `signal` lets the
   * boot sequence bound the probe.
   */
  preflight(signal?: AbortSignal): Promise<AuthStatus>;

  /** Last cached status without re-spawning (null before first preflight). */
  current(): AuthStatus | null;

  /** Guard chokepoint: true once a preflight has succeeded. */
  isReady(): boolean;
}

// -----------------------------------------------------------------------------
// Tunables.
// -----------------------------------------------------------------------------

/** Binary name; resolves on PATH from a WSL login shell to the Windows CLI. */
const CLAUDE_BIN = process.env.LOOM_CLAUDE_BIN ?? "claude";

/** Cheapest model for the probe (alias resolves to claude-haiku-4-5). */
const PROBE_MODEL = process.env.LOOM_AUTH_PROBE_MODEL ?? "haiku";

/**
 * The probe prompt. Must be answerable with no tools and a single token-ish
 * reply so the run is near-free and never prompts. We ask for a literal so we
 * can sanity-check the round trip if needed.
 */
const PROBE_PROMPT = 'Reply with exactly the word: ok';

/** Hard ceiling on the probe (ms); a stuck CLI must not wedge boot. */
const PROBE_TIMEOUT_MS = Number(process.env.LOOM_AUTH_TIMEOUT_MS ?? 30_000);

/**
 * Substrings (lower-cased) in the stream/stderr that mean "authenticated CLI is
 * not usable" — surfaced verbatim-ish in the detail so the operator can act.
 */
const AUTH_FAILURE_HINTS = [
  "not logged in",
  "please log in",
  "please run /login",
  "run `claude login`",
  "run claude login",
  "authentication",
  "unauthorized",
  "401",
  "invalid api key",
  "no credentials",
  "credentials",
  "session expired",
];

// -----------------------------------------------------------------------------
// Inline NDJSON scan result. We only extract what the health verdict needs.
// -----------------------------------------------------------------------------

interface ProbeScan {
  /** Saw the {type:"system",subtype:"init"} handshake (CLI started a session). */
  sawInit: boolean;
  /** Saw a terminal {type:"result"} line (the run completed end to end). */
  sawResult: boolean;
  /** result.is_error / result.subtype==="error_*" — the CLI reported failure. */
  resultIsError: boolean;
  /** CLI/SDK version string if the init line carried one. */
  cliVersion: string | null;
  /** apiKeySource if present ("none" => OAuth login, the expected path). */
  apiKeySource: string | null;
  /** A concise human result string if the CLI emitted one. */
  resultText: string | null;
  /** First auth-shaped error text we noticed, if any. */
  authError: string | null;
}

function emptyScan(): ProbeScan {
  return {
    sawInit: false,
    sawResult: false,
    resultIsError: false,
    cliVersion: null,
    apiKeySource: null,
    resultText: null,
    authError: null,
  };
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function detectAuthError(haystack: string): string | null {
  const lower = haystack.toLowerCase();
  for (const hint of AUTH_FAILURE_HINTS) {
    if (lower.includes(hint)) {
      // Return a trimmed slice of the offending text for the detail.
      return haystack.trim().slice(0, 200);
    }
  }
  return null;
}

/**
 * Fold one NDJSON line into the running scan. Tolerant: unknown/blank/non-JSON
 * lines are ignored (the CLI occasionally interleaves non-JSON banners).
 */
function foldLine(scan: ProbeScan, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return;
    obj = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON noise; still scan it for an auth-shaped failure banner.
    if (!scan.authError) scan.authError = detectAuthError(trimmed);
    return;
  }

  const type = asString(obj["type"]);

  if (type === "system" && asString(obj["subtype"]) === "init") {
    scan.sawInit = true;
    scan.cliVersion =
      asString(obj["version"]) ??
      asString(obj["cli_version"]) ??
      scan.cliVersion;
    scan.apiKeySource =
      asString(obj["apiKeySource"]) ??
      asString(obj["api_key_source"]) ??
      scan.apiKeySource;
    return;
  }

  if (type === "result") {
    scan.sawResult = true;
    const isError = obj["is_error"];
    const subtype = asString(obj["subtype"]) ?? "";
    if (isError === true || subtype.startsWith("error")) {
      scan.resultIsError = true;
    }
    scan.resultText =
      asString(obj["result"]) ?? asString(obj["error"]) ?? scan.resultText;
    if (scan.resultText && !scan.authError) {
      scan.authError = detectAuthError(scan.resultText);
    }
    return;
  }

  // Some failure modes arrive as a top-level error/assistant-error line.
  if (type === "error" || obj["is_error"] === true) {
    const text =
      asString(obj["error"]) ??
      asString(obj["message"]) ??
      asString(obj["result"]) ??
      trimmed;
    if (!scan.authError) scan.authError = detectAuthError(text) ?? text.slice(0, 200);
  }
}

// -----------------------------------------------------------------------------
// The probe spawn. Resolves a verdict; NEVER rejects.
// -----------------------------------------------------------------------------

interface ProbeVerdict {
  ok: boolean;
  detail: string;
}

function runProbe(signal: AbortSignal | undefined): Promise<ProbeVerdict> {
  return new Promise<ProbeVerdict>((resolve) => {
    // Already aborted before we even started.
    if (signal?.aborted) {
      resolve({ ok: false, detail: "auth pre-flight aborted before start" });
      return;
    }

    const argv = [
      "-p",
      PROBE_PROMPT,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      PROBE_MODEL,
      // Bound the probe hard: one turn, no tools, no prompts.
      "--max-turns",
      "1",
      "--disallowedTools",
      "Bash,Edit,Write,Read,WebFetch,WebSearch",
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(CLAUDE_BIN, argv, {
        stdio: ["pipe", "pipe", "pipe"],
        // No shell — argv array, exactly as pinned.
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        ok: false,
        detail: `failed to spawn ${CLAUDE_BIN}: ${errText(err)}`,
      });
      return;
    }

    const scan = emptyScan();
    let stdoutBuf = "";
    let stderrTail = "";
    let settled = false;
    let timedOut = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    };

    const finish = (verdict: ProbeVerdict): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(verdict);
    };

    const killChild = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Best-effort hard kill shortly after, in case SIGTERM is ignored.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 1_000).unref?.();
    };

    const onAbort = (): void => {
      if (settled) return;
      killChild();
      finish({ ok: false, detail: "auth pre-flight aborted" });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killChild();
      finish({
        ok: false,
        detail: `auth pre-flight timed out after ${PROBE_TIMEOUT_MS}ms`,
      });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    // Drain stdout line-by-line into the scan (chunks may split mid-line).
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        foldLine(scan, line);
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Keep only a bounded tail; this is failure-diagnosis context.
      stderrTail = (stderrTail + chunk).slice(-2_000);
      if (!scan.authError) scan.authError = detectAuthError(chunk);
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        detail: `claude spawn error: ${errText(err)}`,
      });
    });

    child.on("close", (code, sigCode) => {
      if (timedOut || settled) return;
      // Flush any trailing un-terminated line.
      if (stdoutBuf.trim()) foldLine(scan, stdoutBuf);

      finish(verdictFromScan(scan, code, sigCode, stderrTail));
    });

    // Feed the prompt over STDIN, then close it so the CLI proceeds.
    try {
      child.stdin?.end(PROBE_PROMPT + "\n", "utf8");
    } catch {
      // If stdin write fails the close/error handler will produce the verdict.
    }
  });
}

/** Turn the folded scan + exit status into a final pass/fail verdict. */
function verdictFromScan(
  scan: ProbeScan,
  code: number | null,
  sigCode: NodeJS.Signals | null,
  stderrTail: string,
): ProbeVerdict {
  // Explicit auth failure anywhere in the stream/stderr wins immediately.
  if (scan.authError) {
    return { ok: false, detail: `claude not authenticated: ${scan.authError}` };
  }
  if (scan.resultIsError) {
    const why = scan.resultText ? `: ${scan.resultText}` : "";
    return { ok: false, detail: `claude health check returned an error${why}` };
  }
  if (sigCode) {
    return { ok: false, detail: `claude exited on signal ${sigCode}` };
  }
  if (code !== 0) {
    const tail = stderrTail.trim();
    const why = tail ? `: ${tail.slice(0, 200)}` : "";
    return { ok: false, detail: `claude exited with code ${code}${why}` };
  }

  // Clean exit. Require at least the init handshake; prefer a full result.
  if (!scan.sawInit && !scan.sawResult) {
    const tail = stderrTail.trim();
    const why = tail ? `: ${tail.slice(0, 200)}` : " (no stream-json output)";
    return { ok: false, detail: `claude produced no health output${why}` };
  }

  // Healthy. Compose a tidy detail line.
  const parts: string[] = [];
  parts.push(scan.cliVersion ? `claude v${scan.cliVersion}` : "claude");
  if (scan.apiKeySource) {
    parts.push(scan.apiKeySource === "none" ? "oauth" : `key:${scan.apiKeySource}`);
  } else {
    parts.push("oauth");
  }
  if (!scan.sawResult) parts.push("init-only");
  return { ok: true, detail: parts.join(", ") };
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// -----------------------------------------------------------------------------
// Service factory.
// -----------------------------------------------------------------------------

/** Construct the auth service; `emit` is how auth.state reaches the event log. */
export function createAuthService(emit: Emit): AuthService {
  let cached: AuthStatus | null = null;
  /** Coalesce concurrent preflights so boot can't fan out duplicate probes. */
  let inFlight: Promise<AuthStatus> | null = null;

  const publish = (verdict: ProbeVerdict): AuthStatus => {
    const status: AuthStatus = {
      ok: verdict.ok,
      detail: verdict.detail,
      checkedAt: Date.now(),
    };
    cached = status;
    // Best-effort emit; a failing event log must not crash the probe.
    try {
      emit({ type: "auth.state", ok: status.ok, detail: status.detail });
    } catch {
      /* swallow — auth.state is observational, not load-bearing here */
    }
    return status;
  };

  const preflight = (signal?: AbortSignal): Promise<AuthStatus> => {
    if (inFlight) return inFlight;
    const run = (async (): Promise<AuthStatus> => {
      // Zero-cost short-circuit: when the engine runs with the fake runner
      // (LOOM_RUNNER=fake), NO claude process is ever spawned, so the auth
      // pre-flight must NOT shell out to claude either (that would cost tokens
      // and defeat a zero-cost dry run / test). Synthesize a ready status so the
      // guard opens for the fake runner without any external call.
      if (process.env.LOOM_RUNNER === "fake") {
        return publish({ ok: true, detail: "fake runner — auth probe skipped (zero cost)" });
      }
      let verdict: ProbeVerdict;
      try {
        verdict = await runProbe(signal);
      } catch (err) {
        // runProbe is designed never to reject, but stay defensive: boot is
        // non-fatal, so convert any escape into a failed (not thrown) status.
        verdict = { ok: false, detail: `auth pre-flight crashed: ${errText(err)}` };
      }
      return publish(verdict);
    })();
    inFlight = run;
    // Clear the coalescing latch once settled (success or failure), so a later
    // boot/retry can re-probe (e.g. after the operator runs `claude login`).
    void run.finally(() => {
      if (inFlight === run) inFlight = null;
    });
    return run;
  };

  return {
    preflight,
    current: () => cached,
    isReady: () => cached?.ok === true,
  };
}
