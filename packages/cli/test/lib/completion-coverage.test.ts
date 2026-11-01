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
 *
 * `lint-rules/completion-exemptions.json` lists the parameters exempt from
 * coverage; the `sentry-cli/require-completion-parser` lint rule reads the
 * same list. An entry must name a visible parameter that still has no
 * completion kind, so the list cannot go stale.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import {
  type Command,
  extractCommandCompletions,
  isCommand,
  isRouteMap,
  type RouteMap,
} from "../../src/lib/introspect.js";

/** A parameter exempt from completion coverage. */
type CompletionExemption = {
  /** Source file defining the parameter, relative to `packages/cli` */
  readonly file: string;
  /** Command path, without `sentry` */
  readonly command: string;
  /** `--flag` or `<placeholder>` */
  readonly parameter: string;
  readonly reason: string;
};

const { exemptions } = JSON.parse(
  readFileSync(
    new URL("../../lint-rules/completion-exemptions.json", import.meta.url),
    "utf8",
  ),
) as { exemptions: readonly CompletionExemption[] };

/** How the coverage report names a parameter. */
function label(command: string, parameter: string): string {
  return `sentry ${command} ${parameter}`;
}

const exempt = new Set(
  exemptions.map(({ command, parameter }) => label(command, parameter)),
);

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
  const flags = commands.flatMap(({ path, command }) =>
    Object.entries(command.parameters.flags ?? {})
      .filter(([, def]) => def.kind !== "boolean" && !def.hidden)
      .map(([name]) => ({ path, flag: `--${name}` })),
  );

  /** Positionals and flags without a completion kind, exempt or not. */
  const uncoveredPositionals = positionals
    .filter(({ path, index }) => !completions[path]?.positionals[index])
    .map(({ path, placeholder }) => label(path, `<${placeholder}>`));
  const uncoveredFlags = flags
    .filter(({ path, flag }) => !completions[path]?.flags[flag])
    .map(({ path, flag }) => label(path, flag));

  test("every visible positional declares a completion kind", () => {
    expect(positionals.length).toBeGreaterThan(0);
    expect(uncoveredPositionals.filter((name) => !exempt.has(name))).toEqual(
      [],
    );
  });

  test("every visible value-taking flag declares a completion kind", () => {
    expect(flags.length).toBeGreaterThan(0);
    expect(uncoveredFlags.filter((name) => !exempt.has(name))).toEqual([]);
  });

  test("every exemption names an uncovered parameter and says why", () => {
    const uncovered = new Set([...uncoveredPositionals, ...uncoveredFlags]);
    const stale = exemptions
      .map(({ command, parameter }) => label(command, parameter))
      .filter((name) => !uncovered.has(name));
    const unexplained = exemptions
      .filter(({ file, reason }) => !(file.trim() && reason.trim()))
      .map(({ command, parameter }) => label(command, parameter));

    expect(stale).toEqual([]);
    expect(unexplained).toEqual([]);
  });
});
