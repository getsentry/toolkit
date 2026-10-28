/**
 * Route Tree Introspection
 *
 * Shared module for extracting structured metadata from Stricli's route tree.
 * Used at runtime by `sentry help --json` and at build time by `generate-skill.ts`.
 *
 * While @stricli/core exports RouteMap and Command types, they require complex
 * generic parameters (CommandContext) and don't export internal types like
 * RouteMapEntry or FlagParameter. These simplified types are purpose-built
 * for introspection and documentation generation.
 */

import { type CommandExample, exampleSteps } from "./command-example.js";
import {
  type CompletionTarget,
  getCompletionTarget,
} from "./completion-target.js";
import {
  extractSchemaFields,
  type SchemaFieldInfo,
} from "./formatters/output.js";
import { fuzzyMatch } from "./fuzzy.js";

// ---------------------------------------------------------------------------
// Stricli Runtime Types (simplified for introspection)
// ---------------------------------------------------------------------------

/** Entry in a Stricli route map as returned by getAllEntries() */
export type RouteMapEntry = {
  name: { original: string };
  target: RouteTarget;
  hidden: boolean;
};

/** A routing target is either a route map (group) or a command */
export type RouteTarget = RouteMap | Command;

/** A route map groups subcommands under a named path segment */
export type RouteMap = {
  brief: string;
  fullDescription?: string;
  getAllEntries: () => RouteMapEntry[];
  /** Returns the default command if one is configured, undefined otherwise */
  getDefaultCommand?: () => unknown;
};

/** A leaf command with parameters */
export type Command = {
  brief: string;
  fullDescription?: string;
  parameters: {
    positional?: PositionalParams;
    flags?: Record<string, FlagDef>;
    aliases?: Record<string, string>;
  };
  /**
   * JSON output schema attached by `buildCommand` when `output.schema` is set.
   * Non-standard property — Stricli doesn't know about it, but introspection
   * reads it to populate {@link CommandInfo.jsonFields}.
   */
  __jsonSchema?: import("valibot").GenericSchema;
  /**
   * Primary Stricli custom usage line, retained by `buildCommand` for
   * introspection because Stricli does not expose it on the built command.
   */
  __primaryUsage?: string;
  __examples?: readonly CommandExample[];
  /** Set by `buildCommand({ destructive: true })` and `buildDeleteCommand`. */
  __destructive?: boolean;
};

/** Positional parameter definitions — either fixed-length tuple or variadic array */
export type PositionalParams =
  | { kind: "tuple"; parameters: readonly PositionalParam[] }
  | { kind: "array"; parameter: PositionalParam };

/** A single positional parameter with optional brief and placeholder */
export type PositionalParam = {
  brief?: string;
  placeholder?: string;
  optional?: boolean;
  /** Stricli parser; completion-aware parsers carry a {@link CompletionTarget}. */
  parse?: unknown;
};

/** Extracted metadata for a single positional argument */
export type PositionalInfo = {
  /** Placeholder text without angle brackets or an ellipsis. */
  placeholder: string;
  brief: string;
  /** Only fixed tuple parameters can be omitted. */
  optional: boolean;
  variadic: boolean;
  /** Canonical public syntax for compound positional forms. */
  syntax?: string;
};

/** Flag definition as stored in Stricli's command parameters */
export type FlagDef = {
  kind: "boolean" | "parsed" | "enum";
  brief?: string;
  default?: unknown;
  optional?: boolean;
  variadic?: boolean;
  placeholder?: string;
  hidden?: boolean;
  /** Stricli parser; completion-aware parsers carry a {@link CompletionTarget}. */
  parse?: unknown;
};

// ---------------------------------------------------------------------------
// Output Types
// ---------------------------------------------------------------------------

/** Extracted metadata for a single command */
export type CommandInfo = {
  path: string;
  brief: string;
  fullDescription?: string;
  flags: FlagInfo[];
  positional: string;
  /** Structured positional parameter metadata for documentation generation */
  positionals: PositionalInfo[];
  aliases: Record<string, string>;
  examples: string[];
  /** JSON output field metadata extracted from `OutputConfig.schema` */
  jsonFields?: SchemaFieldInfo[];
  /** Present (and `true`) when the command is destructive or irreversible */
  destructive?: true;
};

/** Extracted metadata for a single flag */
export type FlagInfo = {
  name: string;
  brief: string;
  kind: FlagDef["kind"];
  default?: unknown;
  optional: boolean;
  variadic: boolean;
  hidden: boolean;
};

/** Extracted metadata for a route group or standalone command */
export type RouteInfo = {
  name: string;
  brief: string;
  commands: CommandInfo[];
};

/**
 * Result of resolving a command path through the route tree.
 * Either a specific command or a route group with subcommands.
 */
export type ResolvedPath =
  | { kind: "command"; info: CommandInfo }
  | { kind: "group"; info: RouteInfo };

/**
 * Returned when a path segment fails to match any route.
 * Includes fuzzy-matched suggestions (up to 3) from the available
 * routes at the level where matching failed.
 */
export type UnresolvedPath = {
  kind: "unresolved";
  /** The input segment that didn't match any route */
  input: string;
  /** Fuzzy-matched suggestions from available route names */
  suggestions: string[];
};

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Check if a routing target is a RouteMap (has subcommands).
 *
 * Accepts `unknown` so callers (e.g., completions.ts) can use it on raw
 * Stricli route entries without first narrowing to {@link RouteTarget}.
 */
export function isRouteMap(target: unknown): target is RouteMap {
  return (
    typeof target === "object" && target !== null && "getAllEntries" in target
  );
}

/**
 * Check if a routing target is a Command (has parameters).
 *
 * Accepts `unknown` for the same reason as {@link isRouteMap}.
 */
export function isCommand(target: unknown): target is Command {
  return (
    typeof target === "object" &&
    target !== null &&
    "parameters" in target &&
    !("getAllEntries" in target)
  );
}

// ---------------------------------------------------------------------------
// Extraction Functions
// ---------------------------------------------------------------------------

/**
 * Build a positional parameter placeholder string from Stricli positional params.
 *
 * @param params - Stricli positional parameter definition
 * @returns Human-readable placeholder like `<target>` or `<command...>`
 */
export function getPositionalString(params?: PositionalParams): string {
  if (!params) {
    return "";
  }

  if (params.kind === "tuple") {
    return params.parameters
      .map((p, i) => {
        const value = `<${p.placeholder ?? `arg${i}`}>`;
        return p.optional ? `[${value}]` : value;
      })
      .join(" ");
  }

  if (params.kind === "array") {
    const placeholder = params.parameter.placeholder ?? "args";
    return `<${placeholder}...>`;
  }

  return "";
}

/**
 * Extract structured positional parameter metadata from a command.
 *
 * Returns one entry per positional, with placeholder, brief, and whether
 * the parameter is optional. Used by documentation generators to build
 * argument tables.
 *
 * @param params - Stricli positional parameter definition
 * @returns Array of positional info objects
 */
export function extractPositionals(
  params?: PositionalParams,
): PositionalInfo[] {
  if (!params) {
    return [];
  }

  if (params.kind === "tuple") {
    return params.parameters.map((p, i) => ({
      placeholder: p.placeholder ?? `arg${i}`,
      brief: p.brief ?? "",
      optional: p.optional ?? false,
      variadic: false,
    }));
  }

  if (params.kind === "array") {
    return [
      {
        placeholder: params.parameter.placeholder ?? "args",
        brief: params.parameter.brief ?? "",
        optional: false,
        variadic: true,
      },
    ];
  }

  return [];
}

/**
 * Extract flag metadata from a command's flag definitions.
 *
 * @param flags - Raw Stricli flag definitions
 * @returns Normalized flag info array
 */
export function extractFlags(
  flags: Record<string, FlagDef> | undefined,
): FlagInfo[] {
  if (!flags) {
    return [];
  }

  return Object.entries(flags).map(([name, def]) => ({
    name,
    brief: def.brief ?? "",
    kind: def.kind,
    default: def.default,
    optional: def.optional ?? def.kind === "boolean",
    variadic: def.variadic ?? false,
    hidden: def.hidden ?? false,
  }));
}

/**
 * Build a {@link CommandInfo} from a Stricli Command.
 *
 * @param cmd - The Stricli command to introspect
 * @param path - Full command path (e.g. "sentry issue list")
 */
export function buildCommandInfo(cmd: Command, path: string): CommandInfo {
  const jsonFields = cmd.__jsonSchema
    ? extractSchemaFields(cmd.__jsonSchema)
    : undefined;
  const positionals = extractPositionals(cmd.parameters.positional);
  const [positional] = positionals;
  if (cmd.__primaryUsage && positional && positionals.length === 1) {
    positionals[0] = { ...positional, syntax: cmd.__primaryUsage };
  }

  return {
    path,
    brief: cmd.brief,
    fullDescription: cmd.fullDescription,
    flags: extractFlags(cmd.parameters.flags),
    positional:
      cmd.__primaryUsage ?? getPositionalString(cmd.parameters.positional),
    positionals,
    aliases: cmd.parameters.aliases ?? {},
    examples: (cmd.__examples ?? []).map(
      (example) =>
        `# ${example.description}\n${exampleSteps(example).join("\n")}`,
    ),
    jsonFields: jsonFields?.length ? jsonFields : undefined,
    ...(cmd.__destructive ? { destructive: true as const } : {}),
  };
}

/**
 * Extract all visible subcommands from a route group.
 *
 * @param routeMap - The route map to introspect
 * @param routeName - Parent route name (e.g. "issue")
 */
export function extractRouteGroupCommands(
  routeMap: RouteMap,
  routeName: string,
): CommandInfo[] {
  const commands: CommandInfo[] = [];

  for (const subEntry of routeMap.getAllEntries()) {
    if (subEntry.hidden) {
      continue;
    }

    const subTarget = subEntry.target;
    if (isCommand(subTarget)) {
      const path = `sentry ${routeName} ${subEntry.name.original}`;
      commands.push(buildCommandInfo(subTarget, path));
    } else if (isRouteMap(subTarget)) {
      const nestedPrefix = `${routeName} ${subEntry.name.original}`;
      commands.push(...extractRouteGroupCommands(subTarget, nestedPrefix));
    }
  }

  return commands;
}

/**
 * Walk the entire route tree and extract metadata for all visible routes.
 *
 * @param routeMap - Top-level Stricli route map
 * @returns Array of route info for each visible top-level entry
 */
export function extractAllRoutes(routeMap: RouteMap): RouteInfo[] {
  const result: RouteInfo[] = [];

  for (const entry of routeMap.getAllEntries()) {
    if (entry.hidden) {
      continue;
    }

    const routeName = entry.name.original;
    const target = entry.target;

    if (isRouteMap(target)) {
      result.push({
        name: routeName,
        brief: target.brief,
        commands: extractRouteGroupCommands(target, routeName),
      });
    } else if (isCommand(target)) {
      const path = `sentry ${routeName}`;
      result.push({
        name: routeName,
        brief: target.brief,
        commands: [buildCommandInfo(target, path)],
      });
    }
  }

  return result;
}

/**
 * What `__complete` needs to know about one command's arguments.
 *
 * Kinds come from the parsers the command already declares (see
 * `completion-target.ts`); `null` marks an argument without one.
 */
type CommandCompletion = {
  /**
   * Kind of each positional, by index. A variadic positional has one entry
   * that applies to every word.
   */
  positionals: (CompletionTarget | null)[];
  /** Whether the last entry of {@link positionals} repeats. */
  variadic: boolean;
  /**
   * Every flag spelling that consumes the next word (`--name`, `-a`), mapped
   * to the kind of its value. Hidden flags count because the parser still
   * accepts them.
   */
  flags: Record<string, CompletionTarget | null>;
};

/** {@link CommandCompletion} per command path (without the `sentry` prefix). */
export type CommandCompletions = Record<string, CommandCompletion>;

/** Read the completion metadata of one command's parameters. */
function getCommandCompletion(command: Command): CommandCompletion {
  const { positional, flags = {}, aliases = {} } = command.parameters;
  const params = positional
    ? positional.kind === "tuple"
      ? positional.parameters
      : [positional.parameter]
    : [];
  const flagKinds: Record<string, CompletionTarget | null> = {};
  for (const [name, def] of Object.entries(flags)) {
    if (def.kind !== "boolean") {
      flagKinds[`--${name}`] = getCompletionTarget(def.parse) ?? null;
    }
  }
  for (const [alias, name] of Object.entries(aliases)) {
    const kind = flagKinds[`--${name}`];
    if (kind !== undefined) {
      flagKinds[`-${alias}`] = kind;
    }
  }
  return {
    positionals: params.map(
      (param) => getCompletionTarget(param.parse) ?? null,
    ),
    variadic: positional?.kind === "array",
    flags: Object.fromEntries(
      Object.entries(flagKinds).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

/**
 * Collect the completion metadata of every visible command that completes
 * at least one positional or flag value.
 *
 * Paths are space-separated route segments without the binary name (e.g.
 * `"issue list"`); nested groups contribute their full path. Sorted for
 * stable generated output.
 *
 * @param routeMap - Top-level Stricli route map
 * @param prefix - Route segments above `routeMap` (used for recursion)
 */
export function extractCommandCompletions(
  routeMap: RouteMap,
  prefix: readonly string[] = [],
): CommandCompletions {
  const result: CommandCompletions = {};
  for (const entry of routeMap.getAllEntries()) {
    if (entry.hidden) {
      continue;
    }
    const segments = [...prefix, entry.name.original];
    const target = entry.target;
    if (isRouteMap(target)) {
      Object.assign(result, extractCommandCompletions(target, segments));
    } else if (isCommand(target)) {
      const completion = getCommandCompletion(target);
      const kinds = [
        ...completion.positionals,
        ...Object.values(completion.flags),
      ];
      if (kinds.some((kind) => kind !== null)) {
        result[segments.join(" ")] = completion;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Matches the "sentry " prefix at the start of a command path. */
const SENTRY_PREFIX_RE = /^sentry /;

/** Maximum number of fuzzy suggestions to include in an UnresolvedPath. */
const MAX_SUGGESTIONS = 3;

/**
 * Resolve a command path through the route tree.
 *
 * Navigates the tree using the provided path segments:
 * - Single segment (e.g. ["issue"]) → returns the route group if it's a RouteMap,
 *   or the command if it's a standalone command
 * - Two segments (e.g. ["issue", "list"]) → returns the specific subcommand
 *
 * When a segment doesn't match, returns an {@link UnresolvedPath} with
 * fuzzy-matched suggestions from the available routes at that level.
 *
 * @param routeMap - Top-level Stricli route map
 * @param path - Command path segments (e.g. ["issue", "list"])
 * @returns Resolved command/group, unresolved with suggestions, or null for empty paths
 */
export function resolveCommandPath(
  routeMap: RouteMap,
  path: string[],
): ResolvedPath | UnresolvedPath | null {
  if (path.length === 0) {
    return null;
  }

  const first = path[0];
  const rest = path.slice(1);

  // length === 0 is handled above; this guard helps TS narrow the type
  if (first === undefined) {
    return null;
  }

  // Collect visible entries once — used for both exact match and fuzzy fallback
  const visibleEntries = routeMap.getAllEntries().filter((e) => !e.hidden);
  const entry = visibleEntries.find((e) => e.name.original === first);

  if (!entry) {
    const names = visibleEntries.map((e) => e.name.original);
    return {
      kind: "unresolved",
      input: first,
      suggestions: fuzzyMatch(first, names, { maxResults: MAX_SUGGESTIONS }),
    };
  }

  const target = entry.target;

  // No more path segments — return what we found
  if (rest.length === 0) {
    if (isRouteMap(target)) {
      return {
        kind: "group",
        info: {
          name: entry.name.original,
          brief: target.brief,
          commands: extractRouteGroupCommands(target, entry.name.original),
        },
      };
    }
    if (isCommand(target)) {
      return {
        kind: "command",
        info: buildCommandInfo(target, `sentry ${entry.name.original}`),
      };
    }
    return null;
  }

  // More path segments — must be a route map to navigate deeper
  if (!isRouteMap(target)) {
    return null;
  }

  // Recurse into the sub-route map with remaining path segments
  const subResult = resolveCommandPath(target, rest);
  if (!subResult) {
    return null;
  }

  // Prepend the parent route segment to all paths in the result
  const parentPrefix = entry.name.original;
  const prependPrefix = (p: string) =>
    p.replace(SENTRY_PREFIX_RE, `sentry ${parentPrefix} `);

  if (subResult.kind === "command") {
    return {
      kind: "command",
      info: { ...subResult.info, path: prependPrefix(subResult.info.path) },
    };
  }
  if (subResult.kind === "group") {
    return {
      kind: "group",
      info: {
        ...subResult.info,
        name: `${parentPrefix} ${subResult.info.name}`,
        commands: subResult.info.commands.map((cmd) => ({
          ...cmd,
          path: prependPrefix(cmd.path),
        })),
      },
    };
  }

  return subResult;
}
