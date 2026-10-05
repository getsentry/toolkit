/**
 * CLI runner with fast-path dispatch.
 *
 * Shell completion (`__complete`) is dispatched before any heavy imports
 * to avoid loading `@sentry/node-core` (~280ms). All other commands go through
 * the full CLI with telemetry, middleware, and error recovery.
 *
 * Extracted from `bin.ts` so the logic is testable and reusable without
 * top-level side effects. `bin.ts` remains a thin wrapper that registers
 * stream error handlers and calls `startCli()`.
 */

import { redactCredentialText } from "./lib/credential-redaction.js";
import { getEnv } from "./lib/env.js";
import { CliError, formatError } from "./lib/errors.js";
import { initTimezone } from "./lib/timezone.js";

/**
 * Preload project context: walk up from `cwd` once, finding both the
 * project root (for DSN detection) and `.sentryclirc` config (for
 * org/project defaults and env shim). Caches both results so later calls
 * to `findProjectRoot` and `loadSentryCliRc` are cache hits.
 */
async function preloadProjectContext(cwd: string): Promise<void> {
  // Snapshot env-token host BEFORE anything mutates env.SENTRY_HOST/URL
  // (the .sentryclirc shim or the default-URL fallback below). Pins the
  // env-token's trust scope to the user's shell, not a repo-local file.
  // Dynamic import: env-token-host chains into db/auth → telemetry → @sentry/node-core
  const { captureEnvTokenHost } = await import("./lib/env-token-host.js");
  captureEnvTokenHost();

  // Dynamic import keeps the heavy DSN/DB modules out of the completion fast-path
  const [{ findProjectRoot }, { setCachedProjectRoot }] = await Promise.all([
    import("./lib/dsn/project-root.js"),
    import("./lib/db/project-root-cache.js"),
  ]);

  const result = await findProjectRoot(cwd);
  await setCachedProjectRoot(cwd, {
    projectRoot: result.projectRoot,
    reason: result.reason,
  });

  // Apply .sentryclirc env shim (token + URL). The URL trust check is
  // deferred to buildCommand's wrapper where commands can opt out via
  // skipRcUrlCheck (used by auth login/logout).
  // Dynamic import: sentryclirc chains into db/index → sqlite, logger → consola
  const { applySentryCliRcEnvShim } = await import("./lib/sentryclirc.js");
  await applySentryCliRcEnvShim(cwd);

  // Apply persistent URL default (lower priority than env vars and .sentryclirc).
  const env = getEnv();
  if (!(env.SENTRY_HOST?.trim() || env.SENTRY_URL?.trim())) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      const { getDefaultUrl } = await import("./lib/db/defaults.js");
      const url = getDefaultUrl();
      if (url) {
        env.SENTRY_URL = url;
      }
    } catch {
      // DB not available — skip
    }
  }
}

/**
 * Fast-path: shell completion.
 *
 * Dispatched before importing the full CLI to avoid loading @sentry/node-core,
 * @stricli/core, and other heavy dependencies. Only loads the lightweight
 * completion engine and SQLite cache modules.
 */
export async function runCompletion(completionArgs: string[]): Promise<void> {
  // Disable telemetry so db/index.ts skips the @sentry/node-core lazy-require (~280ms)
  getEnv().SENTRY_CLI_NO_TELEMETRY = "1";
  const { handleComplete } = await import("./lib/complete.js");
  handleComplete(completionArgs);
}

/**
 * Flags whose values must never be sent to telemetry.
 * Superset of `SENSITIVE_FLAGS` in `telemetry.ts` — includes `auth-token`
 * because raw argv may use either form before Stricli parses to camelCase.
 */
const SENSITIVE_ARGV_FLAGS = new Set(["token", "auth-token"]);

/**
 * Check whether an argv token is a sensitive flag that needs value redaction.
 * Returns `"eq"` for `--flag=value` form, `"next"` for `--flag <value>` form,
 * or `null` if the token is not sensitive.
 */
function sensitiveArgvFlag(token: string): "eq" | "next" | null {
  if (!token.startsWith("--")) {
    return null;
  }
  const eqIdx = token.indexOf("=");
  if (eqIdx !== -1) {
    const name = token.slice(2, eqIdx).toLowerCase();
    return SENSITIVE_ARGV_FLAGS.has(name) ? "eq" : null;
  }
  const name = token.slice(2).toLowerCase();
  return SENSITIVE_ARGV_FLAGS.has(name) ? "next" : null;
}

/**
 * Redact sensitive values from argv before sending to telemetry.
 *
 * When a token matches `--<flag>` or `--<flag>=value` for a sensitive
 * flag name, the value (next positional token or `=value` portion) is
 * replaced with `[REDACTED]`.
 */
function redactArgv(argv: string[]): string[] {
  const redacted: string[] = [];
  let skipNext = false;
  for (const token of argv) {
    if (skipNext) {
      redacted.push("[REDACTED]");
      skipNext = false;
      continue;
    }
    const kind = sensitiveArgvFlag(token);
    if (kind === "eq") {
      const eqIdx = token.indexOf("=");
      redacted.push(`${token.slice(0, eqIdx + 1)}[REDACTED]`);
    } else if (kind === "next") {
      redacted.push(token);
      skipNext = true;
    } else {
      redacted.push(token);
    }
  }
  return redacted;
}

/**
 * Whether `process.exitCode` is Stricli's UnknownCommand code.
 *
 * Checks both the raw (negative) and unsigned-byte forms because Node.js keeps
 * the raw value while Bun converts to an unsigned byte.
 */
function isUnknownCommandExit(unknownCode: number): boolean {
  return (
    process.exitCode === unknownCode ||
    process.exitCode === (unknownCode + 256) % 256
  );
}

/**
 * Recover help requests that Stricli's route scanner rejected as unknown
 * commands, re-dispatching them so the user still gets help output.
 *
 * Three shapes are recovered when the run exited with UnknownCommand:
 *
 * 1. **`--version` on an unknown command** (e.g. `sentry cli nope --version`) —
 *    in a group without a default command, the scanner aborts on the unknown
 *    token before consuming `--version`, so `versionRequested` never trips.
 *    Printed here so `--version` still wins at any depth, matching the old
 *    pre-scanner `isVersionRequest` behavior.
 * 2. **`--help --json` on an unknown command** (e.g.
 *    `sentry cli nope --help --json`) — in a group without a default command,
 *    route resolution fails before the `renderHelp` hook runs, so no JSON is
 *    produced. Retried as the `help` command so agents get a structured
 *    `{ error }` object instead of Stricli's text `UnknownCommand`.
 * 3. **A trailing `help` token** (e.g. `sentry dashboard help`) — retried as
 *    `sentry help <group...>`, which routes to the custom help command.
 *
 * @param cliArgs - The raw CLI arguments that were dispatched
 * @param executor - The command executor (middleware chain) to retry with
 * @param unknownCode - Stricli's `ExitCode.UnknownCommand`
 */
async function recoverUnknownCommandHelp(
  cliArgs: string[],
  executor: (argv: string[]) => Promise<void>,
  unknownCode: number
): Promise<void> {
  if (!isUnknownCommandExit(unknownCode) || cliArgs[0] === "help") {
    return;
  }

  const { isVersionRequest, rewriteHelpJsonToHelpCommand } = await import(
    "./lib/help.js"
  );

  if (isVersionRequest(cliArgs)) {
    process.exitCode = 0;
    const { CLI_VERSION } = await import("./lib/constants.js");
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }

  const helpJsonArgs = rewriteHelpJsonToHelpCommand(cliArgs);
  if (helpJsonArgs) {
    process.exitCode = 0;
    await executor(helpJsonArgs);
    return;
  }

  if (cliArgs.length >= 2 && cliArgs.at(-1) === "help") {
    process.exitCode = 0;
    const groupArgs = cliArgs.slice(0, -1);
    const { warning } = await import("./lib/formatters/colors.js");
    process.stderr.write(
      warning(
        `Tip: use --help for help (e.g., sentry ${groupArgs.join(" ")} --help)\n`
      )
    );
    await executor(["help", ...groupArgs]);
  }
}

/**
 * Error-recovery middleware for the CLI.
 *
 * Each middleware wraps command execution and may intercept specific errors
 * to perform recovery actions (e.g., login, start trial) then retry.
 *
 * Middlewares are applied innermost-first: the last middleware in the array
 * wraps the outermost layer, so it gets first crack at errors. This means
 * auth recovery (outermost) can catch errors from both the command AND
 * the trial prompt retry.
 *
 * @param next - The next function in the chain (command or inner middleware)
 * @param args - CLI arguments for retry
 * @returns A function with the same signature, with error recovery added
 */
type ErrorMiddleware = (
  proceed: (cmdInput: string[]) => Promise<void>,
  retryArgs: string[]
) => Promise<void>;

/**
 * Full CLI execution with telemetry, middleware, and error recovery.
 *
 * All heavy imports are loaded here (not at module top level) so the
 * `__complete` fast-path can skip them entirely.
 */
export async function runCli(cliArgs: string[]): Promise<void> {
  const { isatty } = await import("node:tty");
  const { ExitCode, run } = await import("@stricli/core");
  const { app } = await import("./app.js");
  const { buildContext } = await import("./context.js");
  const { AuthError, OutputError, getExitCode } = await import(
    "./lib/errors.js"
  );
  const { error } = await import("./lib/formatters/colors.js");
  const { runInteractiveLogin } = await import("./lib/interactive-login.js");
  const { recoverWithAutoLogin } = await import("./lib/auto-auth.js");
  const { getEnvLogLevel, setLogLevel } = await import("./lib/logger.js");
  const { scheduleForceExit } = await import("./lib/force-exit.js");
  const { closeGlobalDispatcher } = await import("./lib/close-dispatcher.js");
  const { isTrialEligible, promptAndStartTrial } = await import(
    "./lib/seer-trial.js"
  );
  const { withTelemetry } = await import("./lib/telemetry.js");
  const { startCleanupOldBinary } = await import("./lib/upgrade.js");
  const {
    abortPendingVersionCheck,
    getErrorUpdateNotification,
    getUpdateNotification,
    maybeCheckForUpdateInBackground,
    shouldSuppressNotification,
  } = await import("./lib/version-check.js");

  // Global-flag hoisting, `--version` at any route depth, and `--help --json`
  // structured output are all handled inside Stricli now (the patched route
  // scanner's top-level-flags allow-list + `versionRequested` state, and the
  // `documentation.renderHelp` hook in app.ts), so no argv preprocessing is
  // needed before dispatch — the raw args go straight to `run()`.

  // ---------------------------------------------------------------------------
  // Error-recovery middleware
  // ---------------------------------------------------------------------------

  /**
   * Seer trial prompt middleware.
   *
   * Catches trial-eligible SeerErrors and offers to start a free trial.
   * On success, retries the original command. On failure/decline, re-throws
   * so the outer error handler displays the full error with upgrade URL.
   */
  const seerTrialMiddleware: ErrorMiddleware = async (next, argv) => {
    try {
      await next(argv);
    } catch (err) {
      if (isTrialEligible(err)) {
        const started = await promptAndStartTrial(
          // biome-ignore lint/style/noNonNullAssertion: isTrialEligible guarantees orgSlug is defined
          err.orgSlug!,
          err.reason
        );

        if (started) {
          process.stderr.write("\nRetrying command...\n\n");
          await next(argv);
          return;
        }
      }
      throw err;
    }
  };

  /**
   * Attempt to import `.sentryclirc` settings when the user is unauthenticated.
   *
   * Returns `"imported"` if a trusted token was found, imported, and validated.
   * Returns `"declined"` if the user said no (marked as declined).
   * Returns `"skip"` if no eligible files, trust gate fails, or any error.
   */
  /**
   * Build a trusted import plan from non-project-local .sentryclirc files,
   * or return null if no eligible import is available.
   */
  async function buildEligibleImportPlan() {
    const { discoverRcFiles, buildImportPlan, isImportNeededAsync } =
      await import("./lib/sentryclirc-import.js");

    if (!(await isImportNeededAsync())) {
      return null;
    }
    const files = await discoverRcFiles(process.cwd());
    const eligible = files.filter((f) => f.location !== "project-local");
    if (eligible.length === 0 || !eligible.some((f) => f.token)) {
      return null;
    }
    const plan = buildImportPlan(eligible);
    if (
      !(
        plan.trusted &&
        plan.effective.token &&
        plan.newFields.includes("token")
      )
    ) {
      return null;
    }
    return plan;
  }

  async function tryRcImport(): Promise<"imported" | "declined" | "skip"> {
    const plan = await buildEligibleImportPlan();
    if (!plan) {
      return "skip";
    }

    const source = plan.sources.find((s) => s.token)?.path ?? "~/.sentryclirc";
    process.stderr.write(
      `\nFound auth token in ${source}\n` +
        "Import settings to the new CLI? This stores your token with proper host scoping.\n\n"
    );

    const consent = await promptImportConsent();
    if (consent === "declined") {
      const { markImportDeclined } = await import(
        "./lib/sentryclirc-import.js"
      );
      markImportDeclined(plan.sources);
      return "declined";
    }
    if (consent !== "accepted") {
      return "skip";
    }

    const { executeImport } = await import("./lib/sentryclirc-import.js");
    const result = await executeImport(plan, { validateToken: true });
    return result.imported && result.tokenValid !== false ? "imported" : "skip";
  }

  /**
   * Prompt the user to accept/decline the import.
   * Returns "accepted", "declined" (explicit no), or "cancelled" (Ctrl+C).
   * Only "declined" permanently suppresses future prompts.
   */
  async function promptImportConsent(): Promise<
    "accepted" | "declined" | "cancelled"
  > {
    const { logger: logModule } = await import("./lib/logger.js");
    const confirmed = await logModule
      .withTag("import")
      .prompt("Import from .sentryclirc?", { type: "confirm", initial: true });
    if (confirmed === true) {
      return "accepted";
    }
    // false = explicit "no"; Symbol(clack:cancel) = Ctrl+C
    return confirmed === false ? "declined" : "cancelled";
  }

  /** Log import middleware errors at an appropriate level */
  async function logImportError(importErr: unknown): Promise<void> {
    const { logger: logModule } = await import("./lib/logger.js");
    const { HostScopeError: HSE } = await import("./lib/errors.js");
    const importLog = logModule.withTag("import");
    if (importErr instanceof HSE) {
      importLog.warn("Import middleware error", importErr);
    } else {
      importLog.debug("Import middleware error", importErr);
    }
  }

  /**
   * `.sentryclirc` import middleware.
   *
   * When a command fails with `not_authenticated` and a non-project-local
   * `.sentryclirc` file has a token that passes the same-file trust gate,
   * offers to import it into the new CLI's SQLite store. On success, retries
   * the command. On decline, marks as declined (never asks again) and
   * re-throws so the auto-auth middleware can offer OAuth login instead.
   *
   * Only fires in interactive TTYs (disabled in CI). Project-local files
   * are excluded to avoid prompting in every cloned repo.
   */
  const rcImportMiddleware: ErrorMiddleware = async (next, argv) => {
    try {
      await next(argv);
    } catch (err) {
      let imported = false;
      if (
        err instanceof AuthError &&
        err.reason === "not_authenticated" &&
        !err.skipAutoAuth &&
        isatty(0)
      ) {
        try {
          imported = (await tryRcImport()) === "imported";
        } catch (importErr) {
          await logImportError(importErr);
        }
      }
      if (imported) {
        // Retry outside the import try/catch so retry errors propagate
        // naturally instead of being swallowed and re-throwing the
        // original AuthError.
        process.stderr.write("Import successful! Retrying command...\n\n");
        await next(argv);
        return;
      }
      throw err;
    }
  };

  /**
   * Scope recovery middleware.
   *
   * After a 401/403, compare a stored OAuth grant with the CLI's current scope
   * set. Re-authorize stale grants and retry exactly once. Non-interactive and
   * explicitly unattended commands never enter a device flow.
   */
  const scopeRecoveryMiddleware: ErrorMiddleware = async (next, argv) => {
    const { runWithScopeRecovery } = await import("./lib/scope-recovery.js");
    await runWithScopeRecovery(next, argv, runInteractiveLogin);
  };

  /**
   * Auto-authentication middleware.
   *
   * Catches auth errors (not_authenticated, expired) in interactive TTYs and
   * runs the login flow, honoring the same host-trust gate as `auth login`
   * (see {@link recoverWithAutoLogin}). On success, retries through the full
   * middleware chain so inner middlewares (e.g., trial prompt) also apply.
   */
  const autoAuthMiddleware: ErrorMiddleware = async (next, argv) => {
    try {
      await next(argv);
    } catch (err) {
      const exitCode = await recoverWithAutoLogin(err, () => next(argv), {
        runInteractiveLogin: () => runInteractiveLogin(),
      });
      if (exitCode !== undefined) {
        process.exitCode = exitCode;
      }
    }
  };

  /**
   * Error-recovery middlewares applied around command execution.
   *
   * Order matters: applied innermost-first, so the last entry wraps the
   * outermost layer. Auth middleware is outermost so it catches errors
   * from both the command and any inner middleware retries.
   */
  const errorMiddlewares: ErrorMiddleware[] = [
    seerTrialMiddleware,
    rcImportMiddleware,
    scopeRecoveryMiddleware,
    autoAuthMiddleware,
  ];

  /** Run CLI command with telemetry wrapper */
  async function runCommand(argv: string[]): Promise<void> {
    await withTelemetry(async (span) => {
      await run(app, argv, buildContext(process, span));

      // Stricli handles unknown subcommands internally — it writes to
      // stderr and sets exitCode without throwing. Report to Sentry so
      // we can track typo/confusion patterns and improve suggestions.
      if (
        process.exitCode === ExitCode.UnknownCommand ||
        process.exitCode === (ExitCode.UnknownCommand + 256) % 256
      ) {
        // Skip help/`--version` requests that `recoverUnknownCommandHelp`
        // turns into successful output — they aren't real unknown commands.
        const { isRecoverableUnknownCommand } = await import("./lib/help.js");
        if (isRecoverableUnknownCommand(argv)) {
          return;
        }
        // Best-effort: telemetry must never crash the CLI
        // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
        try {
          await reportUnknownCommand(argv);
        } catch {
          // Silently ignore telemetry failures
        }
      }
    });
  }

  /**
   * Extract org/project from raw argv by scanning for `org/project` tokens.
   *
   * Commands accept `org/project` or `org/` as positional targets.
   * Since Stricli failed at route resolution, args are unparsed — we
   * scan for the first slash-containing, non-flag token.
   */
  function extractOrgProjectFromArgv(argv: string[]): {
    org?: string;
    project?: string;
  } {
    for (const token of argv) {
      if (token.startsWith("-") || !token.includes("/")) {
        continue;
      }
      const slashIdx = token.indexOf("/");
      const org = token.slice(0, slashIdx) || undefined;
      const project = token.slice(slashIdx + 1) || undefined;
      return { org, project };
    }
    return {};
  }

  /**
   * Report an unknown subcommand to Sentry with rich context.
   *
   * Called when Stricli's route scanner rejects an unrecognized token
   * (e.g., `sentry issue helpp`). Uses the introspection system to find
   * fuzzy matches and extracts org/project context from the raw argv.
   */
  async function reportUnknownCommand(argv: string[]): Promise<void> {
    const Sentry = await import("@sentry/node-core/light");
    const { resolveCommandPath } = await import("./lib/introspect.js");
    const { routes } = await import("./app.js");
    const { getDefaultOrganization } = await import("./lib/db/defaults.js");

    // Strip flags so resolveCommandPath only sees command path segments
    const pathSegments = argv.filter((t) => !t.startsWith("-"));
    const resolved = resolveCommandPath(
      routes as unknown as Parameters<typeof resolveCommandPath>[0],
      pathSegments
    );
    const unknownToken =
      resolved?.kind === "unresolved" ? resolved.input : (argv.at(-1) ?? "");
    const suggestions =
      resolved?.kind === "unresolved" ? resolved.suggestions : [];

    // Extract org/project from argv, fall back to default org from SQLite
    const fromArgv = extractOrgProjectFromArgv(argv);
    const org = fromArgv.org ?? getDefaultOrganization() ?? undefined;

    // Redact sensitive flags (e.g., --token) before sending to Sentry
    const safeArgv = redactArgv(argv);

    Sentry.setTag("command", "unknown");
    if (org) {
      Sentry.setTag("sentry.org", org);
    }
    if (fromArgv.project) {
      Sentry.setTag("sentry.project", fromArgv.project);
    }
    Sentry.setContext("unknown_command", {
      argv: safeArgv,
      unknown_token: unknownToken,
      suggestions,
      arg_count: argv.length,
      org: org ?? null,
      project: fromArgv.project ?? null,
    });
    // Fixed message string so all unknown commands group into one Sentry
    // issue. The per-event detail (which token, suggestions) lives in the
    // structured context above and is queryable via Discover.
    Sentry.captureMessage("unknown_command", "info");
  }

  /** Build the command executor by composing error-recovery middlewares. */
  let executor = runCommand;
  for (const mw of errorMiddlewares) {
    const inner = executor;
    executor = (argv) => mw(inner, argv);
  }

  // ---------------------------------------------------------------------------
  // Main execution
  // ---------------------------------------------------------------------------

  // Clean up old binary from previous Windows upgrade (no-op if file doesn't exist)
  startCleanupOldBinary();

  // Apply SENTRY_LOG_LEVEL env var early (lazy read, not at module load time).
  // CLI flags (--log-level, --verbose) are handled by Stricli via
  // buildCommand and take priority when present.
  const envLogLevel = getEnvLogLevel();
  if (envLogLevel !== null) {
    setLogLevel(envLogLevel);
  }

  // `shouldSuppressNotification` scans for `--version`/`--json` and the
  // `cli setup`/`cli fix` subcommands at any position, skipping interleaved
  // global flags — so it works on the raw args even though global flags may
  // precede the subcommand.
  const suppressNotification = shouldSuppressNotification(cliArgs);

  // Start background update check (non-blocking)
  if (!suppressNotification) {
    maybeCheckForUpdateInBackground();
  }

  try {
    await executor(cliArgs);

    // Recover help/`--help --json` requests that Stricli's route scanner
    // rejected as unknown commands (see the helpers below).
    await recoverUnknownCommandHelp(cliArgs, executor, ExitCode.UnknownCommand);
  } catch (err) {
    // OutputError: data was already rendered to stdout by the command wrapper.
    // Just set exitCode silently — no stderr message needed.
    if (err instanceof OutputError) {
      process.exitCode = err.exitCode;
      return;
    }
    process.stderr.write(`${error("Error:")} ${formatError(err)}\n`);
    process.exitCode = getExitCode(err);
    const notification = getErrorUpdateNotification(err, cliArgs);
    if (notification) {
      process.stderr.write(notification);
    }
    return;
  } finally {
    // Abort any pending version check to allow clean exit
    abortPendingVersionCheck();
    // Arm the backstop first so it fires regardless of what the dispatcher
    // teardown does. The unref'd timer only triggers if the loop is still
    // referenced after a drained command, so it's a no-op on clean exits
    // (a libuv refcount quirk on macOS keeps it worthwhile — see #1237).
    scheduleForceExit();
    // Release undici's pooled keep-alive sockets so the event loop can drain
    // on its own — the root-cause fix. Never rejects (see close-dispatcher.ts).
    await closeGlobalDispatcher();
  }

  // Show update notification after command completes
  if (!suppressNotification) {
    const notification = getUpdateNotification();
    if (notification) {
      process.stderr.write(notification);
    }
  }
}

/**
 * Top-level CLI dispatch.
 *
 * Reads `process.argv`, dispatches to the completion fast-path or the full
 * CLI runner, and handles fatal errors. Called from `bin.ts`.
 */
export async function startCli(): Promise<void> {
  const args = process.argv.slice(2);

  // Repair the timezone before anything formats a Date. SEA binaries can fall
  // back to UTC when they cannot resolve the OS zone, which made log
  // timestamps (and all other Date output) appear in the wrong timezone.
  initTimezone();

  // Completions are a fast-path (~1ms) — skip .sentryclirc I/O.
  if (args[0] === "__complete") {
    return runCompletion(args.slice(1)).catch(() => {
      // Completions should never crash — silently return no results
      process.exitCode = 0;
    });
  }

  // Walk up from CWD once to find project root AND .sentryclirc config.
  // Caches both so later findProjectRoot / loadSentryCliRc calls are hits.
  // Most failures here are non-fatal (unreadable rc file, missing project
  // markers), but `CliError` from the rc shim's host-scoping check is an
  // actionable rejection that must surface to the user.
  try {
    await preloadProjectContext(process.cwd());
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`${formatError(err)}\n`);
      process.exitCode = err.exitCode;
      return;
    }
    // Gracefully degrade: project context is optional.
  }

  return runCli(args).catch((err) => {
    process.stderr.write(`Fatal: ${redactCredentialText(String(err))}\n`);
    process.exitCode = 1;
  });
}
