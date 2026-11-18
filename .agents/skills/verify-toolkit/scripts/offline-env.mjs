// Environment for driving `sentry` from source with no live Sentry account.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Any request to this host fails fast: nothing listens on the discard port. */
const OFFLINE_SENTRY_URL = "http://127.0.0.1:9";
export const OFFLINE_TOKEN = "sntryu_verify_toolkit_offline";

/**
 * Copy of the caller's env with no real credentials, an empty home and CLI
 * config dir, an unreachable Sentry host, and telemetry off. The empty home
 * keeps the CLI from reading a token in `~/.sentryclirc`. `token` is false
 * for no token, true for the fake token, or a token string. Call `cleanup()`
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
    // Otherwise each CLI run fetches the latest release from api.github.com.
    SENTRY_CLI_NO_UPDATE_CHECK: "1",
  });
  if (token)
    env.SENTRY_AUTH_TOKEN = typeof token === "string" ? token : OFFLINE_TOKEN;
  return {
    env,
    configDir,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/**
 * Run `sentry <args>` from CLI source with `env`, and record command.txt,
 * stdout.txt, stderr.txt, and exit-code.txt in `out`. Returns the result.
 */
export function runSentry(env, args, out) {
  const run = spawnSync(
    "pnpm",
    ["--silent", "--dir", join(repo, "packages/cli"), "run", "cli", ...args],
    { cwd: repo, env, encoding: "utf8" },
  );
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "command.txt"), `sentry ${args.join(" ")}\n`);
  writeFileSync(join(out, "stdout.txt"), run.stdout);
  writeFileSync(join(out, "stderr.txt"), run.stderr);
  writeFileSync(join(out, "exit-code.txt"), `${run.status}\n`);
  return run;
}
