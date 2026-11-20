/**
 * Short-flag and streaming conventions across the real route tree.
 *
 * `-f` means `--fresh` in every command that can bypass the cache, so the
 * cached footer's "use -f to refresh" and users' muscle memory hold
 * everywhere. Live output is its own command (`log tail`), not a mode flag on
 * a list command. See the "Flags" rules in `design/sentry-cli.md`.
 */

import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import {
  type CommandInfo,
  extractAllRoutes,
  type RouteMap,
} from "../../src/lib/introspect.js";
import {
  STREAMING_COMMANDS,
  STREAMING_FLAGS,
} from "../../src/lib/streaming-commands.js";

/**
 * Commands that still stream through a mode flag. Each entry is a known gap
 * listed in `design/sentry-cli.md`; do not add to it.
 */
const STREAMING_FLAG_COMMANDS = ["dashboard view"];

const commands: CommandInfo[] = extractAllRoutes(
  routes as unknown as RouteMap,
).flatMap((route) => route.commands);

/** `sentry log list` → `log list` */
function routePath(command: CommandInfo): string {
  return command.path.replace(/^sentry /, "");
}

describe("-f means --fresh", () => {
  test("every command with --fresh binds -f to it", () => {
    const offenders = commands
      .filter((cmd) => cmd.flags.some((flag) => flag.name === "fresh"))
      .filter((cmd) => cmd.aliases["f"] !== "fresh")
      .map((cmd) => `${routePath(cmd)}: -f → ${cmd.aliases["f"] ?? "(none)"}`);
    expect(offenders).toEqual([]);
  });

  test("log list is one of them", () => {
    const logList = commands.find((cmd) => routePath(cmd) === "log list");
    expect(logList?.aliases["f"]).toBe("fresh");
  });
});

describe("live output is its own command", () => {
  test("only the listed gaps switch to streaming with a flag", () => {
    const withStreamingFlag = commands
      .filter((cmd) =>
        cmd.flags.some(
          (flag) => !flag.hidden && STREAMING_FLAGS.has(flag.name),
        ),
      )
      .map(routePath);
    expect(withStreamingFlag).toEqual(STREAMING_FLAG_COMMANDS);
  });

  test("no command has a visible --follow flag", () => {
    const withFollow = commands
      .filter((cmd) =>
        cmd.flags.some((flag) => flag.name === "follow" && !flag.hidden),
      )
      .map(routePath);
    expect(withFollow).toEqual([]);
  });

  test("every streaming command is registered", () => {
    const registered = new Set(commands.map(routePath));
    for (const path of STREAMING_COMMANDS) {
      expect(registered.has(path), path).toBe(true);
    }
  });
});
