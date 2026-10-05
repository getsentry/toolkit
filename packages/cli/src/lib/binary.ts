/**
 * Binary Management
 *
 * Shared utilities for installing, replacing, and managing the CLI binary.
 * Used by both `setup --install` (fresh installs) and `upgrade` (self-updates).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, copyFile, mkdir, realpath, unlink } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { compare as semverCompare } from "semver";
import { getUserAgent } from "./constants.js";
import {
  buildTlsErrorDetail,
  customFetch,
  isTlsCertError,
} from "./custom-ca.js";
import {
  stringifyUnknown,
  UpgradeError,
  UpgradeTransportError,
} from "./errors.js";
import { logger } from "./logger.js";
import { isProcessRunning } from "./process-utils.js";
/** Known directories where the curl installer may place the binary */
export const KNOWN_CURL_DIRS = [".local/bin", "bin", ".sentry/bin"];

/**
 * Whether the current platform's filesystem is case-insensitive by default
 * (Windows, macOS). Resolved once at module load — `process.platform` never
 * changes at runtime.
 */
const IS_CASE_INSENSITIVE_FS =
  process.platform === "win32" || process.platform === "darwin";

/**
 * Legacy install directory (relative to home) that predates the XDG layout.
 * The curl installer used to drop the binary here; migration moves it out.
 */
export const LEGACY_INSTALL_SUBDIR = join(".sentry", "bin");

/**
 * Legacy install sub-directories (relative to home) that predate the XDG
 * layout and that migration is allowed to move a binary out of. Deliberately
 * limited to the pre-XDG `~/.sentry/bin`: `~/.local/bin` and `~/bin` (also in
 * {@link KNOWN_CURL_DIRS}) are valid *current* XDG install targets, so treating
 * them as migration sources would relocate a working binary out of an active
 * directory. An array so more legacy locations can be added if they ever exist.
 */
export const LEGACY_INSTALL_SUBDIRS = [LEGACY_INSTALL_SUBDIR];

/**
 * Strip a trailing path separator (but never from a bare root like `/`) so a
 * PATH entry such as `~/.local/bin/` compares equal to `~/.local/bin`.
 */
function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

/**
 * Compare two filesystem paths for equality. Tolerates a trailing separator on
 * either side, and is case-insensitive on case-insensitive filesystems
 * (Windows, macOS) — a stored path can differ in casing from a freshly computed
 * one (e.g. `C:\Users\User` vs `C:\Users\user`) yet point at the same location,
 * so a strict `===` would wrongly differ.
 *
 * The implementation is chosen once at module load from
 * {@link IS_CASE_INSENSITIVE_FS} so there is no per-call platform check.
 */
export const samePath: (a: string, b: string) => boolean =
  IS_CASE_INSENSITIVE_FS
    ? (a, b) =>
        stripTrailingSep(a).toLowerCase() === stripTrailingSep(b).toLowerCase()
    : (a, b) => stripTrailingSep(a) === stripTrailingSep(b);

/**
 * Absolute legacy install directories for the given home. See
 * {@link LEGACY_INSTALL_SUBDIRS} for why this is scoped to pre-XDG locations.
 */
export function getLegacyInstallDirs(homeDir: string): string[] {
  return LEGACY_INSTALL_SUBDIRS.map((dir) => join(homeDir, dir));
}

/**
 * How the CLI was installed. Determines the upgrade strategy.
 *
 * Defined here (alongside other installation constants like
 * {@link KNOWN_CURL_DIRS}) so that both `upgrade.ts` and
 * `db/install-info.ts` can import it without creating a circular
 * dependency.
 */
export type InstallationMethod =
  | "curl"
  | "brew"
  | "npm"
  | "pnpm"
  | "bun"
  | "yarn"
  | "unknown";

/** A repository pair that hosts CLI stable releases and nightly OCI images. */
export type UpgradeSource = {
  /** GitHub `owner/repository` containing CLI release assets. */
  readonly githubRepo: string;
  /** GHCR `owner/package` containing CLI nightly images and delta patches. */
  readonly ghcrRepo: string;
  /** Prefix attached to CLI release tags in this repository. */
  readonly tagPrefix: string;
};

/** Ordered CLI release sources. The resolver falls through only on HTTP 404. */
export const UPGRADE_SOURCES = [
  {
    githubRepo: "getsentry/toolkit",
    ghcrRepo: "getsentry/toolkit",
    tagPrefix: "cli@",
  },
  {
    githubRepo: "getsentry/cli",
    ghcrRepo: "getsentry/cli",
    tagPrefix: "",
  },
] as const satisfies readonly [UpgradeSource, ...UpgradeSource[]];

/** The first source used by direct helper calls that do not resolve a source. */
export const PRIMARY_UPGRADE_SOURCE = UPGRADE_SOURCES[0];

/** Valid methods that can be specified via --method flag */
const VALID_METHODS: InstallationMethod[] = [
  "curl",
  "brew",
  "npm",
  "pnpm",
  "bun",
  "yarn",
];

/**
 * Parse and validate an installation method from user input.
 *
 * @param value - Method string from --method flag
 * @returns Validated installation method
 * @throws {Error} When method is not recognized
 */
export function parseInstallationMethod(value: string): InstallationMethod {
  const normalized = value.toLowerCase() as InstallationMethod;

  if (!VALID_METHODS.includes(normalized)) {
    throw new Error(
      `Invalid method: ${value}. Must be one of: ${VALID_METHODS.join(", ")}`
    );
  }

  return normalized;
}

/**
 * Detect whether the current process is running on a musl-based Linux system
 * (e.g., Alpine Linux, Void Linux musl variant).
 *
 * Uses two heuristics in order of reliability:
 * 1. Check for `/lib/ld-musl-<arch>.so.1` — the musl dynamic linker is always
 *    at this path on musl systems. Fast stat check, no subprocess.
 * 2. Parse `ldd --version` output — musl's ldd writes "musl libc" to stderr,
 *    while glibc outputs "GNU C Library" to stdout.
 *
 * The result is cached after first call since libc cannot change at runtime.
 */
let cachedIsMusl: boolean | undefined;

export function isMusl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (cachedIsMusl !== undefined) {
    return cachedIsMusl;
  }

  // Heuristic 1: Check for musl dynamic linker
  const muslArch = process.arch === "x64" ? "x86_64" : "aarch64";
  if (existsSync(`/lib/ld-musl-${muslArch}.so.1`)) {
    cachedIsMusl = true;
    return true;
  }

  // Heuristic 2: ldd --version output (musl ldd writes "musl libc" to stderr)
  try {
    const result = spawnSync("ldd", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output =
      Buffer.from(result.stdout).toString() +
      Buffer.from(result.stderr).toString();
    cachedIsMusl = output.toLowerCase().includes("musl");
    return cachedIsMusl;
  } catch {
    // ldd not found or failed — assume glibc (the common case)
    cachedIsMusl = false;
    return false;
  }
}

/**
 * Build the platform-specific binary base name.
 *
 * Matches the naming convention used by GitHub Releases and GHCR:
 * `sentry-<os>-<arch>[-musl][.exe]` (e.g., `sentry-linux-x64`, `sentry-linux-arm64-musl`).
 */
export function getPlatformBinaryName(): string {
  let os: string;
  if (process.platform === "darwin") {
    os = "darwin";
  } else if (process.platform === "win32") {
    os = "windows";
  } else {
    os = "linux";
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const libcSuffix = isMusl() ? "-musl" : "";
  const suffix = process.platform === "win32" ? ".exe" : "";
  return `sentry-${os}-${arch}${libcSuffix}${suffix}`;
}

/**
 * Build the download URL for a platform-specific binary from GitHub releases.
 *
 * @param version - Version to download (without 'v' prefix)
 * @returns Download URL for the binary
 */
export function getBinaryDownloadUrl(
  version: string,
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): string {
  const tag = `${source.tagPrefix}${version}`;
  return `https://github.com/${source.githubRepo}/releases/download/${tag}/${getPlatformBinaryName()}`;
}

/** Build the GitHub API base URL for a release source. */
export function getGitHubReleasesUrl(
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): string {
  return `https://api.github.com/repos/${source.githubRepo}/releases`;
}

/** Build the GitHub API URL for one source-specific release tag. */
export function getGitHubReleaseByTagUrl(
  version: string,
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): string {
  const tag = `${source.tagPrefix}${version}`;
  return `${getGitHubReleasesUrl(source)}/tags/${encodeURIComponent(tag)}`;
}

/** Build the GitHub API URL used to discover a source's latest CLI release. */
export function getGitHubLatestReleaseUrl(
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): string {
  return source.tagPrefix
    ? `${getGitHubReleasesUrl(source)}?per_page=100`
    : `${getGitHubReleasesUrl(source)}/latest`;
}

/** Build the GitHub API URL used to verify that a source repository exists. */
export function getGitHubRepositoryUrl(
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): string {
  return `https://api.github.com/repos/${source.githubRepo}`;
}

/** GitHub API base URL for the primary release source. */
export const GITHUB_RELEASES_URL = getGitHubReleasesUrl();

/** Result of selecting one source for an upgrade operation. */
export type ResolvedUpgradeSource = {
  /** The selected release source. */
  readonly source: UpgradeSource;
  /** The successful response from the source probe. */
  readonly response: Response;
};

/** All configured upgrade sources returned an HTTP 404 response. */
export class UpgradeSourceNotFoundError extends UpgradeError {
  constructor() {
    super(
      "network_error",
      "No CLI upgrade source was found: every source returned HTTP 404"
    );
    this.name = "UpgradeSourceNotFoundError";
  }
}

/** Configuration for selecting the first available upgrade source. */
export type ResolveUpgradeSourceOptions = {
  /** Build the source-specific URL whose response proves source availability. */
  readonly getProbeUrl: (source: UpgradeSource) => string;
  /** Fetch implementation used for the probe. Defaults to the CLI CA-aware fetch. */
  readonly fetch?: typeof fetch;
  /** Optional cancellation signal shared by every source probe. */
  readonly signal?: AbortSignal;
  /** Ordered sources to probe. Defaults to all configured upgrade sources. */
  readonly sources?: readonly UpgradeSource[];
};

async function fetchUpgradeProbe(
  source: UpgradeSource,
  options: ResolveUpgradeSourceOptions
): Promise<Response> {
  try {
    return await (options.fetch ?? customFetch)(options.getProbeUrl(source), {
      headers: getGitHubHeaders(),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error && isTlsCertError(error)) {
      throw new UpgradeTransportError(buildTlsErrorDetail(error));
    }
    throw new UpgradeTransportError(
      `Failed to connect to GitHub: ${stringifyUnknown(error)}`
    );
  }
}

/**
 * Select the first available upgrade source.
 *
 * The caller receives the successful probe response so it never repeats the
 * request. Only HTTP 404 advances to the next source. Every other HTTP or
 * network failure aborts immediately.
 */
export async function resolveUpgradeSource(
  options: ResolveUpgradeSourceOptions
): Promise<ResolvedUpgradeSource> {
  for (const source of options.sources ?? UPGRADE_SOURCES) {
    const response = await fetchUpgradeProbe(source, options);
    if (response.ok) {
      return { source, response };
    }
    if (response.status !== 404) {
      throw new UpgradeError(
        "network_error",
        `Failed to fetch from GitHub: HTTP ${response.status}`
      );
    }
  }

  throw new UpgradeSourceNotFoundError();
}

/**
 * Detect whether a version string identifies a nightly build.
 *
 * Nightlies use the format `X.Y.Z-dev.<unix-seconds>` (the timestamp
 * format the build system bakes in).
 *
 * @param version - Version string to check
 * @returns true if the version is a nightly build
 */
export function isNightlyVersion(version: string): boolean {
  return version.includes("-dev.");
}

/**
 * Compare two version strings and return their ordering.
 *
 * Uses `semver.compare` which handles both stable (`X.Y.Z`) and
 * nightly (`X.Y.Z-dev.<unix-seconds>`) versions correctly — the numeric
 * pre-release identifier is compared numerically per SemVer spec.
 *
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  return semverCompare(a, b);
}

/**
 * Check whether moving from `current` to `target` is a downgrade.
 *
 * @returns true if target is older than current
 */
export function isDowngrade(current: string, target: string): boolean {
  return compareVersions(current, target) === 1;
}

/**
 * Get the binary filename for the current platform.
 *
 * @returns "sentry.exe" on Windows, "sentry" elsewhere
 */
export function getBinaryFilename(): string {
  return process.platform === "win32" ? "sentry.exe" : "sentry";
}

/**
 * Build paths object from an install path.
 * Returns the install path and derived sibling paths used during
 * download, replacement, and locking.
 *
 * @param installPath - Absolute path to the binary
 * @returns Object with install, temp (.download), old (.old), and lock (.lock) paths
 */
export function getBinaryPaths(installPath: string): {
  installPath: string;
  tempPath: string;
  oldPath: string;
  lockPath: string;
} {
  return {
    installPath,
    tempPath: `${installPath}.download`,
    oldPath: `${installPath}.old`,
    lockPath: `${installPath}.lock`,
  };
}

/**
 * Determine the install directory for a curl-installed binary.
 *
 * Priority:
 * 1. $SENTRY_INSTALL_DIR environment variable
 * 2. $XDG_BIN_HOME (if set to an absolute path, per the XDG spec)
 * 3. ~/.local/bin (if exists AND in $PATH)
 * 4. ~/bin (if exists AND in $PATH)
 * 5. ~/.local/bin (XDG-aligned fallback; setup handles PATH modification)
 *
 * @param homeDir - User's home directory
 * @param env - Process environment variables
 * @returns Absolute path to the install directory
 */
export function determineInstallDir(
  homeDir: string,
  env: NodeJS.ProcessEnv
): string {
  const pathDirs = (env.PATH ?? "").split(delimiter);

  // 1. Explicit override via environment variable
  if (env.SENTRY_INSTALL_DIR) {
    return env.SENTRY_INSTALL_DIR;
  }

  // 2. XDG_BIN_HOME override — honored only when absolute, per the XDG spec
  const xdgBinHome = env.XDG_BIN_HOME;
  if (xdgBinHome && isAbsolute(xdgBinHome)) {
    return xdgBinHome;
  }

  // 3-4. Check well-known directories that are already in PATH. samePath keeps
  // the membership check case-insensitive on Windows/macOS, where a PATH entry
  // can differ in casing from the computed directory yet be the same dir.
  const candidates = [join(homeDir, ".local", "bin"), join(homeDir, "bin")];

  for (const dir of candidates) {
    if (existsSync(dir) && pathDirs.some((p) => samePath(p, dir))) {
      return dir;
    }
  }

  // 5. XDG-aligned fallback — setup will handle adding this to PATH
  return join(homeDir, ".local", "bin");
}

/**
 * Build headers for GitHub API requests.
 */
export function getGitHubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": getUserAgent(),
  };
}

/**
 * Fetch wrapper that converts network errors to UpgradeError.
 * Handles DNS failures, timeouts, and other connection issues.
 *
 * @param url - URL to fetch
 * @param init - Fetch options
 * @param serviceName - Service name for error messages (e.g., "GitHub")
 * @returns Response object
 * @throws {UpgradeError} On network failure
 * @throws {Error} AbortError if signal is aborted (re-thrown as-is)
 */
export async function fetchWithUpgradeError(
  url: string,
  init: RequestInit,
  serviceName: string
): Promise<Response> {
  try {
    return await customFetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) {
      throw init.signal.reason;
    }
    // Re-throw AbortError as-is so callers can handle it specifically
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error && isTlsCertError(error)) {
      throw new UpgradeTransportError(buildTlsErrorDetail(error));
    }
    const msg = stringifyUnknown(error);
    throw new UpgradeTransportError(
      `Failed to connect to ${serviceName}: ${msg}`
    );
  }
}

/** Parse an upgrade response while preserving cancellation and transport failures. */
export async function parseUpgradeJson(
  response: Response,
  signal: AbortSignal | undefined,
  invalidMessage: string
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (error instanceof SyntaxError) {
      throw new UpgradeError("network_error", invalidMessage);
    }
    throw new UpgradeTransportError(
      `${invalidMessage}: ${stringifyUnknown(error)}`
    );
  }
}

/**
 * Replace the binary at the install path, handling platform differences.
 *
 * Intentionally synchronous: the multi-step rename sequence (especially on
 * Windows where old→.old then temp→install) must be uninterruptible to avoid
 * leaving the install path in a broken state between steps.
 *
 * - Unix: Atomic rename overwrites the target (safe even if the old binary is running)
 * - Windows: Rename old binary to .old first (Windows allows renaming running exes
 *   but not deleting/overwriting them), then rename the temp file into place.
 *   The .old file is cleaned up on next CLI startup via cleanupOldBinary().
 *
 * @param tempPath - Path to the new binary (temp download location)
 * @param installPath - Target path to install the binary to
 */
export function replaceBinarySync(tempPath: string, installPath: string): void {
  if (process.platform === "win32") {
    const oldPath = `${installPath}.old`;
    // Windows: Can't overwrite running exe, but CAN rename it
    try {
      renameSync(installPath, oldPath);
    } catch {
      // Current binary might not exist (fresh install) or .old already exists
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        unlinkSync(oldPath);
        renameSync(installPath, oldPath);
      } catch {
        // If still failing, current binary doesn't exist — that's fine
      }
    }
    renameSync(tempPath, installPath);
  } else {
    // Unix: Atomic rename overwrites target
    renameSync(tempPath, installPath);
  }
}

/**
 * Clean up leftover .old files from previous upgrades.
 * Called on CLI startup to remove .old files left over from Windows upgrades
 * (where the running binary is renamed to .old before replacement).
 *
 * Note: We intentionally do NOT clean up .download files here because an
 * upgrade may be in progress in another process. The .download cleanup is
 * handled inside the upgrade flow under the exclusive lock.
 *
 * @param oldPath - Path to the .old file to clean up
 */
export function cleanupOldBinary(oldPath: string): void {
  // Fire-and-forget: don't await, just let cleanup run in background
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  unlink(oldPath).catch(() => {
    // Intentionally ignore errors — file may not exist
  });
}

// Lock Management

/**
 * Acquire an exclusive lock for binary installation/upgrade.
 * Uses atomic file creation with 'wx' flag to prevent race conditions.
 * If lock exists, checks if owning process is still alive (stale lock detection).
 *
 * @param lockPath - Path to the lock file
 * @throws {UpgradeError} If another upgrade/install is already in progress
 */
export function acquireLock(lockPath: string): void {
  // Ensure the install directory exists before writing the lock. The
  // download/upgrade pipeline derives the lock path from an install
  // location that may not exist yet (fresh ~/.sentry/bin, npm→nightly
  // migration) or was purged after a test install (a stale
  // SENTRY_INSTALL_DIR). Without this, writeFileSync crashes with
  // `ENOENT ... open '.../sentry.lock'` (CLI-1E1, CLI-1RV).
  //
  // Kept OUTSIDE the try/catch below so mkdir failures (EEXIST when the parent
  // path is a regular file, ENOTDIR, EACCES) propagate directly as the genuine
  // errors they are. If mkdir ran inside the try, its EEXIST would be routed
  // into handleExistingLock and re-interpreted as a lock-contention case —
  // surfacing a misleading ENOTDIR (from reading the lock under a non-dir)
  // instead of the real EEXIST.
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o755 });

  try {
    // Try atomic exclusive creation — fails if file exists
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (error) {
    // If error is not "file exists", re-throw
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    // File exists — check if it's a stale lock
    handleExistingLock(lockPath);
  }
}

/**
 * Handle an existing lock file by checking if it's stale.
 * If stale, removes it and retries acquisition. If active, throws.
 */
function handleExistingLock(lockPath: string): void {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf-8").trim();
  } catch (error) {
    // Only retry if file disappeared (ENOENT) — race condition with another process
    // For other errors (EACCES, etc.), re-throw to avoid infinite recursion
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      acquireLock(lockPath);
      return;
    }
    throw error;
  }

  const existingPid = Number.parseInt(content, 10);

  if (!Number.isNaN(existingPid) && isProcessRunning(existingPid)) {
    // If the lock holder is our parent process (upgrade command spawned
    // setup --install), take over the lock instead of failing. This allows
    // the download→install pipeline to stay locked against concurrent upgrades
    // while handing off from parent to child.
    if (existingPid === process.ppid) {
      writeFileSync(lockPath, String(process.pid));
      return;
    }
    throw new UpgradeError(
      "execution_failed",
      "Another upgrade is already in progress"
    );
  }

  // Stale lock from dead process — remove and retry
  try {
    unlinkSync(lockPath);
  } catch (error) {
    // Only proceed if file already gone (ENOENT)
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // Retry acquisition (recursive call handles race with other processes)
  acquireLock(lockPath);
}

/**
 * Release the binary lock.
 *
 * @param lockPath - Path to the lock file
 */
export function releaseLock(lockPath: string): void {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    unlinkSync(lockPath);
  } catch {
    // Ignore errors — file might already be gone
  }
}

/**
 * Install a binary to the target directory.
 *
 * Copies the source binary to the install directory, handling platform
 * differences (Windows .old rename, Unix atomic replace) and concurrency
 * (PID-based lock file).
 *
 * @param sourcePath - Path to the source binary (e.g., temp download)
 * @param installDir - Target directory to install into
 * @returns Absolute path to the installed binary
 */
export async function installBinary(
  sourcePath: string,
  installDir: string
): Promise<string> {
  await mkdir(installDir, { recursive: true, mode: 0o755 });

  const installPath = join(installDir, getBinaryFilename());
  const { tempPath, lockPath } = getBinaryPaths(installPath);

  acquireLock(lockPath);

  try {
    // When upgrade spawns setup --install, the child's execPath IS the
    // .download file (sourcePath === tempPath). In that case skip the
    // unlink+copy — the file is already where we need it.
    // Compare symlink-resolved paths: process.execPath is canonicalized by
    // the OS, but installDir may go through a symlink (e.g. macOS /tmp →
    // /private/tmp). Falls back to resolve() when the path doesn't exist yet.
    const canonical = async (p: string): Promise<string> => {
      try {
        return await realpath(p);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return resolve(p);
        }
        logger.debug("realpath failed, falling back to resolve()", error);
        return resolve(p);
      }
    };

    if ((await canonical(sourcePath)) !== (await canonical(tempPath))) {
      // Clean up any leftover temp file from interrupted operation
      try {
        await unlink(tempPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.debug("Failed to clean up temp file", error);
        }
      }

      // Copy source binary to temp path next to install location
      await copyFile(sourcePath, tempPath);

      // Set executable permission (Unix only)
      if (process.platform !== "win32") {
        await chmod(tempPath, 0o755);
      }
    }

    // Atomically replace (handles Windows .old rename)
    replaceBinarySync(tempPath, installPath);
  } finally {
    releaseLock(lockPath);
  }

  return installPath;
}
