/**
 * Target positionals that parse their own value (src/lib/target-arg.ts).
 *
 * Runs a test command through Stricli's `run()` so the positional parser,
 * the command wrapper, and exit-code handling are exercised together.
 */

import { buildApplication, type CommandContext, run } from "@stricli/core";
import { describe, expect, test } from "vitest";
import type { ParsedOrgProject } from "../../src/lib/arg-parsing.js";
import { buildCommand } from "../../src/lib/command.js";
import {
  getCompletionTarget,
  ORG_PROJECT_TARGET,
} from "../../src/lib/completion-target.js";
import { EXIT, getExitCode, ValidationError } from "../../src/lib/errors.js";
import { buildRouteMap } from "../../src/lib/route-map.js";
import {
  type OrgProjectTargetArg,
  parsedOrgProject,
  parseOrgProjectTargetArg,
  rawPositional,
} from "../../src/lib/target-arg.js";

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
    [OrgProjectTargetArg?],
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
            parse: parseOrgProjectTargetArg,
            optional: true,
          },
        ],
      },
    },
    // oxlint-disable-next-line require-yield -- test command only records the parsed target
    async *func(_flags, target) {
      parsed.push(parsedOrgProject(target));
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

describe("parseOrgProjectTargetArg", () => {
  test("hands the command a parsed target", async () => {
    const { parsed } = await runWithTarget(["acme/web"]);
    expect(parsed).toEqual([{ type: "explicit", org: "acme", project: "web" }]);
  });

  test("an omitted target means auto-detect", async () => {
    const { parsed } = await runWithTarget([]);
    expect(parsed).toEqual([{ type: "auto-detect" }]);
  });

  test("invalid input fails inside the command with the CliError exit code", async () => {
    const { parsed, stderr, exitCode } = await runWithTarget(["@latest"]);
    expect(parsed).toEqual([]);
    expect(exitCode).toBe(EXIT.VALIDATION);
    expect(stderr).toContain("is an issue selector");
    // Not Stricli's argument-parse error, which would exit with -4.
    expect(stderr).not.toContain("Failed to parse");
  });

  test("parses lazily, on first access", () => {
    const target = parseOrgProjectTargetArg("@latest");
    expect(target.raw).toBe("@latest");
    expect(() => target.parsed).toThrow(ValidationError);
  });

  test("keeps completing org/project slugs", () => {
    expect(getCompletionTarget(parseOrgProjectTargetArg)).toBe(
      ORG_PROJECT_TARGET,
    );
  });
});

describe("rawPositional", () => {
  test("returns what the user typed for a target", () => {
    expect(rawPositional(parseOrgProjectTargetArg("acme/"))).toBe("acme/");
    expect(rawPositional("plain")).toBe("plain");
    expect(rawPositional(undefined)).toBeUndefined();
  });
});
