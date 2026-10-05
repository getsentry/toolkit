/**
 * Direct command invocation for the typed SDK layer.
 *
 * Resolves commands from the Stricli route tree and calls their wrapped
 * handler functions directly — no string parsing, no route scanning.
 *
 * Also provides `buildRunner()` — the variadic `run()` escape hatch
 * that accepts CLI argument strings and routes them through Stricli.
 *
 * Both `buildInvoker` and `buildRunner` share the same env isolation,
 * telemetry, zero-copy capture, and error wrapping guarantees via the
 * `executeWithCapture` helper.
 *
 * @module
 */

import { homedir } from "node:os";
import type { Span } from "@sentry/core";
import type { Writer } from "../types/index.js";
import { type AsyncChannel, createAsyncChannel } from "./async-channel.js";
import { setEnv } from "./env.js";
import { SentryError, type SentryOptions } from "./sdk-types.js";

/** CLI flag names/aliases that trigger infinite streaming output. */
const STREAMING_FLAG_NAMES = new Set(["--refresh", "--follow", "-f"]);

/** Check if CLI args contain any streaming flag. */
function hasStreamingFlag(args: string[]): boolean {
  return args.some((arg) => STREAMING_FLAG_NAMES.has(arg));
}

/**
 * Build an isolated env from options, inheriting the consumer's process.env.
 * Sets auth token, host URL, default org/project, and output format.
 */
function buildIsolatedEnv(
  options?: SentryOptions,
  jsonByDefault = true
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options?.token) {
    env.SENTRY_AUTH_TOKEN = options.token;
    env.SENTRY_FORCE_ENV_TOKEN = "1";
  }
  if (options?.url) {
    env.SENTRY_HOST = options.url;
  }
  if (options?.org) {
    env.SENTRY_ORG = options.org;
  }
  if (options?.project) {
    env.SENTRY_PROJECT = options.project;
  }
  if (jsonByDefault && !options?.text) {
    env.SENTRY_OUTPUT_FORMAT = "json";
  }
  return env;
}

/** Type alias for command handler functions loaded from Stricli's route tree. */
type CommandHandler = (...args: unknown[]) => unknown;

/**
 * Stricli flag definition shape — subset needed for default application.
 *
 * The SDK invoke path bypasses Stricli's `buildArgumentScanner`, so parsed
 * flags with defaults never have their `parse` function called on the default
 * string. We capture the flag definitions here so {@link applyFlagDefaults}
 * can replicate that behavior at invocation time.
 */
export type FlagDef = {
  kind: string;
  default?: unknown;
  optional?: boolean;
  parse?: (value: string) => unknown;
  variadic?: boolean;
};

/** Resolved command: handler function + flag definitions for default application. */
type ResolvedCommand = {
  handler: CommandHandler;
  flagDefs: Record<string, FlagDef>;
};

/** Cached command entries, keyed by joined path (e.g., "org.list"). */
const commandCache = new Map<
  string,
  { loader: () => Promise<CommandHandler>; flagDefs: Record<string, FlagDef> }
>();

/**
 * Resolve a command from the route tree by path segments.
 * Returns both the handler function and the command's flag definitions.
 * Result is cached — route tree is only walked once per command.
 */
async function resolveCommand(path: string[]): Promise<ResolvedCommand> {
  const key = path.join(".");
  let cached = commandCache.get(key);
  if (!cached) {
    const { routes } = await import("../app.js");
    // Walk route tree: routes → sub-route → command
    // biome-ignore lint/suspicious/noExplicitAny: Stricli's RoutingTarget union requires runtime duck-typing
    let target: any = routes;
    for (const segment of path) {
      target = target.getRoutingTargetForInput(segment);
      if (!target) {
        throw new Error(`SDK: command not found: ${path.join(" ")}`);
      }
    }
    // target is now a Command — extract flag definitions and cache loader
    const command = target;
    const flagDefs: Record<string, FlagDef> = command.parameters?.flags ?? {};
    cached = {
      loader: () =>
        command.loader().then(
          // biome-ignore lint/suspicious/noExplicitAny: Stricli CommandModule shape has a default export
          (m: any) => (typeof m === "function" ? m : m.default)
        ),
      flagDefs,
    };
    commandCache.set(key, cached);
  }
  return { handler: await cached.loader(), flagDefs: cached.flagDefs };
}

/**
 * Resolve the default value for a single flag definition.
 *
 * For `kind: "parsed"` flags with a string default, calls `flag.parse(flag.default)`
 * to replicate Stricli's `parseInput` behavior. For all other flag kinds (boolean,
 * enum, counter), returns the raw default value.
 *
 * @returns The resolved default, or `undefined` if no default is defined.
 * @throws Re-throws if `flag.parse(flag.default)` fails — a parse function
 *   that rejects its own default is a command definition bug, not a runtime error.
 */
function resolveFlagDefault(def: FlagDef): unknown {
  if (!("default" in def) || def.default === undefined) {
    return;
  }
  if (
    def.kind === "parsed" &&
    typeof def.default === "string" &&
    typeof def.parse === "function"
  ) {
    return def.parse(def.default);
  }
  return def.default;
}

/**
 * Apply Stricli flag defaults for any missing or undefined flag values.
 *
 * The SDK invoke path bypasses Stricli's `buildArgumentScanner`, so parsed
 * flags with defaults (e.g., `period: { kind: "parsed", parse: parsePeriod,
 * default: "7d" }`) never have their `parse` function called on the default
 * string. This function replicates that behavior:
 *
 * - For `kind: "parsed"` flags with a string `default`, calls `flag.parse(flag.default)`
 *   (same as Stricli's `parseInput` path in `parseInputsForFlag`).
 * - For `kind: "boolean"` / `kind: "enum"` flags with a `default`, uses the raw value.
 * - Skips flags already set (non-`undefined`) by the caller.
 *
 * @param flags - The flags object from the SDK caller (may have `undefined` values).
 * @param flagDefs - The command's Stricli flag definitions.
 * @returns A new flags object with defaults applied.
 */
export function applyFlagDefaults(
  flags: Record<string, unknown>,
  flagDefs: Record<string, FlagDef>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Copy caller-provided flags, skipping undefined values so they
  // don't shadow the defaults we're about to apply.
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // Apply defaults for any flag not already set by the caller
  for (const [name, def] of Object.entries(flagDefs)) {
    if (name in result) {
      continue;
    }
    const resolved = resolveFlagDefault(def);
    if (resolved !== undefined) {
      result[name] = resolved;
    }
  }
  return result;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences use ESC (0x1b)
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Install the structured `headers` option for this invocation.
 *
 * Lazy import: `custom-headers.ts` pulls in the SQLite defaults module, which
 * must not load when the SDK is merely imported.
 */
async function applyHeadersOption(
  headers: Record<string, string> | undefined
): Promise<void> {
  const { setCustomHeadersOverride } = await import("./custom-headers.js");
  setCustomHeadersOverride(headers);
}

/** Flush Sentry telemetry (no beforeExit handler in library mode). */
async function flushTelemetry(): Promise<void> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const Sentry = await import("@sentry/node-core/light");
    const client = Sentry.getClient();
    if (client) {
      await client.flush(3000);
    }
  } catch {
    // Telemetry flush is non-critical
  }
}

/** Build a SentryError from captured stderr and a thrown error or exit code. */
function buildSdkError(
  stderrChunks: string[],
  exitCode: number,
  thrown?: unknown
): SentryError {
  const stderrStr = stderrChunks.join("");
  const message =
    stderrStr.replace(ANSI_RE, "").trim() ||
    (thrown instanceof Error ? thrown.message : undefined) ||
    (thrown !== undefined ? String(thrown) : undefined) ||
    `Command failed with exit code ${exitCode}`;
  return new SentryError(message, exitCode, stderrStr);
}

/** Extract exit code from a thrown error, or return 0 if unknown. */
function extractExitCode(thrown: unknown): number {
  if (thrown instanceof Error && "exitCode" in thrown) {
    return (thrown as { exitCode: number }).exitCode;
  }
  return 0;
}

/**
 * Concatenate captured stdout chunks into a single `Uint8Array`.
 *
 * String chunks are UTF-8 encoded; binary chunks are copied as-is. Used when
 * any chunk is binary (e.g. a `sentry api` attachment download) so the bytes
 * survive round-trip instead of being coerced to comma-separated decimals by
 * `Array#join`.
 */
function concatChunksToBytes(chunks: Array<string | Uint8Array>): Uint8Array {
  const parts = chunks.map((c) =>
    typeof c === "string" ? new TextEncoder().encode(c) : c
  );
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Parse captured output: prefer zero-copy object, then JSON, then raw string.
 * @internal Exported for testing
 */
export function parseOutput<T>(
  capturedResult: unknown,
  stdoutChunks: Array<string | Uint8Array>
): T {
  if (capturedResult !== undefined) {
    return capturedResult as T;
  }
  // Binary output (e.g. `sentry api` attachment downloads) must be returned
  // byte-faithfully. If any chunk is a Uint8Array, joining as strings would
  // stringify it to comma-separated decimals — return raw bytes instead.
  if (stdoutChunks.some((c) => c instanceof Uint8Array)) {
    return concatChunksToBytes(stdoutChunks) as T;
  }
  const stdoutStr = stdoutChunks.join("");
  if (!stdoutStr.trim()) {
    return undefined as T;
  }
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return JSON.parse(stdoutStr) as T;
  } catch {
    return stdoutStr.trim() as T;
  }
}

/** Captured output state from a command execution. */
type CaptureContext = {
  /** SentryContext-compatible object for direct command invocation. */
  context: {
    process: {
      stdout: Writer;
      stderr: Writer;
      stdin: NodeJS.ReadStream & { fd: 0 };
      env: NodeJS.ProcessEnv;
      cwd: () => string;
      exitCode: number;
    };
    stdout: Writer;
    stderr: Writer;
    stdin: NodeJS.ReadStream & { fd: 0 };
    env: NodeJS.ProcessEnv;
    cwd: string;
    homeDir: string;
    configDir: string;
  };
  stdoutChunks: Array<string | Uint8Array>;
  stderrChunks: string[];
  getCapturedResult: () => unknown;
};

/** Options for building a capture context. */
type CaptureOptions = {
  /** When set, captureObject pushes to this channel instead of accumulating. */
  channel?: AsyncChannel<unknown>;
  /** When set, placed on the fake process for streaming commands to honor. */
  abortSignal?: AbortSignal;
};

/** Build output capture writers and a SentryContext-compatible context object. */
async function buildCaptureContext(
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts?: CaptureOptions
): Promise<CaptureContext> {
  const stdoutChunks: Array<string | Uint8Array> = [];
  const stderrChunks: string[] = [];
  const capturedResults: unknown[] = [];

  const captureObject = opts?.channel
    ? (obj: unknown) => {
        opts.channel?.push(obj);
      }
    : (obj: unknown) => {
        capturedResults.push(obj);
      };

  const stdout: Writer = {
    write: (s: string | Uint8Array) => {
      stdoutChunks.push(s);
    },
    captureObject,
  };
  const stderr: Writer = {
    write: (s: string) => {
      stderrChunks.push(s);
    },
  };

  const { getConfigDir } = await import("./db/index.js");

  // biome-ignore lint/suspicious/noExplicitAny: abortSignal is an internal extension to the fake process
  const fakeProcess: any = {
    stdout,
    stderr,
    stdin: process.stdin,
    env,
    cwd: () => cwd,
    exitCode: 0,
  };

  if (opts?.abortSignal) {
    fakeProcess.abortSignal = opts.abortSignal;
  }

  const context = {
    process: fakeProcess,
    stdout,
    stderr,
    stdin: process.stdin,
    env,
    cwd,
    homeDir: homedir(),
    configDir: getConfigDir(),
  };

  return {
    context,
    stdoutChunks,
    stderrChunks,
    getCapturedResult: () => {
      if (capturedResults.length === 0) {
        return;
      }
      return capturedResults.length === 1
        ? capturedResults[0]
        : capturedResults;
    },
  };
}

/**
 * Core execution wrapper shared by buildInvoker and buildRunner.
 *
 * Handles env isolation, capture context, telemetry, error wrapping,
 * and output parsing. Both public factories become thin wrappers that
 * only provide the executor callback.
 */
async function executeWithCapture<T>(
  options: SentryOptions | undefined,
  executor: (
    captureCtx: CaptureContext,
    span: Span | undefined
  ) => Promise<void>
): Promise<T> {
  const env = buildIsolatedEnv(options);
  const cwd = options?.cwd ?? process.cwd();
  setEnv(env);

  try {
    await applyHeadersOption(options?.headers);
    const captureCtx = await buildCaptureContext(env, cwd);
    const { withTelemetry } = await import("./telemetry.js");

    try {
      await withTelemetry(async (span) => executor(captureCtx, span), {
        libraryMode: true,
      });
    } catch (thrown) {
      await flushTelemetry();

      // OutputError: data was already rendered (captured) before the throw.
      // Return it despite the non-zero exit code — this is the "HTTP 404 body"
      // pattern where the data is useful even though the operation "failed".
      const captured = captureCtx.getCapturedResult();
      if (captured !== undefined) {
        return captured as T;
      }

      const exitCode =
        extractExitCode(thrown) || captureCtx.context.process.exitCode || 1;
      throw buildSdkError(captureCtx.stderrChunks, exitCode, thrown);
    }

    await flushTelemetry();

    // Check exit code (Stricli sets it without throwing for some errors)
    if (captureCtx.context.process.exitCode !== 0) {
      throw buildSdkError(
        captureCtx.stderrChunks,
        captureCtx.context.process.exitCode
      );
    }

    return parseOutput<T>(
      captureCtx.getCapturedResult(),
      captureCtx.stdoutChunks
    );
  } finally {
    await applyHeadersOption(undefined);
    setEnv(process.env);
  }
}

/**
 * Streaming execution wrapper — runs the command in the background and
 * returns an AsyncChannel that yields values as they arrive.
 *
 * An AbortController is created per call. Consumer `break` (iterator return)
 * and `SentryOptions.signal` both cascade to the controller. The abort signal
 * is placed on the fake process so streaming commands can honor it.
 */
function executeWithStream<T>(
  options: SentryOptions | undefined,
  executor: (
    captureCtx: CaptureContext,
    span: Span | undefined
  ) => Promise<void>
): AsyncChannel<T> {
  const controller = new AbortController();

  // Cascade external signal to our controller
  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  const channel = createAsyncChannel<T>({
    onReturn: () => controller.abort(),
  });

  // Fire-and-forget — command runs in background
  (async () => {
    const env = buildIsolatedEnv(options);
    const cwd = options?.cwd ?? process.cwd();
    setEnv(env);

    let captureCtx: CaptureContext | undefined;
    try {
      await applyHeadersOption(options?.headers);
      captureCtx = await buildCaptureContext(env, cwd, {
        channel: channel as AsyncChannel<unknown>,
        abortSignal: controller.signal,
      });

      const { withTelemetry } = await import("./telemetry.js");

      // biome-ignore lint/style/noNonNullAssertion: captureCtx is assigned on the line above
      await withTelemetry(async (span) => executor(captureCtx!, span), {
        libraryMode: true,
      });

      // Check exit code — Stricli sets it without throwing for some errors
      if (captureCtx.context.process.exitCode !== 0) {
        channel.error(
          buildSdkError(
            captureCtx.stderrChunks,
            captureCtx.context.process.exitCode
          )
        );
      } else {
        // Drain any raw stdout the command wrote directly (via stdout.write)
        // instead of yielding via captureObject — e.g. a binary Uint8Array
        // body. Without this, those bytes accumulate in stdoutChunks and are
        // dropped when the channel closes. No streaming-capable command emits
        // binary today, but this keeps the streaming path faithful to the
        // capture path (see parseOutput) if one ever does.
        const trailing = parseOutput<T>(undefined, captureCtx.stdoutChunks);
        if (trailing !== undefined) {
          channel.push(trailing);
        }
        channel.close();
      }
    } catch (thrown) {
      const stderrChunks = captureCtx?.stderrChunks ?? [];
      const exitCode =
        extractExitCode(thrown) || captureCtx?.context.process.exitCode || 1;
      const err =
        thrown instanceof SentryError
          ? thrown
          : buildSdkError(stderrChunks, exitCode, thrown);
      channel.error(err);
    } finally {
      await flushTelemetry();
      await applyHeadersOption(undefined);
      setEnv(process.env);
    }
  })();

  return channel;
}

/**
 * Build an invoker function bound to the given options.
 *
 * The invoker handles env isolation, context building, telemetry,
 * zero-copy capture, and error wrapping — used by the typed SDK methods.
 *
 * When `meta.streaming` is true, returns an AsyncIterable that yields
 * values as the command produces them (for `--follow`/`--refresh` commands).
 */
export function buildInvoker(options?: SentryOptions) {
  return function invokeCommand<T>(
    commandPath: string[],
    flags: Record<string, unknown>,
    positionalArgs: string[],
    meta?: { streaming?: boolean }
  ): Promise<T> | AsyncIterable<T> {
    if (meta?.streaming) {
      return executeWithStream<T>(options, async (ctx, span) => {
        const { handler, flagDefs } = await resolveCommand(commandPath);
        if (span) {
          const { setCommandSpanName } = await import("./telemetry.js");
          setCommandSpanName(span, commandPath.join("."));
        }
        const resolvedFlags = applyFlagDefaults(flags, flagDefs);
        await handler.call(
          ctx.context,
          { ...resolvedFlags, json: true },
          ...positionalArgs
        );
      });
    }

    return executeWithCapture<T>(options, async (ctx, span) => {
      const { handler, flagDefs } = await resolveCommand(commandPath);
      if (span) {
        const { setCommandSpanName } = await import("./telemetry.js");
        setCommandSpanName(span, commandPath.join("."));
      }
      const resolvedFlags = applyFlagDefaults(flags, flagDefs);
      await handler.call(
        ctx.context,
        { ...resolvedFlags, json: true },
        ...positionalArgs
      );
    });
  };
}

/**
 * Build a runner function bound to the given options.
 *
 * The runner accepts variadic CLI argument strings and routes them
 * through Stricli — the escape hatch for commands not covered by
 * typed SDK methods (or for passing raw CLI flags).
 *
 * Returns parsed JSON by default, or trimmed text for commands
 * without JSON support. When streaming flags are detected, returns
 * an AsyncIterable instead.
 */
export function buildRunner(options?: SentryOptions) {
  return function run(
    ...args: string[]
  ): Promise<unknown> | AsyncIterable<unknown> {
    if (hasStreamingFlag(args)) {
      return executeWithStream<unknown>(options, async (ctx, span) => {
        const { run: stricliRun } = await import("@stricli/core");
        const { app } = await import("../app.js");
        const { buildContext } = await import("../context.js");
        // biome-ignore lint/suspicious/noExplicitAny: fakeProcess duck-types the process interface
        const process_ = ctx.context.process as any;
        await stricliRun(app, args, buildContext(process_, span));
      });
    }

    return executeWithCapture<unknown>(options, async (ctx, span) => {
      const { run: stricliRun } = await import("@stricli/core");
      const { app } = await import("../app.js");
      const { buildContext } = await import("../context.js");
      // biome-ignore lint/suspicious/noExplicitAny: fakeProcess duck-types the process interface
      const process_ = ctx.context.process as any;
      await stricliRun(app, args, buildContext(process_, span));
    });
  };
}
