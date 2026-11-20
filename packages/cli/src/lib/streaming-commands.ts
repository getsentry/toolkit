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
 * @module
 */

import { buildTopLevelFlags } from "./global-flags.js";

/** Flag names that switch a command into streaming mode. */
export const STREAMING_FLAGS: ReadonlySet<string> = new Set(["refresh"]);

/** Commands, as space-separated route paths, that always stream. */
export const STREAMING_COMMANDS: ReadonlySet<string> = new Set(["log tail"]);

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

/**
 * Whether raw CLI arguments run a streaming command or pass a streaming flag.
 *
 * Matches the route path against the leading route segments, so `log tail ...`
 * streams while `log list ...` does not.
 */
export function isStreamingInvocation(args: readonly string[]): boolean {
  for (const path of STREAMING_COMMANDS) {
    const expected = path.split(" ");
    const actual = routeSegments(args, expected.length);
    if (expected.every((segment, index) => actual[index] === segment)) {
      return true;
    }
  }
  return args.some(
    (arg) =>
      arg.startsWith("--") &&
      STREAMING_FLAGS.has(arg.slice(2).split("=")[0] ?? ""),
  );
}
