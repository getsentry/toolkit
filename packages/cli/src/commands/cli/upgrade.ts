/**
 * sentry cli upgrade
 *
 * Self-update the Sentry CLI to the latest or a specific version.
 * After upgrading, spawns the NEW binary with `cli setup` to update
 * completions, agent skills, and record installation metadata.
 *
 * Supports two release channels:
 * - stable (default): tracks the latest GitHub release
 * - nightly: tracks the rolling nightly prerelease built from main
 *
 * The channel can be set via --channel or by passing "nightly"/"stable"
 * as the version argument. The choice is persisted in the local database
 * so that subsequent bare `sentry cli upgrade` calls use the same channel.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { SentryContext } from "../../context.js";
import {
  determineInstallDir,
  isDowngrade,
  isNightlyVersion,
  LEGACY_INSTALL_SUBDIR,
  releaseLock,
  samePath,
  type UpgradeSource,
} from "../../lib/binary.js";
import { buildCommand } from "../../lib/command.js";
import { CLI_VERSION } from "../../lib/constants.js";
import {
  getReleaseChannel,
  type ReleaseChannel,
  setReleaseChannel,
} from "../../lib/db/release-channel.js";
import { getVersionCheckInfo } from "../../lib/db/version-check.js";
import { UpgradeError, UpgradeTransportError } from "../../lib/errors.js";
import { formatUpgradeResult } from "../../lib/formatters/human.js";
import { formatBytes } from "../../lib/formatters/numbers.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import {
  type ChangelogSummary,
  fetchChangelog,
} from "../../lib/release-notes.js";
import { isInPath } from "../../lib/shell.js";
import {
  detectInstallationMethod,
  executeUpgrade,
  fetchLatestVersion,
  getCurlInstallPaths,
  type InstallationMethod,
  NIGHTLY_TAG,
  type OfflineMode,
  parseInstallationMethod,
  resolveExistingUpgradeVersion,
  resolveLatestUpgradeVersion,
  VERSION_PREFIX_REGEX,
  versionExists,
} from "../../lib/upgrade.js";
import { whichSync } from "../../lib/which.js";

const log = logger.withTag("cli.upgrade");

/** Special version strings that select a channel rather than a specific release. */
const CHANNEL_VERSIONS = new Set(["nightly", "stable"]);

/**
 * Structured result of the upgrade command.
 *
 * Returned as `{ data: UpgradeResult }` and rendered via the output config.
 * In JSON mode the object is serialized as-is; in human mode it's passed to
 * {@link formatUpgradeResult}.
 */
export type UpgradeResult = {
  /** What action was taken */
  action: "upgraded" | "downgraded" | "up-to-date" | "checked";
  /** Current CLI version before upgrade */
  currentVersion: string;
  /** Target version (the version we upgraded/downgraded to, or the latest available) */
  targetVersion: string;
  /** Release channel */
  channel: "stable" | "nightly";
  /** Installation method used */
  method: string;
  /** Whether the user forced the upgrade */
  forced: boolean;
  /** Whether the upgrade was performed offline (from cache) */
  offline?: boolean;
  /** Warnings to display (e.g., PATH shadowing from old package manager install) */
  warnings?: string[];
  /** Changelog summary for the version range. Absent for offline or on fetch failure. */
  changelog?: ChangelogSummary;
};

type UpgradeFlags = {
  readonly check: boolean;
  readonly force: boolean;
  readonly offline: boolean;
  readonly "no-agent-skills": boolean;
  readonly method?: InstallationMethod;
  /** Injected by buildCommand output wrapper — suppresses spinners */
  readonly json?: boolean;
};

/**
 * Resolve effective channel and version arg from the positional `version`
 * parameter. "nightly" and "stable" are treated as channel selectors, not
 * literal version strings.
 *
 * @returns `{ channel, versionArg }` where versionArg is undefined when the
 *   positional was a channel name (so we resolve to latest) or was omitted.
 */
function resolveChannelAndVersion(positional: string | undefined): {
  channel: ReleaseChannel;
  versionArg: string | undefined;
} {
  // "nightly" and "stable" as positional args select the channel rather than
  // installing a specific version. Match case-insensitively for convenience.
  const lower = positional?.toLowerCase();
  if (lower === "nightly" || lower === "stable") {
    return {
      channel: lower,
      versionArg: undefined,
    };
  }

  return {
    channel: getReleaseChannel(),
    versionArg: positional,
  };
}

/**
 * Resolve the target version from the local cache (SQLite) instead of
 * fetching from the network. Used by `--offline` and as automatic
 * fallback when `fetchLatestVersion()` hits a network error.
 *
 * @param versionArg - Explicit version from the user, bypasses the cache lookup
 * @returns The target version string
 * @throws {UpgradeError} When no cached version is available
 */
function resolveOfflineTarget(versionArg: string | undefined): string {
  if (versionArg) {
    return versionArg.replace(VERSION_PREFIX_REGEX, "");
  }
  const { latestVersion } = getVersionCheckInfo();
  if (!latestVersion) {
    throw new UpgradeError(
      "network_error",
      "No cached version available. Run any command to trigger a background version check, then retry."
    );
  }
  return latestVersion;
}

/**
 * Resolve the target version, trying the network first and falling back to
 * the local cache when offline or when the network is unavailable.
 *
 * @returns `{ target, offline }` — the resolved version and whether the
 *   resolution used the offline path (explicit or automatic fallback).
 *   Returns `null` when `resolveTargetVersion` returns a "done" result
 *   (check-only or already up-to-date); the caller should yield that result.
 */
async function resolveTargetWithFallback(opts: {
  resolveOpts: ResolveTargetOptions;
  versionArg: string | undefined;
  offline: boolean;
  /** Only curl-installed binaries support offline fallback */
  method: InstallationMethod;
  /** Persist the channel after offline target resolution (deferred to avoid
   *  clearing the version cache before the offline path can read it). */
  persistChannelFn: () => void;
}): Promise<
  | {
      kind: "target";
      target: string;
      offline: OfflineMode;
      source?: UpgradeSource;
    }
  | { kind: "done"; result: UpgradeResult; source?: UpgradeSource }
> {
  const { resolveOpts, versionArg, offline, method, persistChannelFn } = opts;

  if (offline) {
    // Channel switching with --offline is not supported: the cached version
    // belongs to the old channel and would install the wrong binary type.
    if (resolveOpts.channelChanged && !versionArg) {
      throw new UpgradeError(
        "unsupported_operation",
        "Cannot switch channels in offline mode — the cached version belongs to the current channel. " +
          "Run 'sentry cli upgrade' with network access to switch channels."
      );
    }
    // Read the cached version BEFORE persisting the channel — setReleaseChannel
    // clears the version cache on channel changes.
    const target = resolveOfflineTarget(versionArg);
    persistChannelFn();
    log.info(`Offline mode: using cached target ${target}`);
    return { kind: "target", target, offline: "explicit" };
  }

  // Non-offline: persist channel upfront (no cache dependency)
  persistChannelFn();

  try {
    const resolved = await resolveTargetVersion(resolveOpts);
    if (resolved.kind === "done") {
      return resolved;
    }
    return {
      kind: "target",
      target: resolved.target,
      offline: false,
      source: resolved.source,
    };
  } catch (error) {
    // Automatic offline fallback: only for curl-installed binaries (package
    // managers need the network for the actual install, not just version
    // discovery), and only for network errors (not version_not_found etc.)
    if (method !== "curl" || !(error instanceof UpgradeTransportError)) {
      throw error;
    }
    try {
      const target = resolveOfflineTarget(versionArg);
      log.warn("Network unavailable, falling back to cached upgrade target");
      log.info(`Using cached target: ${target}`);
      return { kind: "target", target, offline: "network-fallback" };
    } catch {
      // No cached version either — re-throw original network error
      throw error;
    }
  }
}

/**
 * Validate the installation method against the requested flags and channel.
 * Throws on unsupported combinations.
 */
function validateMethod(
  method: InstallationMethod,
  versionArg: string | undefined,
  offline: boolean
): void {
  if (method === "unknown") {
    throw new UpgradeError("unknown_method");
  }
  // Homebrew manages versioning through the formula — pinning a specific
  // stable version is not supported via this command.
  const pinnedVersion = CHANNEL_VERSIONS.has(versionArg ?? "")
    ? undefined
    : versionArg?.replace(VERSION_PREFIX_REGEX, "");
  if (method === "brew" && pinnedVersion && !isNightlyVersion(pinnedVersion)) {
    throw new UpgradeError(
      "unsupported_operation",
      "Homebrew does not support installing a specific version. Run 'brew upgrade getsentry/tools/sentry' to upgrade to the latest formula version."
    );
  }
  // Offline mode is only supported for curl-installed binaries — package
  // managers always need network to fetch and install packages.
  if (offline && method !== "curl") {
    throw new UpgradeError(
      "unsupported_operation",
      "Offline upgrade is only supported for curl-installed binaries."
    );
  }
}

function getArtifactChannel(target: string): ReleaseChannel {
  return isNightlyVersion(target) ? "nightly" : "stable";
}

type ResolveTargetOptions = {
  method: InstallationMethod;
  channel: ReleaseChannel;
  versionArg: string | undefined;
  channelChanged: boolean;
  flags: UpgradeFlags;
};

/**
 * Result of resolving the target version.
 *
 * - `target`: the version string to upgrade/downgrade to (proceed with upgrade)
 * - `UpgradeResult`: structured result when no upgrade should proceed
 *   (check-only mode, or already up to date)
 */
type ResolveResult =
  | { kind: "target"; target: string; source?: UpgradeSource }
  | { kind: "done"; result: UpgradeResult; source?: UpgradeSource };

async function resolvePinnedVersion(
  lookupMethod: InstallationMethod,
  target: string
): Promise<UpgradeSource | undefined> {
  if (lookupMethod !== "curl") {
    if (!(await versionExists(lookupMethod, target))) {
      throw new UpgradeError(
        "version_not_found",
        `Version ${target} not found`
      );
    }
    return;
  }
  const resolved = await resolveExistingUpgradeVersion(target);
  if (!resolved) {
    throw new UpgradeError("version_not_found", `Version ${target} not found`);
  }
  return resolved.source;
}

/**
 * Resolve the target version and handle check-only mode.
 *
 * @returns A `ResolveResult` indicating whether to proceed with the upgrade
 *   or return a completed result immediately.
 */
async function resolveTargetVersion(
  opts: ResolveTargetOptions
): Promise<ResolveResult> {
  const { method, channel, versionArg, channelChanged, flags } = opts;
  const standalone =
    channel === "nightly" || method === "curl" || method === "brew";
  const pinnedTarget =
    versionArg && !CHANNEL_VERSIONS.has(versionArg)
      ? versionArg.replace(VERSION_PREFIX_REGEX, "")
      : undefined;
  let source: UpgradeSource | undefined;

  if (pinnedTarget) {
    const lookupMethod = isNightlyVersion(pinnedTarget) ? "curl" : method;
    source = await resolvePinnedVersion(lookupMethod, pinnedTarget);
  }

  const latestResolution =
    pinnedTarget === undefined && standalone
      ? await resolveLatestUpgradeVersion(channel)
      : undefined;
  const latest =
    pinnedTarget ??
    latestResolution?.version ??
    (await fetchLatestVersion(method, channel));
  const resolvedTarget = pinnedTarget ?? latest;
  source ??= latestResolution?.source;

  log.debug(`Channel: ${channel}`);
  log.debug(`Latest version: ${latest}`);
  if (versionArg) {
    log.debug(`Target version: ${resolvedTarget}`);
  }

  if (flags.check) {
    return {
      kind: "done",
      result: buildCheckResult({
        target: resolvedTarget,
        versionArg,
        method,
        channel,
        flags,
      }),
      source,
    };
  }

  // Skip if already on target — unless forced or switching channels
  if (CLI_VERSION === resolvedTarget && !flags.force && !channelChanged) {
    return {
      kind: "done",
      result: {
        action: "up-to-date",
        currentVersion: CLI_VERSION,
        targetVersion: resolvedTarget,
        channel,
        method,
        forced: false,
      },
    };
  }

  return { kind: "target", target: resolvedTarget, source };
}

/**
 * Build the structured result for check-only mode.
 */
function buildCheckResult(opts: {
  target: string;
  versionArg: string | undefined;
  method: InstallationMethod;
  channel: ReleaseChannel;
  flags: UpgradeFlags;
}): UpgradeResult {
  const { target, versionArg, method, channel, flags } = opts;
  const result: UpgradeResult = {
    action: "checked",
    currentVersion: CLI_VERSION,
    targetVersion: target,
    channel,
    method,
    forced: flags.force,
  };

  // When already on target, no update hint needed
  if (CLI_VERSION !== target) {
    const cmd =
      versionArg && !CHANNEL_VERSIONS.has(versionArg)
        ? `sentry cli upgrade ${target}`
        : "sentry cli upgrade";
    result.warnings = [`Run '${cmd}' to update.`];
  }

  return result;
}

/**
 * Maximum number of spawn attempts for the new binary.
 *
 * On Windows, Defender/SmartScreen may lock a newly-written executable for
 * antivirus scanning after the file handle is closed. This causes EBUSY from
 * uv_spawn. Retrying with backoff lets the scan complete without a fixed sleep.
 */
const SPAWN_MAX_ATTEMPTS = 5;

/** Base delay (ms) between spawn retry attempts. Delay = attempt * base. */
const SPAWN_RETRY_BASE_MS = 500;

/**
 * Check whether an error is an EBUSY system error from spawn.
 *
 * On Windows, Defender/SmartScreen locks newly-written executables for
 * scanning. libuv's uv_spawn fails with EBUSY until the lock is released.
 */
export function isEbusyError(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "EBUSY"
  );
}

/**
 * Check whether an error indicates the spawn target was not found.
 *
 * Bun surfaces a missing executable as `Executable not found in $PATH: "..."`
 * without a standard `code` field on the Error, so we fall back to message
 * matching. Node's `child_process.spawn` would use `code: "ENOENT"`.
 */
export function isEnoentSpawnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return true;
  }
  return error.message.includes("Executable not found in $PATH");
}

/**
 * Spawn a binary with retry on EBUSY errors.
 *
 * On Windows, Defender/SmartScreen asynchronously scans newly-written
 * executables after the file handle is closed. If the CLI spawns the
 * binary before the scan completes, uv_spawn fails with EBUSY.
 * This function retries with backoff to let the scan finish.
 *
 * On non-Windows platforms (or when Defender isn't active), the first
 * attempt succeeds immediately with zero overhead.
 *
 * @returns Process exit code from the successful spawn
 * @throws {UpgradeError} Reason `execution_failed` when the binary path
 *   doesn't exist (Bun "Executable not found" or ENOENT), with an
 *   actionable message instructing the user to rerun the upgrade.
 * @throws The last EBUSY error if all attempts are exhausted
 * @throws Immediately on other non-EBUSY errors (EACCES, etc.)
 */
async function spawnWithRetry(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined
): Promise<number> {
  for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt++) {
    try {
      const proc = spawn(binaryPath, args, {
        stdio: "inherit",
        env,
      });
      return await new Promise<number>((resolve, reject) => {
        proc.on("close", (code, signal) => {
          // SIGKILL on macOS typically means AMFI killed the binary due to
          // an invalid code signature (the downloaded binary has quarantine
          // xattr). Surface this clearly instead of an opaque exit code.
          if (signal === "SIGKILL") {
            reject(
              new UpgradeError(
                "execution_failed",
                "Downloaded binary was killed by the operating system (SIGKILL). " +
                  "This usually means the binary has an invalid code signature. " +
                  "Try reinstalling: curl -sL https://sentry.io/get-cli/ | bash"
              )
            );
            return;
          }
          resolve(code ?? 1);
        });
        proc.on("error", (err) => reject(err));
      });
    } catch (error) {
      // Translate the opaque Bun "Executable not found" error into an
      // actionable UpgradeError. This path triggers when the binary at
      // `binaryPath` doesn't exist on disk when spawn is attempted (see
      // CLI-1D3). `downloadBinaryToTemp`'s visibility-race retry loop
      // normally catches this earlier, but this is a safety net for the
      // `.download` file being removed between verification and spawn
      // (e.g. manual cleanup by the user) or for future callers that
      // pass a path not backed by the download pipeline.
      if (isEnoentSpawnError(error)) {
        throw new UpgradeError(
          "execution_failed",
          `Downloaded binary not found at ${binaryPath}. ` +
            "The download may have been interrupted — rerun `sentry cli upgrade`."
        );
      }
      if (!isEbusyError(error) || attempt === SPAWN_MAX_ATTEMPTS) {
        throw error;
      }
      const delay = attempt * SPAWN_RETRY_BASE_MS;
      log.warn(
        `Binary is locked (antivirus scan?), retrying in ${delay}ms... (attempt ${attempt}/${SPAWN_MAX_ATTEMPTS})`
      );
      await setTimeout(delay);
    }
  }
  // Unreachable — the loop either returns or throws
  throw new UpgradeError("execution_failed", "Spawn retry loop exhausted");
}

/**
 * Spawn the new binary with `cli setup` to update completions, agent skills,
 * and record installation metadata.
 */
type SetupOptions = {
  binaryPath: string;
  method: InstallationMethod;
  channel: ReleaseChannel;
  /** Whether setup should handle binary placement (curl --install flow) */
  install: boolean;
  /** Pin the install directory (prevents relocation during upgrade) */
  installDir?: string;
  /** Ask the new binary to refresh a stored OAuth grant when scopes changed. */
  ensureAuthScopes: boolean;
  /** Skip agent skill installation during setup. */
  noAgentSkills: boolean;
};

/**
 * Spawn the new binary with `cli setup` to update completions, agent skills,
 * and record installation metadata.
 *
 * For curl upgrades with --install: the new binary places itself at the install
 * path, then runs setup steps. SENTRY_INSTALL_DIR is set in the child's
 * environment to pin the install directory, preventing `determineInstallDir()`
 * from relocating the binary to a different directory.
 *
 * For package manager upgrades: the binary is already in place, so setup only
 * updates completions, agent skills, and records metadata.
 */
async function runSetupOnNewBinary(opts: SetupOptions): Promise<void> {
  const {
    binaryPath,
    method,
    channel,
    install,
    installDir,
    ensureAuthScopes,
    noAgentSkills,
  } = opts;
  const args = [
    "cli",
    "setup",
    "--quiet",
    "--method",
    method,
    "--channel",
    channel,
    "--no-modify-path",
  ];
  if (install) {
    args.push("--install");
  }
  if (ensureAuthScopes) {
    args.push("--ensure-auth-scopes");
  }
  if (noAgentSkills) {
    args.push("--no-agent-skills");
  }

  const env = installDir
    ? { ...process.env, SENTRY_INSTALL_DIR: installDir }
    : undefined;

  const exitCode = await spawnWithRetry(binaryPath, args, env);
  if (exitCode !== 0) {
    throw new UpgradeError(
      "execution_failed",
      `Setup failed with exit code ${exitCode}`
    );
  }
}

function resolveUpdatedCliPath(
  execPath: string,
  entryPath: string | undefined,
  pathEnv: string | undefined
): string {
  return whichSync("sentry", { PATH: pathEnv }) ?? entryPath ?? execPath;
}

/**
 * Decide which directory a curl upgrade should install into.
 *
 * Normally the binary stays where it currently lives — pinning the install
 * dir keeps an in-place update from relocating a binary that is already on
 * the user's `PATH` (upgrade runs setup with `--no-modify-path`, so it can't
 * add a new directory to `PATH`).
 *
 * The one exception is a legacy `~/.sentry/bin` install: those should move to
 * the XDG-aligned location so users actually migrate off `~/.sentry`. We only
 * relocate when the XDG target directory is *already* on `PATH`, so the moved
 * binary stays discoverable without any `PATH` edit. When it isn't, we keep
 * the binary in place and leave relocation to an explicit `sentry cli setup`.
 */
export function resolveUpgradeInstallDir(
  currentInstallDir: string,
  pathEnv: string | undefined
): string {
  const legacyBinDir = join(homedir(), LEGACY_INSTALL_SUBDIR);
  if (!samePath(currentInstallDir, legacyBinDir)) {
    return currentInstallDir;
  }

  // determineInstallDir with the legacy pin removed yields the XDG target.
  const { SENTRY_INSTALL_DIR: _pinned, ...envWithoutPin } = process.env;
  const xdgInstallDir = determineInstallDir(homedir(), envWithoutPin);
  if (
    !samePath(xdgInstallDir, legacyBinDir) &&
    isInPath(xdgInstallDir, pathEnv)
  ) {
    return xdgInstallDir;
  }
  return currentInstallDir;
}

/**
 * Execute the standard upgrade path: download via curl or package manager,
 * then run setup on the new binary.
 */
async function executeStandardUpgrade(opts: {
  method: InstallationMethod;
  channel: ReleaseChannel;
  versionArg: string | undefined;
  target: string;
  execPath: string;
  entryPath?: string;
  pathEnv?: string;
  offline?: OfflineMode;
  json?: boolean;
  noAgentSkills: boolean;
  source?: UpgradeSource;
}): Promise<void> {
  const {
    method,
    channel,
    versionArg,
    target,
    execPath,
    entryPath,
    pathEnv,
    offline,
    json,
    noAgentSkills,
    source,
  } = opts;

  // Use the rolling "nightly" tag only when upgrading to latest nightly
  // (no specific version was requested). A specific version arg always
  // uses its own tag so the correct release is downloaded.
  const downloadTag =
    channel === "nightly" && !versionArg ? NIGHTLY_TAG : undefined;
  const downloadResult = await withProgress(
    { message: `Downloading ${target}...`, json },
    async (setMessage) =>
      executeUpgrade(method, target, downloadTag, offline, setMessage, source)
  );

  if (downloadResult?.patchBytes) {
    log.info(
      `Applied delta patch (${formatBytes(downloadResult.patchBytes)} downloaded)`
    );
  }

  // Run setup on the new binary to update completions, agent skills,
  // and record installation metadata.
  if (downloadResult) {
    // Curl: new binary is at temp path, setup --install will place it.
    // Pin the install directory via SENTRY_INSTALL_DIR so the child's
    // determineInstallDir() doesn't relocate to a directory that isn't on
    // PATH. A legacy ~/.sentry/bin install is relocated to the XDG dir when
    // that dir is already on PATH (see resolveUpgradeInstallDir); setup's
    // legacy-binary migration then moves the old binary and removes it before
    // --install writes the new one.
    // Release the download lock after the child exits — if the child used
    // the same lock path (ppid takeover), this is a harmless no-op.
    const currentInstallDir = dirname(getCurlInstallPaths().installPath);
    const installDir = resolveUpgradeInstallDir(currentInstallDir, pathEnv);
    try {
      await runSetupOnNewBinary({
        binaryPath: downloadResult.tempBinaryPath,
        method,
        channel,
        install: true,
        installDir,
        ensureAuthScopes: !json,
        noAgentSkills,
      });
    } finally {
      releaseLock(downloadResult.lockPath);
    }
  } else {
    // Package managers replace their PATH entry in place. Resolve it after the
    // install so setup runs with the new CLI, not Node's process.execPath or a
    // removed Homebrew keg path.
    await runSetupOnNewBinary({
      binaryPath: resolveUpdatedCliPath(execPath, entryPath, pathEnv),
      method,
      channel,
      install: false,
      ensureAuthScopes: !json,
      noAgentSkills,
    });
  }
}

/**
 * Migrate from a package-manager or Homebrew install to a standalone binary
 * when the user switches to the nightly channel.
 *
 * Nightly builds are distributed as standalone binaries only (GitHub release
 * assets). When a user on brew/npm/pnpm/bun/yarn switches to nightly we:
 *   1. Download the nightly binary to a temp path
 *   2. Install it to `determineInstallDir()` (same logic as the curl installer)
 *   3. Run setup on the new binary to update completions, PATH, and metadata
 *   4. Return warnings about the old package-manager installation that may still be in PATH
 *
 * @param opts.versionArg - Specific version requested by the user, or undefined
 *   for latest nightly. When a specific version is given, its release tag is
 *   used instead of the rolling "nightly" tag so the correct binary is
 *   downloaded.
 * @returns Warnings about the old installation that may shadow the new one
 */
async function migrateToStandaloneForNightly(opts: {
  method: InstallationMethod;
  target: string;
  versionArg: string | undefined;
  noAgentSkills: boolean;
  json?: boolean;
  source?: UpgradeSource;
  channel: ReleaseChannel;
}): Promise<string[]> {
  const { method, target, versionArg, noAgentSkills, json, source, channel } =
    opts;
  log.info("Nightly builds are only available as standalone binaries.");
  log.info("Migrating to standalone installation...");

  // Use the rolling "nightly" tag for latest nightly; use the specific version
  // tag if the user requested a pinned version.
  const downloadTag = versionArg ? undefined : NIGHTLY_TAG;
  const downloadResult = await withProgress(
    { message: `Downloading ${target}...`, json },
    async (setMessage) =>
      executeUpgrade("curl", target, downloadTag, undefined, setMessage, source)
  );

  if (downloadResult?.patchBytes) {
    log.info(
      `Applied delta patch (${formatBytes(downloadResult.patchBytes)} downloaded)`
    );
  }

  if (!downloadResult) {
    throw new UpgradeError(
      "execution_failed",
      "Failed to download nightly binary"
    );
  }

  const installDir = determineInstallDir(homedir(), process.env);

  try {
    await runSetupOnNewBinary({
      binaryPath: downloadResult.tempBinaryPath,
      method: "curl",
      channel,
      install: true,
      installDir,
      ensureAuthScopes: !json,
      noAgentSkills,
    });
  } finally {
    releaseLock(downloadResult.lockPath);
  }

  // Build warnings about the potentially shadowing old installation.
  // Note: install info is already recorded by the child `setup --install`
  // process, so no redundant setInstallInfo call is needed here.
  const uninstallHints: Record<string, string> = {
    npm: "npm uninstall -g sentry",
    pnpm: "pnpm remove -g sentry",
    bun: "bun remove -g sentry",
    yarn: "yarn global remove sentry",
    brew: "brew uninstall getsentry/tools/sentry",
  };
  const warnings: string[] = [];
  warnings.push(
    `Your ${method}-installed sentry may still appear earlier in PATH.`
  );
  const hint = uninstallHints[method];
  if (hint) {
    warnings.push(`Consider removing it: ${hint}`);
  }
  return warnings;
}

/**
 * Resolve the channel, version arg, method, and channel-changed flag from
 * the positional version argument and flags. Extracted to keep `func()`
 * complexity under the biome limit.
 */
async function resolveContext(
  version: string | undefined,
  flags: UpgradeFlags
): Promise<{
  channel: ReleaseChannel;
  versionArg: string | undefined;
  channelChanged: boolean;
  method: InstallationMethod;
}> {
  const { channel, versionArg } = resolveChannelAndVersion(version);
  const currentChannel = getReleaseChannel();
  const channelChanged = channel !== currentChannel;

  const method = flags.method ?? (await detectInstallationMethod());
  validateMethod(method, versionArg, flags.offline);
  return { channel, versionArg, channelChanged, method };
}

/**
 * Persist the release channel preference. Must be called **after** offline
 * target resolution since `setReleaseChannel()` clears the version check
 * cache on channel changes, which would prevent `resolveOfflineTarget()`
 * from reading the cached version.
 */
function persistChannel(
  channel: ReleaseChannel,
  channelChanged: boolean,
  version: string | undefined
): void {
  if (channelChanged || CHANNEL_VERSIONS.has(version ?? "")) {
    setReleaseChannel(channel);
  }
}

/**
 * Start a best-effort changelog fetch in parallel with the binary download.
 *
 * Returns a promise that resolves to the changelog or undefined. Never
 * throws — errors are swallowed so the upgrade is not blocked.
 */
function startChangelogFetch(options: {
  channel: ReleaseChannel;
  currentVersion: string;
  targetVersion: string;
  offline: OfflineMode;
  source?: UpgradeSource;
}): Promise<ChangelogSummary | undefined> {
  const { channel, currentVersion, targetVersion, offline, source } = options;
  if (offline || currentVersion === targetVersion) {
    return Promise.resolve(undefined);
  }
  return fetchChangelog({
    channel,
    fromVersion: currentVersion,
    toVersion: targetVersion,
    source,
  })
    .then((result) => result ?? undefined)
    .catch(() => undefined as undefined);
}

/**
 * Build a check-only result with optional changelog, ready to yield.
 */
async function buildCheckResultWithChangelog(opts: {
  target: string;
  versionArg: string | undefined;
  method: InstallationMethod;
  channel: ReleaseChannel;
  flags: UpgradeFlags;
  offline: OfflineMode;
  changelogPromise: Promise<ChangelogSummary | undefined>;
}): Promise<UpgradeResult> {
  const result = buildCheckResult(opts);
  if (opts.offline) {
    result.offline = true;
  }
  result.changelog = await opts.changelogPromise;
  return result;
}

export const upgradeCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Update the Sentry CLI to the latest version",
    fullDescription:
      "Check for updates and upgrade the Sentry CLI to the latest or a specific version.\n\n" +
      "By default, detects how the CLI was installed (npm, curl, etc.) and uses the same method to upgrade.\n\n" +
      "Two release channels are supported:\n" +
      "  stable  (default) Latest stable release\n" +
      "  nightly           Built from main, updated on every commit\n\n" +
      "The channel is persisted so that subsequent bare `sentry cli upgrade` calls\n" +
      "use the same channel.\n\n" +
      "Examples:\n" +
      "  sentry cli upgrade              # Update to latest (using persisted channel)\n" +
      "  sentry cli upgrade nightly      # Switch to nightly channel and update\n" +
      "  sentry cli upgrade stable       # Switch back to stable channel and update\n" +
      "  sentry cli upgrade 0.5.0        # Install a specific stable version\n" +
      "  sentry cli upgrade --check      # Check for updates without installing\n" +
      "  sentry cli upgrade --force      # Force re-download even if up to date\n" +
      "  sentry cli upgrade --method npm # Force using npm to upgrade\n" +
      "  sentry cli upgrade --offline    # Upgrade from cached patches (no network)\n" +
      "  sentry cli upgrade --no-agent-skills # Skip reinstalling agent skills",
  },
  output: { human: formatUpgradeResult },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief:
            'Specific version (e.g. 0.5.0), or "nightly"/"stable" to switch channel; omit to update within current channel',
          parse: String,
          placeholder: "version",
          optional: true,
        },
      ],
    },
    flags: {
      check: {
        kind: "boolean",
        brief: "Check for updates without installing",
        default: false,
      },
      force: {
        kind: "boolean",
        brief: "Force upgrade even if already on the latest version",
        default: false,
      },
      offline: {
        kind: "boolean",
        brief:
          "Upgrade using only cached version info and patches (no network)",
        default: false,
      },
      "no-agent-skills": {
        kind: "boolean",
        brief: "Skip agent skill installation for AI coding assistants",
        default: false,
      },
      method: {
        kind: "parsed",
        parse: parseInstallationMethod,
        brief: "Installation method to use (curl, brew, npm, pnpm, bun, yarn)",
        optional: true,
        placeholder: "method",
      },
    },
  },
  async *func(this: SentryContext, flags: UpgradeFlags, version?: string) {
    const { channel, versionArg, channelChanged, method } =
      await resolveContext(version, flags);

    log.debug(`Installation method: ${method}`);
    log.debug(`Current version: ${CLI_VERSION}`);

    const resolved = await withProgress(
      { message: "Checking for updates...", json: flags.json },
      async () =>
        resolveTargetWithFallback({
          resolveOpts: { method, channel, versionArg, channelChanged, flags },
          versionArg,
          offline: flags.offline,
          method,
          persistChannelFn: () =>
            persistChannel(channel, channelChanged, version),
        })
    );
    // Early exit for check-only (online) and up-to-date results.
    if (resolved.kind === "done") {
      const result = resolved.result;
      // For --check with a version diff, fetch changelog before returning.
      if (
        result.action === "checked" &&
        result.currentVersion !== result.targetVersion
      ) {
        result.changelog = await startChangelogFetch({
          channel: getArtifactChannel(result.targetVersion),
          currentVersion: CLI_VERSION,
          targetVersion: result.targetVersion,
          offline: false,
          source: resolved.source,
        });
      }
      return yield new CommandOutput(result);
    }

    const { target, offline, source } = resolved;

    // Start changelog fetch early — it runs in parallel with the download.
    const changelogPromise = startChangelogFetch({
      channel: getArtifactChannel(target),
      currentVersion: CLI_VERSION,
      targetVersion: target,
      offline,
      source,
    });

    // --check with offline fallback: resolveTargetWithFallback returns
    // kind: "target" for offline check, so guard against actual upgrade.
    if (flags.check) {
      return yield new CommandOutput(
        await buildCheckResultWithChangelog({
          target,
          versionArg,
          method,
          channel,
          flags,
          offline,
          changelogPromise,
        })
      );
    }

    // Skip if already on target — unless forced or switching channels
    if (CLI_VERSION === target && !flags.force && !channelChanged) {
      return yield new CommandOutput({
        action: "up-to-date",
        currentVersion: CLI_VERSION,
        targetVersion: target,
        channel,
        method,
        forced: false,
        offline: offline ? true : undefined,
      } satisfies UpgradeResult);
    }
    const downgrade = isDowngrade(CLI_VERSION, target);
    log.debug(`${downgrade ? "Downgrading" : "Upgrading"} to ${target}`);

    // Perform the actual upgrade
    let warnings: string[] | undefined;
    if (isNightlyVersion(target) && method !== "curl") {
      // Nightly is GitHub-only. If the current install method is not curl,
      // migrate to a standalone binary — the migration handles setup internally.
      warnings = await migrateToStandaloneForNightly({
        method,
        target,
        versionArg,
        noAgentSkills: flags["no-agent-skills"],
        json: flags.json,
        source,
        channel,
      });
    } else {
      await executeStandardUpgrade({
        method,
        channel,
        versionArg,
        target,
        execPath: this.process.execPath,
        entryPath: this.process.argv?.[1],
        pathEnv: this.process.env.PATH,
        offline,
        json: flags.json,
        noAgentSkills: flags["no-agent-skills"],
        source,
      });
    }

    const changelog = await changelogPromise;
    yield new CommandOutput({
      action: downgrade ? "downgraded" : "upgraded",
      currentVersion: CLI_VERSION,
      targetVersion: target,
      channel,
      method,
      forced: flags.force,
      offline: offline ? true : undefined,
      warnings,
      changelog,
    } satisfies UpgradeResult);
    return;
  },
});
