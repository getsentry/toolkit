/**
 * Bound target positionals (src/lib/positional-parse.ts,
 * src/lib/target-positional.ts).
 *
 * Runs a test command through Stricli's `run()` so the positional parser,
 * the command wrapper, and exit-code handling are exercised together.
 */

import {
  ArgumentParseError,
  buildApplication,
  type CommandContext,
  ExitCode,
  run,
} from "@stricli/core";
import { describe, expect, test, vi } from "vitest";
import type { ParsedOrgProject } from "../../src/lib/arg-parsing.js";
import { buildCommand } from "../../src/lib/command.js";
import {
  getCompletionTarget,
  ORG_PROJECT_TARGET,
} from "../../src/lib/completion-target.js";
import {
  ContextError,
  EXIT,
  getExitCode,
  HostScopeError,
  ValidationError,
} from "../../src/lib/errors.js";
import {
  applyBoundPositionals,
  type BoundArguments,
  BoundPositional,
  boundArguments,
  checkDestructive,
  rawPositional,
  skipLeadingArgument,
  skippedArgument,
} from "../../src/lib/positional-parse.js";
import { buildRouteMap } from "../../src/lib/route-map.js";
import {
  type OrgProjectTarget,
  orgProjectTarget,
} from "../../src/lib/target-positional.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("positional-parse-");

type TestContext = CommandContext & {
  cwd: string;
  process: { exitCode?: number };
  stdout: { write: (s: string) => boolean };
};

/** Resolver that echoes the parsed target, cwd, and command name. */
const echoResolver = vi.fn(
  async (
    parsed: ParsedOrgProject,
    { cwd, commandName }: { cwd: string; commandName: string },
  ) => ({ parsed: { ...parsed }, cwd, commandName }),
);

const echoTarget = orgProjectTarget(echoResolver);

type EchoTarget = OrgProjectTarget<Awaited<ReturnType<typeof echoResolver>>>;

/** Run `test cmd ...args`, recording what `target.resolved` yields. */
async function runWithTarget(
  args: string[],
  { destructive = false, readResolved = true } = {},
): Promise<{
  resolved: unknown[];
  stderr: string;
  exitCode: number | undefined;
}> {
  const resolved: unknown[] = [];
  const command = buildCommand<
    Record<string, never>,
    [EchoTarget],
    TestContext
  >({
    docs: { brief: "Takes a target" },
    auth: false,
    destructive,
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          {
            placeholder: "org/project",
            brief: "Target",
            parse: echoTarget,
            optional: true,
          },
        ],
      },
    },
    // oxlint-disable-next-line require-yield -- test command only records the resolved target
    async *func(_flags, target) {
      // Reading only `parsed` still goes through the destructive check
      resolved.push(readResolved ? await target.resolved : target.parsed);
    },
  });
  const app = buildApplication(
    buildRouteMap({ routes: { cmd: command }, docs: { brief: "Test" } }),
    { name: "test", determineExitCode: getExitCode },
  );
  let stderr = "";
  const stdout = { write: () => true };
  const context = {
    cwd: "/work",
    // Like buildContext: Stricli passes the command path to forCommand
    forCommand({ prefix }: { prefix: readonly string[] }) {
      return { ...this, commandPrefix: prefix };
    },
    process: {
      stdout,
      stderr: {
        write: (s: string) => {
          stderr += s;
          return true;
        },
      },
      exitCode: undefined,
    },
    stdout,
  } as unknown as TestContext;
  await run(app, ["cmd", ...args], context);
  return { resolved, stderr, exitCode: context.process.exitCode };
}

describe("orgProjectTarget", () => {
  test("resolves the parsed target with the command context and name", async () => {
    const { resolved } = await runWithTarget(["acme/web"]);
    expect(resolved).toEqual([
      {
        parsed: { type: "explicit", org: "acme", project: "web" },
        cwd: "/work",
        commandName: "cmd",
      },
    ]);
  });

  test("an omitted target resolves as auto-detect", async () => {
    const { resolved } = await runWithTarget([]);
    expect(resolved).toEqual([
      { parsed: { type: "auto-detect" }, cwd: "/work", commandName: "cmd" },
    ]);
  });

  test("a destructive: true command refuses an auto-detected target", async () => {
    const { resolved, stderr, exitCode } = await runWithTarget([], {
      destructive: true,
    });
    expect(resolved).toEqual([]);
    expect(exitCode).toBe(EXIT.CONTEXT_MISSING);
    expect(stderr).toContain("Auto-detection is disabled");
  });

  test("a destructive command refuses an auto-detected target it only reads as parsed", async () => {
    const { resolved, exitCode } = await runWithTarget([], {
      destructive: true,
      readResolved: false,
    });
    expect(resolved).toEqual([]);
    expect(exitCode).toBe(EXIT.CONTEXT_MISSING);
  });

  test("invalid input fails as an argument parse error", async () => {
    const { resolved, stderr, exitCode } = await runWithTarget(["@latest"]);
    expect(resolved).toEqual([]);
    expect(exitCode).toBe(ExitCode.InvalidArgument);
    expect(stderr).toContain('Failed to parse "@latest"');
    expect(stderr).toContain("is an issue selector");
  });

  test("keeps completing org/project slugs", () => {
    expect(getCompletionTarget(echoTarget)).toBe(ORG_PROJECT_TARGET);
  });
});

describe("parsing and resolution", () => {
  const context = { cwd: "/work", commandPrefix: ["sentry", "thing", "list"] };

  test("parses when the parser runs", () => {
    expect(() => echoTarget.call(context, "@latest")).toThrow(ValidationError);
  });

  test("keeps the raw input and the parsed value", () => {
    const target = echoTarget.call(context, "acme/web");
    expect(target.raw).toBe("acme/web");
    expect(target.parsed).toEqual({
      type: "explicit",
      org: "acme",
      project: "web",
    });
    expect(target.parsed).toBe(target.parsed);
  });

  test("resolves once, on first access of resolved", async () => {
    echoResolver.mockClear();
    const target = echoTarget.call(context, "acme/web");
    expect(echoResolver).not.toHaveBeenCalled();
    const first = target.resolved;
    expect(target.resolved).toBe(first);
    await first;
    expect(echoResolver).toHaveBeenCalledTimes(1);
  });

  test("the destructive check refuses only an auto-detected target", () => {
    const omitted = echoTarget.call(context, undefined);
    expect(() => checkDestructive([omitted])).toThrow(ContextError);
    expect(() => checkDestructive([omitted])).toThrow(
      "sentry thing list <org>/<project>",
    );

    const explicit = echoTarget.call(context, "acme/web");
    expect(() => checkDestructive([explicit, "plain"])).not.toThrow();
  });

  test("applies a pasted URL's server when resolving, not when parsing", async () => {
    echoResolver.mockClear();
    // No account for this server: applying it throws HostScopeError
    const target = echoTarget.call(
      context,
      "https://sentry.example.com/organizations/acme/projects/web/",
    );
    expect(target.parsed).toMatchObject({ org: "acme" });
    await expect(target.resolved).rejects.toThrow(HostScopeError);
    expect(echoResolver).not.toHaveBeenCalled();
  });

  test("needs the command path on the context", async () => {
    const target = echoTarget.call({ cwd: "/work" }, "acme/web");
    await expect(target.resolved).rejects.toThrow("commandPrefix");
  });

  test("is not a thenable, so awaiting it does not resolve", async () => {
    // Stricli awaits parser results; resolving there would skip the auth guard.
    echoResolver.mockClear();
    const target = echoTarget.call(context, "acme/web");
    await expect(Promise.resolve(target)).resolves.toBe(target);
    expect(echoResolver).not.toHaveBeenCalled();
  });
});

describe("rawPositional", () => {
  const context = { cwd: "/work" };

  test("returns what the user typed", () => {
    expect(rawPositional(echoTarget.call(context, "acme/"))).toBe("acme/");
    expect(rawPositional(echoTarget.call(context, undefined))).toBeUndefined();
    expect(rawPositional("plain")).toBe("plain");
    expect(rawPositional(undefined)).toBeUndefined();
  });
});

/** `[<target>] <id>`: what the first argument means depends on the count. */
function parseIdArguments(raw: readonly string[]): {
  target?: string;
  id: string;
} {
  if (raw.length === 0) {
    throw new ContextError("ID", "test cmd [<target>] <id>", []);
  }
  if (raw.length > 2) {
    throw new ValidationError("Too many arguments");
  }
  const [first = "", second] = raw;
  return second === undefined ? { id: first } : { target: first, id: second };
}

const idResolver = vi.fn(
  async (
    parsed: ReturnType<typeof parseIdArguments>,
    { cwd }: { cwd: string },
    raw: readonly string[],
  ) => ({ ...parsed, cwd, raw: [...raw] }),
);

const idArguments = boundArguments({
  placeholder: "target-or-id",
  brief: "[<target>] <id>",
  kind: ORG_PROJECT_TARGET,
  parse: parseIdArguments,
  resolve: idResolver,
});

type IdArguments = BoundArguments<
  ReturnType<typeof parseIdArguments>,
  Awaited<ReturnType<typeof idResolver>>
>;

/** Run `test cmd ...args` with {@link idArguments}, recording the result. */
async function runWithArguments(
  args: string[],
  positional: typeof idArguments = idArguments,
): Promise<{
  resolved: unknown[];
  stderr: string;
  exitCode: number | undefined;
}> {
  const resolved: unknown[] = [];
  const command = buildCommand<
    Record<string, never>,
    [IdArguments],
    TestContext
  >({
    docs: { brief: "Takes an ID" },
    auth: false,
    parameters: { positional },
    // oxlint-disable-next-line require-yield -- test command only records the resolved arguments
    async *func(_flags, target) {
      resolved.push(await target.resolved);
    },
  });
  const app = buildApplication(
    buildRouteMap({ routes: { cmd: command }, docs: { brief: "Test" } }),
    { name: "test", determineExitCode: getExitCode },
  );
  let stderr = "";
  const stdout = { write: () => true };
  const context = {
    cwd: "/work",
    process: {
      stdout,
      stderr: {
        write: (s: string) => {
          stderr += s;
          return true;
        },
      },
      exitCode: undefined,
    },
    stdout,
  } as unknown as TestContext;
  await run(app, ["cmd", ...args], context);
  return { resolved, stderr, exitCode: context.process.exitCode };
}

describe("boundArguments", () => {
  test("parses every argument at once, so the count decides what each means", async () => {
    expect((await runWithArguments(["abc"])).resolved).toEqual([
      { id: "abc", cwd: "/work", raw: ["abc"] },
    ]);
    expect((await runWithArguments(["acme/web", "abc"])).resolved).toEqual([
      { target: "acme/web", id: "abc", cwd: "/work", raw: ["acme/web", "abc"] },
    ]);
  });

  test("a parse error fails as an argument parse error", async () => {
    const { resolved, stderr, exitCode } = await runWithArguments([
      "a",
      "b",
      "c",
    ]);
    expect(resolved).toEqual([]);
    expect(exitCode).toBe(ExitCode.InvalidArgument);
    expect(stderr).toContain('Failed to parse "a b c" for target-or-id');
    expect(stderr).toContain("Too many arguments");
  });

  test("parses no arguments too", async () => {
    const { resolved, exitCode, stderr } = await runWithArguments([]);
    expect(resolved).toEqual([]);
    expect(exitCode).toBe(ExitCode.InvalidArgument);
    expect(stderr).toContain("ID is required");
  });

  test("raw strings (SDK invoke, tests) become one bound value", async () => {
    idResolver.mockClear();
    const context = { cwd: "/work" };
    const [value, ...rest] = applyBoundPositionals(
      ["acme/web", "abc"],
      idArguments,
      context,
    );
    expect(rest).toEqual([]);
    expect(value).toBeInstanceOf(BoundPositional);
    const bound = value as IdArguments;
    expect(bound.raw).toEqual(["acme/web", "abc"]);
    expect(bound.parsed).toEqual({ target: "acme/web", id: "abc" });
    expect(idResolver).not.toHaveBeenCalled();
    await expect(bound.resolved).resolves.toMatchObject({ cwd: "/work" });

    // A value already parsed is kept
    expect(applyBoundPositionals([bound], idArguments, context)).toEqual([
      bound,
    ]);
  });

  test("raw strings that fail to parse throw an argument parse error", () => {
    let error: unknown;
    try {
      applyBoundPositionals([], idArguments, {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ArgumentParseError);
    expect((error as ArgumentParseError).exception).toBeInstanceOf(
      ContextError,
    );
  });

  test("rawPositional returns every argument", () => {
    const [bound] = applyBoundPositionals(["abc"], idArguments, {});
    expect(rawPositional(bound)).toEqual(["abc"]);
  });

  test("skipLeadingArgument leaves a matching first argument out before parsing", async () => {
    const skipping = skipLeadingArgument(idArguments, (arg) => arg === "view");
    // Parsed without "view", so the count still decides
    expect(
      (await runWithArguments(["view", "acme/web", "abc"], skipping)).resolved,
    ).toEqual([
      { target: "acme/web", id: "abc", cwd: "/work", raw: ["acme/web", "abc"] },
    ]);

    const [bound] = applyBoundPositionals(["view", "abc"], skipping, {});
    expect(skippedArgument(bound)).toBe("view");
    expect((bound as IdArguments).parsed).toEqual({ id: "abc" });
    const [kept] = applyBoundPositionals(["abc"], skipping, {});
    expect(skippedArgument(kept)).toBeUndefined();
  });

  test("each argument completes as the given kind", () => {
    expect(getCompletionTarget(idArguments.parameter.parse)).toBe(
      ORG_PROJECT_TARGET,
    );
  });
});
