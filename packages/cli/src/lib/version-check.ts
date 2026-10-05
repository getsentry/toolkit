/**
 * Background version check for "new version available" notifications.
 *
 * For nightly builds (CLI_VERSION contains "-dev.<timestamp>"), checks GHCR for the
 * latest nightly version via the OCI manifest annotation. For stable builds,
 * checks GitHub Releases. Results are cached in the database and shown on
 * subsequent runs.
 */

// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import { compare as semverCompare } from "semver";
import type { UpgradeSource } from "./binary.js";
import { CLI_VERSION } from "./constants.js";
import { getReleaseChannel } from "./db/release-channel.js";
import {
  getVersionCheckInfo,
  markUpdateNotified,
  setVersionCheckInfo,
} from "./db/version-check.js";
import {
  prefetchNightlyPatches,
  prefetchStablePatches,
} from "./delta-upgrade.js";
import { getEnv } from "./env.js";
import { isUserError } from "./errors.js";
import { cyan, muted } from "./formatters/colors.js";
import { GLOBAL_FLAGS } from "./global-flags.js";
import { logger } from "./logger.js";
import { cleanupPatchCache } from "./patch-cache.js";
import {
  fetchLatestFromGitHubWithSource,
  fetchLatestNightlyVersionWithSource,
} from "./upgrade.js";

/** Target check interval: ~24 hours */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum time between successive "new version available" notifications.
 *
 * Rate-limits the banner to once per 24h regardless of how many commands
 * run in that window. Previously the banner fired on every invocation as
 * long as the cached latest-version was ahead of CLI_VERSION, cluttering
 * scripts, CI output, and screen-sharing sessions (see CLI UX feedback
 * getsentry/cli#785 item #10).
 */
const NOTIFICATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Jitter factor for probabilistic checking (±20%) */
const JITTER_FACTOR = 0.2;

/** Commands/flags that should not show update notifications */
const SUPPRESSED_ARGS = new Set([
  "upgrade",
  "--version",
  "-V",
  "--json",
  "token",
  // `init` runs an interactive wizard with its own terminal UI, so suppress
  // update notifications explicitly to avoid unrelated banners mid-flow.
  "init",
]);

/**
 * CLI management subcommands that should not trigger version checks.
 * Matched only when preceded by "cli" to avoid false positives
 * (e.g., `--project setup` should not suppress notifications).
 */
const SUPPRESSED_CLI_SUBCOMMANDS = new Set(["setup", "fix"]);

/** Global value-flag names that consume the following token as their value. */
const GLOBAL_VALUE_FLAG_NAMES = new Set(
  GLOBAL_FLAGS.filter((f) => f.kind === "value").map((f) => f.name)
);

/**
 * Advance past a value-taking global flag's spaced value.
 *
 * A value flag like `--org acme` consumes the following token as its value, so
 * that token must not be mistaken for a command-path segment. Returns the index
 * of the flag's value when `args[i]` is such a flag with a spaced value, or `i`
 * itself otherwise. The caller adds 1 for the normal single-token step.
 *
 * @param args - CLI arguments being scanned
 * @param i - Index of the flag token under inspection
 * @returns The last index consumed by the flag at `i`
 */
function skipGlobalValueFlagValue(args: readonly string[], i: number): number {
  const token = args[i] ?? "";
  const name = token.startsWith("--") ? token.slice(2) : "";
  const next = args[i + 1];
  if (
    GLOBAL_VALUE_FLAG_NAMES.has(name) &&
    !token.includes("=") &&
    next !== undefined &&
    !next.startsWith("-")
  ) {
    return i + 1;
  }
  return i;
}

/**
 * Locate the `cli` command group in argv, skipping any leading global flags.
 *
 * Global flags may precede the command (`sentry --verbose cli setup`) since
 * they're recognized by the route scanner at any depth rather than hoisted, so
 * `cli` is not necessarily `args[0]`. Only global flags (and the values of
 * value-taking global flags) may precede it — the first non-flag token settles
 * the command group, and a `--` escape ends the search.
 *
 * @param args - CLI arguments (`process.argv.slice(2)`-style, post-normalize)
 * @returns The index of the `cli` token, or `undefined` when the first command
 *   token is not `cli`
 */
function cliGroupIndex(args: readonly string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--") {
      return;
    }
    if (!token.startsWith("-")) {
      return token === "cli" ? i : undefined;
    }
    i = skipGlobalValueFlagValue(args, i);
  }
  return;
}

/**
 * Find the first positional (non-global-flag) token after the `cli` group at
 * `start`, or `undefined` if there is none.
 *
 * Global flags may sit between `cli` and its subcommand (`sentry cli --verbose
 * setup`) because they're recognized by the route scanner at any depth, not
 * hoisted. This skips global flags and the value consumed by a value-taking
 * global flag (`--org acme`) so the real subcommand is found regardless of
 * interleaved flags. Tokens after a `--` escape are not command-path segments
 * and stop the scan.
 *
 * @param args - CLI arguments (`process.argv.slice(2)`-style, post-normalize)
 * @param start - Index of the `cli` group token
 * @returns The `cli` subcommand token, or `undefined` when absent
 */
function cliSubcommandAfterGroup(
  args: readonly string[],
  start: number
): string | undefined {
  for (let i = start + 1; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--") {
      return;
    }
    if (!token.startsWith("-")) {
      return token;
    }
    i = skipGlobalValueFlagValue(args, i);
  }
  return;
}

/** AbortController for pending version check fetch */
let pendingAbortController: AbortController | null = null;

/**
 * Determine if we should check for updates based on time since last check.
 * Uses probabilistic approach: probability increases as we approach/pass the interval.
 */
function shouldCheckForUpdate(): boolean {
  const { lastChecked } = getVersionCheckInfo();

  if (lastChecked === null) {
    return true;
  }

  const elapsed = Date.now() - lastChecked;

  // Add jitter to the interval (±20%)
  const jitter = (Math.random() - 0.5) * 2 * JITTER_FACTOR;
  const effectiveInterval = CHECK_INTERVAL_MS * (1 + jitter);

  // Probability ramps up as we approach/exceed the interval
  // At 0% of interval: ~0% chance
  // At 100% of interval: ~63% chance (1 - 1/e)
  // At 200% of interval: ~86% chance
  const probability = 1 - Math.exp(-elapsed / effectiveInterval);

  return Math.random() < probability;
}

/**
 * Check if update notifications should be suppressed for these args.
 */
export function shouldSuppressNotification(args: string[]): boolean {
  if (args.some((arg) => SUPPRESSED_ARGS.has(arg))) {
    return true;
  }
  // Suppress for "cli <subcommand>" management commands (setup, fix). Global
  // flags are no longer hoisted, so they may precede `cli` (`--verbose cli
  // setup`) or sit between `cli` and the subcommand (`cli --verbose setup`);
  // resolve the group and its subcommand past any interleaved global flags.
  const cliIndex = cliGroupIndex(args);
  if (cliIndex !== undefined) {
    const subcommand = cliSubcommandAfterGroup(args, cliIndex);
    if (
      subcommand !== undefined &&
      SUPPRESSED_CLI_SUBCOMMANDS.has(subcommand)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Abort any pending version check to allow process exit.
 * Call this when main CLI work is complete.
 */
export function abortPendingVersionCheck(): void {
  pendingAbortController?.abort();
  pendingAbortController = null;
}

/**
 * Pre-fetch delta patches for a newly discovered version.
 *
 * Best-effort: errors are silently caught so the version check still succeeds.
 * After pre-fetching, opportunistically cleans up stale cached patches.
 */
async function maybePrefetchPatches(
  channel: "stable" | "nightly",
  latestVersion: string,
  signal: AbortSignal,
  source: UpgradeSource
): Promise<void> {
  if (semverCompare(latestVersion, CLI_VERSION) !== 1) {
    return;
  }
  try {
    if (channel === "nightly") {
      await prefetchNightlyPatches(latestVersion, signal, source);
    } else {
      await prefetchStablePatches(latestVersion, signal, source);
    }
  } catch (error) {
    logger.debug("Delta patch pre-fetch failed (best-effort)", error);
  }

  // Opportunistic cleanup of stale cached patches
  try {
    await cleanupPatchCache();
  } catch (error) {
    logger.debug("Patch cache cleanup failed (best-effort)", error);
  }
}

/**
 * Start a background check for new versions.
 * Does not block - fires a fetch and lets it complete in the background.
 * Reports errors to Sentry in a detached span for visibility.
 * Never throws - errors are caught and reported to Sentry.
 */
function checkForUpdateInBackgroundImpl(): void {
  try {
    if (!shouldCheckForUpdate()) {
      return;
    }
  } catch (error) {
    // DB access failed - report to Sentry but don't crash CLI
    Sentry.captureException(error);
    return;
  }

  pendingAbortController = new AbortController();
  const { signal } = pendingAbortController;

  const channel = getReleaseChannel();

  Sentry.startSpanManual(
    {
      name: "version-check",
      op: "version.check",
      forceTransaction: true,
    },
    async (span) => {
      try {
        // Use GHCR for nightly channel; GitHub Releases for stable.
        const { version: latestVersion, source } =
          channel === "nightly"
            ? await fetchLatestNightlyVersionWithSource(signal)
            : await fetchLatestFromGitHubWithSource(signal);
        setVersionCheckInfo(latestVersion);

        // Pre-fetch delta patches so `sentry cli upgrade` can apply them offline
        await maybePrefetchPatches(channel, latestVersion, signal, source);

        span.setStatus({ code: 1 }); // OK
      } catch (error) {
        // Don't report abort errors - they're expected when process exits.
        // Record other errors (network failures, JSON parse errors) as span
        // attributes rather than captureException — these are transient
        // infrastructure issues (GitHub rate limits, CDN errors), not CLI bugs.
        // They remain queryable in Discover without cluttering the Issues feed.
        if (error instanceof Error && error.name !== "AbortError") {
          span.setAttribute("version_check.error", error.message);
          span.setAttribute("version_check.error_type", error.constructor.name);
        }
        span.setStatus({ code: 2 }); // Error
      } finally {
        pendingAbortController = null;
        span.end();
      }
    }
  );
}

/**
 * Check whether stderr is attached to a TTY.
 *
 * Non-TTY output covers scripts piping into other commands, CI logs, and
 * editors capturing CLI output. The update banner is human-only signal —
 * suppress it when no human will read it. Matches `gh` CLI behavior.
 */
function isStderrTTY(): boolean {
  return Boolean(process.stderr.isTTY);
}

/**
 * Whether we've already returned an update notification this process.
 *
 * A single process (e.g. `sentry help` piped into `less`) may read the
 * notification twice — once for the banner render, once by other code
 * paths — but we only want to count as "notified" once.
 */
let notifiedThisProcess = false;

/**
 * Check whether enough time has passed since the last notification.
 *
 * Uses the DB-backed `last_notified` timestamp so the rate limit survives
 * across CLI invocations. Returns `true` on first-ever notification
 * (`lastNotified === null`).
 */
function canNotifyAgain(lastNotified: number | null): boolean {
  if (lastNotified === null) {
    return true;
  }
  return Date.now() - lastNotified >= NOTIFICATION_INTERVAL_MS;
}

/**
 * Build an update notification when a newer version is available.
 * Returns null if up-to-date, no cached version info, rate-limited, on a
 * non-TTY stderr, or on error. Never throws — errors are caught and
 * reported to Sentry.
 *
 * Side effects: when a non-null message is returned, the function also
 * persists `last_notified = now` via {@link markUpdateNotified} so
 * subsequent invocations within the rate-limit window return null.
 */
function getUpdateNotificationWithCopy(
  formatNotification: (latestVersion: string) => string
): string | null {
  // Gate 1: non-TTY stderr (scripts, CI, pipes).
  if (!isStderrTTY()) {
    return null;
  }

  // Gate 2: don't double-emit within the same process.
  if (notifiedThisProcess) {
    return null;
  }

  try {
    const { latestVersion, lastNotified } = getVersionCheckInfo();

    if (!latestVersion) {
      return null;
    }

    // Use Bun's native semver comparison (polyfilled for Node.js)
    // order() returns 1 if first arg is greater than second
    if (semverCompare(latestVersion, CLI_VERSION) !== 1) {
      return null;
    }

    // Gate 3: daily rate limit across CLI invocations.
    if (!canNotifyAgain(lastNotified)) {
      return null;
    }

    const notification = formatNotification(latestVersion);

    // Record that we're about to print the banner so repeat invocations
    // within the rate-limit window stay silent. Failures here are
    // non-fatal: the banner still prints, it just won't be rate-limited
    // on the next run. That's strictly better than swallowing the notice.
    try {
      markUpdateNotified();
    } catch (error) {
      Sentry.captureException(error);
    }
    notifiedThisProcess = true;

    return notification;
  } catch (error) {
    // DB access failed - report to Sentry but don't crash CLI
    Sentry.captureException(error);
    return null;
  }
}

function formatStandardUpdateNotification(latestVersion: string): string {
  const channel = getReleaseChannel();
  const label =
    channel === "nightly" ? "New nightly available:" : "Update available:";

  return `\n${muted(label)} ${cyan(CLI_VERSION)} -> ${cyan(latestVersion)}  Run ${cyan('"sentry cli upgrade"')} to update.\n`;
}

function formatContextualUpdateNotification(latestVersion: string): string {
  return (
    `\n${muted("A new version of sentry-cli is available")} (${cyan(latestVersion)})${muted(".")} ` +
    `${muted("Upgrading may resolve this — we fix a lot of bugs in every release.")} ` +
    `${muted("Run")} ${cyan('"sentry cli upgrade"')} ${muted("to update.")}\n`
  );
}

/**
 * Reset the in-process "already notified" latch.
 *
 * Tests call this between scenarios to re-exercise the first-notification
 * path without spinning up a new process. Not part of the public API and
 * should not be called from production code.
 *
 * @internal
 */
export function resetUpdateNotificationState(): void {
  notifiedThisProcess = false;
}

/**
 * Check if update checking is disabled via environment variable.
 * Checked at runtime to support test isolation.
 */
function isUpdateCheckDisabled(): boolean {
  return getEnv().SENTRY_CLI_NO_UPDATE_CHECK === "1";
}

/**
 * Start a background check for new versions (if not disabled).
 * Does not block - fires a fetch and lets it complete in the background.
 */
export function maybeCheckForUpdateInBackground(): void {
  if (isUpdateCheckDisabled()) {
    return;
  }
  checkForUpdateInBackgroundImpl();
}

/**
 * Get the update notification message if a new version is available.
 * Returns null if disabled, up-to-date, no cached version info, or on error.
 */
export function getUpdateNotification(): string | null {
  if (isUpdateCheckDisabled()) {
    return null;
  }
  return getUpdateNotificationWithCopy(formatStandardUpdateNotification);
}

/**
 * Get an update notification for the error path.
 *
 * User errors get the standard neutral banner. Non-user errors get a
 * contextual nudge suggesting an upgrade may resolve the failure.
 *
 * Shares the same gates as {@link getUpdateNotification} (TTY, rate-limit,
 * once-per-process) so the two never double-emit.
 *
 * Returns null when no notification should be shown (suppressed command,
 * disabled, up-to-date, non-TTY, rate-limited, or on error).
 */
export function getErrorUpdateNotification(
  error: unknown,
  args: string[]
): string | null {
  if (shouldSuppressNotification(args)) {
    return null;
  }

  if (isUserError(error)) {
    return getUpdateNotification();
  }

  if (isUpdateCheckDisabled()) {
    return null;
  }
  return getUpdateNotificationWithCopy(formatContextualUpdateNotification);
}
