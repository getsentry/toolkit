/**
 * Telemetry for Sentry CLI
 *
 * Tracks anonymous usage data to improve the CLI:
 * - Command execution (which commands run, success/failure)
 * - Error tracking (unhandled exceptions)
 * - Performance (command duration)
 *
 * No PII is collected. Opt-out via SENTRY_CLI_NO_TELEMETRY=1 environment variable.
 */

import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";

const _require = createRequire(import.meta.url);

import { isMusl } from "./binary.js";
import {
  CLI_VERSION,
  getCliEnvironment,
  getConfiguredSentryUrl,
  SENTRY_CLI_DSN,
} from "./constants.js";
import { getCustomCaCerts } from "./custom-ca.js";
import { getTelemetryPreference } from "./db/defaults.js";
import { isReadonlyError, tryRepairAndRetry } from "./db/schema.js";
import {
  type AgentInfo,
  detectAgent,
  detectAgentFromProcessTree,
} from "./detect-agent.js";
import { getEnv } from "./env.js";
import {
  classifySilenced,
  enrichEventWithGroupingTags,
  reportCliError,
} from "./error-reporting.js";
import { ApiError, isUserError } from "./errors.js";
import { attachSentryReporter, logger } from "./logger.js";
import { getSentryBaseUrl, isSentrySaasUrl } from "./sentry-urls.js";
import { redactTelemetryEnvelope } from "./telemetry/credential-redaction.js";
import { makeCompressedTransport } from "./telemetry/zstd-transport.js";
import { getRealUsername } from "./utils.js";

export type { Span } from "@sentry/core";

/** Re-imported locally because Span is exported via re-export */
type Span = Sentry.Span;

/**
 * Initialize telemetry context with user and instance information.
 * Called after Sentry is initialized to set user context and instance tags.
 */
async function initTelemetryContext(): Promise<void> {
  try {
    // Dynamic imports to avoid circular dependencies and for ES module compatibility
    const { getUserInfo } = await import("./db/user.js");
    const { getInstanceId } = await import("./db/instance.js");

    const user = getUserInfo();
    const instanceId = getInstanceId();

    if (user) {
      Sentry.setUser({ id: user.userId, email: user.email });
    }

    if (instanceId) {
      Sentry.setTag("instance_id", instanceId);
    }
  } catch (error) {
    // Context initialization is not critical - continue without it
    // But capture the error for debugging
    Sentry.captureException(error);
  }
}

/**
 * Mark the active session as crashed.
 *
 * Checks both current scope and isolation scope since processSessionIntegration
 * stores the session on the isolation scope. Called when a command error
 * propagates through withTelemetry — the SDK auto-marks crashes for truly
 * uncaught exceptions (mechanism.handled === false), but command errors need
 * explicit marking.
 *
 * @internal Exported for testing
 */
export function markSessionCrashed(): void {
  const session =
    Sentry.getCurrentScope().getSession() ??
    Sentry.getIsolationScope().getSession();
  if (session) {
    session.status = "crashed";
  }
}

/** Env var that disables CLI telemetry when set to `"1"`. */
export const TELEMETRY_ENV_VAR = "SENTRY_CLI_NO_TELEMETRY";

/** Industry-standard env var for opting out of telemetry. */
export const DO_NOT_TRACK_ENV_VAR = "DO_NOT_TRACK";

/** Result of resolving the effective telemetry state */
export type TelemetryEffective = {
  /** Whether telemetry is enabled after applying all overrides */
  enabled: boolean;
  /**
   * Which layer determined the result:
   * - `"env:SENTRY_CLI_NO_TELEMETRY"` — env var opt-out
   * - `"env:DO_NOT_TRACK"` — industry-standard opt-out
   * - `"preference"` — persistent `sentry cli defaults telemetry` setting
   * - `"default"` — no override, telemetry enabled by default
   */
  source: string;
};

/**
 * Resolve the effective telemetry state with source attribution.
 *
 * Priority (highest to lowest):
 * 1. `SENTRY_CLI_NO_TELEMETRY=1` — explicit CLI env var opt-out
 * 2. `DO_NOT_TRACK=1` — industry-standard opt-out
 * 3. SQLite persistent preference — `sentry cli defaults telemetry on/off`
 * 4. Default: enabled
 *
 * The DB read is wrapped in try/catch — if the database is uninitialized
 * or corrupted, we fall through to the default (enabled).
 */
export function computeTelemetryEffective(): TelemetryEffective {
  if (getEnv()[TELEMETRY_ENV_VAR] === "1") {
    return { enabled: false, source: `env:${TELEMETRY_ENV_VAR}` };
  }

  if (getEnv()[DO_NOT_TRACK_ENV_VAR] === "1") {
    return { enabled: false, source: `env:${DO_NOT_TRACK_ENV_VAR}` };
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const pref = getTelemetryPreference();
    if (pref !== undefined) {
      return { enabled: pref, source: "preference" };
    }
  } catch {
    // DB not initialized yet — fall through to default
  }

  return { enabled: true, source: "default" };
}

/**
 * Convenience wrapper: returns just the boolean enabled state.
 * Used by `withTelemetry()` and other call sites that only need the decision.
 */
export function isTelemetryEnabled(): boolean {
  return computeTelemetryEffective().enabled;
}

/**
 * Wrap CLI execution with telemetry tracking.
 *
 * Creates a Sentry span for the command execution and captures exceptions.
 * Session lifecycle is managed by the SDK's processSessionIntegration
 * (started during Sentry.init) and a beforeExit handler (registered in
 * initSentry) that ends healthy sessions and flushes events. This ensures
 * sessions are reliably tracked even for unhandled rejections and other
 * paths that bypass this function's try/catch.
 *
 * Telemetry can be disabled via:
 * - `SENTRY_CLI_NO_TELEMETRY=1` environment variable
 * - `DO_NOT_TRACK=1` environment variable
 * - `sentry cli defaults telemetry off` (persistent preference)
 *
 * @param callback - The CLI execution function to wrap, receives the span for naming
 * @returns The result of the callback
 */
export async function withTelemetry<T>(
  callback: (span: Span | undefined) => T | Promise<T>,
  options?: { libraryMode?: boolean }
): Promise<T> {
  const enabled = isTelemetryEnabled();
  const client = initSentry(enabled, options);
  if (!client?.getOptions().enabled) {
    return callback(undefined);
  }

  // Initialize user and instance context
  await initTelemetryContext();

  // Flush deferred completion telemetry (queued during __complete fast-path).
  // Best-effort: never block CLI execution for telemetry emission.
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const { drainCompletionTelemetry } = await import(
      "./db/completion-telemetry.js"
    );
    for (const entry of drainCompletionTelemetry()) {
      Sentry.metrics.distribution("completion.duration_ms", entry.durationMs, {
        attributes: { command_path: entry.commandPath },
      });
      Sentry.metrics.distribution(
        "completion.result_count",
        entry.resultCount,
        { attributes: { command_path: entry.commandPath } }
      );
    }
  } catch {
    // Queue flush is non-essential
  }

  try {
    return await Sentry.startSpan(
      { name: "cli.command", op: "cli.command", forceTransaction: true },
      async (span) => {
        try {
          return await callback(span);
        } catch (e) {
          // Record user API errors (401–499) as span attributes instead of
          // exceptions. These are user errors (wrong ID, no access), not CLI
          // bugs. Recording on the span lets us detect volume spikes in Discover.
          // 400 Bad Request is NOT filtered here — it's a CLI bug.
          if (isUserApiError(e)) {
            recordApiErrorOnSpan(span, e as ApiError);
          }
          throw e;
        }
      }
    );
  } catch (e) {
    // Route through reportCliError so silencing (OutputError, expected-auth
    // AuthError, 401–499 ApiError) and fingerprint normalization are applied
    // consistently. Silenced errors emit a `cli.error.silenced` metric +
    // optional structured log instead of creating a Sentry issue. ContextError
    // and MalformedAuthTokenError stay captured — see classifySilenced.
    reportCliError(e);
    // Only mark the session crashed for genuine, unexpected CLI bugs. This is a
    // stricter gate than `classifySilenced`: an error can be *captured* to
    // Sentry (not silenced) yet still be an expected user/environment failure
    // rather than a crash. `ContextError` (missing org/project) is the
    // motivating case — it is deliberately un-silenced so its volume stays
    // visible (CLI-3B), but it must not count as a crashed session or it would
    // skew release-health for the ~2000 affected users.
    //
    // `isUserError` gates the crash decision. Besides the specific user-context
    // subclasses (ContextError, ResolutionError, ValidationError, AuthError,
    // ConfigError, HostScopeError, user 4xx, network failures), it also returns
    // true for a bare/unknown `CliError`. That is intentional: a `CliError` is a
    // deliberately-thrown, message-carrying failure (the CLI decided to stop and
    // told the user why), not an unexpected crash. Genuine crashes surface as
    // non-CliError throwables (TypeError, RangeError, plain Error) or as
    // captured-but-not-user errors (5xx ApiError, TimeoutError, UpgradeError,
    // CLI-built 400s), all of which still mark the session crashed here.
    if (!(classifySilenced(e) || isUserError(e))) {
      markSessionCrashed();
    }
    throw e;
  }
}

/**
 * Create a beforeExit handler that ends healthy sessions and flushes events.
 *
 * The SDK's processSessionIntegration only ends non-OK sessions (crashed/errored).
 * This handler complements it by ending OK sessions (clean exit → 'exited')
 * and flushing pending events. Includes a re-entry guard since flush is async
 * and causes beforeExit to re-fire when complete.
 *
 * @param client - The Sentry client to flush
 * @returns A handler function for process.on("beforeExit")
 *
 * @internal Exported for testing
 */
export function createBeforeExitHandler(
  client: Sentry.LightNodeClient
): () => void {
  let isFlushing = false;
  return () => {
    if (isFlushing) {
      return;
    }
    isFlushing = true;

    const session = Sentry.getIsolationScope().getSession();
    if (session?.status === "ok") {
      Sentry.endSession();
    }

    // Flush pending events before exit. Convert PromiseLike to Promise
    // for proper error handling. The async work causes beforeExit to
    // re-fire when complete, which the isFlushing guard handles.
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    Promise.resolve(client.flush(3000)).catch(() => {
      // Ignore flush errors — telemetry should never block CLI exit
    });
  };
}

/**
 * Check if a Sentry event represents an EPIPE error.
 *
 * EPIPE (errno -32) occurs when writing to a pipe whose reading end has been
 * closed. This is normal Unix behavior when CLI output is piped through
 * commands like `head`, `less`, or `grep -m1`. These errors are not bugs
 * and should be silently dropped from telemetry.
 *
 * Detects both Bun-style ("EPIPE: broken pipe, write") and Node.js-style
 * ("write EPIPE") error messages, plus the structured `node_system_error` context.
 *
 * @internal Exported for testing
 */
export function isEpipeError(event: Sentry.ErrorEvent): boolean {
  // Check exception message for EPIPE
  const exceptions = event.exception?.values;
  if (exceptions) {
    for (const ex of exceptions) {
      if (ex.value?.includes("EPIPE")) {
        return true;
      }
    }
  }

  // Check Node.js system error context (set by the SDK for system errors)
  const systemError = event.contexts?.node_system_error as
    | { code?: string }
    | undefined;
  if (systemError?.code === "EPIPE") {
    return true;
  }

  return false;
}

/**
 * Detect EBADF (bad file descriptor) errors in Sentry events.
 *
 * These occur when the init wizard's stdin reopen (`stdin-reopen.ts`) queues
 * reads on a destroyed file descriptor. Same class of OS-level noise as EPIPE
 * — not actionable, just different fd numbers producing duplicate issues.
 *
 * @internal Exported for testing
 */
export function isEbadfError(event: Sentry.ErrorEvent): boolean {
  const exceptions = event.exception?.values;
  if (exceptions) {
    for (const ex of exceptions) {
      if (ex.value?.includes("EBADF")) {
        return true;
      }
    }
  }

  const systemError = event.contexts?.node_system_error as
    | { code?: string }
    | undefined;
  if (systemError?.code === "EBADF") {
    return true;
  }

  return false;
}

/**
 * Check if an error is a user-caused (401–499) API error.
 *
 * 401–499 errors are user errors — wrong issue IDs, no access, rate limited —
 * not CLI bugs. 400 Bad Request is **excluded** because it indicates the CLI
 * constructed a malformed API request, which is a code defect. (A user's
 * unparseable `--query` is converted to a ValidationError at the command
 * boundary via toSearchQueryError, so it never reaches here as an ApiError.)
 *
 * These should be recorded as span attributes for volume-spike detection in
 * Discover, but should NOT be captured as Sentry exceptions.
 *
 * @internal Exported for testing
 */
export function isUserApiError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  return error.status > 400 && error.status < 500;
}

/**
 * Record a client API error as span attributes for Discover queryability.
 *
 * Sets `api_error.status`, `api_error.message`, and optionally `api_error.detail`
 * on the span. Must be called before `span.end()`.
 *
 * @internal Exported for testing
 */
export function recordApiErrorOnSpan(span: Span, error: ApiError): void {
  span.setAttribute("api_error.status", error.status);
  span.setAttribute("api_error.message", error.message);
  if (error.detail) {
    span.setAttribute("api_error.detail", error.detail);
  }
}

/**
 * Integrations to exclude for CLI.
 * These add overhead without benefit for short-lived CLI processes.
 */
const EXCLUDED_INTEGRATIONS = new Set([
  "Console", // Captures console output - too noisy for CLI
  "Context", // Replaced below with cpu: false to avoid os.cpus() crash (CLI-1ED)
  "ContextLines", // Reads source files - we rely on uploaded sourcemaps instead
  "LocalVariables", // Captures local variables - adds significant overhead
  "Modules", // Lists all loaded modules - unnecessary for CLI telemetry
]);

/**
 * Integrations to exclude in library mode.
 *
 * Extends {@link EXCLUDED_INTEGRATIONS} with integrations that register
 * global process listeners, monkey-patch builtins, or monitor child
 * processes — all of which would pollute the host application's runtime.
 */
const LIBRARY_EXCLUDED_INTEGRATIONS = new Set([
  ...EXCLUDED_INTEGRATIONS,
  "OnUncaughtException", // process.on('uncaughtException')
  "OnUnhandledRejection", // process.on('unhandledRejection')
  "ProcessSession", // process.on('beforeExit') — anonymous handler, no cleanup
  "Http", // diagnostics_channel + trace headers
  "NodeFetch", // diagnostics_channel + trace headers
  "FunctionToString", // wraps Function.prototype.toString
  "ChildProcess", // monitors child processes
  "NodeRuntimeMetrics", // runtime metrics timer would keep host event loop alive
]);

/**
 * Check whether `util.getSystemErrorMap` exists at setup time.
 * Bun does not implement this Node.js API, which the SDK's NodeSystemError
 * integration uses in its `processEvent` hook. When missing, the hook crashes
 * during event processing instead of sending the error report (CLI-K1).
 *
 * Checked once at module load so the integration filter is a simple boolean.
 */
const hasGetSystemErrorMap = (() => {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // Dynamic require to avoid bundler issues — the check only matters at runtime
    const util = _require("node:util") as Record<string, unknown>;
    return typeof util.getSystemErrorMap === "function";
  } catch {
    return false;
  }
})();

/** Current beforeExit handler, tracked so it can be replaced on re-init */
let currentBeforeExitHandler: (() => void) | null = null;

/** Match all SaaS regional URLs (us.sentry.io, de.sentry.io, o1234.ingest.us.sentry.io, etc.) */
const SENTRY_SAAS_SUBDOMAIN_RE = /^https:\/\/[^/]*\.sentry\.io(\/|$)/;

/** Match the bare sentry.io domain itself */
const SENTRY_SAAS_ROOT_RE = /^https:\/\/sentry\.io(\/|$)/;

/**
 * Build trace propagation targets for Sentry API URLs.
 *
 * Matches:
 * - SaaS: *.sentry.io (all regional URLs like us.sentry.io, de.sentry.io)
 * - SaaS: sentry.io itself
 * - Self-hosted: the configured SENTRY_HOST/SENTRY_URL if non-SaaS
 *
 * @internal Exported for testing
 */
export function getSentryTracePropagationTargets(): (string | RegExp)[] {
  const targets: (string | RegExp)[] = [
    SENTRY_SAAS_SUBDOMAIN_RE,
    SENTRY_SAAS_ROOT_RE,
  ];

  // Also match self-hosted Sentry instances
  const customUrl = getConfiguredSentryUrl();
  if (customUrl && !isSentrySaasUrl(customUrl)) {
    targets.push(customUrl);
  }

  return targets;
}

/**
 * Initialize Sentry for telemetry.
 *
 * @param enabled - Whether telemetry is enabled
 * @param options - Optional configuration
 * @param options.libraryMode - When true, strips all global-polluting
 *   integrations (process listeners, HTTP trace headers, Function.prototype
 *   patches) and disables logs/client reports to avoid timers and beforeExit
 *   handlers. The caller is responsible for calling `client.flush()` manually.
 * @returns The Sentry client, or undefined if initialization failed
 *
 * @internal Exported for testing
 */

/**
 * Set the cli.libc Sentry tag on Linux (musl for Alpine, glibc for most distros).
 * No-op on non-Linux — the concept doesn't apply to macOS/Windows.
 * Extracted from initSentry to stay under the cognitive complexity limit.
 */
function setLibcTag(): void {
  if (process.platform !== "linux") {
    return;
  }
  Sentry.setTag("cli.libc", isMusl() ? "musl" : "glibc");
}

/**
 * Set Sentry tags for a detected AI agent.
 * Splits structured {@link AgentInfo} into `agent`, `agent.version`, and `agent.role` tags.
 */
function setAgentTags(info: AgentInfo): void {
  Sentry.setTag("agent", info.name);
  if (info.version) {
    Sentry.setTag("agent.version", info.version);
  }
  if (info.role) {
    Sentry.setTag("agent.role", info.role);
  }
}

export function initSentry(
  enabled: boolean,
  options?: { libraryMode?: boolean }
): Sentry.LightNodeClient | undefined {
  const libraryMode = options?.libraryMode ?? false;
  const environment = getCliEnvironment();

  /**
   * Ensure frame paths are absolute so Sentry's symbolicator can match them.
   *
   * Bun compiled binaries with `sourcemap: "linked"` produce relative
   * paths like `"dist-bin/bin.js"` in `Error.stack`. The symbolicator's
   * `get_release_file_candidate_urls` generates `"~dist-bin/bin.js"` for
   * relative paths (missing the `/` after `~`), which never matches
   * uploaded artifacts at `"~/dist-bin/bin.js"`. Prepending `/` makes
   * the candidate `"~/dist-bin/bin.js"` — a match.
   */
  /** True if the path is relative (no leading `/`, no scheme, not `native`). */
  function isRelativePath(p: string): boolean {
    if (p.startsWith("/") || p === "native") {
      return false;
    }
    return !p.includes("://");
  }

  function ensureAbsolute(p: string): string {
    // Normalize Windows backslashes to forward slashes for sourcemap URL
    // matching. Bun on Windows produces paths like "dist-bin\bin.js" in
    // Error.stack — the symbolicator expects forward slashes to match
    // artifacts at "~/dist-bin/bin.js".
    const normalized = p.replaceAll("\\", "/");
    return isRelativePath(normalized) ? `/${normalized}` : normalized;
  }

  function normalizeExceptionFrames(event: Sentry.ErrorEvent): void {
    for (const exc of event.exception?.values ?? []) {
      for (const frame of exc.stacktrace?.frames ?? []) {
        if (frame.abs_path) {
          frame.abs_path = ensureAbsolute(frame.abs_path);
        }
        if (frame.filename) {
          frame.filename = ensureAbsolute(frame.filename);
        }
      }
    }
  }

  function normalizeDebugImages(event: Sentry.ErrorEvent): void {
    for (const img of event.debug_meta?.images ?? []) {
      if ("code_file" in img && typeof img.code_file === "string") {
        img.code_file = ensureAbsolute(img.code_file);
      }
    }
  }

  function normalizeFramePaths(event: Sentry.ErrorEvent): void {
    normalizeExceptionFrames(event);
    normalizeDebugImages(event);
  }

  // Close the previous client to clean up its internal timers and beforeExit
  // handlers (client report flusher interval, log flush listener). Without
  // this, re-initializing the SDK (e.g., in tests) leaks setInterval handles
  // that keep the event loop alive and prevent the process from exiting.
  // close(0) removes listeners synchronously; we don't need to await the flush.
  Sentry.getClient()?.close(0);

  const client = Sentry.init({
    dsn: SENTRY_CLI_DSN,
    enabled,
    // Compress outgoing envelopes with zstd (level 3) instead of gzip —
    // smaller payloads, faster compress/decompress on both sides.
    // Automatic gzip fallback when running on Node < 22.15, where
    // `node:zlib`'s zstd support is unavailable.
    transport: (transportOptions) => {
      const transport = makeCompressedTransport(transportOptions);
      return {
        // The SDK adds log scope attributes after beforeSendLog and skips
        // beforeSend for internal errors. Redact at the final delivery boundary.
        send: (envelope) => transport.send(redactTelemetryEnvelope(envelope)),
        flush: (timeout) => transport.flush(timeout),
      };
    },
    // Pass custom CA certificates to the transport for corporate TLS proxies.
    // The zstd-transport reads `caCerts` and passes it as `ca:` to
    // `http.request()`, and the SDK's fallback `makeNodeTransport` does the same.
    transportOptions: { caCerts: getCustomCaCerts() },
    // Keep default integrations but filter out ones that add overhead without benefit.
    // Important: Don't use defaultIntegrations: false as it may break debug ID support.
    // NodeSystemError is excluded on runtimes missing util.getSystemErrorMap (Bun) — CLI-K1.
    // Library mode uses the extended exclusion set to avoid polluting the host process.
    integrations: (defaults) => {
      const excluded = libraryMode
        ? LIBRARY_EXCLUDED_INTEGRATIONS
        : EXCLUDED_INTEGRATIONS;
      const filtered = defaults.filter(
        (integration) =>
          !excluded.has(integration.name) &&
          (integration.name !== "NodeSystemError" || hasGetSystemErrorMap)
      );

      // Re-add Context integration with cpu: false to avoid os.cpus() crash
      // on systems where /proc/cpuinfo is not accessible (CLI-1ED).
      if (!libraryMode) {
        filtered.push(
          Sentry.nodeContextIntegration({ device: { cpu: false } })
        );
      }

      // Collect runtime metrics (CPU, memory, event loop) for non-library mode.
      // Uses nodeRuntimeMetricsIntegration which degrades gracefully on Bun:
      // monitorEventLoopDelay is try/caught, all other APIs are Bun-compatible.
      // 5s interval for CLI — most commands complete in <10s.
      if (!libraryMode) {
        filtered.push(
          Sentry.nodeRuntimeMetricsIntegration({ collectionIntervalMs: 5000 })
        );
      }

      return filtered;
    },
    environment,
    // Enable Sentry structured logs for non-exception telemetry (e.g., unexpected input warnings).
    // Disabled when telemetry is off or in library mode — the SDK registers
    // beforeExit handlers for log flushing that keep the event loop alive.
    enableLogs: enabled && !libraryMode,
    // Disable client reports when telemetry is off or in library mode — the SDK
    // registers a setInterval + beforeExit handler that keep the event loop alive.
    ...((libraryMode || !enabled) && { sendClientReports: false }),
    // Sample all events for CLI telemetry (low volume)
    tracesSampleRate: 1,
    sampleRate: 1,
    release: CLI_VERSION,
    // Propagate traces to Sentry API for distributed tracing
    tracePropagationTargets: getSentryTracePropagationTargets(),

    beforeSendTransaction: (event) => {
      // Remove server_name which may contain hostname (PII)
      event.server_name = undefined;
      return event;
    },

    beforeSend: (event) => {
      // Remove server_name which may contain hostname (PII)
      event.server_name = undefined;

      // EPIPE errors are expected when stdout is piped and the consumer closes
      // early (e.g., `sentry issue list | head`). Not actionable — drop them.
      if (isEpipeError(event)) {
        return null;
      }

      // EBADF errors come from the init wizard's stdin reopen queuing reads
      // on a destroyed fd. Same class of OS-level noise as EPIPE — different
      // fd numbers just produce duplicate issues. Not actionable — drop them.
      if (isEbadfError(event)) {
        return null;
      }

      // Normalize relative frame paths to absolute. Bun's compiled binaries
      // with sourcemap: "linked" produce relative paths like "dist-bin/bin.js"
      // in Error.stack. Sentry's symbolicator only matches absolute paths
      // when generating tilde-prefixed URL candidates (e.g., "~/dist-bin/bin.js"),
      // silently skipping resolution for relative paths.
      normalizeFramePaths(event);

      // Enrich events with cli_error.* tags for server-side fingerprint rules.
      // reportCliError already sets these for command-level errors; this
      // catches uncaught exceptions and best-effort background captures.
      return enrichEventWithGroupingTags(event);
    },
  });

  // Always remove our own previous handler on re-init.
  if (currentBeforeExitHandler) {
    process.removeListener("beforeExit", currentBeforeExitHandler);
    currentBeforeExitHandler = null;
  }

  if (client?.getOptions().enabled) {
    const isBun = typeof process.versions.bun !== "undefined";
    const runtime = isBun ? "bun" : "node";

    // LightNodeClient hardcodes runtime to { name: 'node' }. Override it so
    // events carry the correct runtime when running as a compiled Bun binary.
    const opts = client.getOptions();
    opts.runtime = {
      name: runtime,
      version: isBun ? process.versions.bun : process.version,
    };

    // Tag whether running as bun binary or node (npm package).
    // Kept alongside the SDK's promoted 'runtime' tag for explicit signaling
    // and backward compatibility with existing dashboards/alerts.
    Sentry.setTag("cli.runtime", runtime);

    // Tag whether targeting self-hosted Sentry (not SaaS)
    Sentry.setTag("is_self_hosted", !isSentrySaasUrl(getSentryBaseUrl()));

    // Tag whether running in an interactive terminal or agent/CI environment
    Sentry.setTag("is_tty", !!process.stdout.isTTY);

    // Tag the C library variant on Linux (musl vs glibc).
    setLibcTag();

    // Tag which AI agent (if any) is driving the CLI.
    // Env var detection is sync (instant). If no env var matches, fire off
    // async process tree detection in the background — it sets the tag
    // before the transaction finishes without blocking CLI startup.
    const agent = detectAgent();
    if (agent) {
      setAgentTags(agent);
    } else {
      detectAgentFromProcessTree()
        .then((processAgent) => {
          if (processAgent) {
            setAgentTags(processAgent);
          }
        })
        .catch((error) => {
          logger.withTag("agent").warn("Process tree detection failed:", error);
        });
    }

    // Wire up consola → Sentry log forwarding now that the client is active
    attachSentryReporter();

    // End healthy sessions and flush events when the event loop drains.
    // The SDK's processSessionIntegration starts a session during init and
    // registers its own beforeExit handler that ends non-OK (crashed/errored)
    // sessions. We complement it by ending OK sessions (clean exit → 'exited')
    // and flushing pending events. This covers unhandled rejections and other
    // paths that bypass withTelemetry's try/catch.
    // Ref: https://nodejs.org/api/process.html#event-beforeexit
    //
    // Skipped in library mode — the host owns the process lifecycle.
    // The library entry point calls client.flush() manually after completion.
    if (!libraryMode) {
      currentBeforeExitHandler = createBeforeExitHandler(client);
      process.on("beforeExit", currentBeforeExitHandler);
    }
  }

  return client;
}

/**
 * Set the command name on the telemetry span.
 *
 * Called by stricli's forCommand context builder with the resolved
 * command path (e.g., "auth.login", "issue.list").
 *
 * @param span - The span to update (from withTelemetry callback)
 * @param command - The command name (dot-separated path)
 */
export function setCommandSpanName(
  span: Span | undefined,
  command: string
): void {
  if (span) {
    Sentry.updateSpanName(span, command);
  }
  // Also set as tag for easier filtering in Sentry UI
  Sentry.setTag("command", command);
}

/**
 * Set organization and project context as tags.
 *
 * Call this from commands after resolving the target org/project
 * to enable filtering by org/project in Sentry.
 * Accepts arrays to support multi-project commands.
 *
 * @param orgs - Organization slugs
 * @param projects - Project slugs
 */
export function setOrgProjectContext(orgs: string[], projects: string[]): void {
  if (orgs.length > 0) {
    Sentry.setTag("sentry.org", orgs.join(","));
  }
  if (projects.length > 0) {
    Sentry.setTag("sentry.project", projects.join(","));
  }
}

/**
 * Flag names whose values must never be sent to telemetry.
 * Values for these flags are replaced with "[REDACTED]" regardless of content.
 */
const SENSITIVE_FLAGS = new Set(["token"]);

/**
 * Convert a flag value to a telemetry tag string.
 *
 * Handles booleans, objects (JSON-serialized to avoid "[object Object]"),
 * and primitives. Truncates to 200 chars for Sentry tag limits.
 */
function flagValueToTag(value: unknown): string {
  if (typeof value === "boolean") {
    return String(value);
  }
  // Arrays serialize as comma-separated strings (matching existing behavior)
  if (Array.isArray(value)) {
    return String(value).slice(0, 200);
  }
  // Non-array objects (e.g., TimeRange) must be JSON-serialized to avoid
  // "[object Object]" from String()
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value).slice(0, 200);
  }
  return String(value).slice(0, 200);
}

/**
 * Set command flags as telemetry tags.
 *
 * Converts flag names from camelCase to kebab-case and sets them as tags
 * with the `flag.` prefix (e.g., `flag.no-modify-path`).
 *
 * Only sets tags for flags with non-default/meaningful values:
 * - Boolean flags: only when true
 * - String/number flags: only when defined and non-empty
 * - Array flags: only when non-empty
 *
 * Sensitive flags (e.g., `--token`) have their values replaced with
 * "[REDACTED]" to prevent secrets from reaching telemetry.
 *
 * Call this at the start of command func() to instrument flag usage.
 *
 * @param flags - The parsed flags object from Stricli
 *
 * @example
 * ```ts
 * async func(this: SentryContext, flags: MyFlags): Promise<void> {
 *   setFlagContext(flags);
 *   // ... command implementation
 * }
 * ```
 */
export function setFlagContext(flags: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(flags)) {
    // Skip undefined/null values
    if (value === undefined || value === null) {
      continue;
    }

    // Skip false booleans (default state)
    if (value === false) {
      continue;
    }

    // Skip empty strings
    if (value === "") {
      continue;
    }

    // Skip empty arrays
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }

    // Convert camelCase to kebab-case for consistency with CLI flag names
    const kebabKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();

    // Redact sensitive flag values (e.g., API tokens) — never send secrets to telemetry
    if (SENSITIVE_FLAGS.has(kebabKey)) {
      Sentry.setTag(`flag.${kebabKey}`, "[REDACTED]");
      continue;
    }

    // Set the tag with flag. prefix
    Sentry.setTag(`flag.${kebabKey}`, flagValueToTag(value));
  }
}

/**
 * Set positional arguments as Sentry context.
 *
 * Stores positional arguments in a structured context for debugging.
 * Unlike tags, context is not indexed but provides richer data.
 *
 * @param args - The positional arguments passed to the command
 */
export function setArgsContext(args: readonly unknown[]): void {
  if (args.length === 0) {
    return;
  }

  Sentry.setContext("args", {
    values: args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    ),
    count: args.length,
  });
}

/**
 * Record a cache hit or miss as a distribution metric (0 or 100).
 *
 * Emitting 0 for miss and 100 for hit allows computing hit rate as
 * `avg(value,cache.hit_rate,distribution,none)` on the tracemetrics
 * dashboard — Sentry doesn't support division in widgets, so this
 * pre-computed approach gives us percentages directly.
 *
 * @param cacheName - Identifier for the cache (e.g., "dsn", "project", "region", "http")
 * @param hit - Whether the cache lookup was a hit
 */
export function recordCacheHit(cacheName: string, hit: boolean): void {
  Sentry.metrics.distribution("cache.hit_rate", hit ? 100 : 0, {
    attributes: { cache_name: cacheName },
  });
}

export type WizardPromptKind = "select" | "multiselect" | "confirm" | "welcome";

type WizardPromptTelemetry = {
  setActiveStep(stepId: string, active: boolean): void;
  tracePrompt<T>(kind: WizardPromptKind, prompt: () => Promise<T>): Promise<T>;
};

/**
 * Track time spent waiting for human input during `sentry init`.
 *
 * Prompt spans make user think-time visible in the trace instead of folding it
 * into the top-level `sentry.init` duration. The measurement is accumulated on
 * the root span so a run can be compared both with and without user wait time.
 */
export function createWizardPromptTelemetry(): WizardPromptTelemetry {
  let activeStepId: string | undefined;
  let totalWaitMs = 0;

  return {
    setActiveStep(stepId, active) {
      if (active) {
        activeStepId = stepId;
      } else if (activeStepId === stepId) {
        activeStepId = undefined;
      }
    },
    tracePrompt(kind, prompt) {
      const stepId = activeStepId;
      return withTracingSpan(
        `wizard.prompt.${kind}`,
        "ui.prompt",
        async (span) => {
          const startedAt = performance.now();
          try {
            return await prompt();
          } finally {
            const waitMs = Math.max(0, performance.now() - startedAt);
            totalWaitMs += waitMs;

            span.setAttributes({
              "wizard.user_wait_ms": waitMs,
              "wizard.user_wait_total_ms": totalWaitMs,
            });
            Sentry.setMeasurement(
              "wizard.user_wait_ms",
              totalWaitMs,
              "millisecond",
              Sentry.getRootSpan(span)
            );
            Sentry.metrics.distribution("wizard.user_wait_ms", waitMs, {
              attributes: {
                prompt_kind: kind,
                ...(stepId ? { workflow_step: stepId } : {}),
              },
            });
          }
        },
        {
          "wizard.prompt.kind": kind,
          "wizard.prompt.phase": stepId ? "workflow" : "preflight",
          ...(stepId ? { "wizard.step.id": stepId } : {}),
        }
      );
    },
  };
}

/**
 * Wrap an operation with a Sentry span for tracing.
 *
 * Creates a child span under the current active span to track
 * operation duration and status. Automatically sets span status
 * to OK on success or Error on failure.
 *
 * Use this generic helper for custom operations, or use the specialized
 * helpers (withHttpSpan, withDbSpan, withFsSpan, withSerializeSpan) for
 * common operation types.
 *
 * @param name - Span name (e.g., "scanDirectory", "findProjectRoot")
 * @param op - Operation type (e.g., "dsn.scan", "file.read")
 * @param fn - Function to execute within the span
 * @param attributes - Optional span attributes for additional context
 * @returns The result of the function
 */
export function withTracing<T>(
  name: string,
  op: string,
  fn: () => T | Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return Sentry.startSpan(
    { name, op, attributes, onlyIfParent: true },
    async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: 1 }); // OK
        return result;
      } catch (error) {
        span.setStatus({ code: 2 }); // Error
        throw error;
      }
    }
  );
}

/**
 * Wrap an operation with a Sentry span, passing the span to the callback.
 *
 * Like `withTracing`, but passes the span to the callback for cases where
 * you need to set attributes or record metrics during execution.
 * Automatically sets span status to OK on success or Error on failure,
 * unless the callback has already set a status.
 *
 * @param name - Span name (e.g., "scanDirectory", "findProjectRoot")
 * @param op - Operation type (e.g., "dsn.scan", "file.read")
 * @param fn - Function to execute, receives the span as argument
 * @param attributes - Optional initial span attributes
 * @returns The result of the function
 *
 * @example
 * ```ts
 * const result = await withTracingSpan(
 *   "scanDirectory",
 *   "dsn.scan",
 *   async (span) => {
 *     const files = await collectFiles();
 *     span.setAttribute("files.count", files.length);
 *     return processFiles(files);
 *   },
 *   { "scan.dir": cwd }
 * );
 * ```
 */
export function withTracingSpan<T>(
  name: string,
  op: string,
  fn: (span: Span) => T | Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return Sentry.startSpan(
    { name, op, attributes, onlyIfParent: true },
    async (span) => {
      // Track if callback sets status, so we don't override it
      let statusWasSet = false;
      const originalSetStatus = span.setStatus.bind(span);
      span.setStatus = (...args) => {
        statusWasSet = true;
        return originalSetStatus(...args);
      };

      try {
        const result = await fn(span);
        if (!statusWasSet) {
          span.setStatus({ code: 1 }); // OK
        }
        return result;
      } catch (error) {
        if (!statusWasSet) {
          span.setStatus({ code: 2 }); // Error
        }
        throw error;
      }
    }
  );
}

/**
 * Wrap an HTTP request with a span for tracing.
 *
 * Creates a child span under the current active span to track
 * HTTP request duration and status.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param url - Request URL or path
 * @param fn - The async function that performs the HTTP request
 * @returns The result of the function
 */
export function withHttpSpan<T>(
  method: string,
  url: string,
  fn: () => Promise<T>
): Promise<T> {
  return withTracing(`${method} ${url}`, "http.client", fn, {
    "http.request.method": method,
    "url.path": url,
  });
}

/**
 * Wrap a database operation with a span for tracing.
 *
 * Creates a child span under the current active span to track
 * database operation duration. This is a synchronous wrapper that
 * preserves the sync nature of the callback.
 *
 * Use this for grouping logical operations (e.g., "clearAuth" which runs
 * multiple queries). Individual SQL queries are automatically traced when
 * using a database wrapped with `createTracedDatabase`.
 *
 * @param operation - Name of the operation (e.g., "getAuthToken", "setDefaults")
 * @param fn - The function that performs the database operation
 * @returns The result of the function
 */
export function withDbSpan<T>(operation: string, fn: () => T): T {
  return Sentry.startSpan(
    {
      name: operation,
      op: "db.operation",
      attributes: { "db.system": "sqlite" },
      onlyIfParent: true,
    },
    fn
  );
}

/** Intentional no-op used as a self-replacement target for one-shot functions. */
// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional noop
const noop = (): void => {};

/** Resolves the database path, falling back to a default if the import fails. */
function resolveDbPath(): string {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const { getDbPath } = _require("./db/index.js") as {
      getDbPath: () => string;
    };
    return getDbPath();
  } catch {
    return "~/.sentry/cli.db";
  }
}

/**
 * Print a one-time warning to stderr when the local database is read-only.
 * Replaces itself with a noop after the first call so subsequent invocations
 * are free. Assigned via `let` so the binding can be swapped.
 *
 * Uses lazy require for db/index.js to avoid a circular dependency
 * (db/index.ts imports createTracedDatabase from this module).
 */
let warnReadonlyDatabaseOnce = (): void => {
  warnReadonlyDatabaseOnce = noop;

  const dbPath = resolveDbPath();
  process.stderr.write(
    `\nWarning: Sentry CLI local database is read-only. Caching and preferences won't persist.\n` +
      `  Path: ${dbPath}\n` +
      "  Fix:  sentry cli fix\n\n"
  );
};

/** Whether we already attempted a permission repair this process. */
let repairAttempted = false;

/**
 * Attempt to repair database file permissions so future commands can write.
 *
 * SQLite caches the readonly state at connection open time, so even after a
 * successful chmod the *current* connection remains readonly. This function
 * repairs permissions for the NEXT command and prints a differentiated message.
 * If the repair fails (e.g., file owned by another user) we fall through to
 * {@link warnReadonlyDatabaseOnce} which tells the user to run `sentry cli fix`.
 *
 * Replaces itself with a noop after the first call via the `repairAttempted`
 * guard so we only try once per process.
 */
/**
 * Chmod a path, ignoring ENOENT (file doesn't exist yet).
 * Re-throws any other error so permission failures aren't silently masked.
 */
function chmodIfExists(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Check whether the file at `filePath` is owned by root (uid 0).
 * Returns false if the file doesn't exist, can't be stat'd, or if running on
 * Windows where `fs.stat().uid` always returns 0 regardless of ownership.
 */
function isOwnedByRoot(filePath: string): boolean {
  // Windows fs.stat() always reports uid 0 — skip the check entirely.
  if (process.platform === "win32") {
    return false;
  }
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return statSync(filePath).uid === 0;
  } catch {
    return false;
  }
}

function tryRepairReadonly(): boolean {
  if (repairAttempted) {
    return false;
  }
  repairAttempted = true;

  const dbPath = resolveDbPath();
  const { dirname } = _require("node:path") as {
    dirname: (p: string) => string;
  };
  const configDir = dirname(dbPath);

  // If the config dir or DB file is root-owned, chmod won't help.
  // Emit an actionable message telling the user to run sudo chown.
  if (isOwnedByRoot(configDir) || isOwnedByRoot(dbPath)) {
    const username = getRealUsername();
    // Disable the generic warning — we're emitting a better one here.
    warnReadonlyDatabaseOnce = noop;
    process.stderr.write(
      "\nWarning: Sentry CLI config directory is owned by root.\n" +
        `  Path:  ${configDir}\n` +
        `  Fix:   sudo chown -R ${username} "${configDir}"\n` +
        "  Or:    sudo sentry cli fix\n\n"
    );
    return false;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // Repair config directory (needs rwx for WAL/SHM creation)
    chmodSync(configDir, 0o700);

    // Repair database file and journal files
    chmodSync(dbPath, 0o600);
    chmodIfExists(`${dbPath}-wal`, 0o600);
    chmodIfExists(`${dbPath}-shm`, 0o600);

    // Disable the fallback warning — repair succeeded
    warnReadonlyDatabaseOnce = noop;

    process.stderr.write(
      "\nNote: Database permissions were auto-repaired. Caching will resume on next command.\n\n"
    );
    return true;
  } catch {
    // chmod failed — fall through so warnReadonlyDatabaseOnce fires
    return false;
  }
}

/**
 * Reset all readonly-related state (for testing).
 * @internal
 */
export function resetReadonlyWarning(): void {
  repairAttempted = false;
  warnReadonlyDatabaseOnce = (): void => {
    warnReadonlyDatabaseOnce = noop;

    const dbPath = resolveDbPath();
    process.stderr.write(
      `\nWarning: Sentry CLI local database is read-only. Caching and preferences won't persist.\n` +
        `  Path: ${dbPath}\n` +
        "  Fix:  sentry cli fix\n\n"
    );
  };
}

/** Methods on SQLite Statement that execute queries and should be traced */
const TRACED_STATEMENT_METHODS = ["get", "run", "all", "values"] as const;

/**
 * Handle a readonly database error by attempting auto-repair and returning a
 * type-appropriate no-op value. Returns `undefined` for run/get (void / no-row)
 * and `[]` for all/values (empty result set).
 *
 * First tries to repair file permissions via {@link tryRepairReadonly}. If that
 * fails (or was already attempted), falls back to a one-shot warning directing
 * the user to `sentry cli fix`.
 */
function handleReadonlyError(method: string | symbol): unknown {
  if (!tryRepairReadonly()) {
    warnReadonlyDatabaseOnce();
  }
  if (method === "all" || method === "values") {
    return [];
  }
  return;
}

/**
 * Wrap a SQLite Statement to automatically trace query execution.
 *
 * Intercepts get/run/all/values methods and wraps them with Sentry spans
 * that include the SQL query as both the span name and db.statement attribute.
 *
 * @param stmt - The SQLite Statement to wrap
 * @param sql - The SQL query string (parameterized)
 * @returns A proxied Statement with automatic tracing
 *
 * @internal Used by createTracedDatabase
 */
function createTracedStatement<T>(stmt: T, sql: string): T {
  return new Proxy(stmt as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);

      // Non-function properties pass through directly
      if (typeof value !== "function") {
        return value;
      }

      // Non-traced methods get bound to preserve 'this' context for native methods
      if (
        !TRACED_STATEMENT_METHODS.includes(
          prop as (typeof TRACED_STATEMENT_METHODS)[number]
        )
      ) {
        return value.bind(target);
      }

      // Traced methods get wrapped with Sentry span and auto-repair
      return (...args: unknown[]) =>
        Sentry.startSpan(
          {
            name: sql,
            op: "db",
            attributes: {
              "db.system": "sqlite",
              "db.statement": sql,
            },
            onlyIfParent: true,
          },
          () => {
            const execute = () =>
              (value as (...a: unknown[]) => unknown).apply(target, args);

            try {
              return execute();
            } catch (error) {
              // Attempt auto-repair for schema errors
              const repairResult = tryRepairAndRetry(execute, error);
              if (repairResult.attempted) {
                return repairResult.result;
              }

              // Handle readonly database gracefully: warn once, skip the write.
              // The CLI still works — reads succeed, only caching/persistence is lost.
              if (isReadonlyError(error)) {
                return handleReadonlyError(prop);
              }

              // Re-throw if repair didn't help or wasn't applicable
              throw error;
            }
          }
        );
    },
  }) as T;
}

/** Minimal interface for a database with a query method */
type QueryableDatabase = { query: (sql: string) => unknown };

/**
 * Wrap a SQLite Database to automatically trace all queries.
 *
 * Intercepts the query() method and wraps returned Statements with
 * createTracedStatement, which traces get/run/all/values calls.
 *
 * @param db - The SQLite Database to wrap
 * @returns A proxied Database with automatic query tracing
 *
 * @example
 * ```ts
 * const db = new Database(":memory:");
 * const tracedDb = createTracedDatabase(db);
 *
 * // This query execution is automatically traced with the SQL as span name
 * tracedDb.query("SELECT * FROM users WHERE id = ?").get(1);
 * ```
 */
export function createTracedDatabase<T extends QueryableDatabase>(db: T): T {
  const originalQuery = db.query.bind(db) as (sql: string) => unknown;

  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === "query") {
        return (sql: string) => {
          // Try to prepare the statement, with auto-repair on schema errors
          const prepareStatement = () => originalQuery(sql);

          let stmt: unknown;
          try {
            stmt = prepareStatement();
          } catch (error) {
            // Attempt auto-repair for schema errors during statement preparation
            const repairResult = tryRepairAndRetry(prepareStatement, error);
            if (repairResult.attempted) {
              stmt = repairResult.result;
            } else {
              throw error;
            }
          }

          return createTracedStatement(stmt, sql);
        };
      }
      const value = Reflect.get(target, prop);
      // Bind methods to preserve 'this' context for native methods with private fields
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as T;
}

/**
 * Wrap a serialization/formatting operation with a span for tracing.
 *
 * Creates a child span under the current active span to track
 * expensive formatting operations. This is a synchronous wrapper that
 * preserves the sync nature of the callback.
 *
 * @param operation - Name of the operation (e.g., "formatSpanTree")
 * @param fn - The function that performs the formatting
 * @returns The result of the function
 */
export function withSerializeSpan<T>(operation: string, fn: () => T): T {
  return Sentry.startSpan(
    {
      name: operation,
      op: "serialize",
      onlyIfParent: true,
    },
    fn
  );
}

/**
 * Wrap a file system operation with a span for tracing.
 *
 * Creates a child span under the current active span to track
 * file system operation duration and status.
 *
 * @param operation - Name of the operation (e.g., "readFile", "scanDirectory")
 * @param fn - The function that performs the file operation
 * @returns The result of the function
 */
export function withFsSpan<T>(
  operation: string,
  fn: () => T | Promise<T>
): Promise<T> {
  return withTracing(operation, "file", fn);
}

/**
 * Wrap a cache operation with a Sentry Cache Module span.
 *
 * Implements the [Sentry Cache Module spec](https://develop.sentry.dev/sdk/performance/modules/caches/)
 * for the Caches Insights dashboard. The span is passed to the callback so
 * callers can set `cache.hit`, `cache.item_size`, etc. after the lookup.
 *
 * @param name - Span name (typically the cache key or a descriptive label)
 * @param op - Cache operation: `"cache.get"` for reads, `"cache.put"` for writes
 * @param fn - Function to execute, receives the span for dynamic attribute setting
 * @param attributes - Initial span attributes (e.g., `cache.key`, `network.peer.address`)
 * @returns The result of the function
 */
export function withCacheSpan<T>(
  name: string,
  op: "cache.get" | "cache.put",
  fn: (span: Span) => T | Promise<T>,
  attributes?: Record<string, string | number | boolean | string[]>
): Promise<T> {
  return Sentry.startSpan(
    { name, op, attributes, onlyIfParent: true },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: 1 }); // OK
        return result;
      } catch (error) {
        span.setStatus({ code: 2 }); // Error
        throw error;
      }
    }
  );
}
