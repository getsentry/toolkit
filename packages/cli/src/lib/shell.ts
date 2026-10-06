/**
 * Shell detection and configuration utilities.
 *
 * Provides functions for detecting the current shell, finding config files,
 * and modifying PATH in shell configuration.
 */

import { existsSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { samePath } from "./binary.js";
import { logger } from "./logger.js";
import { whichSync } from "./which.js";

const log = logger.withTag("shell");

/** Supported shell types */
export type ShellType = "bash" | "zsh" | "fish" | "sh" | "ash" | "unknown";

/** Result of shell detection */
export type ShellInfo = {
  /** Detected shell type */
  type: ShellType;
  /** Display name for the shell (e.g. "xonsh", "bash"). Derived from $SHELL basename. */
  name: string;
  /** Path to shell config file, if found */
  configFile: string | null;
  /** All candidate config files for this shell */
  configCandidates: string[];
};

/** Result of PATH modification */
export type PathModificationResult = {
  /** Whether modification was performed */
  modified: boolean;
  /** The config file that was modified, if any */
  configFile: string | null;
  /** Message describing what happened */
  message: string;
  /** Command to add manually if auto-modification failed */
  manualCommand: string | null;
};

/**
 * Detect the current shell from SHELL environment variable.
 */
export function detectShellType(shellPath: string | undefined): ShellType {
  if (!shellPath) {
    return "unknown";
  }

  const shellName = basename(shellPath).toLowerCase();

  switch (shellName) {
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "fish":
      return "fish";
    case "sh":
      return "sh";
    case "ash":
      return "ash";
    default:
      return "unknown";
  }
}

/**
 * Get candidate config files for a shell type.
 *
 * @param shellType - The shell type
 * @param homeDir - User's home directory
 * @param xdgConfigHome - XDG_CONFIG_HOME or default
 */
export function getConfigCandidates(
  shellType: ShellType,
  homeDir: string,
  xdgConfigHome?: string
): string[] {
  const xdg = xdgConfigHome || join(homeDir, ".config");

  switch (shellType) {
    case "fish":
      return [join(xdg, "fish", "config.fish")];

    case "zsh":
      return [
        join(homeDir, ".zshrc"),
        join(homeDir, ".zshenv"),
        join(xdg, "zsh", ".zshrc"),
        join(xdg, "zsh", ".zshenv"),
      ];

    case "bash":
      return [
        join(homeDir, ".bashrc"),
        join(homeDir, ".bash_profile"),
        join(homeDir, ".profile"),
        join(xdg, "bash", ".bashrc"),
        join(xdg, "bash", ".bash_profile"),
      ];

    case "sh":
    case "ash":
      return [join(homeDir, ".profile")];

    default:
      // Fall back to common files for unknown shells
      return [
        join(homeDir, ".bashrc"),
        join(homeDir, ".bash_profile"),
        join(homeDir, ".profile"),
      ];
  }
}

/**
 * Find the first existing config file from candidates.
 */
export function findExistingConfigFile(candidates: string[]): string | null {
  for (const file of candidates) {
    if (existsSync(file)) {
      return file;
    }
  }
  return null;
}

/**
 * Detect shell and find config file.
 */
export function detectShell(
  shellPath: string | undefined,
  homeDir: string,
  xdgConfigHome?: string
): ShellInfo {
  const type = detectShellType(shellPath);
  const name = shellPath ? basename(shellPath) : type;
  const configCandidates = getConfigCandidates(type, homeDir, xdgConfigHome);
  const configFile = findExistingConfigFile(configCandidates);

  return {
    type,
    name,
    configFile,
    configCandidates,
  };
}

/**
 * Generate the PATH export command for a shell.
 */
export function getPathCommand(
  shellType: ShellType,
  directory: string
): string {
  if (shellType === "fish") {
    return `fish_add_path "${directory}"`;
  }
  return `export PATH="${directory}:$PATH"`;
}

/**
 * Check if a directory is in PATH.
 */
export function isInPath(
  directory: string,
  pathEnv: string | undefined
): boolean {
  if (!pathEnv) {
    return false;
  }
  // samePath handles case-insensitive filesystems (Windows, macOS), where a
  // PATH entry can differ in casing from a computed directory yet be the same.
  return pathEnv.split(delimiter).some((p) => samePath(p, directory));
}

/**
 * Append a shell config line to a config file with idempotency.
 *
 * Shared implementation for `addToPath` and `addToFpath`. Handles file
 * creation, duplicate detection, newline-aware appending, and error fallback.
 *
 * @param configFile - Path to the shell config file
 * @param directory - Directory being configured (used for duplicate check)
 * @param command - The full shell command to append (e.g. `export PATH="..."`)
 * @param label - Human-readable label for messages (e.g. "PATH", "fpath")
 */
async function addToShellConfig(
  configFile: string,
  directory: string,
  command: string,
  label: string
): Promise<PathModificationResult> {
  const exists = await access(configFile).then(
    () => true,
    () => false
  );

  if (!exists) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      await writeFile(configFile, `# sentry\n${command}\n`, "utf-8");
      return {
        modified: true,
        configFile,
        message: `Created ${configFile} with ${label} configuration`,
        manualCommand: null,
      };
    } catch {
      return {
        modified: false,
        configFile: null,
        message: `Could not create ${configFile}`,
        manualCommand: command,
      };
    }
  }

  const content = await readFile(configFile, "utf-8");

  if (content.includes(command) || content.includes(`"${directory}"`)) {
    return {
      modified: false,
      configFile,
      message: `${label} already configured in ${configFile}`,
      manualCommand: null,
    };
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const newContent = content.endsWith("\n")
      ? `${content}\n# sentry\n${command}\n`
      : `${content}\n\n# sentry\n${command}\n`;

    await writeFile(configFile, newContent, "utf-8");
    return {
      modified: true,
      configFile,
      message: `Added sentry ${label} in ${configFile}`,
      manualCommand: null,
    };
  } catch {
    return {
      modified: false,
      configFile: null,
      message: `Could not write to ${configFile}`,
      manualCommand: command,
    };
  }
}

export function addToPath(
  configFile: string,
  directory: string,
  shellType: ShellType
): Promise<PathModificationResult> {
  return addToShellConfig(
    configFile,
    directory,
    getPathCommand(shellType, directory),
    "PATH"
  );
}

/**
 * Generate the fpath command for zsh completion directory.
 */
export function getFpathCommand(directory: string): string {
  return `fpath=("${directory}" $fpath)`;
}

/**
 * Add a directory to zsh's fpath in a shell config file.
 *
 * @param configFile - Path to the zsh config file (e.g. ~/.zshrc)
 * @param directory - Directory to add to fpath
 */
export function addToFpath(
  configFile: string,
  directory: string
): Promise<PathModificationResult> {
  return addToShellConfig(
    configFile,
    directory,
    getFpathCommand(directory),
    "fpath"
  );
}

/**
 * Add to GitHub Actions PATH if running in CI.
 */
export async function addToGitHubPath(
  directory: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  if (env.GITHUB_ACTIONS !== "true" || !env.GITHUB_PATH) {
    return false;
  }

  try {
    let content = "";
    try {
      content = await readFile(env.GITHUB_PATH, "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.debug(`Failed to read GITHUB_PATH (${code}):`, error);
        return false;
      }
      // File doesn't exist yet — start with empty content
    }

    if (!content.includes(directory)) {
      const newContent = content.endsWith("\n")
        ? `${content}${directory}\n`
        : `${content}\n${directory}\n`;
      await writeFile(env.GITHUB_PATH, newContent, "utf-8");
    }
    return true;
  } catch (error) {
    log.debug("Failed to update GITHUB_PATH:", error);
    return false;
  }
}

/**
 * Check if bash is available on the system.
 *
 * Uses `Bun.which` to search PATH for a bash executable.
 * Useful as a fallback for unsupported shells — many custom shells
 * (xonsh, nushell, etc.) support bash completions.
 *
 * @param pathEnv - Override PATH for testing. Defaults to the process PATH.
 */
export function isBashAvailable(pathEnv?: string): boolean {
  const opts = pathEnv !== undefined ? { PATH: pathEnv } : undefined;
  return whichSync("bash", opts) !== null;
}
