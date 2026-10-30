/**
 * Every positional declares how shell completion handles it.
 *
 * Walks the real route tree, the one `generate:completions` writes for the
 * `__complete` fast path. A positional without a completion kind fails
 * here, naming the command and placeholder. Give it the bound parser of
 * its target, or one of the pre-tagged parsers in
 * `src/lib/completion-target.ts` (`parseFilePath`, `parseText`,
 * `choiceParser(…)`, …); see "Shell completion" in `packages/cli/AGENTS.md`.
 */

import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import {
  extractCommandCompletions,
  isCommand,
  isRouteMap,
  type RouteMap,
} from "../../src/lib/introspect.js";

/** Every visible positional: its command path, index, and placeholder. */
function visiblePositionals(
  routeMap: RouteMap,
  prefix: readonly string[] = [],
): { path: string; index: number; placeholder: string }[] {
  return routeMap.getAllEntries().flatMap((entry) => {
    if (entry.hidden) {
      return [];
    }
    const segments = [...prefix, entry.name.original];
    if (isRouteMap(entry.target)) {
      return visiblePositionals(entry.target, segments);
    }
    if (!isCommand(entry.target)) {
      return [];
    }
    const positional = entry.target.parameters.positional;
    const params = positional
      ? positional.kind === "tuple"
        ? positional.parameters
        : [positional.parameter]
      : [];
    return params.map((param, index) => ({
      path: segments.join(" "),
      index,
      placeholder: param.placeholder ?? `arg${index}`,
    }));
  });
}

describe("shell completion coverage", () => {
  test("every visible positional declares a completion kind", () => {
    const routeMap = routes as unknown as RouteMap;
    const completions = extractCommandCompletions(routeMap);
    const positionals = visiblePositionals(routeMap);
    const missing = positionals
      .filter(({ path, index }) => !completions[path]?.positionals[index])
      .map(({ path, placeholder }) => `sentry ${path} <${placeholder}>`);

    expect(positionals.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
