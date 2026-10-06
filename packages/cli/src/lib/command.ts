/**
 * Command builder with telemetry, global flag injection, and output modes.
 *
 * Provides `buildCommand` — the standard command builder for all Sentry CLI
 * commands. It wraps Stricli's `buildCommand` with:
 *
 * 1. **Automatic flag/arg telemetry** — captures flag values and positional
 *    arguments as Sentry span context for observability.
 *
 * 2. **Hidden global logging flags** — injects `--log-level` and `--verbose`
 *    into every command's parameters. These are intercepted before the original
 *    `func` runs: the logger level is set, and the injected flags are stripped
 *    so the original function never sees them. If a command already defines its
 *    own `--verbose` flag (e.g. `api` uses it for HTTP output), the injected
 *    one is skipped and the command's own value is used for both purposes.
 *
 * 3. **Output mode injection** — when `output` has an {@link OutputConfig},
 *    `--json` and `--fields` flags are injected automatically. The command
 *    yields branded `CommandOutput` objects via {@link CommandOutput} and
 *    optionally returns a `{ hint }` footer via {@link CommandReturn}.
 *    Commands that define their own `json` flag keep theirs.
 *
 * ALL commands MUST use `buildCommand` from this module, NOT from
 * `@stricli/core`. Importing directly from Stricli silently bypasses
 * telemetry and global flag handling.
 *
 * ```
 * Correct:   import { buildCommand } from "../../lib/command.js";
 * Incorrect: import { buildCommand } from "@stricli/core";         // skips everything!
 * ```
 */

import {
  type Command,
  type CommandContext,
  buildCommand as stricliCommand,
  numberParser as stricliNumberParser,
} from "@stricli/core";
import type { Writer } from "../types/index.js";
import { appendCacheHint } from "./cache-hint.js";
import { getAuthConfig } from "./db/auth.js";
import { getEnv } from "./env.js";
import { AuthError, CliError, OutputError } from "./errors.js";
import { warning } from "./formatters/colors.js";
import { parseFieldsList } from "./formatters/json.js";
import {
  ClearScreen,
  CommandOutput,
  type CommandReturn,
  extractSchemaFields,
  formatSchemaForHelp,
  type HumanRenderer,
  type OutputConfig,
  renderCommandOutput,
  resolveRenderer,
  writeFooter,
} from "./formatters/output.js";
import { isPlainOutput } from "./formatters/plain-detect.js";
import { GLOBAL_FLAGS } from "./global-flags.js";
import { setInteractivePromptsAllowed } from "./interactive-prompts.js";
import {
  LOG_LEVEL_NAMES,
  type LogLevelName,
  logger,
  parseLogLevel,
  setLogLevel,
} from "./logger.js";
import { setArgsContext, setFlagContext, withTracing } from "./telemetry.js";

/**
 * Parse a string input as a number.
 * Re-exported from Stricli for convenience.
 */
export const numberParser = stricliNumberParser;

/** Base flags type from Stricli */
type BaseFlags = Readonly<Partial<Record<string, unknown>>>;

/** Base args type from Stricli */
type BaseArgs = readonly unknown[];

/**
 * Type-erased Stricli builder arguments.
 *
 * At the `stricliCommand()` call site we've modified both `parameters`
 * (injected hidden flags) and `func` (wrapped with telemetry/output
 * logic), which breaks the original `FLAGS`/`ARGS` generic alignment
 * that Stricli's `CommandBuilderArguments` enforces via `NoInfer`.
 *
 * Rather than silencing with `as any`, we cast through `unknown` to
 * this type that matches Stricli's structural expectations while
 * erasing the generic constraints we can no longer satisfy.
 */
type StricliBuilderArgs<CONTEXT extends CommandContext> =
  import("@stricli/core").CommandBuilderArguments<BaseFlags, BaseArgs, CONTEXT>;

/**
 * Native Stricli documentation. When `customUsage` is present, its first line
 * must be the canonical signature suffix used by introspection and generated
 * docs; later lines may document equivalent forms.
 */
type CommandDocumentation = StricliBuilderArgs<CommandContext>["docs"];

/**
 * Command function type for Sentry CLI commands.
 *
 * ALL command functions are async generators. The framework iterates
 * each yielded value and renders it through the output config.
 *
 * - **Non-streaming**: yield a single `CommandOutput<T>`, optionally
 *   return `{ hint }` for a post-output footer.
 * - **Streaming**: each yield is rendered immediately. Commands that support
 *   `--json` must yield one aggregate value when callers need one parseable
 *   JSON document; individual JSON chunks are pretty-printed, not JSONL.
 * - **Void**: return without yielding for early exits (e.g. `--web`).
 *
 * The return value (`CommandReturn`) is captured by the wrapper and
 * rendered after all yields are consumed. Hints live exclusively on
 * the return value — never on individual yields.
 */
type SentryCommandFunction<
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
 * Arguments for building a command with a local function.
 * This is the subset of Stricli's CommandBuilderArguments that we support.
 */
type LocalCommandBuilderArguments<
  FLAGS extends BaseFlags,
  ARGS extends BaseArgs,
  CONTEXT extends CommandContext,
> = {
  readonly parameters?: Record<string, unknown>;
  readonly docs: CommandDocumentation;
  readonly func: SentryCommandFunction<FLAGS, ARGS, CONTEXT>;
  /**
   * Output configuration — controls flag injection and auto-rendering.
   *
   * When provided, `--json` and `--fields` flags are injected automatically.
   * The command yields `new CommandOutput(data)` and the wrapper handles
   * JSON/human branching. Void yields are ignored.
   *
   * @example
   * ```ts
   * buildCommand({
   *   output: { human: formatUser },
   *   async *func() { yield new CommandOutput(user); },
   * })
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: Variance erasure — OutputConfig<T>.human is contravariant in T, but the builder erases T because it doesn't know the output type. Using `any` allows commands to declare OutputConfig<SpecificType> while the wrapper handles it generically.
  readonly output?: OutputConfig<any>;
  /**
   * Whether the command requires authentication. Defaults to `true`.
   *
   * When `true` (the default), the command throws `AuthError("not_authenticated")`
   * before executing if no credentials exist at all (no token or refresh token
   * in the DB or env vars). Expired tokens with a valid refresh token pass the
   * guard — the API client handles silent refresh. The auto-auth middleware in
   * `cli.ts` catches the error and triggers the login flow.
   *
   * Set to `false` for commands that intentionally work without a token
   * (e.g. `auth login`, `auth logout`, `auth status`, `help`, `cli upgrade`).
   *
   * Set to `"dsn"` for commands that authenticate via a Sentry DSN instead of
   * a Bearer token (e.g. `event send`). These commands skip
   * the token guard and the `.sentryclirc` URL trust check entirely, since
   * DSN auth is fully independent of the user's logged-in session.
   */
  readonly auth?: boolean | "dsn";
  /**
   * Skip the `.sentryclirc` URL trust check. Defaults to `false`.
   *
   * Set to `true` for commands that establish or tear down host trust
   * (`auth login`, `auth logout`) — they must run even when a
   * repo-local `.sentryclirc` URL mismatches the current token.
   */
  readonly skipRcUrlCheck?: boolean;
};

// ---------------------------------------------------------------------------
// Global logging flags
// ---------------------------------------------------------------------------

/**
 * Hidden `--log-level` flag injected into every command by {@link buildCommand}.
 *
 * Accepts one of the valid log level names. Hidden so it doesn't clutter
 * individual command `--help` output — it's documented at the CLI level.
 */
export const LOG_LEVEL_FLAG = {
  kind: "enum" as const,
  values: LOG_LEVEL_NAMES as unknown as LogLevelName[],
  brief: "Set log verbosity level",
  optional: true as const,
  hidden: true as const,
} as const;

/**
 * Hidden `--verbose` flag injected into every command by {@link buildCommand}.
 * Equivalent to `--log-level debug`.
 */
export const VERBOSE_FLAG = {
  kind: "boolean" as const,
  brief: "Enable verbose (debug-level) logging output",
  default: false,
  hidden: true as const,
} as const;

// ---------------------------------------------------------------------------
// JSON output flags (injected when output config is present)
// ---------------------------------------------------------------------------

/**
 * `--json` flag injected by {@link buildCommand} when `output` config is set.
 * Outputs machine-readable JSON instead of human-readable text.
 */
export const JSON_FLAG = {
  kind: "boolean" as const,
  brief: "Output as JSON",
  default: false,
} as const;

/**
 * `--fields` flag injected by {@link buildCommand} when `output` config is set.
 *
 * Accepts a comma-separated list of field paths (dot-notation supported)
 * to include in JSON output. Reduces token consumption for agent workflows.
 *
 * The raw string is **pre-parsed** into a `string[]` by the wrapper before
 * the command's `func` receives it. Commands should declare their flags type
 * as `fields?: string[]` (not `string`).
 *
 * Only meaningful when `--json` is also set — silently ignored otherwise.
 */
export const FIELDS_FLAG = {
  kind: "parsed" as const,
  parse: String,
  brief:
    "Comma-separated fields to include in JSON output (dot.notation supported)",
  optional: true as const,
} as const;

// ---------------------------------------------------------------------------
// Hidden org/project compat flags (LLM error recovery)
// ---------------------------------------------------------------------------

/**
 * Hidden `--org` flag injected into every command by {@link buildCommand}.
 *
 * Backward-compatibility shim for the older `sentry-cli` that accepted
 * `--org` on every command. LLMs trained on the old CLI generate this flag.
 * The value is written to `SENTRY_ORG` so the existing resolution chain
 * in `resolve-target.ts` picks it up at priority #2 (env vars).
 */
const ORG_FLAG = {
  kind: "parsed" as const,
  parse: String,
  brief: "Organization slug",
  optional: true as const,
  hidden: true as const,
} as const;

/**
 * Hidden `--project` flag injected into every command by {@link buildCommand}.
 *
 * Same backward-compatibility shim as `--org`. Written to `SENTRY_PROJECT`
 * before the command's `func` runs.
 */
const PROJECT_FLAG = {
  kind: "parsed" as const,
  parse: String,
  brief: "Project slug",
  optional: true as const,
  hidden: true as const,
} as const;

/** The flag key for the injected --log-level flag (always stripped) */
const LOG_LEVEL_KEY = "log-level";

/**
 * Apply logging flags parsed by Stricli.
 *
 * `--log-level` takes priority over `--verbose`. If neither is specified,
 * the level is left as-is (env var or default).
 *
 * @param logLevel - Value of the `--log-level` flag, if provided
 * @param verbose - Value of the `--verbose` flag
 */
export function applyLoggingFlags(
  logLevel: LogLevelName | undefined,
  verbose: boolean
): void {
  if (logLevel) {
    setLogLevel(parseLogLevel(logLevel));
  } else if (verbose) {
    setLogLevel(parseLogLevel("debug"));
  }
}

const orgProjectLog = logger.withTag("compat-flags");

/**
 * Write `--org` / `--project` flag values to environment variables.
 *
 * Called by the {@link buildCommand} wrapper before the command's `func()`
 * runs. The values are written to `SENTRY_ORG` and `SENTRY_PROJECT` so
 * the existing resolution chain in `resolve-target.ts` picks them up at
 * priority #2 (env vars). Overwrites existing env vars because explicit
 * CLI flags are highest-priority user intent.
 *
 * Empty and whitespace-only values are treated as "not provided" — they
 * fall through to the rest of the resolution chain rather than overwriting
 * a real pre-existing env var with garbage. This matters for LLM-generated
 * commands that occasionally emit `--org ""` or stray whitespace.
 *
 * Skipped when the command defines its own `--org` / `--project` flag
 * (e.g., `release create --project`) — those are passed through to `func()`.
 */
export function applyOrgProjectFlags(
  org: string | undefined,
  project: string | undefined,
  commandOwnsOrg: boolean,
  commandOwnsProject: boolean
): void {
  const env = getEnv();
  const orgTrimmed = commandOwnsOrg ? undefined : org?.trim();
  const projectTrimmed = commandOwnsProject ? undefined : project?.trim();
  if (orgTrimmed) {
    orgProjectLog.debug(`--org flag → SENTRY_ORG=${orgTrimmed}`);
    env.SENTRY_ORG = orgTrimmed;
  }
  if (projectTrimmed) {
    orgProjectLog.debug(`--project flag → SENTRY_PROJECT=${projectTrimmed}`);
    env.SENTRY_PROJECT = projectTrimmed;
  }
}

// ---------------------------------------------------------------------------
// buildCommand — the single entry point for all Sentry CLI commands
// ---------------------------------------------------------------------------

/**
 * Build a Sentry CLI command with telemetry, global flags, and output modes.
 *
 * This is the **only** command builder that should be used. It:
 * 1. Injects hidden `--log-level` and `--verbose` flags into the parameters
 * 2. Intercepts them before the original `func` runs to call `setLogLevel()`
 * 3. Strips injected flags so the original function never sees them
 * 4. Captures flag values and positional arguments as Sentry telemetry context
 * 5. When `output` has an {@link OutputConfig}, injects `--json` and `--fields`
 *    flags, pre-parses `--fields`, and auto-renders the command's `{ data }` return
 * 6. Enforces authentication by default — throws `AuthError("not_authenticated")`
 *    before the command runs if no credentials exist at all (expired tokens with
 *    a refresh token pass through so the API client can silently refresh). Opt out with `auth: false`
 *    for commands that intentionally work without a token (e.g. `auth login`, `help`)
 *
 * When a command already defines its own `verbose` flag (e.g. the `api` command
 * uses `--verbose` for HTTP request/response output), the injected `VERBOSE_FLAG`
 * is skipped. The command's own `verbose` value is still used for log-level
 * side-effects, and it is **not** stripped — the original func receives it as usual.
 *
 * Similarly, when a command already defines its own `json` flag (e.g. for
 * custom brief text), the injected `JSON_FLAG` is skipped. `--fields` is
 * always injected when `output: { human: ... }` regardless.
 *
 * Flag keys use kebab-case because Stricli uses the literal object key as
 * the CLI flag name (e.g. `"log-level"` → `--log-level`).
 *
 * @param builderArgs - Same shape as Stricli's buildCommand arguments,
 *   plus an optional `output` mode
 * @returns A fully-wrapped Stricli Command
 */

/**
 * Build the `--fields` flag definition, enriched with available field names
 * when a schema is registered on the output config.
 */
// biome-ignore lint/suspicious/noExplicitAny: OutputConfig type is erased at the builder level
function buildFieldsFlag(outputConfig?: OutputConfig<any>) {
  if (!outputConfig?.schema) {
    return FIELDS_FLAG;
  }
  const schemaFields = extractSchemaFields(outputConfig.schema);
  if (schemaFields.length === 0) {
    return FIELDS_FLAG;
  }
  const fieldNames = schemaFields.map((f) => f.name).join(", ");
  return {
    ...FIELDS_FLAG,
    brief: `${FIELDS_FLAG.brief}. Available: ${fieldNames}`,
  };
}

/**
 * Enrich command docs with a JSON fields section when a schema is registered.
 * Appends available field names and types to `fullDescription` so they appear
 * in Stricli's `--help` output.
 */
function enrichDocsWithSchema(
  docs: CommandDocumentation,
  // biome-ignore lint/suspicious/noExplicitAny: OutputConfig type is erased at the builder level
  outputConfig?: OutputConfig<any>
): CommandDocumentation {
  if (!outputConfig?.schema) {
    return docs;
  }
  const schemaFields = extractSchemaFields(outputConfig.schema);
  if (schemaFields.length === 0) {
    return docs;
  }
  const jsonFieldsDoc = formatSchemaForHelp(schemaFields);
  const baseFull = docs.fullDescription ?? docs.brief;
  return {
    ...docs,
    fullDescription: `${baseFull}\n\n${jsonFieldsDoc}`,
  };
}

/**
 * Global flag defaults keyed by flag name.
 * Used by {@link mergeGlobalFlags} to inject flags when the command
 * doesn't define its own.
 */
const GLOBAL_FLAG_DEFAULTS: Record<string, unknown> = {
  [LOG_LEVEL_KEY]: LOG_LEVEL_FLAG,
  verbose: VERBOSE_FLAG,
  org: ORG_FLAG,
  project: PROJECT_FLAG,
};

/** Flags that are always stripped (command never sees them). */
const ALWAYS_STRIP = new Set([LOG_LEVEL_KEY]);

/**
 * Merge global flags into a command's existing flags.
 *
 * For each global flag, if the command doesn't already define it, the
 * default shape is injected and its key is added to the returned
 * `stripKeys` set (so the wrapper strips it before calling `func`).
 *
 * @returns The merged flags, ownership booleans, and keys to strip.
 */
function mergeGlobalFlags(
  existingFlags: Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: OutputConfig type is erased at the builder level
  outputConfig?: OutputConfig<any>
): {
  mergedFlags: Record<string, unknown>;
  commandOwnsOrg: boolean;
  commandOwnsProject: boolean;
  stripKeys: Set<string>;
} {
  const commandOwnsJson = "json" in existingFlags;
  const commandOwnsOrg = "org" in existingFlags;
  const commandOwnsProject = "project" in existingFlags;

  const mergedFlags: Record<string, unknown> = { ...existingFlags };
  const stripKeys = new Set<string>(ALWAYS_STRIP);

  for (const [name, shape] of Object.entries(GLOBAL_FLAG_DEFAULTS)) {
    if (!(name in existingFlags)) {
      mergedFlags[name] = shape;
      stripKeys.add(name);
    }
  }

  // Inject --json and --fields when output config is set
  if (outputConfig) {
    if (!commandOwnsJson) {
      mergedFlags.json = JSON_FLAG;
    }
    mergedFlags.fields = buildFieldsFlag(outputConfig);
  }

  return {
    mergedFlags,
    commandOwnsOrg,
    commandOwnsProject,
    stripKeys,
  };
}

export function buildCommand<
  const FLAGS extends BaseFlags = NonNullable<unknown>,
  const ARGS extends BaseArgs = [],
  const CONTEXT extends CommandContext = CommandContext,
>(
  builderArgs: LocalCommandBuilderArguments<FLAGS, ARGS, CONTEXT>
): Command<CONTEXT> {
  const originalFunc = builderArgs.func;
  const outputConfig = builderArgs.output;
  const requiresAuth = builderArgs.auth !== false && builderArgs.auth !== "dsn";
  const skipRcUrlCheck =
    builderArgs.skipRcUrlCheck === true || builderArgs.auth === "dsn";

  // Merge global flags into the command's flag definitions.
  const existingParams = (builderArgs.parameters ?? {}) as Record<
    string,
    unknown
  >;
  const existingFlags = (existingParams.flags ?? {}) as Record<string, unknown>;

  const { mergedFlags, commandOwnsOrg, commandOwnsProject, stripKeys } =
    mergeGlobalFlags(existingFlags, outputConfig);

  // Enrich fullDescription with JSON fields when schema is registered.
  // This makes field info visible in Stricli's --help output.
  const enrichedDocs = enrichDocsWithSchema(builderArgs.docs, outputConfig);

  // Inject short aliases for global flags (e.g., -v → --verbose).
  // Derived from the shared GLOBAL_FLAGS definition so adding a new
  // global flag with a short alias automatically propagates here.
  const existingAliases = (existingParams.aliases ?? {}) as Record<
    string,
    unknown
  >;
  const mergedAliases: Record<string, unknown> = { ...existingAliases };
  for (const gf of GLOBAL_FLAGS) {
    if (gf.short && !(gf.name in existingFlags || gf.short in mergedAliases)) {
      mergedAliases[gf.short] = gf.name;
    }
  }

  const mergedParams = {
    ...existingParams,
    flags: mergedFlags,
    aliases: mergedAliases,
  };

  /**
   * If the yielded value is a {@link CommandOutput}, render it via
   * the output config. Void/undefined/Error/other values are ignored.
   */
  /** Pending clear-screen — set by ClearScreen token, consumed by next render. */
  let pendingClear = false;

  function handleYieldedValue(
    stdout: Writer,
    value: unknown,
    flags: Record<string, unknown>,
    // biome-ignore lint/suspicious/noExplicitAny: Renderer type mirrors erased OutputConfig<T>
    renderer?: HumanRenderer<any>
  ): void {
    // ClearScreen token: defer until next render to avoid flash
    if (value instanceof ClearScreen) {
      if (!(isPlainOutput() || flags.json)) {
        pendingClear = true;
      }
      return;
    }

    if (!(outputConfig && renderer && value instanceof CommandOutput)) {
      return;
    }

    renderCommandOutput(stdout, value.data, outputConfig, renderer, {
      json: Boolean(flags.json),
      fields: flags.fields as string[] | undefined,
      clearPrefix: pendingClear ? "\x1b[H\x1b[J" : undefined,
    });
    pendingClear = false;
  }

  /**
   * Strip injected flags from the raw Stricli-parsed flags object.
   * Global flags we injected (tracked in `stripKeys` from
   * {@link mergeGlobalFlags}) are removed. --fields is pre-parsed from
   * comma-string to string[] when output: { human: ... }.
   */
  function cleanRawFlags(
    raw: Record<string, unknown>
  ): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (stripKeys.has(key)) {
        continue;
      }
      clean[key] = value;
    }
    if (outputConfig && typeof clean.fields === "string") {
      clean.fields = parseFieldsList(clean.fields);
    }
    return clean;
  }

  /**
   * Write post-generator output: either the renderer's `finalize()` result
   * or the default `writeFooter(hint)`. Suppressed in JSON mode.
   */
  function writeFinalization(
    stdout: Writer,
    hint: string | undefined,
    json: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: Renderer type mirrors erased OutputConfig<T>
    renderer?: HumanRenderer<any>
  ): void {
    if (json) {
      return;
    }
    if (renderer?.finalize) {
      const text = renderer.finalize(hint);
      if (text) {
        stdout.write(text);
      }
      return;
    }
    if (hint) {
      writeFooter(stdout, hint);
    }
  }

  /**
   * When a command throws a {@link CliError} and a positional arg was
   * `"help"`, `"--h"`, or `"-help"`, the user likely intended `--help`.
   * Show the command's help instead of the confusing error.
   *
   * Only fires as **error recovery** — if the command succeeds with a
   * legitimate value like a project named "help", this never runs.
   *
   * Catches all {@link CliError} subtypes (AuthError, ResolutionError,
   * ValidationError, ContextError, etc.) because any failure with "help"
   * as input strongly signals the user wanted `--help`. For example,
   * `sentry issue list help` may throw AuthError (not logged in) before
   * ever reaching project resolution.
   *
   * {@link OutputError} is excluded — it carries legitimate data to render
   * (the "HTTP 404 body" pattern) and must fall through to `handleOutputError`.
   *
   * @returns `true` if help was shown and the error was recovered
   */
  async function maybeRecoverWithHelp(
    err: unknown,
    stdout: Writer,
    ctx: { commandPrefix?: readonly string[]; stderr: Writer },
    args: unknown[]
  ): Promise<boolean> {
    if (!(err instanceof CliError) || err instanceof OutputError) {
      return false;
    }
    if (
      args.length === 0 ||
      !args.some((a) => a === "help" || a === "--h" || a === "-help")
    ) {
      return false;
    }
    if (!ctx.commandPrefix) {
      return false;
    }
    const pathSegments = ctx.commandPrefix.slice(1); // strip "sentry" prefix
    // Dynamic import to avoid circular: command.ts → help.ts → app.ts → commands → command.ts
    const { introspectCommand, formatHelpHuman } = await import("./help.js");
    const result = introspectCommand(pathSegments);
    if ("error" in result) {
      return false;
    }
    ctx.stderr.write(
      warning(
        `Tip: use --help for help (e.g., sentry ${pathSegments.join(" ")} --help)\n\n`
      )
    );
    stdout.write(`${formatHelpHuman(result)}\n`);
    return true;
  }

  // Wrap func to intercept logging flags, capture telemetry, then call original.
  // The wrapper is an async function that iterates the generator returned by func.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Central framework wrapper — flag cleanup, env-based JSON, output rendering, and error handling are all tightly coupled.
  const wrappedFunc = async function (
    this: CONTEXT,
    flags: Record<string, unknown>,
    ...args: unknown[]
  ) {
    applyLoggingFlags(
      flags[LOG_LEVEL_KEY] as LogLevelName | undefined,
      flags.verbose as boolean
    );

    // Map --org / --project compat flags to env vars before anything
    // else reads them (auth guard, org/project resolution, etc.)
    applyOrgProjectFlags(
      flags.org as string | undefined,
      flags.project as string | undefined,
      commandOwnsOrg,
      commandOwnsProject
    );

    const cleanFlags = cleanRawFlags(flags as Record<string, unknown>);
    setFlagContext(cleanFlags);
    if (args.length > 0) {
      setArgsContext(args);
    }

    // Environment-based JSON mode (used by library entry point)
    if (outputConfig && !cleanFlags.json) {
      const env = (this as unknown as { env?: NodeJS.ProcessEnv }).env;
      if (env?.SENTRY_OUTPUT_FORMAT === "json") {
        cleanFlags.json = true;
      }
    }

    // Suppress prompts when parsed command flags require unattended or
    // machine-readable execution. Using parsed flags avoids confusing aliases
    // such as list command `-n` (limit) with init's `-n` (dry-run).
    setInteractivePromptsAllowed(
      !(
        cleanFlags.json === true ||
        cleanFlags.yes === true ||
        cleanFlags["dry-run"] === true
      )
    );

    const stdout = (this as unknown as { stdout: Writer }).stdout;

    // Reset per-invocation state
    pendingClear = false;

    // Resolve the human renderer once per invocation. Factory creates
    // fresh per-invocation state for streaming commands.
    const renderer = outputConfig
      ? resolveRenderer(outputConfig.human)
      : undefined;

    // OutputError handler: render data through the output system, then
    // re-throw so the exit code propagates. Stricli's
    // exceptionWhileRunningCommand intercepts OutputError and re-throws
    // it without formatting, so both bin.ts and index.ts can set
    // exitCode from the caught error.
    const handleOutputError = (err: unknown): never => {
      if (err instanceof OutputError && outputConfig) {
        // Only render if there's actual data to show
        if (err.data !== null && err.data !== undefined) {
          handleYieldedValue(
            stdout,
            new CommandOutput(err.data),
            cleanFlags,
            renderer
          );
        }
        throw err;
      }
      throw err;
    };

    // Iterate the generator using manual .next() instead of for-await-of
    // so we can capture the return value (done: true result). The return
    // value carries the final `hint` — for-await-of discards it.
    //
    // Auth guard is inside the try block so that maybeRecoverWithHelp can
    // intercept the AuthError when "help" appears as a positional arg (e.g.
    // `sentry issue list help`). Without this, the auth prompt would fire
    // before the help-recovery path could show the command's help text.
    try {
      if (requiresAuth && !getAuthConfig()) {
        throw new AuthError("not_authenticated");
      }

      // Validate rc-sourced URL against the active token's host. Deferred
      // to here (instead of boot) so commands can opt out via skipRcUrlCheck.
      if (!skipRcUrlCheck && "cwd" in this) {
        const { assertRcUrlTrusted } = await import("./sentryclirc.js");
        await assertRcUrlTrusted(this.cwd as string);
      }

      // Execution phase: core command logic, API calls, org/project resolution
      const returned = await withTracing(
        "exec",
        "cli.command.exec",
        async () => {
          const generator = originalFunc.call(
            this,
            cleanFlags as FLAGS,
            ...(args as unknown as ARGS)
          );
          let result = await generator.next();
          while (!result.done) {
            handleYieldedValue(stdout, result.value, cleanFlags, renderer);
            result = await generator.next();
          }
          return result.value as CommandReturn | undefined;
        }
      );

      // Render phase: output finalization.
      // Append cache-age hint automatically so every command gets
      // "cached · 3m ago · use -f to refresh" when data was cached.
      // Skip bare `return;` paths (e.g. `--web` which opens a browser
      // without yielding) — no rendered output should mean no footer.
      const finalHint = returned ? appendCacheHint(returned.hint) : undefined;
      await withTracing("render", "cli.command.render", () => {
        writeFinalization(stdout, finalHint, cleanFlags.json, renderer);
      });
    } catch (err) {
      // Finalize before error handling to close streaming state
      // (e.g., table footer). No hint since the generator didn't
      // complete. Only in human mode — JSON must not be corrupted.
      if (!cleanFlags.json) {
        writeFinalization(stdout, undefined, false, renderer);
      }

      // If a positional arg was "help" and the command failed with a
      // resolution/validation error, the user likely meant --help.
      // Show help as recovery instead of the confusing error.
      const recovered = await maybeRecoverWithHelp(
        err,
        stdout,
        this as unknown as {
          commandPrefix?: readonly string[];
          stderr: Writer;
        },
        args
      );
      if (recovered) {
        return;
      }

      handleOutputError(err);
    }
  };

  // Build the command with the wrapped function via Stricli.
  // The cast is necessary because we modify both `parameters` (injecting
  // hidden flags) and `func` (wrapping with telemetry/output logic),
  // which breaks the original FLAGS/ARGS type alignment that Stricli's
  // `CommandBuilderArguments` enforces via `NoInfer`.
  const cmd = stricliCommand({
    ...builderArgs,
    docs: enrichedDocs,
    parameters: mergedParams,
    func: wrappedFunc,
  } as unknown as StricliBuilderArgs<CONTEXT>);

  // Stricli uses customUsage for native help but does not expose it on the
  // built command. Preserve its primary line for introspection consumers.
  const primaryUsage = enrichedDocs.customUsage?.[0];
  if (primaryUsage) {
    (cmd as unknown as Record<string, unknown>).__primaryUsage =
      typeof primaryUsage === "string" ? primaryUsage : primaryUsage.input;
  }

  // Attach the JSON schema to the built command as a non-standard property.
  // introspect.ts reads this to populate CommandInfo.jsonFields for help
  // output and SKILL.md generation.
  if (outputConfig?.schema) {
    (cmd as unknown as Record<string, unknown>).__jsonSchema =
      outputConfig.schema;
  }

  // Expose the unwrapped generator for internal dispatchers (e.g. bare
  // `sentry auth`) that must run a subcommand without re-entering the
  // telemetry / auth-guard / rc-trust / output pipeline.
  (cmd as unknown as Record<string, unknown>).__rawFunc = originalFunc;

  return cmd;
}
