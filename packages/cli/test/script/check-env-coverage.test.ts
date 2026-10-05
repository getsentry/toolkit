/**
 * Tests for the env var documentation coverage check.
 *
 * The check (script/check-env-coverage.ts) fails CI when the CLI reads a
 * user-facing env var that isn't in ENV_VAR_REGISTRY or the internal allowlist.
 * It runs as a standalone script with top-level await and process.exit, so we
 * exercise it as a subprocess against the real source tree.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runCheck() {
  return spawnSync("pnpm", ["tsx", "script/check-env-coverage.ts"], {
    cwd: pkgRoot,
    encoding: "utf-8",
  });
}

describe("check-env-coverage", () => {
  test("passes against the current source tree", () => {
    const result = runCheck();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("user-facing env var(s) read in src/");
  });
});
