/**
 * Tests for which raw `sdk.run()` arguments stream.
 *
 * The route-tree section checks every flag and alias of every registered
 * command, so a short alias that collides with a streaming flag (the `-f`
 * bug: `-f` was `--follow` in `sdk.run()` but `--fresh` in `issue list`)
 * fails here instead of hanging an SDK caller.
 */

import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import {
  isCommand,
  isRouteMap,
  type Command,
  type RouteMap,
} from "../../src/lib/introspect.js";
import {
  isStreamingInvocation,
  STREAMING_COMMANDS,
} from "../../src/lib/streaming-commands.js";

type RegisteredCommand = { path: string[]; command: Command };

/** Every command in the route tree, hidden aliases included. */
function allCommands(
  map: RouteMap,
  prefix: string[] = [],
): RegisteredCommand[] {
  return map.getAllEntries().flatMap((entry) => {
    const path = [...prefix, entry.name.original];
    if (isRouteMap(entry.target)) {
      return allCommands(entry.target, path);
    }
    return isCommand(entry.target) ? [{ path, command: entry.target }] : [];
  });
}

const registered = allCommands(routes as unknown as RouteMap);

describe("STREAMING_COMMANDS matches the route tree", () => {
  test("every entry is a registered command whose flag and alias match", () => {
    for (const [path, mode] of Object.entries(STREAMING_COMMANDS)) {
      const found = registered.find((cmd) => cmd.path.join(" ") === path);
      expect(found, path).toBeDefined();
      if (mode.kind !== "flag" || !found) {
        continue;
      }
      const { flags = {}, aliases = {} } = found.command.parameters;
      expect(Object.keys(flags), path).toContain(mode.flag);
      const commandAlias = Object.entries(aliases).find(
        ([, target]) => target === mode.flag,
      )?.[0];
      expect(mode.alias, `${path}: alias of --${mode.flag}`).toBe(commandAlias);
    }
  });

  test("a flag or alias streams only where the table says so", () => {
    const wrong: string[] = [];
    for (const { path, command } of registered) {
      const mode = STREAMING_COMMANDS[path.join(" ")];
      const { flags = {}, aliases = {} } = command.parameters;
      const tokens: [string, string][] = [
        ...Object.keys(flags).map((name): [string, string] => [
          `--${name}`,
          name,
        ]),
        ...Object.entries(aliases).map(([alias, name]): [string, string] => [
          `-${alias}`,
          name,
        ]),
      ];
      for (const [token, flagName] of tokens) {
        const expected =
          mode?.kind === "always" ||
          (mode?.kind === "flag" && mode.flag === flagName);
        if (isStreamingInvocation([...path, token]) !== expected) {
          wrong.push(`${path.join(" ")} ${token}: expected ${expected}`);
        }
      }
      if (isStreamingInvocation(path) !== (mode?.kind === "always")) {
        wrong.push(`${path.join(" ")}: expected ${mode?.kind === "always"}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("isStreamingInvocation", () => {
  test("a streaming command streams with any arguments", () => {
    expect(isStreamingInvocation(["log", "tail"])).toBe(true);
    expect(isStreamingInvocation(["log", "tail", "acme/api", "-i", "5"])).toBe(
      true,
    );
  });

  test("a streaming flag streams in long, --flag=value, or alias form", () => {
    expect(isStreamingInvocation(["dashboard", "view", "1", "-r"])).toBe(true);
    expect(isStreamingInvocation(["dashboard", "view", "1", "--refresh"])).toBe(
      true,
    );
    expect(
      isStreamingInvocation(["dashboard", "view", "1", "--refresh=30"]),
    ).toBe(true);
  });

  test("-f is --fresh, not a stream", () => {
    expect(isStreamingInvocation(["log", "list", "-f"])).toBe(false);
    expect(isStreamingInvocation(["issue", "list", "-f"])).toBe(false);
  });

  test("a streaming flag streams only in its own command", () => {
    expect(isStreamingInvocation(["issue", "list", "--refresh"])).toBe(false);
    expect(isStreamingInvocation(["log", "list", "-r"])).toBe(false);
  });

  test("global flags before or between route segments are skipped", () => {
    expect(isStreamingInvocation(["--json", "log", "tail"])).toBe(true);
    expect(isStreamingInvocation(["log", "--json", "tail"])).toBe(true);
    expect(isStreamingInvocation(["--log-level", "debug", "log", "tail"])).toBe(
      true,
    );
    expect(isStreamingInvocation(["log", "--org=acme", "tail"])).toBe(true);
    expect(isStreamingInvocation(["--json", "log", "list"])).toBe(false);
  });

  test("the command path must lead the arguments", () => {
    expect(isStreamingInvocation(["log", "list", "tail"])).toBe(false);
    expect(isStreamingInvocation(["log"])).toBe(false);
  });
});
