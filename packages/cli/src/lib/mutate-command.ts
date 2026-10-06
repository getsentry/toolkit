/**
 * Shared building blocks for mutation (create/delete) commands.
 *
 * Provides reusable Stricli parameter definitions, safety utilities, and a
 * `buildDeleteCommand` wrapper — paralleling `list-command.ts` for list commands.
 *
 * Level A — shared constants (used by create and delete commands):
 *   DRY_RUN_FLAG, YES_FLAG, FORCE_FLAG,
 *   DESTRUCTIVE_FLAGS, DESTRUCTIVE_ALIASES, DRY_RUN_ALIASES
 *
 * Level B — shared utilities:
 *   isConfirmationBypassed, guardNonInteractive, confirmByTyping,
 *   requireExplicitTarget
 *
 * Level C — delete command builder:
 *   buildDeleteCommand
 */

import { isatty } from "node:tty";
import type { Command, CommandContext } from "@stricli/core";
import type { ParsedOrgProject } from "./arg-parsing.js";
import { buildCommand } from "./command.js";
import { CliError, ContextError } from "./errors.js";
import type { CommandReturn } from "./formatters/output.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Level A: shared flag / alias definitions
// ---------------------------------------------------------------------------

/**
 * Standard `--dry-run` flag for mutation commands.
 *
 * Shows what would happen without making changes. Used by both create commands
 * (preview the resource to be created) and delete commands (preview what would
 * be deleted).
 *
 * @example
 * ```ts
 * import { DRY_RUN_FLAG, DRY_RUN_ALIASES } from "../../lib/mutate-command.js";
 *
 * // In parameters:
 * flags: { "dry-run": DRY_RUN_FLAG, team: { ... } },
 * aliases: { ...DRY_RUN_ALIASES, t: "team" },
 * ```
 */
export const DRY_RUN_FLAG = {
  kind: "boolean" as const,
  brief: "Show what would happen without making changes",
  default: false,
} as const;

/**
 * Standard `--yes` / `-y` flag for delete commands.
 * Skips the interactive confirmation prompt.
 */
export const YES_FLAG = {
  kind: "boolean" as const,
  brief: "Skip confirmation prompt",
  default: false,
} as const;

/**
 * Standard `--force` / `-f` flag for delete commands.
 * Forces the operation without confirmation — alias for `--yes` with a
 * different mental model ("force it through" vs "yes I confirm").
 */
export const FORCE_FLAG = {
  kind: "boolean" as const,
  brief: "Force the operation without confirmation",
  default: false,
} as const;

/**
 * Spreadable flag bundle for destructive commands: `--yes`, `--force`, `--dry-run`.
 *
 * Spread into a command's `flags` alongside command-specific flags:
 * ```ts
 * flags: { ...DESTRUCTIVE_FLAGS, index: { ... } },
 * ```
 *
 * Prefer using `buildDeleteCommand()` which auto-injects these with a
 * non-interactive safety guard.
 */
export const DESTRUCTIVE_FLAGS = {
  yes: YES_FLAG,
  force: FORCE_FLAG,
  "dry-run": DRY_RUN_FLAG,
} as const;

/**
 * Standard aliases for destructive commands: `-y` → `--yes`, `-f` → `--force`,
 * `-n` → `--dry-run`.
 *
 * Spread into a command's `aliases` alongside command-specific aliases:
 * ```ts
 * aliases: { ...DESTRUCTIVE_ALIASES, i: "index" },
 * ```
 *
 * **Note**: Commands that use `-f` for a different flag should NOT spread this
 * constant — define aliases individually instead.
 */
export const DESTRUCTIVE_ALIASES = {
  y: "yes",
  f: "force",
  n: "dry-run",
} as const;

/**
 * Alias map for `--dry-run` only: `-n` → `--dry-run`.
 *
 * Used by create commands that need only the dry-run flag (not yes/force):
 * ```ts
 * aliases: { ...DRY_RUN_ALIASES, t: "team" }
 * ```
 */
export const DRY_RUN_ALIASES = { n: "dry-run" } as const;

/**
 * Alias map for `--yes` only: `-y` → `--yes`.
 *
 * Used by non-delete commands that need only the yes flag (not force):
 * ```ts
 * aliases: { ...YES_ALIASES, t: "team" }
 * ```
 */
export const YES_ALIASES = { y: "yes" } as const;

// ---------------------------------------------------------------------------
// Level B: shared utilities
// ---------------------------------------------------------------------------

/**
 * Check whether `--yes` or `--force` was passed.
 *
 * Convenience for the common `if (flags.yes || flags.force)` pattern used
 * before calling {@link confirmByTyping}.
 */
export function isConfirmationBypassed(flags: {
  readonly yes?: boolean;
  readonly force?: boolean;
}): boolean {
  return Boolean(flags.yes || flags.force);
}

/**
 * Guard against running destructive operations in non-interactive mode
 * without explicit confirmation.
 *
 * Throws {@link CliError} if stdin is not a TTY and neither `--yes`/`--force`
 * was passed and `--dry-run` is not set. Dry-run is always safe to run
 * non-interactively since it makes no changes.
 *
 * Used internally by {@link buildDeleteCommand} as a pre-hook. Exported for
 * commands not using the wrapper (e.g., create commands with confirmation).
 */
export function guardNonInteractive(flags: {
  readonly yes?: boolean;
  readonly force?: boolean;
  readonly "dry-run"?: boolean;
}): void {
  if (flags["dry-run"] || isConfirmationBypassed(flags)) {
    return;
  }
  if (!isatty(0)) {
    throw new CliError(
      "Destructive operation refused in non-interactive mode. " +
        "Use --yes or --force to confirm."
    );
  }
}

/**
 * Prompt for type-out confirmation before a destructive operation.
 *
 * The user must type the exact `expected` string to confirm. Returns `false`
 * if the user cancels (Ctrl+C) or types something else.
 *
 * Does **not** include a non-interactive guard — that's handled by
 * {@link buildDeleteCommand}'s pre-hook or by calling {@link guardNonInteractive}
 * directly.
 *
 * @param expected - The string the user must type to confirm (e.g., "acme/my-app")
 * @param promptMessage - The message displayed to the user
 * @param opts - Optional logger override (defaults to the global logger)
 * @returns `true` if confirmed, `false` if cancelled or mismatched
 *
 * @example
 * ```ts
 * if (!isConfirmationBypassed(flags)) {
 *   const confirmed = await confirmByTyping(
 *     `${orgSlug}/${project.slug}`,
 *     `Type '${orgSlug}/${project.slug}' to permanently delete project '${project.name}':`
 *   );
 *   if (!confirmed) return;
 * }
 * ```
 */
export async function confirmByTyping(
  expected: string,
  promptMessage: string,
  opts?: { logger?: { prompt: typeof logger.prompt } }
): Promise<boolean> {
  const log = opts?.logger ?? logger;

  const response = await log.prompt(promptMessage, {
    type: "text",
    placeholder: expected,
  });

  // consola prompt returns Symbol(clack:cancel) on Ctrl+C — a truthy value.
  // Check type to avoid treating cancel as a valid response.
  if (typeof response !== "string") {
    return false;
  }

  return response.trim() === expected;
}

/**
 * Block auto-detect target for destructive operations.
 *
 * Destructive commands should require explicit targets to prevent accidental
 * modification. Throws {@link ContextError} if the parsed target is "auto-detect"
 * (i.e., the user didn't provide a target at all).
 *
 * @param parsed - The parsed org/project argument
 * @param entityType - What is being targeted (e.g., "Project target", "Dashboard")
 * @param usageHint - Single-line CLI usage example (e.g., "sentry project delete <org>/<project>")
 */
export function requireExplicitTarget(
  parsed: ParsedOrgProject,
  entityType: string,
  usageHint: string
): void {
  if (parsed.type === "auto-detect") {
    throw new ContextError(entityType, usageHint, [
      "Auto-detection is disabled for destructive operations — specify the target explicitly",
    ]);
  }
}

// ---------------------------------------------------------------------------
// Level C: delete command builder
// ---------------------------------------------------------------------------

/** Base flags type (mirrors command.ts) */
type BaseFlags = Readonly<Partial<Record<string, unknown>>>;

/** Base args type (mirrors command.ts) */
type BaseArgs = readonly unknown[];

/**
 * Command function type that returns an async generator.
 *
 * Mirrors `SentryCommandFunction` from `command.ts`.
 */
type DeleteCommandFunction<
  FLAGS extends BaseFlags,
  ARGS extends BaseArgs,
  CONTEXT extends CommandContext,
> = (
  this: CONTEXT,
  flags: FLAGS,
  ...args: ARGS
  // biome-ignore lint/suspicious/noConfusingVoidType: void is required here — generators that don't return a value have implicit void return, which is distinct from undefined in TypeScript's type system
) => AsyncGenerator<unknown, CommandReturn | void, undefined>;

/**
 * Options for controlling which flags {@link buildDeleteCommand} auto-injects.
 *
 * By default, `buildDeleteCommand` adds `--yes`, `--force`, `--dry-run`, and
 * their aliases (`-y`, `-f`, `-n`) plus a non-interactive safety guard.
 * Use these options to opt out when a command has conflicts or doesn't need
 * specific flags.
 */
export type DeleteCommandOptions = {
  /** Skip injecting `--force` flag and `-f` alias. */
  noForceFlag?: boolean;
  /** Skip injecting `--dry-run` flag and `-n` alias. */
  noDryRunFlag?: boolean;
  /** Skip the non-interactive safety guard pre-hook. */
  noNonInteractiveGuard?: boolean;
};

/**
 * Build a Stricli command for a destructive operation with automatic safety
 * flag injection and a non-interactive guard.
 *
 * This is a drop-in replacement for `buildCommand` that:
 * 1. Auto-injects `--yes`, `--force`, and `--dry-run` flags (unless already
 *    defined, controlled by `options`)
 * 2. Auto-injects `-y`, `-f`, `-n` aliases (skips if key already taken)
 * 3. Runs a non-interactive guard before `func()` — refuses to proceed if
 *    stdin is not a TTY and neither `--yes`/`--force` was passed (dry-run
 *    bypasses the guard since it makes no changes)
 *
 * Commands still handle their own confirmation prompts using
 * {@link confirmByTyping} + {@link isConfirmationBypassed} inside `func()`,
 * since the prompt depends on data resolved during execution.
 *
 * Mirrors {@link import("./list-command.js").buildListCommand} for list commands.
 *
 * @param builderArgs - Same arguments as `buildCommand` from `lib/command.js`
 * @param options - Control which flags are auto-injected
 *
 * @example
 * ```ts
 * export const deleteCommand = buildDeleteCommand({
 *   docs: { brief: "Delete a widget" },
 *   output: { human: formatWidgetDeleted },
 *   parameters: {
 *     positional: { ... },
 *     flags: { index: { ... } },
 *     aliases: { i: "index" },
 *   },
 *   async *func(this: SentryContext, flags, ...args) {
 *     // --yes, --force, --dry-run are available on flags
 *     if (flags["dry-run"]) { yield preview; return; }
 *     if (!isConfirmationBypassed(flags)) {
 *       if (!await confirmByTyping(expected, message)) return;
 *     }
 *     await doDelete();
 *   },
 * });
 * ```
 */
export function buildDeleteCommand<
  const FLAGS extends BaseFlags = NonNullable<unknown>,
  const ARGS extends readonly unknown[] = [],
  const CONTEXT extends CommandContext = CommandContext,
>(
  builderArgs: {
    readonly parameters?: Record<string, unknown>;
    readonly docs: {
      readonly brief: string;
      readonly fullDescription?: string;
    };
    readonly func: DeleteCommandFunction<FLAGS, ARGS, CONTEXT>;
    // biome-ignore lint/suspicious/noExplicitAny: OutputConfig is generic but type is erased at the builder level
    readonly output?: import("./formatters/output.js").OutputConfig<any>;
    readonly auth?: boolean;
  },
  options?: DeleteCommandOptions
): Command<CONTEXT> {
  const originalFunc = builderArgs.func;

  // Auto-inject common flags and aliases into parameters
  const params = (builderArgs.parameters ?? {}) as Record<string, unknown>;
  const existingFlags = (params.flags ?? {}) as Record<string, unknown>;
  const existingAliases = (params.aliases ?? {}) as Record<string, string>;

  const mergedFlags = { ...existingFlags };
  const mergedAliases = { ...existingAliases };

  // Always inject --yes unless the command already defines it
  if (!("yes" in mergedFlags)) {
    mergedFlags.yes = YES_FLAG;
  }

  // Inject --force unless opted out or already defined
  if (!(options?.noForceFlag || "force" in mergedFlags)) {
    mergedFlags.force = FORCE_FLAG;
  }

  // Inject --dry-run unless opted out or already defined
  if (!(options?.noDryRunFlag || "dry-run" in mergedFlags)) {
    mergedFlags["dry-run"] = DRY_RUN_FLAG;
  }

  // Inject -y alias unless already defined
  if (!("y" in mergedAliases)) {
    mergedAliases.y = "yes";
  }

  // Inject -f alias unless force is opted out or already defined
  if (!(options?.noForceFlag || "f" in mergedAliases)) {
    mergedAliases.f = "force";
  }

  // Inject -n alias unless dry-run is opted out or already defined
  if (!(options?.noDryRunFlag || "n" in mergedAliases)) {
    mergedAliases.n = "dry-run";
  }

  const mergedParams = {
    ...params,
    flags: mergedFlags,
    aliases: mergedAliases,
  };

  // biome-ignore lint/suspicious/noExplicitAny: Stricli's CommandFunction type is complex
  const wrappedFunc = function (this: CONTEXT, flags: FLAGS, ...args: any[]) {
    // Pre-hook: non-interactive safety guard
    if (!options?.noNonInteractiveGuard) {
      guardNonInteractive(
        flags as unknown as {
          yes?: boolean;
          force?: boolean;
          "dry-run"?: boolean;
        }
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
