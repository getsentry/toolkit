/**
 * sentry cli setup
 *
 * Configure shell integration: PATH, completions, and install metadata.
 * With --install, also handles binary placement (used by the install script
 * and the upgrade command for curl-based installs).
 */

import { existsSync, unlinkSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isatty } from "node:tty";
import { captureException } from "@sentry/node-core/light";
import type { SentryContext } from "../../context.js";
import { installAgentSkills } from "../../lib/agent-skills.js";
import { assertAutoLoginHostTrusted } from "../../lib/auto-auth.js";
import {
  determineInstallDir,
  getBinaryFilename,
  getLegacyInstallDirs,
  type InstallationMethod,
  installBinary,
  parseInstallationMethod,
  samePath,
} from "../../lib/binary.js";
import { buildCommand } from "../../lib/command.js";
import {
  type CompletionLocation,
  installCompletions,
} from "../../lib/completions.js";
import { CLI_VERSION } from "../../lib/constants.js";
import { getAuthConfig } from "../../lib/db/auth.js";
import {
  getAgentSkillsPreference,
  setAgentSkillsPreference,
} from "../../lib/db/defaults.js";
import { closeDatabase, resolveXdgConfigDir } from "../../lib/db/index.js";
import { setInstallInfo } from "../../lib/db/install-info.js";
import {
  parseReleaseChannel,
  type ReleaseChannel,
  setReleaseChannel,
} from "../../lib/db/release-channel.js";
import {
  detectAgent,
  detectAgentFromProcessTree,
} from "../../lib/detect-agent.js";
import { getEnv } from "../../lib/env.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { runInteractiveLogin } from "../../lib/interactive-login.js";
import { interactivePromptsAllowed } from "../../lib/interactive-prompts.js";
import { logger } from "../../lib/logger.js";
import {
  addToFpath,
  addToGitHubPath,
  addToPath,
  detectShell,
  getFpathCommand,
  getPathCommand,
  isBashAvailable,
  isInPath,
  type ShellInfo,
} from "../../lib/shell.js";

type SetupFlags = {
  readonly install: boolean;
  readonly method?: InstallationMethod;
  readonly channel?: ReleaseChannel;
  readonly "no-modify-path": boolean;
  readonly "no-completions": boolean;
  readonly "no-agent-skills": boolean;
  readonly "ensure-auth-scopes": boolean;
  readonly quiet: boolean;
};

type Logger = (msg: string) => void;

/** Structured result of the setup operation */
type SetupResult = {
  /** Status messages collected during setup */
  messages: string[];
  /** Warning messages from best-effort steps that failed non-fatally */
  warnings: string[];
  /** Whether a fresh binary was installed */
  freshInstall: boolean;
  /** Path to the installed binary */
  binaryPath: string;
  /** CLI version */
  version: string;
};

/** Format setup result for human-readable output */
function formatSetupResult(result: SetupResult): string {
  return result.messages.join("\n");
}

/**
 * Migrate `cli.db` (+ WAL sidecars) and the old `config.json` out of the legacy
 * `~/.sentry` directory into the XDG config directory.
 *
 * The database is opened at CLI startup (cleanup-old-binary reads install
 * info), so it must be closed before the files are moved — an open SQLite file
 * cannot be renamed on Windows. Closing also invalidates the cached handle, so
 * the next `getDatabase()` reopens at the new path.
 */
async function migrateLegacyConfig(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  emit: Logger
): Promise<void> {
  const legacyDir = join(homeDir, ".sentry");
  // Target the XDG location directly — resolveConfigDir keeps returning the
  // legacy dir while it still holds cli.db, which would make migration a no-op.
  const targetConfigDir = resolveXdgConfigDir(env, homeDir);
  if (samePath(targetConfigDir, legacyDir)) {
    return;
  }

  const configFiles = ["cli.db", "cli.db-wal", "cli.db-shm", "config.json"];
  const hasLegacyConfig = configFiles.some((name) =>
    existsSync(join(legacyDir, name))
  );
  if (!hasLegacyConfig || existsSync(join(targetConfigDir, "cli.db"))) {
    return;
  }

  closeDatabase();
  await mkdir(targetConfigDir, { recursive: true, mode: 0o700 });
  for (const name of configFiles) {
    const from = join(legacyDir, name);
    if (existsSync(from)) {
      await rename(from, join(targetConfigDir, name));
    }
  }
  emit(`Config: Migrated ${legacyDir} → ${targetConfigDir}`);
}

/**
 * Find a binary in a *legacy* install directory (see {@link getLegacyInstallDirs})
 * that should be migrated into the resolved install target. Only genuinely
 * pre-XDG locations are considered — `~/.local/bin` and `~/bin` are valid
 * current targets and must never be treated as migration sources, or a working
 * binary could be relocated out of an active directory.
 */
function findMigratableBinary(
  homeDir: string,
  targetDir: string,
  filename: string
): string | undefined {
  for (const dir of getLegacyInstallDirs(homeDir)) {
    if (samePath(dir, targetDir)) {
      continue;
    }
    const candidate = join(dir, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return;
}

/**
 * Migrate an existing binary out of a known legacy install directory into the
 * XDG-aware install dir. Returns the new binary path when a move happened, so
 * the caller can point PATH setup and recorded install info at the new location
 * instead of the now-deleted legacy path.
 */
async function migrateLegacyBinary(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  emit: Logger
): Promise<string | undefined> {
  const filename = getBinaryFilename();
  const targetDir = determineInstallDir(homeDir, env);
  const targetBin = join(targetDir, filename);
  if (existsSync(targetBin)) {
    return;
  }

  const legacyBin = findMigratableBinary(homeDir, targetDir, filename);
  if (!legacyBin) {
    return;
  }

  await mkdir(targetDir, { recursive: true, mode: 0o755 });
  await copyFile(legacyBin, targetBin);
  // copyFile already preserves the source mode, but assert the exec bit
  // explicitly — mirrors installBinary — so the migrated binary is runnable
  // even if the legacy copy's permissions were somehow stripped.
  await chmod(targetBin, 0o755);
  try {
    await unlink(legacyBin);
  } catch (error) {
    // Leave the old binary in place if it can't be removed — the new copy
    // is authoritative and setInstallInfo points upgrades at it.
    logger.withTag("cli.setup").debug("Failed to remove legacy binary", error);
  }
  setInstallInfo({ method: "curl", path: targetBin, version: CLI_VERSION });
  emit(`Binary: Migrated ${legacyBin} → ${targetBin}`);
  return targetBin;
}

/**
 * Handle binary installation from a temp location.
 *
 * Determines the target install directory, copies the running binary
 * (which is at a temp path) to the install location, then cleans up
 * the temp binary on Posix (safe because the running process's inode
 * stays alive until exit).
 *
 * On Windows, the temp binary cannot be deleted while running. It will
 * be cleaned up by the OS when the temp directory is purged.
 *
 * @returns The installed binary path, its directory, and whether this
 *   was a fresh install (`created`) or an upgrade of an existing binary
 */
async function handleInstall(
  execPath: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
  emit: Logger
): Promise<{ binaryPath: string; binaryDir: string; created: boolean }> {
  const installDir = determineInstallDir(homeDir, env);
  const targetPath = join(installDir, getBinaryFilename());
  const alreadyExists = existsSync(targetPath);

  const binaryPath = await installBinary(execPath, installDir);
  const binaryDir = dirname(binaryPath);

  emit(`Binary: Installed to ${binaryPath}`);

  // Clean up temp binary (Posix only — the inode stays alive for the running process)
  if (process.platform !== "win32") {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      unlinkSync(execPath);
    } catch {
      // Ignore — temp file may already be gone or we lack permissions
    }
  }

  return { binaryPath, binaryDir, created: !alreadyExists };
}

/**
 * Handle PATH modification for a directory.
 */
async function handlePathModification(
  binaryDir: string,
  shell: ShellInfo,
  env: NodeJS.ProcessEnv,
  emit: Logger
) {
  const alreadyInPath = isInPath(binaryDir, env.PATH);

  if (alreadyInPath) {
    emit(`PATH: ${binaryDir} is already in PATH`);
    return;
  }

  if (shell.configFile) {
    const result = await addToPath(shell.configFile, binaryDir, shell.type);

    if (result.modified) {
      emit(`PATH: ${result.message}`);
      emit(`      Restart your shell or run: source ${shell.configFile}`);
    } else if (result.manualCommand) {
      emit(`PATH: ${result.message}`);
      emit(`      Add manually: ${result.manualCommand}`);
    } else {
      emit(`PATH: ${result.message}`);
    }
  } else {
    const cmd = getPathCommand(shell.type, binaryDir);
    emit("PATH: No shell config file found");
    emit(`      Add manually to your shell config: ${cmd}`);
  }

  // Handle GitHub Actions
  const addedToGitHub = await addToGitHubPath(binaryDir, env);
  if (addedToGitHub) {
    emit("PATH: Added to $GITHUB_PATH");
  }
}

/**
 * Attempt to install bash completions as a fallback for unsupported shells.
 *
 * Many custom shells (xonsh, nushell, etc.) can load bash completions,
 * so this is a useful fallback when the user's shell isn't directly supported.
 *
 * @param pathEnv - The PATH to search for bash, forwarded from the process env.
 * @returns The completion location if bash is available, null otherwise.
 */
async function tryBashCompletionFallback(
  homeDir: string,
  xdgDataHome: string | undefined,
  pathEnv: string | undefined
): Promise<CompletionLocation | null> {
  if (!isBashAvailable(pathEnv)) {
    return null;
  }

  // Defensive: installCompletions returns null only if the shell type has no
  // completion script or path configured. "bash" is always supported, but
  // we guard here in case that changes in future.
  return await installCompletions("bash", homeDir, xdgDataHome);
}

/**
 * Ensure the zsh completion directory is in fpath.
 *
 * Runs even on updates so existing installs get fpath configured (one-time migration).
 * Returns status messages for the user.
 */
async function handleZshFpath(
  shell: ShellInfo,
  completionDir: string,
  isNewInstall: boolean
): Promise<string[]> {
  const lines: string[] = [];

  if (shell.configFile) {
    const result = await addToFpath(shell.configFile, completionDir);
    if (result.modified) {
      lines.push(`Completions: ${result.message}`);
      lines.push(`      Restart your shell or run: source ${shell.configFile}`);
    } else if (result.manualCommand) {
      lines.push(`Completions: ${result.message}`);
      lines.push(
        `      Add manually to ${shell.configFile}: ${result.manualCommand}`
      );
    }
  } else if (isNewInstall) {
    lines.push(`      Add to your .zshrc: ${getFpathCommand(completionDir)}`);
  }

  return lines;
}

/**
 * Handle shell completion installation.
 *
 * For unsupported shells (xonsh, nushell, etc.), falls back to installing
 * bash completions if bash is available on the system. Uses the provided
 * PATH env to check for bash so the call is testable without side effects.
 *
 * Only produces output when completions are freshly created. Subsequent
 * runs (e.g. after upgrade) silently update the file without printing,
 * avoiding noisy repeated messages.
 */
async function handleCompletions(
  shell: ShellInfo,
  homeDir: string,
  xdgDataHome: string | undefined,
  pathEnv: string | undefined
): Promise<string[]> {
  const location = await installCompletions(shell.type, homeDir, xdgDataHome);

  if (location) {
    const lines: string[] = [];

    if (shell.type === "zsh") {
      const completionDir = dirname(location.path);
      lines.push(
        ...(await handleZshFpath(shell, completionDir, location.created))
      );
    }

    if (location.created) {
      lines.unshift(`Completions: Installed to ${location.path}`);
    }

    return lines;
  }

  // Shells with native completion support (bash/zsh/fish) return null only
  // when the target directory is not writable (permission error handled
  // inside installCompletions). Don't fall through to the bash fallback —
  // that would misleadingly say the shell "is not directly supported".
  // sh/ash are minimal POSIX shells — completions aren't expected either.
  if (
    shell.type === "bash" ||
    shell.type === "zsh" ||
    shell.type === "fish" ||
    shell.type === "sh" ||
    shell.type === "ash"
  ) {
    return [];
  }

  const fallback = await tryBashCompletionFallback(
    homeDir,
    xdgDataHome,
    pathEnv
  );

  if (fallback) {
    // Bash fallback was silently updated — nothing new to report
    if (!fallback.created) {
      return [];
    }

    return [
      `Completions: Your shell (${shell.name}) is not directly supported`,
      `      Installed bash completions as a fallback: ${fallback.path}`,
    ];
  }

  // No completions possible and nothing actionable — stay silent
  return [];
}

/**
 * Handle agent skill installation for AI coding assistants.
 *
 * Detects supported agent roots (currently `~/.agents` and `~/.claude`)
 * and installs the version-pinned skill files. Silent when no compatible
 * agent root is detected.
 *
 * Only produces output when the skill file is freshly created. Subsequent
 * runs (e.g. after upgrade) silently update without printing.
 */
async function handleAgentSkills(homeDir: string, emit: Logger) {
  const location = await installAgentSkills(homeDir);

  if (location?.created) {
    emit(`Agent skills: Installed to ${location.path}`);
  }
}

/**
 * Print a rich welcome message after fresh install.
 */
function printWelcomeMessage(
  emit: Logger,
  version: string,
  binaryPath: string
): void {
  emit("");
  emit(`Installed sentry v${version} to ${binaryPath}`);
  emit("");
  emit("Get started:");
  emit("  sentry auth     Authenticate with Sentry");
  emit("  sentry --help   See all available commands");
  emit("");
  emit("https://cli.sentry.dev");
}

type WarnLogger = (step: string, error: unknown) => void;

/**
 * Run a best-effort setup step, logging a warning on failure instead of aborting.
 *
 * Post-install configuration steps (recording install info, shell completions,
 * agent skills) are non-essential. Permission errors are common when Homebrew
 * runs post-install (e.g. root-owned ~/.sentry from a previous `sudo brew install`,
 * restricted ~/.local/share). The binary is already installed — these are
 * nice-to-have side effects that should never crash setup.
 */
async function bestEffort(
  stepName: string,
  fn: () => void | Promise<void>,
  warn: WarnLogger
) {
  try {
    await fn();
  } catch (error) {
    warn(stepName, error);
    captureException(error, {
      level: "warning",
      tags: { "setup.step": stepName },
    });
  }
}

/** Options for configuration steps, grouped to stay within parameter limits */
type ConfigStepOptions = {
  readonly flags: SetupFlags;
  readonly binaryPath: string;
  readonly binaryDir: string;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly emit: Logger;
  readonly warn: WarnLogger;
};

/**
 * Run all best-effort configuration steps after binary installation.
 *
 * Each step is independently guarded so a failure in one (e.g. DB permission
 * error) doesn't prevent the others from running.
 */
async function runConfigurationSteps(opts: ConfigStepOptions) {
  const { flags, binaryPath, binaryDir, homeDir, env, emit, warn } = opts;
  const shell = detectShell(env.SHELL, homeDir, env.XDG_CONFIG_HOME);

  // 1. Record installation info
  const method = flags.method;
  if (method) {
    await bestEffort(
      "Recording installation info",
      () => {
        setInstallInfo({
          method,
          path: binaryPath,
          version: CLI_VERSION,
        });
        if (!flags.install) {
          emit(`Recorded installation method: ${method}`);
        }
      },
      warn
    );
  }

  // 1b. Persist release channel (set by install script or upgrade command)
  const channel = flags.channel;
  if (channel) {
    await bestEffort(
      "Recording release channel",
      () => {
        setReleaseChannel(channel);
        if (!flags.install) {
          emit(`Recorded release channel: ${channel}`);
        }
      },
      warn
    );
  }

  // 2. Handle PATH modification
  if (!flags["no-modify-path"]) {
    await bestEffort(
      "PATH modification",
      () => handlePathModification(binaryDir, shell, env, emit),
      warn
    );
  }

  // 3. Install shell completions
  if (!flags["no-completions"]) {
    await bestEffort(
      "Shell completions",
      async () => {
        const completionLines = await handleCompletions(
          shell,
          homeDir,
          env.XDG_DATA_HOME,
          env.PATH
        );
        for (const line of completionLines) {
          emit(line);
        }
      },
      warn
    );
  }

  // 4. Install agent skills (auto-detected, silent when no agent found).
  // Persist an explicit --no-agent-skills opt-out so later upgrades (which
  // re-run setup without the flag) keep honoring it. Re-enable with
  // `sentry cli defaults agent-skills on`.
  if (flags["no-agent-skills"]) {
    await bestEffort(
      "Recording agent skills preference",
      () => setAgentSkillsPreference(false),
      warn
    );
  }
  const skipAgentSkills =
    flags["no-agent-skills"] || getAgentSkillsPreference() === false;
  if (!skipAgentSkills) {
    await bestEffort(
      "Agent skills",
      () => handleAgentSkills(homeDir, emit),
      warn
    );
  }
}

export const setupCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Configure shell integration",
    fullDescription:
      "Sets up shell integration for the Sentry CLI:\n\n" +
      "- Adds binary directory to PATH (if not already in PATH)\n" +
      "- Installs shell completions (bash, zsh, fish)\n" +
      "- Installs agent skills for detected AI coding assistants\n" +
      "- Records installation metadata for upgrades\n\n" +
      "With --install, also handles binary placement from a temporary\n" +
      "download location (used by the install script and upgrade command).\n\n" +
      "This command is called automatically by the install script,\n" +
      "but can also be run manually after downloading the binary.\n\n" +
      "Examples:\n" +
      "  sentry cli setup                    # Auto-detect and configure\n" +
      "  sentry cli setup --method curl      # Record install method\n" +
      "  sentry cli setup --install          # Place binary and configure\n" +
      "  sentry cli setup --no-modify-path   # Skip PATH modification\n" +
      "  sentry cli setup --no-completions   # Skip shell completions\n" +
      "  sentry cli setup --no-agent-skills  # Skip agent skill installation",
  },
  parameters: {
    flags: {
      install: {
        kind: "boolean",
        brief: "Install the binary from a temp location to the system path",
        default: false,
      },
      method: {
        kind: "parsed",
        parse: parseInstallationMethod,
        brief: "Installation method (curl, npm, pnpm, bun, yarn)",
        placeholder: "method",
        optional: true,
      },
      channel: {
        kind: "parsed",
        parse: parseReleaseChannel,
        brief: "Release channel to persist (stable or nightly)",
        placeholder: "channel",
        optional: true,
      },
      "no-modify-path": {
        kind: "boolean",
        brief: "Skip PATH modification",
        default: false,
      },
      "no-completions": {
        kind: "boolean",
        brief: "Skip shell completion installation",
        default: false,
      },
      "no-agent-skills": {
        kind: "boolean",
        brief: "Skip agent skill installation for AI coding assistants",
        default: false,
      },
      "ensure-auth-scopes": {
        kind: "boolean",
        brief: "Refresh an outdated stored OAuth authorization",
        default: false,
        hidden: true as const,
      },
      quiet: {
        kind: "boolean",
        brief: "Suppress output (for scripted usage)",
        default: false,
      },
    },
  },
  output: { human: formatSetupResult },
  async *func(this: SentryContext, flags: SetupFlags) {
    const { process, homeDir } = this;

    const log = logger.withTag("cli.setup");
    const messages: string[] = [];
    const warnings: string[] = [];

    const emit: Logger = (msg: string) => {
      if (!flags.quiet) {
        messages.push(msg);
      }
    };

    const warn: WarnLogger = (step, error) => {
      const msg =
        error instanceof Error ? error.message : "Unknown error occurred";
      const warning = `${step} failed: ${msg}`;
      log.warn(warning);
      warnings.push(warning);
    };

    let binaryPath = process.execPath;
    let binaryDir = dirname(binaryPath);
    let freshInstall = false;

    // 0. Migrate any legacy ~/.sentry config/binary into XDG locations first,
    // so the steps below operate on the new paths. Config and binary migrations
    // are independent — a failure in one must not skip the other, and both are
    // best-effort: warnings surface to the user and errors are reported to
    // Sentry, but a failure never aborts setup.
    await bestEffort(
      "Legacy config migration",
      () => migrateLegacyConfig(homeDir, process.env, emit),
      warn
    );
    await bestEffort(
      "Legacy binary migration",
      async () => {
        const migratedBinary = await migrateLegacyBinary(
          homeDir,
          process.env,
          emit
        );
        // Adopt the new location so PATH setup and recorded install info point
        // at the migrated binary rather than the deleted legacy path.
        if (migratedBinary) {
          binaryPath = migratedBinary;
          binaryDir = dirname(migratedBinary);
        }
      },
      warn
    );

    // 1. Install binary from temp location (when --install is set)
    if (flags.install) {
      const result = await handleInstall(
        process.execPath,
        homeDir,
        process.env,
        emit
      );
      binaryPath = result.binaryPath;
      binaryDir = result.binaryDir;
      freshInstall = result.created;
    }

    // 1–4. Run best-effort configuration steps
    await runConfigurationSteps({
      flags,
      binaryPath,
      binaryDir,
      homeDir,
      env: process.env,
      emit,
      warn,
    });

    if (flags["ensure-auth-scopes"]) {
      await bestEffort(
        "Authorization",
        async () => {
          const { ensureCurrentOAuthScopes } = await import(
            "../../lib/scope-recovery.js"
          );
          await ensureCurrentOAuthScopes(runInteractiveLogin);
        },
        warn
      );
    }

    // 5. Print welcome message only on fresh install — upgrades are silent
    // since the upgrade command itself prints a success message.
    if (!flags.quiet && freshInstall) {
      printWelcomeMessage(emit, CLI_VERSION, binaryPath);
    }

    yield new CommandOutput<SetupResult>({
      messages,
      warnings,
      freshInstall,
      binaryPath,
      version: CLI_VERSION,
    });

    if (
      !freshInstall ||
      flags.method !== "curl" ||
      flags.quiet ||
      flags["ensure-auth-scopes"] ||
      getEnv().SENTRY_INIT === "1" ||
      !(interactivePromptsAllowed() && isatty(0) && isatty(1) && isatty(2))
    ) {
      return;
    }

    await bestEffort(
      "Authentication",
      async () => {
        if (
          getAuthConfig() ||
          detectAgent() ||
          (await detectAgentFromProcessTree())
        ) {
          return;
        }
        assertAutoLoginHostTrusted();
        const result = await runInteractiveLogin();
        if (result) {
          log.success("Authenticated with Sentry.");
        } else {
          log.info("Run 'sentry auth login' to authenticate later.");
        }
      },
      warn
    );
  },
});
