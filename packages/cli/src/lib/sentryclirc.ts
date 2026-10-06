/**
 * `.sentryclirc` Configuration File Reader
 *
 * Provides backward compatibility with the old `sentry-cli` INI config file.
 * Walks up from `cwd` toward the filesystem root looking for `.sentryclirc`
 * files, merging them with a global fallback (`~/.sentryclirc` or
 * `$SENTRY_CONFIG_DIR/.sentryclirc`).
 *
 * Supported fields:
 * - `[defaults]` section: `org`, `project`, `url`
 * - `[auth]` section: `token`
 *
 * The env shim ({@link applySentryCliRcEnvShim}) maps `token` → `SENTRY_AUTH_TOKEN`
 * and `url` → `SENTRY_URL` so existing code picks them up without changes.
 * Org and project are consumed directly by the resolution chain in
 * `resolve-target.ts`.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeUrl } from "./constants.js";
import { getConfigDir } from "./db/index.js";
import { getEnv } from "./env.js";
import { HostScopeError } from "./errors.js";
import { parseIni } from "./ini.js";
import { logger } from "./logger.js";
import { isSaaSTrustOrigin } from "./sentry-urls.js";
import { getActiveTokenHost, isHostTrusted } from "./token-host.js";
import { walkUpFrom } from "./walk-up.js";

const log = logger.withTag("sentryclirc");

/** Config file name matching the old `sentry-cli` convention */
export const CONFIG_FILENAME = ".sentryclirc";

/** Parsed `.sentryclirc` config with provenance tracking */
export type SentryCliRcConfig = {
  /** Organization slug from `[defaults]` section */
  org?: string;
  /** Project slug from `[defaults]` section */
  project?: string;
  /** Sentry base URL from `[defaults]` section */
  url?: string;
  /** Auth token from `[auth]` section */
  token?: string;
  /**
   * Source file path for each resolved field.
   * Useful for debug logging and error messages.
   */
  sources: {
    org?: string;
    project?: string;
    url?: string;
    token?: string;
  };
};

/**
 * Process-lifetime cache keyed by cwd.
 * Stores promises (not resolved values) so concurrent callers share the same load.
 */
const cache = new Map<string, Promise<SentryCliRcConfig>>();

/**
 * Fields we extract from an INI config, keyed by section.field.
 *
 * Each entry maps to a field on {@link SentryCliRcConfig}.
 */
const FIELD_MAP: ReadonlyArray<{
  section: string;
  key: string;
  field: keyof Omit<SentryCliRcConfig, "sources">;
}> = [
  { section: "defaults", key: "org", field: "org" },
  { section: "defaults", key: "project", field: "project" },
  { section: "defaults", key: "url", field: "url" },
  { section: "auth", key: "token", field: "token" },
];

/**
 * Apply values from a parsed INI file to the result, filling gaps only.
 * Fields already set in `result` are not overwritten (closest-file-wins).
 */
function applyConfig(
  result: SentryCliRcConfig,
  iniData: ReturnType<typeof parseIni>,
  filePath: string
): void {
  for (const { section, key, field } of FIELD_MAP) {
    if (result[field] !== undefined) {
      continue;
    }
    const value = iniData[section]?.[key]?.trim();
    if (value) {
      result[field] = value;
      result.sources[field] = filePath;
    }
  }
}

/**
 * Check if all config fields are populated (early exit optimization).
 */
function isComplete(result: SentryCliRcConfig): boolean {
  return (
    result.org !== undefined &&
    result.project !== undefined &&
    result.url !== undefined &&
    result.token !== undefined
  );
}

/**
 * True for the two I/O errors we treat as "file effectively absent"
 * — a missing path and a permission-denied read. Any other error
 * code signals something worth surfacing to the user.
 */
function isNarrowAbsenceError(error: unknown): boolean {
  if (error instanceof Error && "code" in error) {
    const { code } = error as NodeJS.ErrnoException;
    return code === "ENOENT" || code === "EACCES";
  }
  return false;
}

/**
 * Read a `.sentryclirc` file's text content. Returns `null` when
 * the file:
 *
 * - is absent (ENOENT)
 * - is unreadable for a common reason (EACCES)
 * - is a non-regular file (FIFO / socket / symlink → FIFO — the
 *   1Password pattern, which would otherwise block `text()`
 *   indefinitely)
 *
 * Re-throws every other I/O error (EPERM, EISDIR, EIO,
 * ENOTDIR, etc.). A `.sentryclirc` is a committed config file — a
 * user with `chmod 000` at the directory level (EPERM), a typo
 * pointing at a directory (EISDIR), or a disk throwing EIO needs
 * to see that clearly, not have it silently suppressed and surface
 * downstream as a confusing "no auth token" error.
 *
 * Note: cannot use {@link safeReadFile} / `isRegularFile` from
 * `safe-read.ts` — their `handleFileError` treats EPERM and
 * EISDIR as ignorable, swallowing them during the stat phase.
 * That broader policy is correct for opportunistic DSN scans; not
 * for this committed config load.
 */
export async function tryReadSentryCliRc(
  filePath: string
): Promise<string | null> {
  let statResult: Awaited<ReturnType<typeof stat>>;
  try {
    statResult = await stat(filePath);
  } catch (error) {
    if (isNarrowAbsenceError(error)) {
      return null;
    }
    throw error;
  }
  // Non-regular file (FIFO, socket, device, symlink → any of these)
  // — `text()` would block. Return null so the walk-up moves on.
  if (!statResult.isFile()) {
    return null;
  }
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if (isNarrowAbsenceError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Try to read and apply a `.sentryclirc` file to the result.
 * No-op if the file doesn't exist or can't be read.
 */
async function tryApplyFile(
  result: SentryCliRcConfig,
  filePath: string,
  isGlobal: boolean
): Promise<void> {
  const content = await tryReadSentryCliRc(filePath);
  if (content !== null) {
    log.debug(
      `Found ${isGlobal ? "global" : "local"} ${CONFIG_FILENAME} at ${filePath}`
    );
    applyConfig(result, parseIni(content), filePath);
  }
}

/** Lazy-cached set of global `.sentryclirc` paths (stable for the process lifetime) */
let globalPaths: Set<string> | null = null;

/**
 * Global paths checked as fallback after the walk-up.
 *
 * Returns `$SENTRY_CONFIG_DIR/.sentryclirc` and `~/.sentryclirc`.
 * Used by the import engine to classify files by location.
 */
export function getGlobalPaths(): Set<string> {
  if (!globalPaths) {
    globalPaths = new Set([
      join(getConfigDir(), CONFIG_FILENAME),
      join(homedir(), CONFIG_FILENAME),
    ]);
  }
  return globalPaths;
}

/**
 * Apply global `.sentryclirc` fallbacks to fill any remaining gaps.
 * Checks `$SENTRY_CONFIG_DIR/.sentryclirc`, then `~/.sentryclirc`.
 *
 * Must be called after the walk-up and before caching the result,
 * so that global values are included in the cached config.
 */
export async function applyGlobalFallbacks(
  result: SentryCliRcConfig
): Promise<void> {
  for (const globalPath of getGlobalPaths()) {
    if (isComplete(result)) {
      break;
    }
    await tryApplyFile(result, globalPath, true);
  }
}

/**
 * Try to apply a `.sentryclirc` file from `dir` to `result`.
 *
 * Skips global paths (handled separately by {@link applyGlobalFallbacks}).
 * Returns true if all fields are now populated (caller can stop walking).
 *
 * Exported so the project-root walk in `dsn/project-root.ts` can read
 * `.sentryclirc` files during its own walk-up, avoiding a second traversal.
 */
export async function applySentryCliRcDir(
  result: SentryCliRcConfig,
  dir: string
): Promise<boolean> {
  if (isComplete(result)) {
    return true;
  }
  const rcPath = join(dir, CONFIG_FILENAME);
  // Skip global paths — they're applied as fallback after the walk
  if (!getGlobalPaths().has(rcPath)) {
    await tryApplyFile(result, rcPath, false);
  }
  return isComplete(result);
}

/**
 * Store a pre-built config in the cache.
 *
 * Called by `findProjectRoot` after it has walked the directory tree
 * and accumulated `.sentryclirc` data, so that a later `loadSentryCliRc`
 * call for the same `cwd` is a cache hit instead of a second walk.
 */
export function setSentryCliRcCache(
  cwd: string,
  config: SentryCliRcConfig
): void {
  cache.set(cwd, Promise.resolve(config));
}

/**
 * Create an empty accumulator for building a config during a walk.
 */
export function createSentryCliRcConfig(): SentryCliRcConfig {
  return { sources: {} };
}

/**
 * Perform the actual load: walk up from `cwd`, then check global paths.
 */
async function doLoad(cwd: string): Promise<SentryCliRcConfig> {
  const result = createSentryCliRcConfig();

  // Walk up from cwd, applying local .sentryclirc files (closest-first)
  for await (const dir of walkUpFrom(cwd)) {
    if (await applySentryCliRcDir(result, dir)) {
      break;
    }
  }

  await applyGlobalFallbacks(result);
  return result;
}

/**
 * Load `.sentryclirc` config by walking up from `cwd` and merging with global.
 *
 * Walk-up behavior:
 * 1. Start at `cwd`, walk toward filesystem root
 * 2. At each directory, check for `.sentryclirc`
 * 3. Closest file's values win per-field
 * 4. Always check global location as fallback:
 *    `$SENTRY_CONFIG_DIR/.sentryclirc`, then `~/.sentryclirc`
 *
 * Results are cached for the process lifetime (keyed by `cwd`).
 * Concurrent callers for the same `cwd` share the same promise.
 *
 * @param cwd - Starting directory for walk-up search
 * @returns Merged config (empty fields if no files found)
 */
export function loadSentryCliRc(cwd: string): Promise<SentryCliRcConfig> {
  const cached = cache.get(cwd);
  if (cached) {
    return cached;
  }

  // Evict from cache on failure so subsequent calls retry instead of
  // permanently returning a rejected promise.
  const promise = doLoad(cwd).catch((error) => {
    cache.delete(cwd);
    throw error;
  });
  cache.set(cwd, promise);
  return promise;
}

/**
 * Path of the `.sentryclirc` file whose `token` the shim copied into
 * `SENTRY_AUTH_TOKEN`, pinned by {@link applySentryCliRcEnvShim} at the
 * one point it knows the provenance. `undefined` when the active env
 * token was set by the user rather than injected from rc.
 *
 * Mirrors the boot-time snapshot pattern in `env-token-host.ts`
 * (`pinnedHost` + getter): lets the synchronous env-token-ignored hint
 * name the real source instead of claiming the user set an env var they
 * never did, without re-awaiting the async rc loader.
 */
let rcInjectedTokenSource: string | undefined;

/** Read the pinned rc-injected token source. See {@link rcInjectedTokenSource}. */
export function getRcInjectedTokenSource(): string | undefined {
  return rcInjectedTokenSource;
}

/**
 * Apply env shim for `.sentryclirc` token and URL fields.
 *
 * Maps config file values to environment variables so the existing
 * auth and URL resolution code picks them up without changes:
 * - `[auth] token` → `SENTRY_AUTH_TOKEN` (if neither `SENTRY_AUTH_TOKEN` nor `SENTRY_TOKEN` is set)
 * - `[defaults] url` → `SENTRY_URL` (if both `SENTRY_HOST` and `SENTRY_URL` are unset)
 *
 * The URL is applied unconditionally at boot — the trust check is deferred
 * to {@link assertRcUrlTrusted}, which `buildCommand` calls after Stricli
 * identifies the command (so the command can opt out via `skipRcUrlCheck`).
 *
 * Call this once, early in the CLI boot process (before any auth or API calls).
 */
export async function applySentryCliRcEnvShim(cwd: string): Promise<void> {
  const config = await loadSentryCliRc(cwd);
  const env = getEnv();

  if (
    config.token &&
    !env.SENTRY_AUTH_TOKEN?.trim() &&
    !env.SENTRY_TOKEN?.trim()
  ) {
    log.debug(
      `Setting SENTRY_AUTH_TOKEN from ${CONFIG_FILENAME} (${config.sources.token})`
    );
    env.SENTRY_AUTH_TOKEN = config.token;
    rcInjectedTokenSource = config.sources.token;
  }

  const normalizedRcUrl = config.url ? normalizeUrl(config.url) : undefined;
  if (normalizedRcUrl && !env.SENTRY_HOST?.trim() && !env.SENTRY_URL?.trim()) {
    log.debug(
      `Setting SENTRY_URL from ${CONFIG_FILENAME} (${config.sources.url})`
    );
    env.SENTRY_URL = normalizedRcUrl;
  }
}

/**
 * Validate that the rc-sourced URL (if any) matches the active token's
 * scoped host. Called by `buildCommand` after Stricli identifies the
 * command — commands that establish or tear down trust (`auth login`,
 * `auth logout`) opt out via `skipRcUrlCheck: true`.
 *
 * No-op when: no rc URL was loaded, the rc URL is SaaS, or the rc URL
 * matches the active token's host.
 *
 * @throws {HostScopeError} On non-SaaS URL that doesn't match the token
 */
export async function assertRcUrlTrusted(cwd: string): Promise<void> {
  const config = await loadSentryCliRc(cwd);
  const normalizedRcUrl = config.url ? normalizeUrl(config.url) : undefined;
  // No rc URL or SaaS rc URL → always trusted (no credential leak risk).
  if (!normalizedRcUrl || isSaaSTrustOrigin(normalizedRcUrl)) {
    return;
  }
  // Non-SaaS rc URL: must match active token's host. No token at all is
  // also a refusal — the rc URL by itself isn't a trust source.
  const tokenHost = getActiveTokenHost();
  if (tokenHost && isHostTrusted(normalizedRcUrl, tokenHost)) {
    return;
  }
  const source = config.sources.url
    ? `Config at ${config.sources.url}`
    : `${CONFIG_FILENAME} [defaults] url`;
  throw new HostScopeError(source, normalizedRcUrl, tokenHost);
}

/**
 * Clear the process-lifetime cache.
 *
 * @internal Exported for testing only
 */
export function clearSentryCliRcCache(): void {
  cache.clear();
  // Reset global paths — tests change SENTRY_CONFIG_DIR between runs
  globalPaths = null;
  rcInjectedTokenSource = undefined;
}
