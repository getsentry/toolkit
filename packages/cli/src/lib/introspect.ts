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

import generatedCommandApi from "../generated/command-api.json";
import { type CommandExample, exampleSteps } from "./command-example.js";
import {
  CHOICE_TARGET,
  type CompletionTarget,
  getCompletionChoices,
  getCompletionTarget,
} from "./completion-target.js";
import type { ApiReference, CommandApiReference } from "./api-schema.js";
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
  aliases?: readonly string[];
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
  /** Accepted values of an `enum` flag. */
  values?: readonly string[];
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
   * accepts them. `enum` flags complete their values as `choice`.
   */
  flags: Record<string, CompletionTarget | null>;
  /**
   * Values of each `choice` argument, keyed by positional index (`"0"`) or
   * flag spelling (`"--format"`). Omitted when the command has none.
   */
  choices?: Record<string, readonly string[]>;
};

/** {@link CommandCompletion} per command path (without the `sentry` prefix). */
export type CommandCompletions = Record<string, CommandCompletion>;

/**
 * The kind and, for `choice`, the values of one argument: those of an
 * `enum` flag, or of a `choiceParser` parser.
 */
function argumentCompletion(
  parse: unknown,
  enumValues?: readonly string[],
): { kind: CompletionTarget | null; values?: readonly string[] } {
  const values = enumValues ?? getCompletionChoices(parse);
  return values
    ? { kind: CHOICE_TARGET, values }
    : { kind: getCompletionTarget(parse) ?? null };
}

/** Sort an object's entries by key, for stable generated output. */
function sortedByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Read the completion metadata of one command's parameters. */
function getCommandCompletion(command: Command): CommandCompletion {
  const { positional, flags = {}, aliases = {} } = command.parameters;
  const params = positional
    ? positional.kind === "tuple"
      ? positional.parameters
      : [positional.parameter]
    : [];
  const choices: Record<string, readonly string[]> = {};
  const positionals = params.map((param, index) => {
    const { kind, values } = argumentCompletion(param.parse);
    if (values) {
      choices[index] = values;
    }
    return kind;
  });
  const flagKinds: Record<string, CompletionTarget | null> = {};
  for (const [name, def] of Object.entries(flags)) {
    if (def.kind !== "boolean") {
      const { kind, values } = argumentCompletion(
        def.parse,
        def.kind === "enum" ? def.values : undefined,
      );
      flagKinds[`--${name}`] = kind;
      if (values) {
        choices[`--${name}`] = values;
      }
    }
  }
  for (const [alias, name] of Object.entries(aliases)) {
    const kind = flagKinds[`--${name}`];
    if (kind !== undefined) {
      flagKinds[`-${alias}`] = kind;
    }
    const values = choices[`--${name}`];
    if (values) {
      choices[`-${alias}`] = values;
    }
  }
  return {
    positionals,
    variadic: positional?.kind === "array",
    flags: sortedByKey(flagKinds),
    ...(Object.keys(choices).length > 0
      ? { choices: sortedByKey(choices) }
      : {}),
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
  return sortedByKey(result);
}

/**
 * Visible subcommand names and briefs of every route group, by group path
 * (without the `sentry` prefix; `""` is the top level), so `__complete`
 * can complete nested subcommands and command paths. Sorted for stable
 * generated output.
 *
 * @param routeMap - Top-level Stricli route map
 * @param prefix - Route segments above `routeMap` (used for recursion)
 */
export function extractRouteGroups(
  routeMap: RouteMap,
  prefix: readonly string[] = [],
): Record<string, Record<string, string>> {
  const subcommands: Record<string, string> = {};
  const result: Record<string, Record<string, string>> = {};
  for (const entry of routeMap.getAllEntries()) {
    if (entry.hidden) {
      continue;
    }
    subcommands[entry.name.original] = entry.target.brief;
    if (isRouteMap(entry.target)) {
      const segments = [...prefix, entry.name.original];
      Object.assign(result, extractRouteGroups(entry.target, segments));
    }
  }
  result[prefix.join(" ")] = sortedByKey(subcommands);
  return sortedByKey(result);
}

/** Maximum number of fuzzy suggestions to include in an UnresolvedPath. */
const MAX_SUGGESTIONS = 3;
const COMMAND_PATH_SEPARATOR = /\s+/;

/** Find canonical public paths so hidden aliases cannot expose internal commands. */
export function publicTargetPaths(
  routeMap: RouteMap,
  prefix: readonly string[] = [],
  paths = new Map<RouteTarget, string[]>(),
): Map<RouteTarget, string[]> {
  for (const entry of routeMap.getAllEntries()) {
    if (entry.hidden || paths.has(entry.target)) {
      continue;
    }
    const path = [...prefix, entry.name.original];
    paths.set(entry.target, path);
    if (isRouteMap(entry.target)) {
      publicTargetPaths(entry.target, path, paths);
    }
  }
  return paths;
}

/**
 * Resolve a full command path using the registered route names and aliases.
 * Hidden aliases are accepted only when their target also has a public path.
 * Results always use the canonical public spelling; no command is executed.
 */
export function resolveCommandPath(
  routeMap: RouteMap,
  path: string[],
): ResolvedPath | UnresolvedPath | null {
  if (path.length === 0) {
    return null;
  }

  const publicPaths = publicTargetPaths(routeMap);
  let target: RouteTarget = routeMap;
  let canonicalPath: string[] = [];

  for (const segment of path) {
    if (!isRouteMap(target)) {
      return null;
    }
    const entries: RouteMapEntry[] = target
      .getAllEntries()
      .filter(
        (candidate) => !candidate.hidden || publicPaths.has(candidate.target),
      );
    const entry: RouteMapEntry | undefined =
      entries.find((candidate) => candidate.name.original === segment) ??
      entries.find((candidate) => candidate.aliases?.includes(segment));
    if (!entry) {
      return {
        kind: "unresolved",
        input: segment,
        suggestions: fuzzyMatch(
          segment,
          entries
            .filter((candidate) => !candidate.hidden)
            .map((candidate) => candidate.name.original),
          { maxResults: MAX_SUGGESTIONS },
        ),
      };
    }
    canonicalPath = entry.hidden
      ? [...(publicPaths.get(entry.target) ?? [])]
      : [...canonicalPath, entry.name.original];
    target = entry.target;
  }

  const name = canonicalPath.join(" ");
  if (isRouteMap(target)) {
    return {
      kind: "group",
      info: {
        name,
        brief: target.brief,
        commands: extractRouteGroupCommands(target, name),
      },
    };
  }
  if (isCommand(target)) {
    return {
      kind: "command",
      info: buildCommandInfo(target, `sentry ${name}`),
    };
  }
  return null;
}

/** Collect related APIs for one exact command path or all commands in a group. */
export function getCommandApiReferences(
  routeMap: RouteMap,
  query: string,
  apiByCommand: Readonly<
    Record<string, readonly ApiReference[]>
  > = generatedCommandApi,
): CommandApiReference[] {
  const path = query.trim().split(COMMAND_PATH_SEPARATOR).filter(Boolean);
  const resolved = resolveCommandPath(routeMap, path);
  if (!resolved || resolved.kind === "unresolved") {
    return [];
  }
  const commands =
    resolved.kind === "command" ? [resolved.info] : resolved.info.commands;
  return commands.flatMap((command) =>
    (apiByCommand[command.path] ?? []).map((reference) => ({
      ...reference,
      command: command.path,
    })),
  );
}
