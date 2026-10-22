/**
 * Positional parsers that throw CliErrors (src/lib/positional-parse.ts).
 *
 * Runs a test command through Stricli's `run()` so the positional parser,
 * the command wrapper, and exit-code handling are exercised together.
 */

import { buildApplication, type CommandContext, run } from "@stricli/core";
import { describe, expect, test } from "vitest";
import {
  AUTO_DETECT_TARGET,
  type ParsedOrgProject,
  parseOrgProjectPositional,
} from "../../src/lib/arg-parsing.js";
import { buildCommand } from "../../src/lib/command.js";
import {
  getCompletionTarget,
  ORG_PROJECT_TARGET,
} from "../../src/lib/completion-target.js";
import { EXIT, getExitCode, ValidationError } from "../../src/lib/errors.js";
import {
  DeferredPositionalError,
  deferPositionalErrors,
  rawPositional,
} from "../../src/lib/positional-parse.js";
import { buildRouteMap } from "../../src/lib/route-map.js";

type TestContext = CommandContext & {
  process: { exitCode?: number };
  stdout: { write: (s: string) => boolean };
};

/** Run `test cmd ...args` with an org/project target positional. */
async function runWithTarget(args: string[]): Promise<{
  parsed: ParsedOrgProject[];
  stderr: string;
  exitCode: number | undefined;
}> {
  const parsed: ParsedOrgProject[] = [];
  const command = buildCommand<
    Record<string, never>,
    [ParsedOrgProject?],
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
            parse: parseOrgProjectPositional,
            optional: true,
          },
        ],
      },
    },
    // oxlint-disable-next-line require-yield -- test command only records the parsed target
    async *func(_flags, target = AUTO_DETECT_TARGET) {
      parsed.push(target);
    },
  });
  const app = buildApplication(
    buildRouteMap({ routes: { cmd: command }, docs: { brief: "Test" } }),
    { name: "test", determineExitCode: getExitCode },
  );
  let stderr = "";
  const stdout = { write: () => true };
  const context = {
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
  return { parsed, stderr, exitCode: context.process.exitCode };
}

describe("parseOrgProjectPositional", () => {
  test("hands the command a parsed target", async () => {
    const { parsed } = await runWithTarget(["acme/web"]);
    expect(parsed).toEqual([{ type: "explicit", org: "acme", project: "web" }]);
  });

  test("an omitted target means auto-detect", async () => {
    const { parsed } = await runWithTarget([]);
    expect(parsed).toEqual([{ type: "auto-detect" }]);
  });

  test("invalid input fails with the CliError exit code, not Stricli's", async () => {
    const { parsed, stderr, exitCode } = await runWithTarget(["@latest"]);
    expect(parsed).toEqual([]);
    expect(exitCode).toBe(EXIT.VALIDATION);
    expect(stderr).toContain("is an issue selector");
    // Not Stricli's argument-parse error, which would exit with -4.
    expect(stderr).not.toContain("Failed to parse");
  });

  test("keeps completing org/project slugs", () => {
    expect(getCompletionTarget(parseOrgProjectPositional)).toBe(
      ORG_PROJECT_TARGET,
    );
  });
});

describe("deferPositionalErrors", () => {
  const parse = deferPositionalErrors(parseOrgProjectPositional);

  test("returns a CliError as a deferred value", () => {
    const value = parse("@latest");
    expect(value).toBeInstanceOf(DeferredPositionalError);
    expect((value as DeferredPositionalError).error).toBeInstanceOf(
      ValidationError,
    );
  });

  test("lets other errors propagate", () => {
    const failing = deferPositionalErrors(() => {
      throw new TypeError("boom");
    });
    expect(() => failing("x")).toThrow(TypeError);
  });

  test("keeps the completion target", () => {
    expect(getCompletionTarget(parse)).toBe(ORG_PROJECT_TARGET);
  });
});

describe("rawPositional", () => {
  const parse = deferPositionalErrors(parseOrgProjectPositional);

  test("returns what the user typed", () => {
    expect(rawPositional(parse("acme/"))).toBe("acme/");
    expect(rawPositional(parse("@latest"))).toBe("@latest");
    expect(rawPositional("plain")).toBe("plain");
    expect(rawPositional(undefined)).toBeUndefined();
  });
});
