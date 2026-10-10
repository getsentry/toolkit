/**
 * Unit tests for `src/lib/dsn/scan-options.ts`.
 *
 * Ensures the preset we'll use in PR 3 to replace the DSN scanner's
 * walk logic produces the expected `WalkOptions` shape. Isolated from
 * the walker itself so we don't rely on fs side-effects.
 */

import { describe, expect, test } from "vitest";
import {
  DSN_MAX_DEPTH,
  dsnDescentHook,
  dsnScanOptions,
} from "../../../src/lib/dsn/scan-options.js";
import {
  DEFAULT_SKIP_DIRS,
  DSN_ADDITIONAL_SKIP_DIRS,
  MONOREPO_ROOTS,
  TEXT_EXTENSIONS,
} from "../../../src/lib/scan/constants.js";

describe("dsnScanOptions", () => {
  test("returns the expected shape", () => {
    const opts = dsnScanOptions();
    expect(opts.extensions).toBe(TEXT_EXTENSIONS);
    expect(opts.maxDepth).toBe(DSN_MAX_DEPTH);
    expect(opts.nestedGitignore).toBe(true);
    expect(opts.respectGitignore).toBe(true);
    expect(opts.hidden).toBe(true);
    expect(opts.descentHook).toBe(dsnDescentHook);
  });

  test("skip list combines DEFAULT + DSN additions", () => {
    const opts = dsnScanOptions();
    const skipSet = new Set(opts.alwaysSkipDirs);
    for (const d of DEFAULT_SKIP_DIRS) {
      expect(skipSet.has(d)).toBe(true);
    }
    for (const d of DSN_ADDITIONAL_SKIP_DIRS) {
      expect(skipSet.has(d)).toBe(true);
    }
    // DSN-specific dirs are NOT in DEFAULT_SKIP_DIRS (sanity check
    // that we're still getting them from the second list).
    expect(DEFAULT_SKIP_DIRS.includes("test")).toBe(false);
    expect(DSN_ADDITIONAL_SKIP_DIRS.includes("test")).toBe(true);
    expect(skipSet.has("test")).toBe(true);
  });

  test("skips OS app-data and credential dirs (defence in depth)", () => {
    const opts = dsnScanOptions();
    const skipSet = new Set(opts.alwaysSkipDirs);
    for (const d of [
      "Library",
      "AppData",
      ".ssh",
      ".aws",
      ".gnupg",
      ".config",
    ]) {
      expect(skipSet.has(d)).toBe(true);
    }
  });
});

describe("dsnDescentHook", () => {
  test("returns 0 for monorepo package dirs", () => {
    for (const root of MONOREPO_ROOTS) {
      expect(dsnDescentHook(`${root}/foo`, 1)).toBe(0);
      expect(dsnDescentHook(`${root}/bar`, 5)).toBe(0);
    }
  });

  test("returns currentDepth + 1 for non-package paths", () => {
    expect(dsnDescentHook("src", 0)).toBe(1);
    expect(dsnDescentHook("src/lib", 1)).toBe(2);
    expect(dsnDescentHook("packages", 0)).toBe(1); // 1-segment, not a pkg dir
    expect(dsnDescentHook("packages/foo/src", 1)).toBe(2); // 3-segment
  });

  test("returns 0 at deep monorepo pkg boundary too (multiple packages)", () => {
    // Two-segment path with a monorepo root first segment always
    // resets to 0, regardless of the walker's current depth.
    expect(dsnDescentHook("apps/web", 100)).toBe(0);
  });
});
