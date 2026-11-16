// Environment for driving `sentry` from source with no live Sentry account.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Any request to this host fails fast: nothing listens on the discard port. */
const OFFLINE_SENTRY_URL = "http://127.0.0.1:9";
export const OFFLINE_TOKEN = "sntryu_verify_toolkit_offline";

/**
 * Copy of the caller's env with no real credentials, an empty home and CLI
 * config dir, an unreachable Sentry host, and telemetry off. The empty home
 * keeps the CLI from reading a token in `~/.sentryclirc`. Call `cleanup()`
 * when done.
 */
export function offlineEnv({ token }) {
  const home = mkdtempSync(join(tmpdir(), "verify-toolkit-home-"));
  const configDir = join(home, ".sentry");
  const env = { ...process.env };
  // Set, not deleted: `pnpm run cli` loads `packages/cli/.env.local` for
  // unset variables only, and the CLI treats an empty token as unset.
  for (const name of [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_ACCESS_TOKEN",
    "SENTRY_TOKEN",
  ]) {
    env[name] = "";
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    SENTRY_CONFIG_DIR: configDir,
    SENTRY_HOST: OFFLINE_SENTRY_URL,
    SENTRY_URL: OFFLINE_SENTRY_URL,
    SENTRY_CLI_NO_TELEMETRY: "1",
  });
  if (token) env.SENTRY_AUTH_TOKEN = OFFLINE_TOKEN;
  return {
    env,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
