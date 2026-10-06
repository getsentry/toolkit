/**
 * Shell completion script generation.
 *
 * Dynamically generates completion scripts from the Stricli route map.
 * When commands are added or removed, completions update automatically.
 *
 * Uses a hybrid approach:
 * - **Static**: command/subcommand names, flag names, enum flag values
 *   are embedded in the shell script for instant tab completion.
 * - **Dynamic**: positional arg values (org slugs, project names, aliases)
 *   are completed by calling `sentry __complete` at runtime, which reads
 *   the SQLite cache with fuzzy matching.
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { routes } from "../app.js";
import { type FlagDef, isCommand, isRouteMap } from "./introspect.js";
import type { ShellType } from "./shell.js";

/** Where completions are installed */
export type CompletionLocation = {
  /** Path where the completion file was installed */
  path: string;
  /** Whether the file was created or already existed */
  created: boolean;
};

/** Flag metadata for shell completion */
type FlagEntry = {
  /** Flag name without `--` prefix (e.g., "limit") */
  name: string;
  /** Human-readable description */
  brief: string;
  /** For enum flags, the valid values */
  enumValues?: string[];
};

/** A command with its description and flags */
type CommandEntry = {
  name: string;
  brief: string;
  flags: FlagEntry[];
};

/** A command group (route map) containing subcommands */
type CommandGroup = {
  name: string;
  brief: string;
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
 * Extract flags from a Stricli command's parameters.
 *
 * Filters out hidden flags (like --log-level, --verbose) and returns
 * metadata needed for completion.
 */
function extractFlagEntries(
  flags: Record<string, FlagDef> | undefined
): FlagEntry[] {
  if (!flags) {
    return [];
  }

  const entries: FlagEntry[] = [];
  for (const [name, def] of Object.entries(flags)) {
    if (def.hidden) {
      continue;
    }
    const entry: FlagEntry = { name, brief: def.brief ?? "" };
    if (def.kind === "enum" && "values" in def) {
      const enumDef = def as FlagDef & { values?: readonly string[] };
      if (enumDef.values) {
        entry.enumValues = [...enumDef.values];
      }
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Build a CommandEntry from a route target with its name.
 * Extracts flags if the target is a command.
 */
function buildCommandEntry(name: string, target: unknown): CommandEntry {
  const flags = isCommand(target)
    ? extractFlagEntries(target.parameters.flags)
    : [];
  return {
    name,
    brief: (target as { brief: string }).brief,
    flags,
  };
}

/**
 * Extract subcommands from a route map group.
 */
function extractSubcommands(routeMap: {
  getAllEntries: () => readonly {
    name: { original: string };
    target: unknown;
    hidden: boolean;
  }[];
}): CommandEntry[] {
  const subcommands: CommandEntry[] = [];
  for (const sub of routeMap.getAllEntries()) {
    if (!sub.hidden) {
      subcommands.push(buildCommandEntry(sub.name.original, sub.target));
    }
  }
  return subcommands;
}

/**
 * Extract the command tree from the Stricli route map.
 *
 * Walks the route map recursively to build a structured command tree
 * that can be used to generate completion scripts for any shell.
 * Includes flag metadata for each command.
 */
export function extractCommandTree(): CommandTree {
  const groups: CommandGroup[] = [];
  const standalone: CommandEntry[] = [];

  for (const entry of routes.getAllEntries()) {
    if (entry.hidden) {
      continue;
    }

    const name = entry.name.original;

    if (isRouteMap(entry.target)) {
      groups.push({
        name,
        brief: entry.target.brief,
        subcommands: extractSubcommands(entry.target),
      });
    } else {
      standalone.push(buildCommandEntry(name, entry.target));
    }
  }

  return { groups, standalone };
}

/**
 * Sanitize a string for use in a shell variable name.
 *
 * Uses an allowlist approach — replaces any character that is not a valid
 * shell identifier character (`[a-zA-Z0-9_]`) with an underscore.
 * Input comes from Stricli route/flag names (alphanumeric + hyphen),
 * but the whitelist guards against unexpected characters.
 */
function shellVarName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Collected flag and enum variable declarations for bash scripts. */
type BashFlagVars = {
  flagVarLines: string[];
  enumVarLines: string[];
  enumFlagNames: string[];
};

/**
 * Collect bash variable lines for a single command's flags and enum values.
 *
 * @param prefix - Variable name prefix (e.g., "issue_list" or "api")
 * @param cmd - The command entry to process
 * @param out - Accumulator for flag/enum variable lines
 */
function collectCommandFlagVars(
  prefix: string,
  cmd: CommandEntry,
  out: BashFlagVars
): void {
  if (cmd.flags.length > 0) {
    const flagNames = cmd.flags.map((f) => `--${f.name}`).join(" ");
    out.flagVarLines.push(`  local ${prefix}_flags="${flagNames}"`);
  }
  for (const flag of cmd.flags) {
    if (flag.enumValues && flag.enumValues.length > 0) {
      const varName = `${prefix}_${shellVarName(flag.name)}_values`;
      out.enumVarLines.push(
        `  local ${varName}="${flag.enumValues.join(" ")}"`
      );
      out.enumFlagNames.push(`--${flag.name}`);
    }
  }
}

/**
 * Build bash variable declarations for command flags and enum values.
 *
 * Extracted from generateBashCompletion to reduce complexity.
 */
function buildBashFlagVars(tree: CommandTree): BashFlagVars {
  const out: BashFlagVars = {
    flagVarLines: [],
    enumVarLines: [],
    enumFlagNames: [],
  };

  for (const g of tree.groups) {
    for (const sub of g.subcommands) {
      const prefix = `${shellVarName(g.name)}_${shellVarName(sub.name)}`;
      collectCommandFlagVars(prefix, sub, out);
    }
  }

  for (const cmd of tree.standalone) {
    collectCommandFlagVars(shellVarName(cmd.name), cmd, out);
  }

  return out;
}

/**
 * Generate bash completion script.
 *
 * Includes:
 * - Static command/subcommand word lists
 * - Static flag name lists per command
 * - Static enum values per flag
 * - Dynamic `sentry __complete` callback for positional values
 */
export function generateBashCompletion(binaryName: string): string {
  const tree = extractCommandTree();
  const { groups, standalone } = tree;

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

  const { flagVarLines, enumVarLines, enumFlagNames } = buildBashFlagVars(tree);

  const caseBranches = groups
    .map(
      (g) =>
        `        ${g.name})\n          COMPREPLY=($(compgen -W "\${${shellVarName(g.name)}_commands}" -- "\${cur}"))\n          ;;`
    )
    .join("\n");

  const uniqueEnumFlags = [...new Set(enumFlagNames)];
  const enumFlagWords = uniqueEnumFlags.join(" ");

  // Build the enum flag test only if there are any enum flags
  const enumBranch = enumFlagWords
    ? `elif [[ " ${enumFlagWords} " == *" \${prev} "* ]]; then
        # Enum value completion (static)
        local val_var="$(__${binaryName}_varname "\${cmd}")_$(__${binaryName}_varname "\${subcmd}")_$(__${binaryName}_varname "\${prev#--}")_values"
        if [[ -n "\${!val_var+x}" ]]; then
          COMPREPLY=($(compgen -W "\${!val_var}" -- "\${cur}"))
        else
          # Fallback for standalone commands (subcmd is a flag, not a subcommand)
          local standalone_val_var="$(__${binaryName}_varname "\${cmd}")_$(__${binaryName}_varname "\${prev#--}")_values"
          if [[ -n "\${!standalone_val_var+x}" ]]; then
            COMPREPLY=($(compgen -W "\${!standalone_val_var}" -- "\${cur}"))
          fi
        fi`
    : "";

  return `# bash completion for ${binaryName}
# Auto-generated from command definitions

# Sanitize a string for use as a bash variable name suffix.
# Mirrors shellVarName() in completions.ts — replaces non-identifier chars.
__${binaryName}_varname() { echo "\${1//[^a-zA-Z0-9_]/_}"; }

_${binaryName}_completions() {
  local cur prev words cword
  _init_completion || return

  local commands="${allTopLevel.join(" ")}"
${subVars}
${flagVarLines.join("\n")}
${enumVarLines.join("\n")}

  case "\${COMP_CWORD}" in
    1)
      COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
      ;;
    2)
      case "\${prev}" in
${caseBranches}
        *)
          # Standalone command: check for flags at position 2
          if [[ "\${cur}" == --* ]]; then
            local standalone_var="$(__${binaryName}_varname "\${prev}")_flags"
            if [[ -n "\${!standalone_var+x}" ]]; then
              COMPREPLY=($(compgen -W "\${!standalone_var}" -- "\${cur}"))
            fi
          else
            # Dynamic value completion for standalone commands
            local IFS=$'\\n'
            COMPREPLY=($(${binaryName} __complete "\${COMP_WORDS[@]:1}" 2>/dev/null))
            if [[ \${#COMPREPLY[@]} -gt 0 ]]; then
              local i
              for i in "\${!COMPREPLY[@]}"; do
                COMPREPLY[$i]="\${COMPREPLY[$i]%%$'\\t'*}"
              done
            fi
          fi
          ;;
      esac
      ;;
    *)
      local cmd="\${COMP_WORDS[1]}"
      local subcmd="\${COMP_WORDS[2]}"

      if [[ "\${cur}" == --* ]]; then
        # Flag name completion (static)
        local cmd_var="$(__${binaryName}_varname "\${cmd}")_$(__${binaryName}_varname "\${subcmd}")_flags"
        if [[ -n "\${!cmd_var+x}" ]]; then
          COMPREPLY=($(compgen -W "\${!cmd_var}" -- "\${cur}"))
        else
          # Try standalone command flags
          local standalone_var="$(__${binaryName}_varname "\${cmd}")_flags"
          if [[ -n "\${!standalone_var+x}" ]]; then
            COMPREPLY=($(compgen -W "\${!standalone_var}" -- "\${cur}"))
          fi
        fi
      ${enumBranch ? `${enumBranch}\n      ` : ""}else
        # Dynamic value completion (from cache, with fuzzy matching)
        # The binary returns only relevant matches (prefix + fuzzy).
        local IFS=$'\\n'
        COMPREPLY=($(${binaryName} __complete "\${COMP_WORDS[@]:1}" 2>/dev/null))
        # Strip tab-separated descriptions (bash doesn't support them)
        if [[ \${#COMPREPLY[@]} -gt 0 ]]; then
          local i
          for i in "\${!COMPREPLY[@]}"; do
            COMPREPLY[$i]="\${COMPREPLY[$i]%%$'\\t'*}"
          done
        fi
      fi
      ;;
  esac
}

complete -F _${binaryName}_completions ${binaryName}
`;
}

/**
 * Generate zsh completion script.
 *
 * Includes static commands/subcommands, flag specs, and a dynamic
 * completer that calls `sentry __complete` for positional values.
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

  // Build case branches
  const caseBranches = groups
    .map(
      (g) =>
        `        ${g.name})\n          _describe -t commands '${g.name} command' ${shellVarName(g.name)}_commands\n          ;;`
    )
    .join("\n");

  return `#compdef ${binaryName}
# zsh completion for ${binaryName}
# Auto-generated from command definitions

_${binaryName}() {
  local -a commands
  local curcontext="$curcontext" state line
  commands=(
${topLevelItems}
  )

${subArrays}

  _arguments -C \\
    '1: :->command' \\
    '2: :->subcommand' \\
    '*::arg:->args'

  case "$state" in
    command)
      _describe -t commands 'command' commands
      ;;
    subcommand)
      case "$line[1]" in
${caseBranches}
        *)
          # Standalone command — delegate to dynamic completion
          ;;
      esac
      ;|
    args|subcommand)
      # Dynamic completion for positional args (org slugs, project names)
      # In the args state, $line[1] and $line[2] hold the parsed command
      # and subcommand. Pass them to __complete for context detection.
      local -a completions
      local escaped_value
      while IFS=$'\\t' read -r value desc; do
        escaped_value="\${value//:/\\\\:}"
        if [[ -n "$desc" ]]; then
          completions+=("\${escaped_value}:\${desc}")
        else
          completions+=("\${escaped_value}")
        fi
      done < <(
        if (( \${#words} == 0 )); then
          ${binaryName} __complete "$line[1]" "$line[2]" "" 2>/dev/null
        else
          ${binaryName} __complete "$line[1]" "$line[2]" "\${words[@]}" 2>/dev/null
        fi
      )
      if (( \${#completions} )); then
        _describe -t values 'value' completions
      fi
      ;;
  esac
}

_${binaryName}
`;
}

/**
 * Generate fish completion script.
 *
 * Includes static commands/subcommands and flag completions, plus a
 * dynamic completer for positional values.
 */
export function generateFishCompletion(binaryName: string): string {
  const { groups, standalone } = extractCommandTree();

  // Top-level command completions
  const topLevelLines = [
    ...groups.map(
      (g) =>
        `complete -c ${binaryName} -n "__fish_use_subcommand" -a "${g.name}" -d "${escapeDblQuote(g.brief)}"`
    ),
    ...standalone.map(
      (s) =>
        `complete -c ${binaryName} -n "__fish_use_subcommand" -a "${s.name}" -d "${escapeDblQuote(s.brief)}"`
    ),
  ].join("\n");

  // Subcommand completions
  const subLines = groups
    .map((g) => {
      const cmdLines = g.subcommands
        .map(
          (s) =>
            `complete -c ${binaryName} -n "__fish_seen_subcommand_from ${g.name}" -a "${s.name}" -d "${escapeDblQuote(s.brief)}"`
        )
        .join("\n");

      // Flag completions per subcommand
      const flagLines = g.subcommands
        .flatMap((s) =>
          s.flags.map(
            (f) =>
              `complete -c ${binaryName} -n "__fish_seen_subcommand_from ${g.name}; and __fish_seen_subcommand_from ${s.name}" -l "${f.name}" -d "${escapeDblQuote(f.brief)}"`
          )
        )
        .join("\n");

      return `\n# ${g.name} subcommands\n${cmdLines}${flagLines ? `\n${flagLines}` : ""}`;
    })
    .join("\n");

  // Flag completions for standalone commands (e.g., `sentry api --method`)
  const standaloneFlagLines = standalone
    .filter((cmd) => cmd.flags.length > 0)
    .map((cmd) => {
      const flags = cmd.flags
        .map(
          (f) =>
            `complete -c ${binaryName} -n "__fish_seen_subcommand_from ${cmd.name}" -l "${f.name}" -d "${escapeDblQuote(f.brief)}"`
        )
        .join("\n");
      return `\n# ${cmd.name} flags\n${flags}`;
    })
    .join("\n");

  return `# fish completion for ${binaryName}
# Auto-generated from command definitions

# Disable file completion by default
complete -c ${binaryName} -f

# Dynamic completion for positional values
function __${binaryName}_complete_dynamic
  # commandline -opc: all tokens before cursor (excludes current partial)
  # commandline -ct: the current token being completed (the partial)
  set -l preceding (commandline -opc)
  set -l current (commandline -ct)
  # Quote $current so an empty partial (TAB after space) is passed as ""
  # instead of being silently dropped by fish's empty-list expansion.
  ${binaryName} __complete $preceding[2..] "$current" 2>/dev/null | while read -l line
    echo $line
  end
end

# Top-level commands
${topLevelLines}
${subLines}
${standaloneFlagLines}

# Dynamic completions (org slugs, project names)
complete -c ${binaryName} -n "not __fish_use_subcommand" -a "" -k
complete -c ${binaryName} -a "(__${binaryName}_complete_dynamic)"
`;
}

/** Escape single quotes for zsh completion descriptions. */
function escapeSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Escape characters special in double-quoted shell strings.
 *
 * Handles bash (`\`, `$`, `"`) and fish (`\`, `$`, `"`, `(`, `)`)
 * since parentheses trigger command substitution in fish double quotes.
 */
function escapeDblQuote(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\$/g, "\\$")
    .replace(/"/g, '\\"')
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * Get the completion script for a shell type.
 */
export function getCompletionScript(
  shellType: ShellType,
  binaryName = "sentry"
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
  xdgDataHome?: string
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
  xdgDataHome?: string
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
