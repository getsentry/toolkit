/**
 * Which commands stream output until stopped, for the library SDK.
 *
 * A streaming command returns an `AsyncIterable` from the SDK instead of a
 * `Promise`. Commands declare it with `streams` in `buildCommand`. The SDK
 * generator reads that marker through {@link streamingModeOf}, and
 * `script/generate-streaming-commands.ts` writes
 * {@link collectStreamingCommands} to `src/generated/streaming-commands.json`
 * for `sdk.run()`, which must pick a return shape before it loads any
 * command. Both come from the command definitions, so there is no list to
 * keep in sync.
 *
 * Streaming is per command: a flag or alias streams only in the command that
 * declares it, so `-r` on `dashboard view` streams and `-f` never does.
 *
 * @module
 */

import { buildTopLevelFlags } from "./global-flags.js";
import type { Command, RouteMap } from "./introspect.js";

/**
 * How a command streams. Without `flag`, every run streams. With `flag`, only
 * runs that pass `--<flag>` or its short `alias` do.
 */
export type StreamingMode = {
  readonly flag?: string;
  readonly alias?: string;
};

/** Streaming commands keyed by space-separated route path. */
export type StreamingCommands = Readonly<Record<string, StreamingMode>>;

/**
 * The streaming mode a command declares with `streams` in `buildCommand`,
 * with the flag's short alias read from the command's own aliases.
 * `undefined` for commands that never stream.
 */
export function streamingModeOf(command: Command): StreamingMode | undefined {
  const streams = (command as { __streams?: true | { flag: string } })
    .__streams;
  if (!streams) {
    return;
  }
  if (streams === true) {
    return {};
  }
  const alias = Object.entries(command.parameters.aliases ?? {}).find(
    ([, target]) => target === streams.flag,
  )?.[0];
  return alias ? { flag: streams.flag, alias } : { flag: streams.flag };
}

/**
 * Every streaming command in a route tree, hidden alias routes included,
 * keyed by route path.
 */
export function collectStreamingCommands(
  map: RouteMap,
  prefix: readonly string[] = [],
): Record<string, StreamingMode> {
  const found: Record<string, StreamingMode> = {};
  for (const entry of map.getAllEntries()) {
    const path = [...prefix, entry.name.original];
    if ("getAllEntries" in entry.target) {
      Object.assign(found, collectStreamingCommands(entry.target, path));
      continue;
    }
    const mode = streamingModeOf(entry.target);
    if (mode) {
      found[path.join(" ")] = mode;
    }
  }
  return found;
}

/**
 * The leading route segments of raw CLI arguments, skipping global flags the
 * way the route scanner does (`sentry --json log tail`, `sentry log
 * --log-level debug tail`). Stops at the first other flag.
 */
function routeSegments(args: readonly string[], depth: number): string[] {
  const { booleanFlags, valueFlags } = buildTopLevelFlags();
  const segments: string[] = [];
  for (let i = 0; i < args.length && segments.length < depth; i++) {
    const arg = args[i] ?? "";
    if (booleanFlags.has(arg)) {
      continue;
    }
    if (valueFlags.has(arg)) {
      i++; // the flag's value
      continue;
    }
    if (valueFlags.has(arg.split("=")[0] ?? "")) {
      continue;
    }
    if (arg.startsWith("-")) {
      break;
    }
    segments.push(arg);
  }
  return segments;
}

/** Whether `arg` passes the streaming flag of `mode`. */
function passesStreamingFlag(arg: string, mode: StreamingMode): boolean {
  return (
    arg === `--${mode.flag}` ||
    arg.startsWith(`--${mode.flag}=`) ||
    (mode.alias !== undefined && arg === `-${mode.alias}`)
  );
}

/**
 * Whether raw CLI arguments run a streaming command, or pass the streaming
 * flag of the command they run. Matches route paths against the leading route
 * segments, so `log tail ...` streams while `log list ...` does not.
 */
export function isStreamingInvocation(
  args: readonly string[],
  commands: StreamingCommands,
): boolean {
  for (const [path, mode] of Object.entries(commands)) {
    const expected = path.split(" ");
    const actual = routeSegments(args, expected.length);
    if (!expected.every((segment, index) => actual[index] === segment)) {
      continue;
    }
    return (
      mode.flag === undefined ||
      args.some((arg) => passesStreamingFlag(arg, mode))
    );
  }
  return false;
}
