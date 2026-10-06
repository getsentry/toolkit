/**
 * Post-init verification: run the dev server and check for SDK events.
 *
 * Uses a two-signal approach:
 * 1. **Stdout-based**: Pipe the child's stdout/stderr and watch for output.
 *    If the process produces output without fatal error patterns, the app
 *    started successfully.
 * 2. **Envelope-based**: A Spotlight sidecar receives SDK envelopes. If one
 *    arrives, the SDK is confirmed working (strongest signal).
 *
 * Either signal resolving first counts as success. A non-zero exit code
 * or fatal error patterns in stderr indicate failure.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  addBreadcrumb,
  captureException,
  setTag,
} from "@sentry/node-core/light";
import { createSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import { BUFFER_SIZE, shutdownServer } from "../../commands/local/run.js";
import { buildApp, tryListen } from "../../commands/local/server.js";
import { detectDevCommand } from "../dev-script.js";
import { logger } from "../logger.js";
import type { WorkflowRunResult } from "./types.js";
import type { WizardUI } from "./ui/types.js";

/** Verification timeout in seconds. */
const VERIFY_TIMEOUT_S = 15;

/** POSIX grace period before escalating verification cleanup to SIGKILL. */
const PROCESS_SHUTDOWN_GRACE_MS = 5000;

/** Maximum POSIX wait after force-killing the verification process tree. */
const PROCESS_FORCE_SHUTDOWN_MS = 1000;

/** Poll interval while waiting for a verification process tree to exit. */
const PROCESS_EXIT_POLL_MS = 50;

/** Maximum time for a Windows taskkill invocation to complete. */
const WINDOWS_TREE_KILL_TIMEOUT_MS = 1000;

/**
 * Patterns in stderr/stdout that indicate a fatal startup failure.
 * Matched case-insensitively against each collected output line.
 */
const FATAL_ERROR_PATTERNS = [
  /\bERR_MODULE_NOT_FOUND\b/,
  /\bMODULE_NOT_FOUND\b/,
  /\bCannot find module\b/i,
  /\bEADDRINUSE\b/,
  /\bSyntaxError\b/,
  /\bReferenceError\b/,
  /\bTypeError\b/,
  /\bError \[ERR_/,
  /\bFATAL ERROR\b/i,
  /\bUnhandledPromiseRejection\b/,
  /\bERR_PNPM_/,
];

/** Maximum number of output lines to keep for error reporting. */
const MAX_OUTPUT_LINES = 50;

/** Absolute-path pattern — scrub user-specific directory paths from telemetry. */
const ABS_PATH_RE = /(?:\/[\w.@-]+){2,}/g;

/** Key=value pattern for redaction (env vars and --flag=value args). */
const KEY_VALUE_RE = /(?:--?)?[A-Za-z_][\w-]*=\S+/g;

/** URI userinfo (user:password@ or :password@) pattern for redaction. */
const URI_USERINFO_RE = /\/\/[^@/\s]*:[^@/\s]+@/g;

/** Strip absolute paths, env-var values, and URI credentials from output. */
function scrubOutputLine(line: string): string {
  return line
    .replace(URI_USERINFO_RE, "//[REDACTED]@")
    .replace(KEY_VALUE_RE, (m) => `${m.split("=")[0]}=[REDACTED]`)
    .replace(ABS_PATH_RE, "[PATH]");
}

/** Newline splitter — hoisted to top level per lint rule. */
const NEWLINE_RE = /\r?\n/;

/**
 * Outcome of the stdout-based startup check.
 *
 * - `started`: The child produced output without fatal error patterns.
 * - `errored`: A fatal error pattern was detected in the output.
 * - `silent`:  No output was produced before the timeout.
 */
type StartupOutcome =
  | { kind: "started" }
  | { kind: "errored"; errorLine: string }
  | { kind: "silent" };

/** Check a single line against all fatal error patterns. */
function findFatalError(line: string): boolean {
  return FATAL_ERROR_PATTERNS.some((p) => p.test(line));
}

/** Scan collected lines for fatal errors, returning the first match. */
function scanLinesForError(
  lines: readonly string[]
): StartupOutcome & { kind: "errored" | "started" } {
  for (const line of lines) {
    if (findFatalError(line)) {
      return { kind: "errored", errorLine: line };
    }
  }
  return { kind: "started" };
}

/**
 * Collect lines from a child process's piped stdout and stderr.
 * Returns a promise that resolves when either:
 * - A fatal error pattern is detected (errored)
 * - At least one non-empty line arrives without errors after the timeout (started)
 * - The timeout expires with no output (silent)
 */
function watchChildOutput(
  child: ChildProcess,
  timeoutMs: number
): { promise: Promise<StartupOutcome>; getLines: () => string[] } {
  const lines: string[] = [];
  let hasOutput = false;
  let settled = false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: (outcome: StartupOutcome) => void;
  const promise = new Promise<StartupOutcome>((r) => {
    settle = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      r(outcome);
    };
  });

  const processChunk = (raw: Buffer) => {
    if (settled) {
      return;
    }
    const text = raw.toString("utf-8");
    for (const segment of text.split(NEWLINE_RE)) {
      const trimmed = segment.trim();
      if (!trimmed) {
        continue;
      }
      if (lines.length < MAX_OUTPUT_LINES) {
        lines.push(trimmed);
      }
      if (findFatalError(trimmed)) {
        settle({ kind: "errored", errorLine: trimmed });
        return;
      }
      hasOutput = true;
    }
  };

  child.stdout?.on("data", processChunk);
  child.stderr?.on("data", processChunk);

  timer = setTimeout(() => {
    settle(hasOutput ? { kind: "started" } : { kind: "silent" });
  }, timeoutMs);

  child.on("close", () => {
    if (hasOutput) {
      settle(scanLinesForError(lines));
    } else {
      settle({ kind: "silent" });
    }
  });

  return { promise, getLines: () => lines };
}

/** Build the child process environment for verification. */
function buildVerifyEnv(
  spotlightUrl: string,
  detected: { source: string },
  cwd: string
): Record<string, string | undefined> {
  let env: Record<string, string | undefined> = {
    ...process.env,
    SENTRY_SPOTLIGHT: spotlightUrl,
    NEXT_PUBLIC_SENTRY_SPOTLIGHT: spotlightUrl,
    SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1",
    SENTRY_RELEASE: "sentry-cli-verify",
  };
  if (detected.source.startsWith("package.json")) {
    const binDir = resolve(cwd, "node_modules", ".bin");
    const sep = process.platform === "win32" ? ";" : ":";
    env = {
      ...env,
      PATH: env.PATH ? `${binDir}${sep}${env.PATH}` : binDir,
    };
  }
  return env;
}

/** Signal the POSIX process group or force-terminate the Windows process tree. */
function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): boolean {
  const pid = child.pid;
  if (pid === undefined) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      // Verification children are disposable. Force the complete tree in one
      // bounded call because Windows cannot reliably reproduce POSIX process-
      // group signaling or discover descendants after their parent exits.
      const args = ["/PID", String(pid), "/T", "/F"];
      const taskkill = spawnSync("taskkill", args, {
        stdio: "ignore",
        timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
      });
      if (taskkill.error) {
        logger.debug(
          `Failed to terminate Windows verification process tree while handling ${signal}`,
          taskkill.error
        );
        return false;
      }
      if (taskkill.status !== 0) {
        logger.debug(
          `taskkill exited with status ${taskkill.status} while handling ${signal} for the verification process tree`
        );
        return false;
      }
      return true;
    }
    // Verification children are spawned detached on POSIX, making their PID
    // the process-group ID. A negative PID signals the whole group, including
    // shell pipelines, concurrently tasks, and framework watchers.
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      logger.debug(`Failed to signal verification process tree with ${signal}`);
    }
    return false;
  }
}

/** Fall back to signaling only the direct child process. */
function signalDirectChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    logger.debug(`Verification child exited before receiving ${signal}`);
  }
}

/** Check whether the POSIX verification process group is still alive. */
function isPosixProcessGroupAlive(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) {
    return false;
  }

  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Wait for a POSIX verification process group to exit, bounded by a timeout. */
async function waitForPosixProcessGroupExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPosixProcessGroupAlive(child)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, Math.min(PROCESS_EXIT_POLL_MS, remainingMs));
    });
  }
  return true;
}

/** Terminate the process tree, with a grace period on POSIX. */
async function cleanupProcessTree(child: ChildProcess): Promise<void> {
  try {
    if (process.platform === "win32") {
      if (!terminateProcessTree(child, "SIGKILL")) {
        signalDirectChild(child, "SIGKILL");
      }
      return;
    }

    terminateProcessTree(child, "SIGTERM");
    const exited = await waitForPosixProcessGroupExit(
      child,
      PROCESS_SHUTDOWN_GRACE_MS
    );
    if (!exited) {
      terminateProcessTree(child, "SIGKILL");
      await waitForPosixProcessGroupExit(child, PROCESS_FORCE_SHUTDOWN_MS);
    }
  } catch (error) {
    logger.debug("Failed to kill verification process tree", error);
  } finally {
    // Descendants can inherit these pipes. Destroying our ends guarantees the
    // verification cleanup itself never waits indefinitely for `close`.
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

type VerificationSkipReason = "no_dev_command" | "server_bind" | "spawn_failed";

/**
 * Expected verification skips are not failures. Emitting them with
 * `captureException` produced ERROR events on healthy completed runs.
 */
function recordVerificationSkipped(reason: VerificationSkipReason): void {
  addBreadcrumb({
    category: "wizard.verify",
    level: "info",
    message: `skipped:${reason}`,
  });
  setTag("wizard.verify", "skipped");
}

/**
 * Outcome of {@link verifySetup}, surfaced to the completion screen so it can
 * celebrate a received event (and deep-link it) instead of only telling the
 * user to go trigger one.
 */
export type VerifyResult = {
  /** True when the SDK delivered an envelope to the local sidecar — the
   * strongest signal that events are actually flowing to Sentry. */
  verified: boolean;
  /** Outcome detail, for callers that want more than the boolean. */
  kind: VerifyOutcome["kind"] | "skipped";
  /** event_id of the first intercepted event, when one could be parsed.
   * Only set when {@link verified} is true. */
  eventId?: string;
};

/**
 * Run the dev server, spawn the child process, and verify that the Sentry
 * SDK is working or at minimum that the app starts without errors.
 *
 * Called before `formatResult` in the wizard success path. On failure this
 * logs a warning and reports to Sentry telemetry — it does NOT throw, since
 * the init itself succeeded and the user should not be blocked.
 */
export async function verifySetup(
  result: WorkflowRunResult,
  ui: WizardUI,
  cwd: string
): Promise<VerifyResult> {
  const detected = await detectDevCommand(cwd);
  if (!detected) {
    ui.log.info("Skipping verification — could not detect a dev command");
    recordVerificationSkipped("no_dev_command");
    return { verified: false, kind: "skipped" };
  }

  logger.debug(`Verification command: ${detected.args.join(" ")}`);

  const buffer = createSpotlightBuffer(BUFFER_SIZE);
  const app = buildApp(buffer);

  let server: Awaited<ReturnType<typeof tryListen>>["server"];
  let boundPort: number;
  try {
    const listenResult = await tryListen(app, 0, "localhost");
    server = listenResult.server;
    boundPort = listenResult.port;
  } catch (error) {
    logger.debug("Failed to start verification server", error);
    ui.log.warn("Skipping verification — could not start local server.");
    recordVerificationSkipped("server_bind");
    return { verified: false, kind: "skipped" };
  }

  const spotlightUrl = `http://localhost:${boundPort}/stream`;
  let subscriptionId: string | undefined;
  // Capture the first event's id so the completion screen can deep-link the
  // exact event. Best-effort: a missing/malformed id just means no deep-link.
  let firstEventId: string | undefined;
  const envelopeReceived = new Promise<void>((r) => {
    subscriptionId = buffer.subscribe((container) => {
      if (firstEventId === undefined) {
        // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
        try {
          const parsed = container.getParsedEnvelope();
          const header = parsed?.envelope?.[0] as
            | { event_id?: string }
            | undefined;
          if (typeof header?.event_id === "string" && header.event_id) {
            firstEventId = header.event_id;
          }
        } catch {
          // best-effort — fall back to the project Issues stream
        }
      }
      r();
    });
  });
  const childEnv = buildVerifyEnv(spotlightUrl, detected, cwd);

  let child: ChildProcess;
  try {
    const [cmd = "", ...cmdArgs] = detected.args;
    child = spawn(cmd, cmdArgs, {
      cwd,
      // On POSIX this creates a dedicated process group whose entire tree can
      // be terminated without touching the CLI's own process group.
      detached: process.platform !== "win32",
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    logger.debug("Failed to spawn verification child", error);
    await shutdownServer(server);
    ui.log.warn("Skipping verification — could not start the dev command.");
    recordVerificationSkipped("spawn_failed");
    return { verified: false, kind: "skipped" };
  }

  // Track whether the user sent an interrupt so we can re-emit it after
  // cleanup instead of silently continuing the wizard.
  let signalReceived: NodeJS.Signals | null = null;
  const safeKill = (sig: NodeJS.Signals) => {
    if (!terminateProcessTree(child, sig)) {
      signalDirectChild(child, sig);
    }
  };
  const onSigint = () => {
    signalReceived = "SIGINT";
    safeKill("SIGINT");
  };
  const onSigterm = () => {
    signalReceived = "SIGTERM";
    safeKill("SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const { promise: startupPromise, getLines } = watchChildOutput(
    child,
    VERIFY_TIMEOUT_S * 1000
  );
  const childExited = new Promise<{ kind: "exited"; code: number }>((r) => {
    child.on("close", (code) =>
      r({ kind: "exited" as const, code: code ?? 1 })
    );
  });
  const childErrored = new Promise<{ kind: "spawn_error"; error: Error }>(
    (resolveError) => {
      child.once("error", (error) => {
        resolveError({ kind: "spawn_error", error });
      });
    }
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    envelopeReceived.then(() => ({ kind: "envelope" as const })),
    startupPromise,
    childExited,
    childErrored,
    new Promise<{ kind: "timeout" }>((r) => {
      timeoutHandle = setTimeout(
        () => r({ kind: "timeout" as const }),
        VERIFY_TIMEOUT_S * 1000
      );
    }),
  ]);

  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

  // Capture the exit code before cleanup — terminating the process tree would
  // set exitCode to 143/137, masking a natural crash code.
  const preCleanupExitCode = child.exitCode;

  await cleanupProcessTree(child);
  if (subscriptionId) {
    buffer.unsubscribe(subscriptionId);
  }
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  await shutdownServer(server);

  // Re-emit the signal after cleanup so the default handler terminates the
  // process. Without this, Ctrl+C during verification would be swallowed and
  // the wizard would continue as if nothing happened.
  if (signalReceived) {
    process.kill(process.pid, signalReceived);
    return { verified: false, kind: "skipped" };
  }

  // If the child crashed (non-zero exit) but the startup watcher resolved
  // first as "started" or "silent", correct to "exited" so the crash is
  // reported instead of a false success or misleading timeout message.
  let effectiveOutcome: VerifyOutcome = outcome;
  if (
    (outcome.kind === "started" || outcome.kind === "silent") &&
    preCleanupExitCode !== null &&
    preCleanupExitCode !== 0
  ) {
    effectiveOutcome = { kind: "exited", code: preCleanupExitCode };
  }

  reportOutcome(effectiveOutcome, { ui, result, detected, getLines });

  const verified = effectiveOutcome.kind === "envelope";
  return {
    verified,
    kind: effectiveOutcome.kind,
    eventId: verified ? firstEventId : undefined,
  };
}

type VerifyOutcome =
  | { kind: "envelope" }
  | StartupOutcome
  | { kind: "exited"; code: number }
  | { kind: "spawn_error"; error: Error }
  | { kind: "timeout" };

type ReportContext = {
  ui: WizardUI;
  result: WorkflowRunResult;
  detected: { args: string[]; source: string };
  getLines: () => string[];
};

/** Report the verification outcome to the user and telemetry. */
function reportOutcome(outcome: VerifyOutcome, ctx: ReportContext): void {
  const { ui, result, detected, getLines } = ctx;
  const telemetryTags = {
    "wizard.platform": String(result.result?.platform ?? "unknown"),
  };
  const telemetryExtra = {
    features: result.result?.features,
    detectedCommand: scrubOutputLine(detected.args.join(" ")),
    detectedSource: detected.source,
    outputLines: getLines().length,
  };

  if (outcome.kind === "envelope") {
    ui.log.success("Verified — your app is sending events to Sentry");
    return;
  }

  if (outcome.kind === "started") {
    ui.log.success("Verified — app started successfully");
    return;
  }

  if (outcome.kind === "spawn_error") {
    logger.debug("Failed to spawn verification child", outcome.error);
    ui.log.warn("Skipping verification — could not start the dev command.");
    recordVerificationSkipped("spawn_failed");
    return;
  }

  if (outcome.kind === "errored") {
    const scrubbed = scrubOutputLine(outcome.errorLine).slice(0, 200);
    ui.log.warn(`Could not verify — startup error: ${scrubbed}`);
    captureException(new Error("init verification: startup error"), {
      tags: { ...telemetryTags, "wizard.verify": "startup_error" },
      extra: {
        ...telemetryExtra,
        errorLine: scrubOutputLine(outcome.errorLine),
      },
    });
    return;
  }

  if (outcome.kind === "exited") {
    if (outcome.code === 0) {
      ui.log.success("Verified — dev server exited cleanly");
      return;
    }
    ui.log.warn(
      `Could not verify — dev server exited with code ${outcome.code}`
    );
    logger.debug(`Last output: ${getLines().slice(-3).join(" | ")}`);
    captureException(new Error("init verification failed"), {
      tags: { ...telemetryTags, "wizard.verify": "child_exited" },
      extra: { ...telemetryExtra, exitCode: outcome.code },
    });
    return;
  }

  const verifyTag = outcome.kind === "silent" ? "silent" : "timeout";
  ui.log.warn(`Could not verify — no output within ${VERIFY_TIMEOUT_S}s`);
  captureException(new Error("init verification failed"), {
    tags: { ...telemetryTags, "wizard.verify": verifyTag },
    extra: telemetryExtra,
  });
}
