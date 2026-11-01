/**
 * Shell completion script generation.
 *
 * Dynamically generates completion scripts from the Stricli route map.
 * When commands are added or removed, completions update automatically.
 *
 * Uses a hybrid approach:
 * - **Static**: command and subcommand names are embedded in the shell
 *   script, so the first two words complete without starting the CLI.
 * - **Dynamic**: everything after them (flag names, flag values,
 *   positionals, nested subcommands) comes from `sentry __complete`
 *   (`complete.ts`), so every shell completes every command depth the
 *   same way.
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRouteMap } from "./introspect.js";
import { getRoutes } from "./route-registry.js";
import type { ShellType } from "./shell.js";

/** Where completions are installed */
export type CompletionLocation = {
  /** Path where the completion file was installed */
  path: string;
  /** Whether the file was created or already existed */
  created: boolean;
};

/** A command or route group with its description */
type CommandEntry = {
  name: string;
  brief: string;
};

/** A command group (route map) containing subcommands */
type CommandGroup = CommandEntry & {
  subcommands: CommandEntry[];
};

/** Extracted command tree from the Stricli route map */
export type CommandTree = {
  /** Command groups with subcommands (auth, issue, org, etc.) */
  groups: CommandGroup[];
  /** Standalone top-level commands (api, help, version, etc.) */
  standalone: CommandEntry[];
};

/**
 * Extract the first two levels of the Stricli route map: top-level
 * commands and groups, and the visible subcommands of each group.
 */
export function extractCommandTree(): CommandTree {
  const groups: CommandGroup[] = [];
  const standalone: CommandEntry[] = [];

  for (const entry of getRoutes().getAllEntries()) {
    if (entry.hidden) {
      continue;
    }

    const name = entry.name.original;

    if (isRouteMap(entry.target)) {
      groups.push({
        name,
        brief: entry.target.brief,
        subcommands: entry.target
          .getAllEntries()
          .filter((sub) => !sub.hidden)
          .map((sub) => ({ name: sub.name.original, brief: sub.target.brief })),
      });
    } else {
      standalone.push({ name, brief: entry.target.brief });
    }
  }

  return { groups, standalone };
}

/**
 * Sanitize a string for use in a shell variable name.
 *
 * Uses an allowlist approach — replaces any character that is not a valid
 * shell identifier character (`[a-zA-Z0-9_]`) with an underscore.
 * Input comes from Stricli route names (alphanumeric + hyphen), but the
 * allowlist guards against unexpected characters.
 */
function shellVarName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Generate bash completion script.
 *
 * Completes the command and a group's subcommand from static word lists,
 * and every later word with `sentry __complete`. Suggestions are escaped
 * for the shell, and a single suggestion ending in `/` (a directory,
 * `org/`) takes no trailing space so the next TAB continues it.
 */
export function generateBashCompletion(binaryName: string): string {
  const { groups, standalone } = extractCommandTree();

  const allTopLevel = [
    ...groups.map((g) => g.name),
    ...standalone.map((s) => s.name),
  ];

  const subVars = groups
    .map((g) => {
      const subs = g.subcommands.map((s) => s.name).join(" ");
      return `  local ${shellVarName(g.name)}_commands="${subs}"`;
    })
    .join("\n");

  return `# bash completion for ${binaryName}
# Auto-generated from command definitions

# Sanitize a string for use as a bash variable name suffix.
# Mirrors shellVarName() in completions.ts — replaces non-identifier chars.
__${binaryName}_varname() { echo "\${1//[^a-zA-Z0-9_]/_}"; }

# Set variable $1 to word $2 without the backslash escapes readline keeps
# in it (\`docs\\ dir/\` → \`docs dir/\`).
__${binaryName}_dequote() {
  local rest="$2" out=""
  while [[ "\${rest}" == *'\\'* ]]; do
    out+="\${rest%%'\\'*}"
    rest="\${rest#*'\\'}"
    out+="\${rest:0:1}"
    rest="\${rest:1}"
  done
  printf -v "$1" '%s' "\${out}\${rest}"
}

_${binaryName}_completions() {
  local cur prev words cword
  _init_completion || return

  local commands="${allTopLevel.join(" ")}"
${subVars}

  if [[ \${cword} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
    return
  fi
  local group_var="$(__${binaryName}_varname "\${words[1]}")_commands"
  if [[ \${cword} -eq 2 && "\${cur}" != -* && -n "\${!group_var+x}" ]]; then
    COMPREPLY=($(compgen -W "\${!group_var}" -- "\${cur}"))
    return
  fi

  # Flags, flag values, positionals, and nested subcommands come from the
  # binary, one \`value<TAB>description\` per line.
  local word partial line
  local -a args=()
  for word in "\${words[@]:1:cword-1}"; do
    __${binaryName}_dequote word "\${word}"
    args+=("\${word}")
  done
  __${binaryName}_dequote partial "\${cur}"
  COMPREPLY=()
  while IFS= read -r line; do
    line="\${line%%$'\\t'*}"
    # Escape spaces and shell characters, keeping a leading ~/ expandable
    if [[ "\${line}" == "~/"?* ]]; then
      printf -v line '~/%q' "\${line:2}"
    else
      printf -v line '%q' "\${line}"
    fi
    COMPREPLY+=("\${line}")
  done < <(${binaryName} __complete "\${args[@]}" "\${partial}" 2>/dev/null)
  if [[ \${#COMPREPLY[@]} -eq 1 && "\${COMPREPLY[0]}" == */ ]]; then
    compopt -o nospace
  fi
}

complete -F _${binaryName}_completions ${binaryName}
`;
}

/**
 * Generate zsh completion script.
 *
 * Completes the command and a group's subcommand from static arrays, and
 * every later word with `sentry __complete`, showing its descriptions.
 * Suggestions ending in `/` (directories, `org/`) take no trailing space.
 */
export function generateZshCompletion(binaryName: string): string {
  const { groups, standalone } = extractCommandTree();

  // Build top-level commands array
  const topLevelItems = [
    ...groups.map((g) => `    '${g.name}:${escapeSingleQuote(g.brief)}'`),
    ...standalone.map((s) => `    '${s.name}:${escapeSingleQuote(s.brief)}'`),
  ].join("\n");

  // Build subcommand arrays
  const subArrays = groups
    .map((g) => {
      const items = g.subcommands
        .map((s) => `    '${s.name}:${escapeSingleQuote(s.brief)}'`)
        .join("\n");
      return `  local -a ${shellVarName(g.name)}_commands\n  ${shellVarName(g.name)}_commands=(\n${items}\n  )`;
    })
    .join("\n\n");

  return `#compdef ${binaryName}
# zsh completion for ${binaryName}
# Auto-generated from command definitions

_${binaryName}() {
  local -a commands
  commands=(
${topLevelItems}
  )

${subArrays}

  if (( CURRENT == 2 )); then
    _describe -t commands 'command' commands
    return
  fi
  local group="\${words[2]//[^a-zA-Z0-9_]/_}_commands"
  if (( CURRENT == 3 )) && [[ $PREFIX != -* ]] && (( \${+parameters[$group]} )); then
    _describe -t commands "$words[2] command" "$group"
    return
  fi

  # Flags, flag values, positionals, and nested subcommands come from the
  # binary, one \`value<TAB>description\` per line. Unquote the words, since
  # zsh keeps them as typed (\`docs\\ dir/\`).
  local -a values slashed
  local value desc ret=1
  while IFS=$'\\t' read -r value desc; do
    value="\${value//:/\\\\:}"
    if [[ $value == */ ]]; then
      slashed+=("\${value}\${desc:+:$desc}")
    else
      values+=("\${value}\${desc:+:$desc}")
    fi
  done < <(${binaryName} __complete "\${(@Q)words[2,CURRENT-1]}" "\${(Q)PREFIX}" 2>/dev/null)
  (( \${#values} )) && _describe -t values 'value' values && ret=0
  (( \${#slashed} )) && _describe -t values 'value' slashed -S '' && ret=0
  return ret
}

_${binaryName}
`;
}

/**
 * Generate fish completion script.
 *
 * Completes the command and a group's subcommand from static completions,
 * and every later token with `sentry __complete`, whose tab-separated
 * descriptions fish shows as they are.
 */
export function generateFishCompletion(binaryName: string): string {
  const { groups, standalone } = extractCommandTree();
  const groupNames = groups.map((g) => g.name).join(" ");

  // Top-level command completions
  const topLevelLines = [...groups, ...standalone]
    .map(
      (c) =>
        `complete -c ${binaryName} -n "__fish_use_subcommand" -a "${c.name}" -d "${escapeDblQuote(c.brief)}"`,
    )
    .join("\n");

  // Subcommand completions
  const subLines = groups
    .map((g) => {
      const cmdLines = g.subcommands
        .map(
          (s) =>
            `complete -c ${binaryName} -n "__${binaryName}_group ${g.name}" -a "${s.name}" -d "${escapeDblQuote(s.brief)}"`,
        )
        .join("\n");
      return `\n# ${g.name} subcommands\n${cmdLines}`;
    })
    .join("\n");

  return `# fish completion for ${binaryName}
# Auto-generated from command definitions

# Disable file completion by default; \`__complete\` lists paths for the
# arguments that take them
complete -c ${binaryName} -f

# Succeed when the token being completed is the subcommand of one of the
# groups given as arguments
function __${binaryName}_group
  set -l tokens (commandline -opc)
  test (count $tokens) -eq 2
  and not string match -q -- '-*' (commandline -ct)
  and contains -- $tokens[2] $argv
end

# Flags, flag values, positionals, and nested subcommands
function __${binaryName}_complete_dynamic
  # commandline -opc: the tokens before the cursor, unescaped
  # commandline -ct: the token being completed, as typed
  set -l preceding (commandline -opc)
  # Quote $current so an empty partial (TAB after space) is passed as ""
  # instead of being silently dropped by fish's empty-list expansion.
  set -l current (commandline -ct | string unescape)
  ${binaryName} __complete $preceding[2..] "$current" 2>/dev/null
end

# Top-level commands
${topLevelLines}
${subLines}

complete -c ${binaryName} -n "not __fish_use_subcommand; and not __${binaryName}_group ${groupNames}" -a "(__${binaryName}_complete_dynamic)"
`;
}

/** Escape single quotes for zsh completion descriptions. */
function escapeSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Escape the characters special in fish double-quoted strings (`\`, `$`,
 * `"`). Fish keeps any other backslash, so parentheses stay as they are.
 */
function escapeDblQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/"/g, '\\"');
}

/**
 * Get the completion script for a shell type.
 */
export function getCompletionScript(
  shellType: ShellType,
  binaryName = "sentry",
): string | null {
  switch (shellType) {
    case "bash":
      return generateBashCompletion(binaryName);
    case "zsh":
      return generateZshCompletion(binaryName);
    case "fish":
      return generateFishCompletion(binaryName);
    default:
      return null;
  }
}

/**
 * Get the default completion file path for a shell type.
 *
 * @param shellType - The shell type
 * @param homeDir - User's home directory
 * @param xdgDataHome - XDG_DATA_HOME or undefined for default
 */
export function getCompletionPath(
  shellType: ShellType,
  homeDir: string,
  xdgDataHome?: string,
): string | null {
  const dataHome = xdgDataHome || join(homeDir, ".local", "share");

  switch (shellType) {
    case "bash":
      // bash-completion user directory
      return join(dataHome, "bash-completion", "completions", "sentry");

    case "zsh":
      // Site-functions in user's local share
      return join(dataHome, "zsh", "site-functions", "_sentry");

    case "fish":
      // Fish completions directory
      return join(homeDir, ".config", "fish", "completions", "sentry.fish");

    default:
      return null;
  }
}

/**
 * Install completion script for a shell type.
 *
 * Returns `null` when the shell is unsupported or when the target directory
 * cannot be created due to filesystem permission restrictions (EPERM/EACCES).
 * This is common on macOS where `~/.local/share/zsh` may be owned by root
 * or protected by SIP, and during Homebrew post-install when the home
 * directory has restrictive permissions.
 *
 * @param shellType - The shell type
 * @param homeDir - User's home directory
 * @param xdgDataHome - XDG_DATA_HOME or undefined for default
 * @returns Location info if installed, null if shell not supported or path not writable
 */
export async function installCompletions(
  shellType: ShellType,
  homeDir: string,
  xdgDataHome?: string,
): Promise<CompletionLocation | null> {
  const script = getCompletionScript(shellType);
  if (!script) {
    return null;
  }

  const path = getCompletionPath(shellType, homeDir, xdgDataHome);
  if (!path) {
    return null;
  }

  try {
    // Create directory if needed
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    const alreadyExists = existsSync(path);
    await writeFile(path, script, "utf-8");

    return {
      path,
      created: !alreadyExists,
    };
  } catch (error: unknown) {
    // Permission errors are expected when the target directory is owned by
    // root, protected by macOS SIP, or when running in a restricted context
    // (e.g. Homebrew post-install). Silently skip — the caller (bestEffort
    // in setup.ts) would catch anyway, but handling here avoids noisy Sentry
    // reports for a non-critical operation.
    if (isPermissionError(error)) {
      return null;
    }
    throw error;
  }
}

/** Filesystem error codes that indicate a permission problem */
const PERMISSION_ERROR_CODES = new Set(["EPERM", "EACCES", "EROFS"]);

/**
 * Check whether an error is a filesystem permission error.
 *
 * Matches EPERM (operation not permitted), EACCES (permission denied),
 * and EROFS (read-only filesystem).
 */
function isPermissionError(error: unknown): boolean {
  if (!(error instanceof Error && "code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && PERMISSION_ERROR_CODES.has(code);
}
