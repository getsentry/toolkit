/**
 * Tests for interceptSubcommand in list-command.ts.
 */

import { describe, expect, test } from "vitest";
// Registers the CLI route map that subcommand names are read from.
import "../../src/app.js";
import { interceptSubcommand } from "../../src/lib/list-command.js";

function makeStderr(): { write(s: string): void; output: string } {
  let output = "";
  return {
    write(s: string) {
      output += s;
    },
    get output() {
      return output;
    },
  };
}

describe("interceptSubcommand", () => {
  test("returns undefined and writes hint for known subcommand", () => {
    const stderr = makeStderr();
    const result = interceptSubcommand("list", stderr, "project");
    expect(result).toBeUndefined();
    expect(stderr.output).toContain("Tip:");
    expect(stderr.output).toContain("sentry project list");
  });

  test("returns target unchanged for normal project names", () => {
    const stderr = makeStderr();
    const result = interceptSubcommand("my-project", stderr, "project");
    expect(result).toBe("my-project");
    expect(stderr.output).toBe("");
  });

  test("returns target unchanged for org/project patterns", () => {
    const stderr = makeStderr();
    const result = interceptSubcommand("sentry/cli", stderr, "issue");
    expect(result).toBe("sentry/cli");
    expect(stderr.output).toBe("");
  });

  test("returns undefined/empty unchanged (no hint)", () => {
    const stderr = makeStderr();
    expect(interceptSubcommand(undefined, stderr, "project")).toBeUndefined();
    expect(stderr.output).toBe("");

    expect(interceptSubcommand("", stderr, "project")).toBe("");
    expect(stderr.output).toBe("");
  });

  test("hint includes the route name and subcommand", () => {
    const stderr = makeStderr();
    interceptSubcommand("view", stderr, "issue");
    expect(stderr.output).toContain("sentry issue view");
  });

  test("handles 'explain' and 'plan' subcommands for issue route", () => {
    const stderr1 = makeStderr();
    expect(interceptSubcommand("explain", stderr1, "issue")).toBeUndefined();
    expect(stderr1.output).toContain("sentry issue explain");

    const stderr2 = makeStderr();
    expect(interceptSubcommand("plan", stderr2, "issue")).toBeUndefined();
    expect(stderr2.output).toContain("sentry issue plan");
  });

  test("does not intercept subcommands from unrelated routes", () => {
    const stderr = makeStderr();
    // "explain" is a subcommand of "issue" but not "project"
    const result = interceptSubcommand("explain", stderr, "project");
    expect(result).toBe("explain");
    expect(stderr.output).toBe("");
  });

  test("only intercepts subcommands of the specified route", () => {
    const stderr = makeStderr();
    // "login" is a subcommand of "auth", not "project"
    const result = interceptSubcommand("login", stderr, "project");
    expect(result).toBe("login");
    expect(stderr.output).toBe("");
  });
});
