/**
 * sentry cli uninstall
 *
 * Reverse of `sentry cli setup`: removes the Sentry CLI binary, shell
 * completions, PATH/fpath entries from shell config files, agent skill
 * files, and the config directory.
 *
 * ## Flow
 *
 * 1. Detect installation method — if package manager (npm/brew/pnpm/etc.),
 *    advise the user to use their PM's uninstall and exit.
 * 2. Gather all artifacts to remove (completions, skills, config lines,
 *    config dir, binary).
 * 3. If `--dry-run`, display the removal plan and exit.
 * 4. If not `--yes`/`--force`, prompt for confirmation.
 * 5. Remove each artifact in order, logging results.
 * 6. Delete the binary itself last.
 *
 * Safety measures:
 * - Uses `buildDeleteCommand` — auto-injects `--yes`/`--force`/`--dry-run`
 * - Non-interactive guard: refuses in non-TTY without `--yes`/`--force`
 * - Package manager installs are redirected to the PM's own uninstall
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import type { SentryContext } from "../../context.js";
import { getSkillInstallPath } from "../../lib/agent-skills.js";
import { getCompletionPath } from "../../lib/completions.js";
import { closeDatabase, getConfigDir } from "../../lib/db/index.js";
import { getInstallInfo } from "../../lib/db/install-info.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
} from "../../lib/mutate-command.js";
import { getConfigCandidates, type ShellType } from "../../lib/shell.js";

const log = logger.withTag("cli.uninstall");

/** Sentry marker comment used in shell config files by setup. */
const SENTRY_MARKER = "# sentry";

/** Regex to strip `.exe` suffix from binary names (Windows). */
const EXE_SUFFIX_RE = /\.exe$/;

/**
 * Uninstall hints for package manager installs — advise users to use
 * their PM's own uninstall instead.
 */
const PM_UNINSTALL_HINTS: Record<string, string> = {
  npm: "npm uninstall -g sentry",
  pnpm: "pnpm remove -g sentry",
  bun: "bun remove -g sentry",
  yarn: "yarn global remove sentry",
  brew: "brew uninstall getsentry/tools/sentry",
};

/**
 * Detect if the CLI is running via a package manager even without stored
 * install info. Checks `process.argv[1]` for node_modules indicators.
 */
function detectRuntimePackageManager(): string | null {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return null;
  }
  // npm/pnpm/bun/yarn installs run via node_modules
  if (scriptPath.includes("node_modules")) {
    if (scriptPath.includes(".pnpm")) {
      return "pnpm";
    }
    if (scriptPath.includes(".bun")) {
      return "bun";
    }
    if (scriptPath.includes(".yarn") || scriptPath.includes("yarn/global")) {
      return "yarn";
    }
    return "npm";
  }
  return null;
}

/** An artifact that can be removed during uninstall. */
type UninstallArtifact = {
  /** Human-readable label */
  label: string;
  /** Filesystem path (or description for non-file artifacts) */
  path: string;
  /** Whether the artifact currently exists */
  exists: boolean;
  /** The removal function */
  remove: () => Promise<void>;
};

/**
 * Result of the uninstall operation.
 */
type UninstallResult = {
  /** Artifacts that were removed */
  removed: string[];
  /** Artifacts that were skipped (didn't exist) */
  skipped: string[];
  /** Artifacts that failed to remove */
  failed: { label: string; error: string }[];
  /** Whether this was a dry run */
  dryRun: boolean;
};

/**
 * Remove sentry-related lines from a shell config file.
 *
 * Identifies blocks added by `addToShellConfig()` in `src/lib/shell.ts`:
 * a `# sentry` comment followed by the next non-empty line. Removes both
 * the comment and the command line.
 *
 * @internal Exported for testing
 */
export async function removeSentryLinesFromConfig(
  configFile: string
): Promise<boolean> {
  try {
    const content = await readFile(configFile, "utf-8");
    const lines = content.split("\n");

    // Check for an exact `# sentry` line — not just a substring match —
    // to avoid false positives from e.g. `# sentry-wizard`
    if (!lines.some((line) => line.trim() === SENTRY_MARKER)) {
      return false;
    }

    const filtered: string[] = [];
    let i = 0;

    while (i < lines.length) {
      if (lines[i]?.trim() === SENTRY_MARKER) {
        // Skip the marker and exactly one command line (matching what
        // addToShellConfig writes: "# sentry\n<command>\n")
        i += 1;
        if (i < lines.length && lines[i]?.trim() !== "") {
          i += 1;
        }
        // Consume one trailing blank line if present
        if (i < lines.length && lines[i]?.trim() === "") {
          i += 1;
        }
        continue;
      }
      filtered.push(lines[i] ?? "");
      i += 1;
    }

    // Clean up extra trailing newlines
    let result = filtered.join("\n");
    while (result.endsWith("\n\n")) {
      result = result.slice(0, -1);
    }

    await writeFile(configFile, result, "utf-8");
    return true;
  } catch (error) {
    log.debug("Failed to clean shell config", error);
    return false;
  }
}

/**
 * Check whether a single config file contains sentry marker lines.
 */
function configFileHasSentryMarker(candidate: string): boolean {
  try {
    const content = readFileSync(candidate, "utf-8");
    // Check for an exact `# sentry` line (not just substring match)
    // to avoid false positives from e.g. `# sentry-wizard`
    return content.split("\n").some((line) => line.trim() === SENTRY_MARKER);
  } catch (error) {
    log.debug(`Skipping unreadable config file: ${candidate}`, error);
    return false;
  }
}

/**
 * Find all shell config files that contain sentry entries.
 */
function findSentryConfigFiles(home: string): string[] {
  const shellTypes: ShellType[] = ["bash", "zsh", "fish", "sh"];
  const seen = new Set<string>();
  const results: string[] = [];

  for (const shellType of shellTypes) {
    const candidates = getConfigCandidates(shellType, home);
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (existsSync(candidate) && configFileHasSentryMarker(candidate)) {
        results.push(candidate);
      }
    }
  }

  return results;
}

/**
 * Gather all artifacts to remove.
 */
function gatherArtifacts(home: string): UninstallArtifact[] {
  const artifacts: UninstallArtifact[] = [];
  const xdgDataHome = process.env.XDG_DATA_HOME;

  // 1. Shell completions
  const completionShells: ShellType[] = ["bash", "zsh", "fish"];
  for (const shell of completionShells) {
    const path = getCompletionPath(shell, home, xdgDataHome);
    if (path) {
      artifacts.push({
        label: `${shell} completion`,
        path,
        exists: existsSync(path),
        remove: async () => {
          await unlink(path);
        },
      });
    }
  }

  // 2. Agent skill files
  const agentRoots = [".claude", ".agents"] as const;
  for (const root of agentRoots) {
    const skillPath = getSkillInstallPath(home, root);
    // Go up from SKILL.md -> sentry-cli/ directory
    const skillDir = dirname(skillPath);
    if (existsSync(skillDir)) {
      artifacts.push({
        label: `${root} agent skills`,
        path: skillDir,
        exists: true,
        remove: async () => {
          await rm(skillDir, { recursive: true, force: true });
        },
      });
    }
  }

  // 3. Shell config entries (PATH, fpath)
  const sentryConfigs = findSentryConfigFiles(home);
  for (const configFile of sentryConfigs) {
    artifacts.push({
      label: `sentry entries in ${configFile}`,
      path: configFile,
      exists: true,
      remove: async () => {
        const removed = await removeSentryLinesFromConfig(configFile);
        if (!removed) {
          throw new Error(`Failed to remove sentry entries from ${configFile}`);
        }
      },
    });
  }

  // 4. Binary (self-delete — must come before config dir)
  const installInfo = getInstallInfo();
  const binaryPath = installInfo?.path || process.execPath;
  // Only self-delete for direct/curl installs (SEA binaries).
  // For npm installs, the PM manages the binary.
  const isSelfManaged =
    !(installInfo?.method || detectRuntimePackageManager()) ||
    installInfo?.method === "curl" ||
    installInfo?.method === "unknown";

  // Safety: verify the binary path looks like a sentry binary to avoid
  // accidentally deleting node, tsx, or other interpreters when install
  // info is missing and process.execPath is the runtime itself.
  const binaryName = basename(binaryPath)
    .toLowerCase()
    .replace(EXE_SUFFIX_RE, "");
  const looksLikeSentry = binaryName.startsWith("sentry");

  if (isSelfManaged && looksLikeSentry && existsSync(binaryPath)) {
    // Windows holds a mandatory lock on running executables — skip
    // self-deletion and tell the user to remove it manually.
    if (process.platform === "win32") {
      artifacts.push({
        label: "sentry binary (manual removal needed on Windows)",
        path: binaryPath,
        exists: true,
        remove: () =>
          Promise.reject(
            new Error(
              `Cannot delete running binary on Windows. Please delete manually: ${binaryPath}`
            )
          ),
      });
    } else {
      artifacts.push({
        label: "sentry binary",
        path: binaryPath,
        exists: true,
        remove: async () => {
          await unlink(binaryPath);
          // Clean up empty parent directory if it's sentry-specific
          const parentDir = dirname(binaryPath);
          const normalizedParent = parentDir.replace(/\\/g, "/");
          if (
            normalizedParent.endsWith(".sentry/bin") ||
            normalizedParent.endsWith("sentry/bin")
          ) {
            try {
              const remaining = readdirSync(parentDir);
              if (remaining.length === 0) {
                await rm(parentDir, { recursive: true, force: true });
              }
            } catch (error) {
              log.debug("Failed to clean up empty parent directory", error);
            }
          }
        },
      });
    }
  }

  // 5. Config directory (~/.sentry/)
  const configDir = getConfigDir();
  artifacts.push({
    label: "config directory",
    path: configDir,
    exists: existsSync(configDir),
    remove: async () => {
      closeDatabase();
      await rm(configDir, { recursive: true, force: true });
    },
  });

  return artifacts;
}

/**
 * Format an artifact list as `"label (path)"` strings.
 */
function formatArtifactList(artifacts: UninstallArtifact[]): string[] {
  return artifacts.map((a) => `${a.label} (${a.path})`);
}

/**
 * Execute removal of all artifacts, collecting results.
 */
async function executeRemovals(
  existing: UninstallArtifact[],
  missing: UninstallArtifact[]
): Promise<UninstallResult> {
  const result: UninstallResult = {
    removed: [],
    skipped: formatArtifactList(missing),
    failed: [],
    dryRun: false,
  };

  for (const artifact of existing) {
    try {
      await artifact.remove();
      result.removed.push(`${artifact.label} (${artifact.path})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.debug(`Failed to remove ${artifact.label}`, error);
      result.failed.push({ label: artifact.label, error: msg });
    }
  }

  return result;
}

/**
 * Format the uninstall result for human output.
 */
function formatUninstallHuman(result: UninstallResult): string {
  const lines: string[] = [];

  if (result.dryRun) {
    lines.push("**Dry run** — no changes made.\n");
  }

  if (result.removed.length > 0) {
    const verb = result.dryRun ? "Would remove" : "Removed";
    lines.push(`${verb}:`);
    for (const item of result.removed) {
      lines.push(`  - ${item}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push("\nSkipped (not found):");
    for (const item of result.skipped) {
      lines.push(`  - ${item}`);
    }
  }

  if (result.failed.length > 0) {
    lines.push("\nFailed:");
    for (const { label, error } of result.failed) {
      lines.push(`  - ${label}: ${error}`);
    }
  }

  if (
    !result.dryRun &&
    result.removed.length > 0 &&
    result.failed.length === 0
  ) {
    lines.push(
      "\nSentry CLI has been uninstalled. Restart your shell to apply PATH changes."
    );
  }

  return lines.join("\n");
}

export const uninstallCommand = buildDeleteCommand({
  docs: {
    brief: "Uninstall Sentry CLI",
    fullDescription:
      "Remove the Sentry CLI binary, shell completions, PATH entries, " +
      "agent skill files, and configuration directory. Reverses the " +
      "changes made by `sentry cli setup`.",
  },
  output: {
    human: formatUninstallHuman,
  },
  parameters: {
    flags: {
      "keep-config": {
        kind: "boolean",
        brief: "Keep the config directory (~/.sentry) and auth tokens",
        default: false,
        optional: true,
      },
    },
  },
  auth: false,
  async *func(
    this: SentryContext,
    flags: {
      readonly yes?: boolean;
      readonly force?: boolean;
      readonly "dry-run"?: boolean;
      readonly "keep-config"?: boolean;
    }
  ) {
    const home = homedir();

    // Check if installed via a package manager
    const installInfo = getInstallInfo();
    const pmMethod =
      installInfo?.method && installInfo.method in PM_UNINSTALL_HINTS
        ? installInfo.method
        : detectRuntimePackageManager();

    if (pmMethod) {
      const hint = PM_UNINSTALL_HINTS[pmMethod] ?? "";
      const result: UninstallResult = {
        removed: [],
        skipped: [],
        failed: [
          {
            label: "package manager install detected",
            error: `Installed via ${pmMethod}. Run: ${hint}`,
          },
        ],
        dryRun: false,
      };
      yield new CommandOutput(result);
      return {
        hint: `This CLI was installed via ${pmMethod}. Run \`${hint}\` to uninstall.`,
      };
    }

    // Gather artifacts
    let artifacts = gatherArtifacts(home);

    // Filter out config dir if --keep-config
    if (flags["keep-config"]) {
      artifacts = artifacts.filter((a) => a.label !== "config directory");
    }

    const existing = artifacts.filter((a) => a.exists);
    const missing = artifacts.filter((a) => !a.exists);

    // Dry run: show what would be removed
    if (flags["dry-run"]) {
      const result: UninstallResult = {
        removed: formatArtifactList(existing),
        skipped: formatArtifactList(missing),
        failed: [],
        dryRun: true,
      };
      yield new CommandOutput(result);
      return;
    }

    if (existing.length === 0) {
      const result: UninstallResult = {
        removed: [],
        skipped: formatArtifactList(missing),
        failed: [],
        dryRun: false,
      };
      yield new CommandOutput(result);
      return {
        hint: "Nothing to uninstall — no Sentry CLI artifacts found.",
      };
    }

    // Confirm unless --yes/--force
    if (!isConfirmationBypassed(flags)) {
      log.warn(
        `This will remove ${existing.length} item(s):\n${existing.map((a) => `  - ${a.label} (${a.path})`).join("\n")}`
      );

      const confirmed = await confirmByTyping(
        "uninstall",
        "Type 'uninstall' to confirm removal:"
      );
      if (!confirmed) {
        return { hint: "Uninstall cancelled." };
      }
    }

    const result = await executeRemovals(existing, missing);
    yield new CommandOutput(result);

    if (result.failed.length > 0) {
      // Signal partial failure to the caller/CI
      process.exitCode = 1;
      return {
        hint: `${result.removed.length} removed, ${result.failed.length} failed. Check permissions.`,
      };
    }
  },
});
