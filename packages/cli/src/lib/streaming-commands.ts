/**
 * Which commands stream output until stopped, for the library SDK.
 *
 * A streaming command returns an `AsyncIterable` from the SDK instead of a
 * `Promise`. `script/generate-sdk.ts` reads this module to type the generated
 * methods, and `sdk.run()` reads it to pick the same return shape at runtime,
 * so the two cannot disagree.
 *
 * Live output gets its own command (`log tail`), not a mode flag on a list
 * command; see `design/sentry-cli.md`. `--refresh` on `dashboard view` is the
 * one flag that still switches a command into streaming.
 *
 * Streaming is per command: a flag or alias streams only in the command
 * listed with it, so `-r` on `dashboard view` streams and `-f` never does.
 *
 * @module
 */

import { buildTopLevelFlags } from "./global-flags.js";

/**
 * How a command streams: on every run, or only when one of its flags is
 * passed. `alias` is that flag's short alias in the command, if any.
 */
export type StreamingMode =
  | { readonly kind: "always" }
  | { readonly kind: "flag"; readonly flag: string; readonly alias?: string };

/**
 * Every command that can stream, keyed by space-separated route path.
 * `test/lib/streaming-commands.test.ts` checks this table against the real
 * route tree: each flag and alias here must match the command's own
 * definition, and no other flag or alias of any command may stream.
 */
export const STREAMING_COMMANDS: Readonly<Record<string, StreamingMode>> = {
  "log tail": { kind: "always" },
  "dashboard view": { kind: "flag", flag: "refresh", alias: "r" },
};

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
function passesStreamingFlag(
  arg: string,
  mode: Extract<StreamingMode, { kind: "flag" }>,
): boolean {
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
export function isStreamingInvocation(args: readonly string[]): boolean {
  for (const [path, mode] of Object.entries(STREAMING_COMMANDS)) {
    const expected = path.split(" ");
    const actual = routeSegments(args, expected.length);
    if (!expected.every((segment, index) => actual[index] === segment)) {
      continue;
    }
    return (
      mode.kind === "always" ||
      args.some((arg) => passesStreamingFlag(arg, mode))
    );
  }
  return false;
}
