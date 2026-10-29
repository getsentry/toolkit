/**
 * Project context loading shared by every entry point that runs CLI code.
 */

import { getEnv } from "./env.js";

/**
 * Preload project context: walk up from `cwd` once, finding both the
 * project root (for DSN detection) and `.sentryclirc` config (for
 * org/project defaults and env shim). Caches both results so later calls
 * to `findProjectRoot` and `loadSentryCliRc` are cache hits.
 */
export async function preloadProjectContext(cwd: string): Promise<void> {
  // Snapshot env-token host BEFORE anything mutates env.SENTRY_HOST/URL
  // (the .sentryclirc shim or the default-URL fallback below). Pins the
  // env-token's trust scope to the user's shell, not a repo-local file.
  // Dynamic import: env-token-host chains into db/auth → telemetry → @sentry/node
  const { captureEnvTokenHost } = await import("./env-token-host.js");
  captureEnvTokenHost();

  // Dynamic import keeps the heavy DSN/DB modules out of the completion fast-path
  const [{ findProjectRoot }, { setCachedProjectRoot }] = await Promise.all([
    import("./dsn/project-root.js"),
    import("./db/project-root-cache.js"),
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
  const { applySentryCliRcEnvShim } = await import("./sentryclirc.js");
  await applySentryCliRcEnvShim(cwd);

  // Apply persistent URL default (lower priority than env vars and .sentryclirc).
  const env = getEnv();
  if (!(env.SENTRY_HOST?.trim() || env.SENTRY_URL?.trim())) {
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      const { getDefaultUrl } = await import("./db/defaults.js");
      const url = getDefaultUrl();
      if (url) {
        env.SENTRY_URL = url;
        const { markPersistedDefaultUrl } = await import("./constants.js");
        markPersistedDefaultUrl(url);
      }
    } catch {
      // DB not available — skip
    }
  }
}
