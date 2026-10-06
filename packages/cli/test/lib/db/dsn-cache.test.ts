/**
 * DSN Cache Tests
 *
 * Tests for both single-DSN caching and full detection caching with mtime validation.
 */

import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearDsnCache,
  disableDsnCache,
  enableDsnCache,
  getCachedDetection,
  getCachedDsn,
  setCachedDetection,
  setCachedDsn,
  updateCachedResolution,
} from "../../../src/lib/db/dsn-cache.js";
import type { DetectedDsn } from "../../../src/lib/dsn/types.js";
import { useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("test-dsn-cache-");
let testProjectDir: string;

beforeEach(() => {
  // Create a test project directory with source files
  testProjectDir = join(getConfigDir(), "project");
  mkdirSync(testProjectDir, { recursive: true });
  mkdirSync(join(testProjectDir, "src"), { recursive: true });
  writeFileSync(
    join(testProjectDir, "src/app.ts"),
    'const DSN = "https://abc@o123.ingest.sentry.io/456";'
  );
});

afterEach(() => {
  enableDsnCache();
});

// =============================================================================
// Single DSN Cache Tests (Original functionality)
// =============================================================================

describe("getCachedDsn", () => {
  test("returns undefined when no cache entry exists", async () => {
    const result = getCachedDsn("/nonexistent/path");
    expect(result).toBeUndefined();
  });

  test("returns cached entry when it exists", async () => {
    setCachedDsn(testProjectDir, {
      dsn: "https://abc@o123.ingest.sentry.io/456",
      projectId: "456",
      orgId: "123",
      source: "env",
      sourcePath: ".env",
    });

    const result = getCachedDsn(testProjectDir);
    expect(result?.dsn).toBe("https://abc@o123.ingest.sentry.io/456");
    expect(result?.projectId).toBe("456");
    expect(result?.orgId).toBe("123");
    expect(result?.source).toBe("env");
    expect(result?.sourcePath).toBe(".env");
  });

  test("treats empty DSN rows from setCachedDetection as cache misses", async () => {
    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "fp-empty",
      allDsns: [],
      sourceMtimes: {},
      dirMtimes: {},
      rootDirMtime,
    });

    // Single-DSN callers must not receive dsn="".
    expect(getCachedDsn(testProjectDir)).toBeUndefined();

    // Full-detection cache still records a valid empty scan so we don't rescan.
    const detection = await getCachedDetection(testProjectDir);
    expect(detection?.allDsns).toHaveLength(0);
  });
});

describe("setCachedDsn", () => {
  test("stores DSN cache entry", async () => {
    setCachedDsn(testProjectDir, {
      dsn: "https://key@o999.ingest.sentry.io/111",
      projectId: "111",
      orgId: "999",
      source: "code",
      sourcePath: "src/index.ts",
    });

    const result = getCachedDsn(testProjectDir);
    expect(result?.dsn).toBe("https://key@o999.ingest.sentry.io/111");
    expect(result?.projectId).toBe("111");
  });

  test("overwrites existing cache entry", async () => {
    setCachedDsn(testProjectDir, {
      dsn: "https://first@o1.ingest.sentry.io/1",
      projectId: "1",
      source: "env",
    });

    setCachedDsn(testProjectDir, {
      dsn: "https://second@o2.ingest.sentry.io/2",
      projectId: "2",
      source: "code",
    });

    const result = getCachedDsn(testProjectDir);
    expect(result?.dsn).toBe("https://second@o2.ingest.sentry.io/2");
    expect(result?.projectId).toBe("2");
  });
});

describe("updateCachedResolution", () => {
  test("updates resolved org/project info", async () => {
    setCachedDsn(testProjectDir, {
      dsn: "https://abc@o123.ingest.sentry.io/456",
      projectId: "456",
      source: "env",
    });

    updateCachedResolution(testProjectDir, {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const result = getCachedDsn(testProjectDir);
    expect(result?.resolved?.orgSlug).toBe("my-org");
    expect(result?.resolved?.orgName).toBe("My Organization");
    expect(result?.resolved?.projectSlug).toBe("my-project");
    expect(result?.resolved?.projectName).toBe("My Project");
  });

  test("does nothing if cache entry does not exist", async () => {
    // Should not throw
    updateCachedResolution("/nonexistent", {
      orgSlug: "org",
      orgName: "Org",
      projectSlug: "project",
      projectName: "Project",
    });
  });
});

describe("clearDsnCache", () => {
  test("removes specific directory cache", async () => {
    setCachedDsn(testProjectDir, {
      dsn: "https://abc@o123.ingest.sentry.io/456",
      projectId: "456",
      source: "env",
    });

    clearDsnCache(testProjectDir);

    const result = getCachedDsn(testProjectDir);
    expect(result).toBeUndefined();
  });

  test("removes all caches when no directory specified", async () => {
    const dir1 = join(getConfigDir(), "dir1");
    const dir2 = join(getConfigDir(), "dir2");
    mkdirSync(dir1);
    mkdirSync(dir2);

    setCachedDsn(dir1, {
      dsn: "https://a@o1.ingest.sentry.io/1",
      projectId: "1",
      source: "env",
    });
    setCachedDsn(dir2, {
      dsn: "https://b@o2.ingest.sentry.io/2",
      projectId: "2",
      source: "code",
    });

    clearDsnCache();

    expect(getCachedDsn(dir1)).toBeUndefined();
    expect(getCachedDsn(dir2)).toBeUndefined();
  });
});

const createTestDsn = (overrides: Partial<DetectedDsn> = {}): DetectedDsn => ({
  protocol: "https",
  publicKey: "testkey",
  host: "o123.ingest.sentry.io",
  projectId: "456",
  orgId: "123",
  raw: "https://testkey@o123.ingest.sentry.io/456",
  source: "code",
  sourcePath: "src/app.ts",
  ...overrides,
});

// =============================================================================
// Cache Bypass Tests (--fresh flag support)
// =============================================================================

describe("disableDsnCache / enableDsnCache", () => {
  test("getCachedDsn returns undefined when cache is disabled", async () => {
    setCachedDsn(testProjectDir, {
      dsn: "https://abc@o123.ingest.sentry.io/456",
      projectId: "456",
      orgId: "123",
      source: "code",
    });

    // Verify it exists before disabling
    expect(getCachedDsn(testProjectDir)).toBeDefined();

    disableDsnCache();
    expect(getCachedDsn(testProjectDir)).toBeUndefined();

    // Re-enable and verify it's still there
    enableDsnCache();
    expect(getCachedDsn(testProjectDir)).toBeDefined();
  });

  test("getCachedDetection returns undefined when cache is disabled", async () => {
    const testDsn = createTestDsn();
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };
    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "test-fp",
      allDsns: [testDsn],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    // Verify it exists before disabling
    expect(await getCachedDetection(testProjectDir)).toBeDefined();

    disableDsnCache();
    expect(await getCachedDetection(testProjectDir)).toBeUndefined();

    enableDsnCache();
    expect(await getCachedDetection(testProjectDir)).toBeDefined();
  });

  test("cache writes still work when disabled", async () => {
    disableDsnCache();

    // Write while disabled
    setCachedDsn(testProjectDir, {
      dsn: "https://abc@o123.ingest.sentry.io/456",
      projectId: "456",
      source: "code",
    });

    // Can't read while disabled
    expect(getCachedDsn(testProjectDir)).toBeUndefined();

    // Re-enable and verify the write persisted
    enableDsnCache();
    const result = getCachedDsn(testProjectDir);
    expect(result?.dsn).toBe("https://abc@o123.ingest.sentry.io/456");
  });
});

// =============================================================================
// Full Detection Cache Tests (v4 functionality)
// =============================================================================

describe("getCachedDetection", () => {
  test("returns undefined when no cache entry exists", async () => {
    const result = await getCachedDetection("/nonexistent/path");
    expect(result).toBeUndefined();
  });

  test("returns cached detection when valid", async () => {
    const testDsn = createTestDsn();
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };

    // Get current root dir mtime
    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "test-fingerprint",
      allDsns: [testDsn],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    const result = await getCachedDetection(testProjectDir);
    expect(result).toBeDefined();
    expect(result?.fingerprint).toBe("test-fingerprint");
    expect(result?.allDsns).toHaveLength(1);
    expect(result?.allDsns[0].raw).toBe(testDsn.raw);
  });

  test("invalidates cache when source file mtime changes", async () => {
    const testDsn = createTestDsn();
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };

    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "test-fingerprint",
      allDsns: [testDsn],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    // Verify cache exists
    const before = await getCachedDetection(testProjectDir);
    expect(before).toBeDefined();

    // Modify source file and set mtime to cachedMtime + 5s to guarantee
    // a detectable difference regardless of OS clock resolution.
    const srcFile = join(testProjectDir, "src/app.ts");
    writeFileSync(
      srcFile,
      'const DSN = "https://changed@o123.ingest.sentry.io/789";'
    );
    const futureTime = new Date(sourceMtimes["src/app.ts"] + 5000);
    utimesSync(srcFile, futureTime, futureTime);

    // Cache should be invalidated
    const after = await getCachedDetection(testProjectDir);
    expect(after).toBeUndefined();
  });

  test("invalidates cache when source file is deleted", async () => {
    const testDsn = createTestDsn();
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };

    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "test-fingerprint",
      allDsns: [testDsn],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    // Delete the source file
    const { rm } = await import("node:fs/promises");
    await rm(join(testProjectDir, "src/app.ts"));

    // Cache should be invalidated
    const result = await getCachedDetection(testProjectDir);
    expect(result).toBeUndefined();
  });

  test("invalidates cache when root directory mtime changes", async () => {
    const testDsn = createTestDsn();
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };

    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "test-fingerprint",
      allDsns: [testDsn],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    // Verify cache exists
    const before = await getCachedDetection(testProjectDir);
    expect(before).toBeDefined();

    // Add a new file and set root dir mtime to cachedMtime + 5s
    writeFileSync(join(testProjectDir, "new-file.txt"), "test");
    const futureTime = new Date(rootDirMtime + 5000);
    utimesSync(testProjectDir, futureTime, futureTime);

    // Cache should be invalidated
    const after = await getCachedDetection(testProjectDir);
    expect(after).toBeUndefined();
  });

  test("invalidates cache when tracked subdirectory mtime changes", async () => {
    const testDsn = createTestDsn();
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };

    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);
    const srcStats = await stat(join(testProjectDir, "src"));
    const srcDirMtime = Math.floor(srcStats.mtimeMs);

    // Store cache with tracked src/ directory mtime
    setCachedDetection(testProjectDir, {
      fingerprint: "test-fingerprint",
      allDsns: [testDsn],
      sourceMtimes,
      dirMtimes: { src: srcDirMtime },
      rootDirMtime,
    });

    // Verify cache exists
    const before = await getCachedDetection(testProjectDir);
    expect(before).toBeDefined();

    // Add a new file to src/ and set mtime to cachedMtime + 5s
    const srcDir = join(testProjectDir, "src");
    writeFileSync(join(srcDir, "new-config.ts"), "export default {}");
    const futureTime = new Date(srcDirMtime + 5000);
    utimesSync(srcDir, futureTime, futureTime);

    // Cache should be invalidated because src/ mtime changed
    const after = await getCachedDetection(testProjectDir);
    expect(after).toBeUndefined();
  });
});

describe("setCachedDetection", () => {
  test("stores full detection result", async () => {
    const testDsn = createTestDsn();
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };

    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "fp-123",
      allDsns: [testDsn],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    const result = await getCachedDetection(testProjectDir);
    expect(result?.fingerprint).toBe("fp-123");
    expect(result?.allDsns).toHaveLength(1);
    expect(Object.keys(result?.sourceMtimes ?? {})).toContain("src/app.ts");
  });

  test("stores multiple DSNs", async () => {
    const dsn1 = createTestDsn({ raw: "https://a@o1.ingest.sentry.io/1" });
    const dsn2 = createTestDsn({ raw: "https://b@o2.ingest.sentry.io/2" });
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };

    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "fp-multi",
      allDsns: [dsn1, dsn2],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    const result = await getCachedDetection(testProjectDir);
    expect(result?.allDsns).toHaveLength(2);
  });

  test("stores empty DSN array", async () => {
    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "fp-empty",
      allDsns: [],
      sourceMtimes: {},
      dirMtimes: {},
      rootDirMtime,
    });

    const result = await getCachedDetection(testProjectDir);
    expect(result?.fingerprint).toBe("fp-empty");
    expect(result?.allDsns).toHaveLength(0);
  });

  test("overwrites existing detection cache", async () => {
    const dsn1 = createTestDsn({ raw: "https://first@o1.ingest.sentry.io/1" });
    const dsn2 = createTestDsn({ raw: "https://second@o2.ingest.sentry.io/2" });
    const sourceMtimes = {
      "src/app.ts": Math.floor(
        statSync(join(testProjectDir, "src/app.ts")).mtimeMs
      ),
    };

    const { stat } = await import("node:fs/promises");
    const rootStats = await stat(testProjectDir);
    const rootDirMtime = Math.floor(rootStats.mtimeMs);

    setCachedDetection(testProjectDir, {
      fingerprint: "fp-first",
      allDsns: [dsn1],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    setCachedDetection(testProjectDir, {
      fingerprint: "fp-second",
      allDsns: [dsn2],
      sourceMtimes,
      dirMtimes: {},
      rootDirMtime,
    });

    const result = await getCachedDetection(testProjectDir);
    expect(result?.fingerprint).toBe("fp-second");
    expect(result?.allDsns[0].raw).toBe("https://second@o2.ingest.sentry.io/2");
  });
});
