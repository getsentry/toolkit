/**
 * Tests for the error-pattern checker (script/check-error-patterns.ts).
 *
 * The script both runs standalone (globbing src/, printing, process.exit) and
 * exports its detection logic so it can be unit-tested against string fixtures.
 * We exercise the pure functions directly and run the whole check as a
 * subprocess against the real source tree.
 *
 * Silent-catch detection moved to the Biome plugin
 * `lint-rules/no-silent-catch.grit`; see #1531.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  findAdHocTryPatterns,
  findContextErrorNewlines,
} from "../../script/check-error-patterns.ts";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runCheck(args: string[] = []) {
  return spawnSync("pnpm", ["tsx", "script/check-error-patterns.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf-8",
  });
}

describe("findContextErrorNewlines", () => {
  test("flags a multi-line command argument", () => {
    const src = 'throw new ContextError("issue", "run this\\nthen that");';
    expect(findContextErrorNewlines(src, "a.ts")).toHaveLength(1);
  });

  test("allows a single-line command argument", () => {
    const src = 'throw new ContextError("issue", "sentry issue list");';
    expect(findContextErrorNewlines(src, "a.ts")).toHaveLength(0);
  });
});

describe("findAdHocTryPatterns", () => {
  test('flags a CliError with an ad-hoc "Try:" string', () => {
    const src = 'throw new CliError(\n  "nope",\n  "Try: sentry login",\n);';
    expect(findAdHocTryPatterns(src, "a.ts")).toHaveLength(1);
  });

  test("allows a CliError without a Try string", () => {
    const src = 'throw new CliError("something went wrong");';
    expect(findAdHocTryPatterns(src, "a.ts")).toHaveLength(0);
  });
});

describe("check-error-patterns (subprocess)", () => {
  test("passes against the current source tree", () => {
    const result = runCheck();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("No error class anti-patterns found");
  });
});
