// Environment for driving `sentry` from source with no live Sentry account.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Any request to this host fails fast: nothing listens on the discard port. */
const OFFLINE_SENTRY_URL = "http://127.0.0.1:9";
export const OFFLINE_TOKEN = "sntryu_verify_toolkit_offline";

/**
 * Copy of the caller's env with no real credentials, an empty CLI config dir,
 * an unreachable Sentry host, and telemetry off. Call `cleanup()` when done.
 */
export function offlineEnv({ token }) {
  const configDir = mkdtempSync(join(tmpdir(), "verify-toolkit-config-"));
  const env = { ...process.env };
  for (const name of [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_ACCESS_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_HOST",
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    SENTRY_CONFIG_DIR: configDir,
    SENTRY_URL: OFFLINE_SENTRY_URL,
    SENTRY_CLI_NO_TELEMETRY: "1",
  });
  if (token) env.SENTRY_AUTH_TOKEN = OFFLINE_TOKEN;
  return {
    env,
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}
