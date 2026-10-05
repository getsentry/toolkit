/**
 * One-shot env-token-ignored hint.
 *
 * When a user sets SENTRY_AUTH_TOKEN (or SENTRY_TOKEN) — or a `token`
 * in `.sentryclirc`, which the env shim copies into SENTRY_AUTH_TOKEN —
 * but also has a stored OAuth login from `sentry auth login`, the CLI
 * silently prefers the stored login. Users then wonder why their valid
 * provisioned token isn't being used — this was the most painful item
 * in the CLI UX feedback issue (getsentry/cli#785 #4). The hint surfaces
 * the collision on stderr the first time the CLI reaches for auth in a
 * given process, naming the real source (env var vs `.sentryclirc`).
 *
 * Design notes:
 * - Fires at most once per process (module-local latch). CLI invocations
 *   are short-lived, so "once per invocation" is the intended scope —
 *   persisting across invocations would require a DB key and add noise
 *   without a clear benefit.
 * - Gated behind `!SENTRY_FORCE_ENV_TOKEN`: when the user has already
 *   opted in to the env-var path, the hint is moot.
 * - Gated behind `hasStoredAuthCredentials()`: without a stored OAuth
 *   login there's no collision to surface.
 * - Uses `log.info` to stay clearly advisory (not a warning — nothing
 *   is wrong, just a helpful breadcrumb).
 */

// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import {
  getActiveEnvVarName,
  getRawEnvToken,
  hasStoredAuthCredentials,
} from "./db/auth.js";
import { getUserInfo } from "./db/user.js";
import { getEnv } from "./env.js";
import { logger } from "./logger.js";
import { getRcInjectedTokenSource } from "./sentryclirc.js";

const log = logger.withTag("auth");

/** Per-process latch — flipped the first time we emit the hint. */
let hintEmitted = false;

/**
 * Emit the env-token-ignored hint if the current process has the
 * collision and hasn't yet notified the user.
 *
 * Safe to call on every auth'd request — the per-process latch and
 * quick environment / DB checks mean the cost is negligible after the
 * first call.
 */
export function maybeWarnEnvTokenIgnored(): void {
  if (hintEmitted) {
    return;
  }

  // Fast path: no env token to ignore.
  const envToken = getRawEnvToken();
  if (!envToken) {
    return;
  }

  // Fast path: user opted into the env token explicitly.
  if (getEnv().SENTRY_FORCE_ENV_TOKEN?.trim()) {
    return;
  }

  // No stored OAuth → no collision. DB access failures are reported
  // to Sentry but must not crash the CLI — the hint is best-effort.
  // When `hasStoredAuthCredentials()` throws, `hasStored` stays `false`
  // and the subsequent guard suppresses the hint, which is the intended
  // conservative behavior.
  let hasStored = false;
  try {
    hasStored = hasStoredAuthCredentials();
  } catch (error) {
    Sentry.captureException(error);
  }
  if (!hasStored) {
    return;
  }

  hintEmitted = true;

  const userLabel = resolveStoredUserLabel();

  log.info(
    `${describeIgnoredTokenSource()} but using stored login for ${userLabel}.\n` +
      "  Set SENTRY_FORCE_ENV_TOKEN=1 to prefer it."
  );
}

/**
 * Describe where the ignored token came from, for the hint's first line.
 *
 * The `.sentryclirc` shim copies a `[auth] token` into `SENTRY_AUTH_TOKEN`,
 * so a bare "Detected SENTRY_AUTH_TOKEN env var" message would misattribute
 * the source — the user set a config file, not an env var (getsentry/cli#1345).
 * When the shim was the source, name the `.sentryclirc` file instead.
 */
function describeIgnoredTokenSource(): string {
  const rcSource = getRcInjectedTokenSource();
  if (rcSource) {
    return `Detected a token in .sentryclirc (${rcSource})`;
  }
  return `Detected ${getActiveEnvVarName()} env var`;
}

/**
 * Resolve a user-friendly label for the stored OAuth user.
 *
 * Prefers `username`, then `email`, then `name` — matching what
 * `sentry auth whoami` surfaces. Falls back to a neutral "stored
 * OAuth user" when the cached `user_info` row is missing (fresh DB,
 * never-ran-whoami, or read error).
 */
function resolveStoredUserLabel(): string {
  try {
    const user = getUserInfo();
    return user?.username ?? user?.email ?? user?.name ?? "stored OAuth user";
  } catch (error) {
    // DB read failure for the user-info cache is non-fatal — fall back
    // to the neutral label — but still surface the error to Sentry so
    // we can diagnose persistent cache-read failures.
    Sentry.captureException(error);
    return "stored OAuth user";
  }
}

/**
 * Reset the one-shot latch. Tests call this between scenarios so each
 * case starts with a fresh "has this process already notified" state.
 *
 * @internal
 */
export function resetAuthHintState(): void {
  hintEmitted = false;
}
