/**
 * Resolve the CLI's config directory.
 *
 * Kept free of the logger and the database so the CLI's main script
 * (`src/chunk-main.ts`) can find the code cache without loading either.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const CONFIG_DIR_ENV_VAR = "SENTRY_CONFIG_DIR";

/** Legacy config directory name under the user's home directory (`~/.sentry`). */
const LEGACY_CONFIG_DIR_NAME = ".sentry";

/** Sub-directory used under the XDG config base directory. */
const XDG_CONFIG_SUBDIR = "sentry";

/** Default config directory as shown to users (help text, docs). */
export const DEFAULT_CONFIG_DIR_DISPLAY = `~/.config/${XDG_CONFIG_SUBDIR}`;

export const DB_FILENAME = "cli.db";

/**
 * Resolve the config directory from an environment and home directory.
 *
 * Precedence:
 * 1. `SENTRY_CONFIG_DIR` — explicit override, always wins.
 * 2. Legacy `~/.sentry` — used when it already exists, so existing installs
 *    keep working without migration.
 * 3. XDG base directory — `$XDG_CONFIG_HOME/sentry`, falling back to
 *    `~/.config/sentry`. Per the XDG spec, a non-absolute `XDG_CONFIG_HOME`
 *    is ignored.
 *
 * Pure and side-effect free so it can be unit-tested directly.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env[CONFIG_DIR_ENV_VAR];
  if (override) {
    return override;
  }

  const legacyDir = join(home, LEGACY_CONFIG_DIR_NAME);
  // Only treat the legacy directory as a prior config install when it
  // contains the actual database or the old JSON config. A bare
  // `~/.sentry/bin` created by the curl installer should not block XDG.
  if (
    existsSync(legacyDir) &&
    (existsSync(join(legacyDir, DB_FILENAME)) ||
      existsSync(join(legacyDir, "config.json")))
  ) {
    return legacyDir;
  }

  return resolveXdgConfigDir(env, home);
}

/**
 * Resolve the XDG-compliant config directory, ignoring any legacy `~/.sentry`
 * install. This is the migration *target*: `resolveConfigDir` keeps returning
 * the legacy dir while it holds `cli.db`, so migration must compute the new
 * location directly. Honors `SENTRY_CONFIG_DIR` and an absolute
 * `XDG_CONFIG_HOME`, otherwise defaults to `~/.config/sentry`.
 */
export function resolveXdgConfigDir(
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const override = env[CONFIG_DIR_ENV_VAR];
  if (override) {
    return override;
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configHome =
    xdgConfigHome && isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : join(home, ".config");
  return join(configHome, XDG_CONFIG_SUBDIR);
}
