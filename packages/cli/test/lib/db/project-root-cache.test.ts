/**
 * Project Root Cache Tests
 *
 * Tests for cwd -> projectRoot caching with mtime-based invalidation.
 */

import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  clearProjectRootCache,
  clearProjectRootCacheFor,
  getCachedProjectRoot,
  setCachedProjectRoot,
} from "../../../src/lib/db/project-root-cache.js";
import { cleanupTestDir, useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("test-project-root-cache-");
let testProjectDir: string;

beforeEach(() => {
  // Create a test project directory with a file (to have a stable mtime)
  testProjectDir = join(getConfigDir(), "project");
  mkdirSync(testProjectDir, { recursive: true });
  writeFileSync(join(testProjectDir, "package.json"), "{}");
});

describe("getCachedProjectRoot", () => {
  test("returns undefined when no cache entry exists", async () => {
    const result = await getCachedProjectRoot("/nonexistent/path");
    expect(result).toBeUndefined();
  });

  test("returns cached entry when valid", async () => {
    await setCachedProjectRoot(testProjectDir, {
      projectRoot: testProjectDir,
      reason: "language",
    });

    const result = await getCachedProjectRoot(testProjectDir);
    expect(result).toEqual({
      projectRoot: testProjectDir,
      reason: "language",
    });
  });

  test("invalidates cache when directory mtime changes", async () => {
    await setCachedProjectRoot(testProjectDir, {
      projectRoot: testProjectDir,
      reason: "language",
    });

    // Verify cache exists
    const before = await getCachedProjectRoot(testProjectDir);
    expect(before).toBeDefined();

    // Add a new file and set dir mtime to cachedMtime + 5s
    writeFileSync(join(testProjectDir, "new-file.txt"), "test");
    const cachedMtime = statSync(testProjectDir).mtimeMs;
    const futureTime = new Date(cachedMtime + 5000);
    utimesSync(testProjectDir, futureTime, futureTime);

    // Cache should be invalidated
    const after = await getCachedProjectRoot(testProjectDir);
    expect(after).toBeUndefined();
  });

  test("invalidates cache when directory is deleted", async () => {
    const tempDir = join(getConfigDir(), "temp-dir");
    mkdirSync(tempDir);
    writeFileSync(join(tempDir, "file.txt"), "test");

    await setCachedProjectRoot(tempDir, {
      projectRoot: tempDir,
      reason: "vcs",
    });

    // Verify cache exists
    const before = await getCachedProjectRoot(tempDir);
    expect(before).toBeDefined();

    // Delete the directory
    await cleanupTestDir(tempDir);

    // Cache should be invalidated
    const after = await getCachedProjectRoot(tempDir);
    expect(after).toBeUndefined();
  });
});

describe("setCachedProjectRoot", () => {
  test("stores project root with reason", async () => {
    await setCachedProjectRoot(testProjectDir, {
      projectRoot: "/some/root",
      reason: "vcs",
    });

    const result = await getCachedProjectRoot(testProjectDir);
    expect(result?.projectRoot).toBe("/some/root");
    expect(result?.reason).toBe("vcs");
  });

  test("overwrites existing cache entry", async () => {
    await setCachedProjectRoot(testProjectDir, {
      projectRoot: "/first/root",
      reason: "language",
    });

    await setCachedProjectRoot(testProjectDir, {
      projectRoot: "/second/root",
      reason: "vcs",
    });

    const result = await getCachedProjectRoot(testProjectDir);
    expect(result?.projectRoot).toBe("/second/root");
    expect(result?.reason).toBe("vcs");
  });

  test("does not cache when directory cannot be stat", async () => {
    await setCachedProjectRoot("/nonexistent/path", {
      projectRoot: "/some/root",
      reason: "vcs",
    });

    // Should not have cached anything (can't stat the directory)
    const result = await getCachedProjectRoot("/nonexistent/path");
    expect(result).toBeUndefined();
  });
});

describe("clearProjectRootCache", () => {
  test("removes all cached entries", async () => {
    const dir1 = join(getConfigDir(), "dir1");
    const dir2 = join(getConfigDir(), "dir2");
    mkdirSync(dir1);
    mkdirSync(dir2);

    await setCachedProjectRoot(dir1, {
      projectRoot: dir1,
      reason: "vcs",
    });
    await setCachedProjectRoot(dir2, {
      projectRoot: dir2,
      reason: "language",
    });

    // Verify both exist
    expect(await getCachedProjectRoot(dir1)).toBeDefined();
    expect(await getCachedProjectRoot(dir2)).toBeDefined();

    // Clear all
    await clearProjectRootCache();

    // Both should be gone
    expect(await getCachedProjectRoot(dir1)).toBeUndefined();
    expect(await getCachedProjectRoot(dir2)).toBeUndefined();
  });

  test("is safe to call on empty cache", async () => {
    // Should not throw
    await clearProjectRootCache();
  });
});

describe("clearProjectRootCacheFor", () => {
  test("removes only the specified entry", async () => {
    const dir1 = join(getConfigDir(), "dir1");
    const dir2 = join(getConfigDir(), "dir2");
    mkdirSync(dir1);
    mkdirSync(dir2);

    await setCachedProjectRoot(dir1, {
      projectRoot: dir1,
      reason: "vcs",
    });
    await setCachedProjectRoot(dir2, {
      projectRoot: dir2,
      reason: "language",
    });

    // Clear only dir1
    await clearProjectRootCacheFor(dir1);

    // dir1 should be gone, dir2 should remain
    expect(await getCachedProjectRoot(dir1)).toBeUndefined();
    expect(await getCachedProjectRoot(dir2)).toBeDefined();
  });

  test("is safe to call for nonexistent entry", async () => {
    // Should not throw
    await clearProjectRootCacheFor("/nonexistent/path");
  });
});
