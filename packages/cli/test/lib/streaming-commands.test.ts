/**
 * Tests for which raw `sdk.run()` arguments stream.
 *
 * Commands declare streaming with `streams` in `buildCommand`, and
 * `sdk.run()` reads the generated `streaming-commands.json`. The route-tree
 * section runs every flag and alias of every registered command through the
 * generated table and compares the answer with the command's own marker, so
 * a short alias that collides with a streaming flag (the `-f` bug: `-f` was
 * `--follow` in `sdk.run()` but `--fresh` in `issue list`) or a stale
 * generated file fails here instead of hanging an SDK caller.
 */

import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import generated from "../../src/generated/streaming-commands.json" with { type: "json" };
import {
  isCommand,
  isRouteMap,
  type Command,
  type RouteMap,
} from "../../src/lib/introspect.js";
import {
  collectStreamingCommands,
  isStreamingInvocation,
  type StreamingCommands,
  streamingModeOf,
} from "../../src/lib/streaming-commands.js";

const STREAMING_COMMANDS: StreamingCommands = generated;

/** What `sdk.run()` decides for these raw arguments. */
function streams(args: readonly string[]): boolean {
  return isStreamingInvocation(args, STREAMING_COMMANDS);
}

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

const routeMap = routes as unknown as RouteMap;
const registered = allCommands(routeMap);

describe("streaming comes from the commands' streams markers", () => {
  test("log tail always streams, dashboard view streams on -r/--refresh", () => {
    expect(STREAMING_COMMANDS["log tail"]).toEqual({});
    expect(STREAMING_COMMANDS["dashboard view"]).toEqual({
      flag: "refresh",
      alias: "r",
    });
  });

  test("the generated table is current", () => {
    expect(STREAMING_COMMANDS).toEqual(collectStreamingCommands(routeMap));
  });

  test("a declared streaming flag exists on its command", () => {
    for (const { path, command } of registered) {
      const flag = streamingModeOf(command)?.flag;
      if (flag !== undefined) {
        expect(
          Object.keys(command.parameters.flags ?? {}),
          path.join(" "),
        ).toContain(flag);
      }
    }
  });

  test("a flag or alias streams in sdk.run() only where its command says so", () => {
    const wrong: string[] = [];
    for (const { path, command } of registered) {
      const mode = streamingModeOf(command);
      const always = mode !== undefined && mode.flag === undefined;
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
        const expected = always || mode?.flag === flagName;
        if (streams([...path, token]) !== expected) {
          wrong.push(`${path.join(" ")} ${token}: expected ${expected}`);
        }
      }
      if (streams(path) !== always) {
        wrong.push(`${path.join(" ")}: expected ${always}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("isStreamingInvocation", () => {
  test("a streaming command streams with any arguments", () => {
    expect(streams(["log", "tail"])).toBe(true);
    expect(streams(["log", "tail", "acme/api", "-i", "5"])).toBe(true);
  });

  test("a streaming flag streams in long, --flag=value, or alias form", () => {
    expect(streams(["dashboard", "view", "1", "-r"])).toBe(true);
    expect(streams(["dashboard", "view", "1", "--refresh"])).toBe(true);
    expect(streams(["dashboard", "view", "1", "--refresh=30"])).toBe(true);
  });

  test("-f is --fresh, not a stream", () => {
    expect(streams(["log", "list", "-f"])).toBe(false);
    expect(streams(["issue", "list", "-f"])).toBe(false);
  });

  test("a streaming flag streams only in its own command", () => {
    expect(streams(["issue", "list", "--refresh"])).toBe(false);
    expect(streams(["log", "list", "-r"])).toBe(false);
  });

  test("global flags before or between route segments are skipped", () => {
    expect(streams(["--json", "log", "tail"])).toBe(true);
    expect(streams(["log", "--json", "tail"])).toBe(true);
    expect(streams(["--log-level", "debug", "log", "tail"])).toBe(true);
    expect(streams(["log", "--org=acme", "tail"])).toBe(true);
    expect(streams(["--json", "log", "list"])).toBe(false);
  });

  test("the command path must lead the arguments", () => {
    expect(streams(["log", "list", "tail"])).toBe(false);
    expect(streams(["log"])).toBe(false);
  });
});
