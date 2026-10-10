/**
 * Shared building blocks for org-scoped list commands.
 *
 * Provides reusable Stricli parameter definitions (target positional, common
 * flags, aliases) and a `buildOrgListCommand` factory for commands whose
 * entire `func` body is handled by `dispatchOrgScopedList`.
 *
 * Level A — shared constants (used by all four list commands):
 *   LIST_TARGET_POSITIONAL, LIST_JSON_FLAG, LIST_CURSOR_FLAG,
 *   buildListLimitFlag, LIST_BASE_ALIASES
 *
 * Level B — full command builder (team / repo only):
 *   buildOrgListCommand
 */

import { createRequire } from "node:module";
import type { Aliases, Command, CommandContext } from "@stricli/core";
import type { SentryContext } from "../context.js";

const _require = createRequire(import.meta.url);

import { parseOrgProjectArg } from "./arg-parsing.js";
import {
  buildCommand,
  type CommandDocumentation,
  numberParser,
} from "./command.js";
import { disableOrgCache } from "./db/regions.js";
import { logger } from "./logger.js";

const log = logger.withTag("list-command");

import { disableDsnCache } from "./dsn/index.js";
import { warning } from "./formatters/colors.js";
import {
  CommandOutput,
  type CommandReturn,
  type OutputConfig,
} from "./formatters/output.js";
import {
  dispatchOrgScopedList,
  jsonTransformListResult,
  type ListResult,
  type OrgListConfig,
} from "./org-list.js";
import { disableResponseCache } from "./response-cache.js";
import { PERIOD_BRIEF, parsePeriod } from "./time-range.js";

// ---------------------------------------------------------------------------
// Level A: shared parameter / flag definitions
// ---------------------------------------------------------------------------

/**
 * Absolute maximum items a list command will return.
 *
 * The Sentry API max `per_page` is 100 (some endpoints 400 if larger);
 * commands auto-paginate to fill larger limits but stop at this ceiling
 * for practical CLI use.
 */
export const LIST_MAX_LIMIT = 1000;

/** Minimum allowed value for `--limit` across all list commands. */
export const LIST_MIN_LIMIT = 1;

/** Default number of items returned by list commands when `--limit` is omitted. */
export const LIST_DEFAULT_LIMIT = 25;

/**
 * Positional `org/project` parameter shared by all list commands.
 *
 * Accepts `<org>/`, `<org>/<project>`, or bare `<project>` (search).
 * Marked optional so the command falls back to auto-detection when omitted.
 */
export const LIST_TARGET_POSITIONAL = {
  kind: "tuple" as const,
  parameters: [
    {
      placeholder: "org/project",
      brief: "<org>/ (all projects), <org>/<project>, or <project> (search)",
      parse: String,
      optional: true as const,
    },
  ],
};

/**
 * Short note for commands that accept a bare project name but do not support
 * org-all mode (e.g. trace list, log list, project view).
 *
 * Explains that a bare name triggers project-search, not org-scoped listing.
 */
export const TARGET_PATTERN_NOTE =
  "A bare name (no slash) is treated as a project search. " +
  "Use <org>/<project> for an explicit target.";

/**
 * Full explanation of trailing-slash semantics for commands that support all
 * four target modes including org-all (e.g. issue list, project list).
 *
 * @param cursorNote - Optional sentence appended when the command supports
 *   cursor pagination (e.g. "Cursor pagination (--cursor) requires the <org>/ form.").
 */
export function targetPatternExplanation(cursorNote?: string): string {
  const base =
    "The trailing slash on <org>/ is significant — without it, the argument " +
    "is treated as a project name search (e.g., 'sentry' searches for a " +
    "project named 'sentry', while 'sentry/' lists all projects in the " +
    "'sentry' org).";
  return cursorNote ? `${base} ${cursorNote}` : base;
}

/**
 * The `--json` flag shared by all list commands.
 * Outputs machine-readable JSON instead of a human-readable table.
 *
 * @deprecated Use `output: { human: ... }` on `buildCommand` instead, which
 * injects `--json` and `--fields` automatically. This constant is kept
 * for commands that define `--json` with custom brief text.
 */
export const LIST_JSON_FLAG = {
  kind: "boolean" as const,
  brief: "Output JSON",
  default: false,
} as const;

/**
 * The `--fresh` / `-f` flag shared by read-only commands.
 * Bypasses the response cache and fetches fresh data from the API.
 *
 * Add to any command's `flags` object, then call `applyFreshFlag(flags)` at
 * the top of `func()` to activate cache bypass when the flag is set.
 *
 * @example
 * ```ts
 * import { applyFreshFlag, FRESH_ALIASES, FRESH_FLAG } from "../lib/list-command.js";
 *
 * // In parameters:
 * flags: { ..., fresh: FRESH_FLAG },
 * aliases: { ...FRESH_ALIASES },
 *
 * // In func():
 * applyFreshFlag(flags);
 * ```
 */
export const FRESH_FLAG = {
  kind: "boolean" as const,
  brief: "Bypass cache, re-detect projects, and fetch fresh data",
  default: false,
} as const;

/**
 * Alias map for the `--fresh` flag: `-f` → `--fresh`.
 *
 * Spread into a command's `aliases` alongside other aliases:
 * ```ts
 * aliases: { ...FRESH_ALIASES, w: "web" }
 * ```
 *
 * **Note**: Commands that use `-f` for a different flag (e.g. `log list`
 * uses `-f` for `--follow`) should NOT spread this constant.
 */
export const FRESH_ALIASES = { f: "fresh" } as const;

/**
 * Apply the `--fresh` flag: disables the response cache for this invocation.
 *
 * Call at the top of a command's `func()` after defining the `fresh` flag:
 * ```ts
 * flags: { fresh: FRESH_FLAG },
 * async *func(this: SentryContext, flags) {
 *   applyFreshFlag(flags);
 * ```
 */
export function applyFreshFlag(flags: { readonly fresh: boolean }): void {
  if (flags.fresh) {
    disableResponseCache();
    disableDsnCache();
    disableOrgCache();
  }
}

/** Matches strings that are all digits — used to detect invalid cursor values */
const ALL_DIGITS_RE = /^\d+$/;

/**
 * Navigation keywords accepted by `--cursor`.
 *
 * - `"next"` / `"last"` — advance to the next page
 * - `"prev"` / `"previous"` — go back to the previous page
 * - `"first"` — jump back to the first page
 *
 * `"last"` is a silent alias for `"next"` preserved for muscle-memory compat.
 */
export const CURSOR_KEYWORDS = new Set([
  "next",
  "last",
  "prev",
  "previous",
  "first",
]);

/**
 * Parse and validate a `--cursor` flag value.
 *
 * Accepts navigation keywords (`"next"`, `"prev"`, `"previous"`, `"first"`,
 * `"last"`) and opaque Sentry cursor strings (e.g. `"1735689600:0:0"`).
 * Rejects bare integers early — they are never valid cursors and would
 * produce a cryptic 400 from the API.
 *
 * Shared by {@link LIST_CURSOR_FLAG} and commands that define their own
 * cursor flag with a custom `brief`.
 *
 * @throws Error when value is a bare integer
 */
export function parseCursorFlag(value: string): string {
  if (CURSOR_KEYWORDS.has(value)) {
    return value;
  }
  if (ALL_DIGITS_RE.test(value)) {
    throw new Error(
      `'${value}' is not a valid cursor. Cursors look like "1735689600:0:0". Use "next" / "prev" to navigate pages.`,
    );
  }
  return value;
}

/**
 * The `--cursor` / `-c` flag shared by all list commands.
 *
 * Accepts navigation keywords (`next`, `prev`, `first`, `last`) or an
 * opaque cursor string for power users. Only meaningful in `<org>/`
 * (org-all) mode by default.
 */
export const LIST_CURSOR_FLAG = {
  kind: "parsed" as const,
  parse: parseCursorFlag,
  brief: 'Navigate pages: "next", "prev", "first" (or raw cursor string)',
  optional: true as const,
};

/**
 * Build a bidirectional pagination hint string from next/prev command hints.
 *
 * Combines a "Prev" and/or "Next" hint into a single line, returning an
 * empty string when neither direction is available. Commands supply their
 * own fully-formed hint strings (including flag suffixes) via `nextHint`
 * and `prevHint`.
 *
 * @param opts - Pagination state and pre-built hint strings
 * @returns Combined hint string, or `""` if no navigation is possible
 *
 * @example
 * ```ts
 * const nav = paginationHint({
 *   hasPrev: true,
 *   hasMore: true,
 *   prevHint: "sentry trace list my-org/my-proj -c prev",
 *   nextHint: "sentry trace list my-org/my-proj -c next",
 * });
 * // → "Prev: sentry trace list my-org/my-proj -c prev | Next: sentry trace list my-org/my-proj -c next"
 * ```
 */
export function paginationHint(opts: {
  hasPrev: boolean;
  hasMore: boolean;
  prevHint: string;
  nextHint: string;
}): string {
  const parts: string[] = [];
  if (opts.hasPrev) {
    parts.push(`Prev: ${opts.prevHint}`);
  }
  if (opts.hasMore) {
    parts.push(`Next: ${opts.nextHint}`);
  }
  return parts.join(" | ");
}

/**
 * Append `-q "<query>"` to a hint-flag parts array when the user passed `--query`.
 *
 * Standard helper for pagination-hint builders that need to preserve the
 * active search filter. Quotes are added unconditionally to handle queries
 * containing spaces.
 */
export function appendQueryHint(
  parts: string[],
  query: string | undefined,
): void {
  if (query) {
    parts.push(`-q "${query}"`);
  }
}

/**
 * Append `--sort <value>` to a hint-flag parts array when the sort differs
 * from the command's default.
 *
 * Stringly-typed to support both raw API sort strings (e.g. `"-count()"`)
 * and command-specific enum values (e.g. `"date" | "duration"`).
 */
export function appendSortHint(
  parts: string[],
  sort: string | undefined,
  defaultSort?: string,
): void {
  if (sort && sort !== defaultSort) {
    parts.push(`--sort "${sort}"`);
  }
}

/**
 * Build the `--limit` / `-n` flag for a list command.
 *
 * @param entityPlural - Plural entity name used in the brief (e.g. "teams")
 * @param defaultValue - Default limit as a string — Stricli passes it through
 *   numberParser at runtime, so the command receives a number
 *   (default: {@link LIST_DEFAULT_LIMIT})
 */
export function buildListLimitFlag(
  entityPlural: string,
  defaultValue = String(LIST_DEFAULT_LIMIT),
): {
  kind: "parsed";
  parse: typeof numberParser;
  brief: string;
  default: string;
} {
  return {
    kind: "parsed",
    parse: numberParser,
    brief: `Maximum number of ${entityPlural} to list`,
    default: defaultValue,
  };
}

/**
 * The `--period` / `-t` flag for list commands that query time-bounded data.
 *
 * Controls the `statsPeriod` parameter sent to the Sentry Events API.
 * Accepts relative durations (`"7d"`, `"24h"`), date ranges
 * (`"2024-01-01..2024-02-01"`), and comparison operators (`">=2024-01-01"`).
 *
 * Stricli calls `parsePeriod` on both user input and the default value,
 * so `flags.period` is always a `TimeRange` object — no manual
 * `parsePeriod()` call needed in `func()`.
 *
 * Default is `"7d"` (7 days). Commands that need a different default (e.g.,
 * `issue list` uses `"90d"`) should define their own flag inline with
 * `parse: parsePeriod`.
 *
 * @example
 * ```ts
 * flags: { ..., period: LIST_PERIOD_FLAG },
 * aliases: { ...PERIOD_ALIASES },
 * ```
 */
export const LIST_PERIOD_FLAG = {
  kind: "parsed" as const,
  parse: parsePeriod,
  brief: PERIOD_BRIEF,
  default: "7d",
};

/**
 * Alias map for the `--period` flag: `-t` → `--period`.
 *
 * Exported separately from `LIST_BASE_ALIASES` because not all list commands
 * need a period flag, and some commands already use `-t` for other purposes.
 */
export const PERIOD_ALIASES = { t: "period" } as const;

/**
 * Alias map shared by all list commands.
 * `-n` → `--limit`, `-c` → `--cursor`.
 *
 * Commands with additional flags should spread this and add their own aliases:
 * ```ts
 * aliases: { ...LIST_BASE_ALIASES, p: "platform" }
 * ```
 */
export const LIST_BASE_ALIASES: Aliases<string> = { n: "limit", c: "cursor" };

// ---------------------------------------------------------------------------
// Level B: subcommand interception for plural aliases
// ---------------------------------------------------------------------------

let _subcommandsByRoute: Map<string, Set<string>> | undefined;

/**
 * Entry shape returned by Stricli's getAllEntries().
 * `aliases` is always present at runtime (empty array when none),
 * but typed as optional for defensive safety.
 */
type RouteEntry = {
  name: { original: string };
  aliases?: readonly string[];
  target: unknown;
};

/** Collect all subcommand names and aliases from a route group's children. */
function collectChildNames(parent: {
  getAllEntries: () => readonly RouteEntry[];
}): Set<string> {
  const names = new Set<string>();
  for (const child of parent.getAllEntries()) {
    names.add(child.name.original);
    for (const alias of child.aliases ?? []) {
      names.add(alias);
    }
  }
  return names;
}

/**
 * Get the subcommand names for a given singular route (e.g. "project" → {"list", "view"}).
 *
 * Lazily walks the Stricli route map on first call. Uses `require()` to break
 * the circular dependency: list-command → app → commands → list-command.
 */
function getSubcommandsForRoute(routeName: string): Set<string> {
  if (!_subcommandsByRoute) {
    _subcommandsByRoute = new Map();

    try {
      const { routes } = _require("../app.js") as {
        routes: { getAllEntries: () => readonly RouteEntry[] };
      };

      for (const entry of routes.getAllEntries()) {
        const target = entry.target as unknown as Record<string, unknown>;
        if (typeof target?.getAllEntries === "function") {
          _subcommandsByRoute.set(
            entry.name.original,
            collectChildNames(
              target as { getAllEntries: () => readonly RouteEntry[] },
            ),
          );
        }
      }
    } catch (error) {
      // In test environments (vitest), require("../app.js") may fail because
      // Node's ESM resolver can't resolve .js→.ts for transitive imports.
      // Gracefully degrade: interceptSubcommand will treat all targets as
      // plain values (no subcommand interception).
      log.debug("Failed to load app routes for subcommand detection", error);
    }
  }

  return _subcommandsByRoute.get(routeName) ?? new Set();
}

/**
 * Check if a positional target is actually a subcommand name passed through
 * a plural alias (e.g. "list" from `sentry projects list`).
 *
 * When a plural alias like `sentry projects` maps directly to the list
 * command, Stricli passes extra tokens as positional args. If the token
 * matches a known subcommand of the singular route, we treat it as if no
 * target was given (auto-detect) and print a command-specific hint.
 *
 * @param target - The raw positional argument
 * @param stderr - Writable stream for the hint message
 * @param routeName - Singular route name (e.g. "project", "issue")
 * @returns The original target, or `undefined` if it was a subcommand name
 */
export function interceptSubcommand(
  target: string | undefined,
  stderr: { write(s: string): void },
  routeName: string,
): string | undefined {
  if (!target) {
    return target;
  }
  const trimmed = target.trim();
  if (trimmed && getSubcommandsForRoute(routeName).has(trimmed)) {
    stderr.write(
      warning(
        `Tip: "${trimmed}" is a subcommand. Running: sentry ${routeName} ${trimmed}\n`,
      ),
    );
    return;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Level C: list command builder with automatic subcommand interception
// ---------------------------------------------------------------------------

/** Base flags type (mirrors command.ts) */
type BaseFlags = Readonly<Partial<Record<string, unknown>>>;

/** Base args type (mirrors command.ts) */
type BaseArgs = readonly unknown[];

/**
 * Command function type that returns an async generator.
 *
 * Mirrors `SentryCommandFunction` from `command.ts`. All command functions
 * are async generators — non-streaming commands yield once and return.
 */
type ListCommandFunction<
  FLAGS extends BaseFlags,
  ARGS extends BaseArgs,
  CONTEXT extends CommandContext,
> = (
  this: CONTEXT,
  flags: FLAGS,
  ...args: ARGS
  // void is required here — generators that don't return a value have implicit void return, which is distinct from undefined in TypeScript's type system
) => AsyncGenerator<unknown, CommandReturn | void, undefined>;

/**
 * Options for controlling which flags {@link buildListCommand} auto-injects.
 *
 * By default, `buildListCommand` adds `--fresh`, `--cursor`, and their aliases
 * (`-f`, `-c`). Use these options to opt out when a command has conflicts.
 */
export type ListCommandOptions = {
  /** Skip injecting `--cursor` flag and `-c` alias (e.g., log list uses streaming). */
  noCursorFlag?: boolean;
  /** Skip injecting `-f` alias for `--fresh` (e.g., log list uses `-f` for `--follow`). */
  noFreshAlias?: boolean;
};

/**
 * Build a Stricli command for a list endpoint with automatic plural-alias
 * interception and common flag injection.
 *
 * This is a drop-in replacement for `buildCommand` that:
 * 1. Intercepts subcommand names passed through plural aliases
 * 2. Auto-injects `--fresh` and `--cursor` flags (unless already defined)
 * 3. Auto-injects `-f` and `-c` aliases (with opt-outs via `options`)
 * 4. Auto-calls `applyFreshFlag(flags)` before the command function runs
 *
 * Commands that define their own `cursor` or `fresh` flags (e.g., with a
 * custom `brief`) keep theirs — auto-injection skips flags already present.
 *
 * @param routeName - Singular route name (e.g. "project", "issue") for the
 *   hint message and subcommand lookup
 * @param builderArgs - Same arguments as `buildCommand` from `lib/command.js`
 * @param options - Control which flags are auto-injected
 */
export function buildListCommand<
  const FLAGS extends BaseFlags = NonNullable<unknown>,
  const ARGS extends readonly unknown[] = [],
  const CONTEXT extends CommandContext = CommandContext,
>(
  routeName: string,
  builderArgs: {
    readonly parameters?: Record<string, unknown>;
    readonly docs: CommandDocumentation;
    readonly func: ListCommandFunction<FLAGS, ARGS, CONTEXT>;
    // oxlint-disable-next-line typescript/no-explicit-any -- OutputConfig is generic but type is erased at the builder level
    readonly output?: OutputConfig<any>;
    readonly auth?: boolean;
  },
  options?: ListCommandOptions,
): Command<CONTEXT> {
  const originalFunc = builderArgs.func;

  // Auto-inject common flags and aliases into parameters
  const params = (builderArgs.parameters ?? {}) as Record<string, unknown>;
  const existingFlags = (params.flags ?? {}) as Record<string, unknown>;
  const existingAliases = (params.aliases ?? {}) as Record<string, string>;

  const mergedFlags = { ...existingFlags };
  const mergedAliases = { ...existingAliases };

  // Always inject --fresh unless the command already defines it
  if (!("fresh" in mergedFlags)) {
    mergedFlags.fresh = FRESH_FLAG;
  }

  // Inject --cursor unless opted out or already defined
  if (!(options?.noCursorFlag || "cursor" in mergedFlags)) {
    mergedFlags.cursor = LIST_CURSOR_FLAG;
  }

  // Inject -f alias unless opted out or already defined
  if (!(options?.noFreshAlias || "f" in mergedAliases)) {
    mergedAliases.f = "fresh";
  }

  // Inject -c alias unless cursor is opted out or already defined
  if (!(options?.noCursorFlag || "c" in mergedAliases)) {
    mergedAliases.c = "cursor";
  }

  const mergedParams = {
    ...params,
    flags: mergedFlags,
    aliases: mergedAliases,
  };

  // oxlint-disable-next-line typescript/no-explicit-any -- Stricli's CommandFunction type is complex
  const wrappedFunc = function (this: CONTEXT, flags: FLAGS, ...args: any[]) {
    // Auto-apply fresh flag before command runs
    applyFreshFlag(flags as unknown as { readonly fresh: boolean });

    // The first positional arg is always the target (org/project pattern).
    // Intercept it to handle plural alias confusion.
    if (
      args.length > 0 &&
      (typeof args[0] === "string" || args[0] === undefined)
    ) {
      // All list commands use SentryContext which has stderr at top level
      const ctx = this as unknown as { stderr: { write(s: string): void } };
      args[0] = interceptSubcommand(
        args[0] as string | undefined,
        ctx.stderr,
        routeName,
      );
    }
    return originalFunc.call(this, flags, ...(args as unknown as ARGS));
  } as typeof originalFunc;

  return buildCommand({
    ...builderArgs,
    parameters: mergedParams,
    func: wrappedFunc,
    output: builderArgs.output,
  });
}

// ---------------------------------------------------------------------------
// Level D: full command builder for dispatchOrgScopedList-based commands
// ---------------------------------------------------------------------------

/** Documentation for a list command built with `buildOrgListCommand`. */
export type OrgListCommandDocs = CommandDocumentation;

/**
 * Format a {@link ListResult} as human-readable output using the config's
 * `displayTable` function. Handles empty results, headers, table body, and hints.
 *
 * @param result - The list result from a dispatch handler
 * @param config - The OrgListConfig providing the `displayTable` renderer
 * @returns Formatted string for terminal output
 */
function formatListHuman<TEntity, TWithOrg>(
  result: ListResult<TWithOrg>,
  config: OrgListConfig<TEntity, TWithOrg>,
): string {
  const parts: string[] = [];

  if (result.items.length === 0) {
    // Empty result — show the hint (which contains the "No X found" message)
    if (result.hint) {
      parts.push(result.hint);
    }
    return parts.join("\n");
  }

  // Table body
  parts.push(config.displayTable(result.items));

  // Header contains count info like "Showing N items (more available)"
  if (result.header) {
    parts.push(`\n${result.header}`);
  }

  return parts.join("");
}

// JSON transform is shared via jsonTransformListResult in org-list.ts

/**
 * Build a complete Stricli command whose entire `func` body delegates to
 * `dispatchOrgScopedList`.
 *
 * This covers the team and repo list commands, where all runtime behaviour is
 * encapsulated in the shared org-list framework. The resulting command has:
 * - An optional positional `target` argument
 * - `--limit` / `-n`, `--json`, `--fields`, `--cursor` / `-c` flags
 * - A `func` that calls `parseOrgProjectArg` then `dispatchOrgScopedList`
 *
 * Rendering is handled automatically via `OutputConfig`:
 * - JSON mode produces paginated envelopes or flat arrays
 * - Human mode uses the config's `displayTable` function
 *
 * @param config - The `OrgListConfig` that drives fetching and display
 * @param docs   - Brief and optional full description for `--help`
 * @param routeName - Singular route name for subcommand interception
 */
export function buildOrgListCommand<TEntity, TWithOrg>(
  config: OrgListConfig<TEntity, TWithOrg>,
  docs: OrgListCommandDocs,
  routeName: string,
): Command<SentryContext> {
  return buildListCommand(routeName, {
    docs,
    output: {
      human: (result: ListResult<TWithOrg>) => formatListHuman(result, config),
      jsonTransform: (result: ListResult<TWithOrg>, fields?: string[]) =>
        jsonTransformListResult(result, fields),
      schema: config.schema,
    } satisfies OutputConfig<ListResult<TWithOrg>>,
    parameters: {
      positional: LIST_TARGET_POSITIONAL,
      flags: {
        limit: buildListLimitFlag(config.entityPlural),
      },
      aliases: LIST_BASE_ALIASES,
    },
    async *func(
      this: SentryContext,
      flags: {
        readonly limit: number;
        readonly json: boolean;
        readonly cursor?: string;
        readonly fresh: boolean;
        readonly fields?: string[];
      },
      target?: string,
    ) {
      const { cwd } = this;
      const parsed = parseOrgProjectArg(target);
      const result = await dispatchOrgScopedList({
        config,
        cwd,
        flags,
        parsed,
      });
      yield new CommandOutput(result);
      // Only forward hint to the footer when items exist — empty results
      // already render hint text inside the human formatter.
      const hint = result.items.length > 0 ? result.hint : undefined;
      return { hint };
    },
  });
}
