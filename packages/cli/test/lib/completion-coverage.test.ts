/**
 * Every positional and value-taking flag declares how shell completion
 * handles it.
 *
 * Walks the real route tree, the one `generate:completions` writes for the
 * `__complete` fast path. A visible positional or flag without a completion
 * kind fails here, naming the command and the placeholder or flag. Give it
 * the bound parser of its target, or one of the pre-tagged parsers in
 * `src/lib/completion-target.ts` (`parseFilePath`, `parseText`,
 * `choiceParser(…)`, `textParser(…)`, …); see "Shell completion" in
 * `packages/cli/AGENTS.md`.
 */

import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import {
  type Command,
  extractCommandCompletions,
  isCommand,
  isRouteMap,
  type RouteMap,
} from "../../src/lib/introspect.js";

/** Every visible command with its path. */
function visibleCommands(
  routeMap: RouteMap,
  prefix: readonly string[] = [],
): { path: string; command: Command }[] {
  return routeMap.getAllEntries().flatMap((entry) => {
    if (entry.hidden) {
      return [];
    }
    const segments = [...prefix, entry.name.original];
    if (isRouteMap(entry.target)) {
      return visibleCommands(entry.target, segments);
    }
    return isCommand(entry.target)
      ? [{ path: segments.join(" "), command: entry.target }]
      : [];
  });
}

describe("shell completion coverage", () => {
  const routeMap = routes as unknown as RouteMap;
  const completions = extractCommandCompletions(routeMap);
  const commands = visibleCommands(routeMap);

  test("every visible positional declares a completion kind", () => {
    const positionals = commands.flatMap(({ path, command }) => {
      const positional = command.parameters.positional;
      const params = positional
        ? positional.kind === "tuple"
          ? positional.parameters
          : [positional.parameter]
        : [];
      return params.map((param, index) => ({
        path,
        index,
        placeholder: param.placeholder ?? `arg${index}`,
      }));
    });
    const missing = positionals
      .filter(({ path, index }) => !completions[path]?.positionals[index])
      .map(({ path, placeholder }) => `sentry ${path} <${placeholder}>`);

    expect(positionals.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("every visible value-taking flag declares a completion kind", () => {
    const flags = commands.flatMap(({ path, command }) =>
      Object.entries(command.parameters.flags ?? {})
        .filter(([, def]) => def.kind !== "boolean" && !def.hidden)
        .map(([name]) => ({ path, flag: `--${name}` })),
    );
    const missing = flags
      .filter(({ path, flag }) => !completions[path]?.flags[flag])
      .map(({ path, flag }) => `sentry ${path} ${flag}`);

    expect(flags.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
