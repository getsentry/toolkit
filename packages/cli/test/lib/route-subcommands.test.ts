/**
 * Tests for interceptSubcommand in list-command.ts.
 */

import { describe, expect, test } from "vitest";
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
  // Skip: interceptSubcommand relies on require("../app.js") to load the
  // Stricli route map, which fails under vitest because Node's CJS require
  // can't resolve .js→.ts for transitive ESM imports. The try-catch in
  // getSubcommandsForRoute gracefully degrades to empty sets in test.
  // biome-ignore lint/suspicious/noSkippedTests: require("../app.js") fails in vitest — CJS can't resolve .js→.ts
  test.skip("returns undefined and writes hint for known subcommand", () => {
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

  // Skip: same reason as above — require("../app.js") fails in vitest
  // biome-ignore lint/suspicious/noSkippedTests: require("../app.js") fails in vitest — CJS can't resolve .js→.ts
  test.skip("hint includes the route name and subcommand", () => {
    const stderr = makeStderr();
    interceptSubcommand("view", stderr, "issue");
    expect(stderr.output).toContain("sentry issue view");
  });

  // Skip: same reason as above — require("../app.js") fails in vitest
  // biome-ignore lint/suspicious/noSkippedTests: require("../app.js") fails in vitest — CJS can't resolve .js→.ts
  test.skip("handles 'explain' and 'plan' subcommands for issue route", () => {
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
