/**
 * Lazily parsed and resolved target positionals (src/lib/positional-parse.ts,
 * src/lib/target-positional.ts).
 *
 * Runs a test command through Stricli's `run()` so the positional parser,
 * the command wrapper, and exit-code handling are exercised together.
 */

import { buildApplication, type CommandContext, run } from "@stricli/core";
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
  ValidationError,
} from "../../src/lib/errors.js";
import {
  markDestructive,
  rawPositional,
} from "../../src/lib/positional-parse.js";
import { buildRouteMap } from "../../src/lib/route-map.js";
import {
  type OrgProjectTarget,
  orgProjectTarget,
} from "../../src/lib/target-positional.js";

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
async function runWithTarget(args: string[]): Promise<{
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

  test("invalid input fails inside the command with the CliError exit code", async () => {
    const { resolved, stderr, exitCode } = await runWithTarget(["@latest"]);
    expect(resolved).toEqual([]);
    expect(exitCode).toBe(EXIT.VALIDATION);
    expect(stderr).toContain("is an issue selector");
    // Not Stricli's argument-parse error, which would exit with -4.
    expect(stderr).not.toContain("Failed to parse");
  });

  test("keeps completing org/project slugs", () => {
    expect(getCompletionTarget(echoTarget)).toBe(ORG_PROJECT_TARGET);
  });
});

describe("lazy parsing and resolution", () => {
  const context = { cwd: "/work", commandPrefix: ["sentry", "thing", "list"] };

  test("parses on first property access", () => {
    const target = echoTarget.call(context, "@latest");
    expect(() => target.type).toThrow(ValidationError);
  });

  test("rejects resolved with the parse error", async () => {
    const target = echoTarget.call(context, "@latest");
    await expect(target.resolved).rejects.toThrow(ValidationError);
  });

  test("reads like the parsed value, without the resolved getter", () => {
    const target = echoTarget.call(context, "acme/web");
    expect(target).toEqual({ type: "explicit", org: "acme", project: "web" });
    expect({ ...target }).toEqual({
      type: "explicit",
      org: "acme",
      project: "web",
    });
    expect("resolved" in target).toBe(true);
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

  test("a destructive command refuses an auto-detected target", async () => {
    echoResolver.mockClear();
    const omitted = echoTarget.call(context, undefined);
    markDestructive([omitted]);
    const error = await omitted.resolved.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContextError);
    expect((error as Error).message).toContain(
      "sentry thing list <org>/<project>",
    );
    expect(echoResolver).not.toHaveBeenCalled();

    const explicit = echoTarget.call(context, "acme/web");
    markDestructive([explicit]);
    await expect(explicit.resolved).resolves.toMatchObject({
      commandName: "thing list",
    });
  });

  test("needs the command path on the context", async () => {
    const target = echoTarget.call({ cwd: "/work" }, "acme/web");
    await expect(target.resolved).rejects.toThrow("commandPrefix");
  });

  test("is not a thenable, so awaiting it does not parse", async () => {
    // Stricli awaits parser results; a parse here would fail in its scanner.
    const target = echoTarget.call(context, "@latest");
    await expect(Promise.resolve(target)).resolves.toBe(target);
  });
});

describe("rawPositional", () => {
  const context = { cwd: "/work" };

  test("returns what the user typed without parsing", () => {
    expect(rawPositional(echoTarget.call(context, "acme/"))).toBe("acme/");
    expect(rawPositional(echoTarget.call(context, "@latest"))).toBe("@latest");
    expect(rawPositional(echoTarget.call(context, undefined))).toBeUndefined();
    expect(rawPositional("plain")).toBe("plain");
    expect(rawPositional(undefined)).toBeUndefined();
  });
});
