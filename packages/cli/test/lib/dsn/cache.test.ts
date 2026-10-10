/**
 * DSN Cache Tests
 *
 * Tests for DSN detection caching functionality.
 */

import { describe, expect, test } from "vitest";
import {
  clearDsnCache,
  getCachedDsn,
  setCachedDsn,
  updateCachedResolution,
} from "../../../src/lib/db/dsn-cache.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-dsn-cache-");

describe("DSN Cache", () => {
  describe("getCachedDsn", () => {
    test("returns undefined when no cache exists", async () => {
      const result = getCachedDsn("/some/path");
      expect(result).toBeUndefined();
    });

    test("returns cached entry when it exists", async () => {
      const testDir = "/test/directory";
      setCachedDsn(testDir, {
        dsn: "https://key@o123.ingest.sentry.io/456",
        projectId: "456",
        orgId: "123",
        source: "env_file",
        sourcePath: ".env.local",
      });

      const result = getCachedDsn(testDir);

      expect(result).toBeDefined();
      expect(result?.dsn).toBe("https://key@o123.ingest.sentry.io/456");
      expect(result?.projectId).toBe("456");
      expect(result?.source).toBe("env_file");
      expect(result?.cachedAt).toBeDefined();
    });
  });

  describe("setCachedDsn", () => {
    test("creates new cache entry", async () => {
      const testDir = "/new/directory";

      setCachedDsn(testDir, {
        dsn: "https://abc@o789.ingest.sentry.io/111",
        projectId: "111",
        orgId: "789",
        source: "code",
        sourcePath: "src/config.ts",
      });

      const cached = getCachedDsn(testDir);
      expect(cached?.dsn).toBe("https://abc@o789.ingest.sentry.io/111");
      expect(cached?.sourcePath).toBe("src/config.ts");
    });

    test("updates existing cache entry", async () => {
      const testDir = "/update/test";

      setCachedDsn(testDir, {
        dsn: "https://old@o1.ingest.sentry.io/1",
        projectId: "1",
        orgId: "1",
        source: "env_file",
      });

      setCachedDsn(testDir, {
        dsn: "https://new@o2.ingest.sentry.io/2",
        projectId: "2",
        orgId: "2",
        source: "code",
      });

      const cached = getCachedDsn(testDir);
      expect(cached?.dsn).toBe("https://new@o2.ingest.sentry.io/2");
      expect(cached?.projectId).toBe("2");
    });

    test("adds cachedAt timestamp", async () => {
      const testDir = "/timestamp/test";
      const before = Date.now();

      setCachedDsn(testDir, {
        dsn: "https://key@o1.ingest.sentry.io/1",
        projectId: "1",
        source: "env",
      });

      const after = Date.now();
      const cached = getCachedDsn(testDir);

      expect(cached?.cachedAt).toBeGreaterThanOrEqual(before);
      expect(cached?.cachedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("updateCachedResolution", () => {
    test("adds resolved info to existing cache entry", async () => {
      const testDir = "/resolve/test";

      setCachedDsn(testDir, {
        dsn: "https://key@o123.ingest.sentry.io/456",
        projectId: "456",
        orgId: "123",
        source: "env_file",
      });

      updateCachedResolution(testDir, {
        orgSlug: "my-org",
        orgName: "My Organization",
        projectSlug: "my-project",
        projectName: "My Project",
      });

      const cached = getCachedDsn(testDir);
      expect(cached?.resolved).toBeDefined();
      expect(cached?.resolved?.orgSlug).toBe("my-org");
      expect(cached?.resolved?.projectName).toBe("My Project");
    });

    test("does nothing when no cache entry exists", async () => {
      updateCachedResolution("/nonexistent", {
        orgSlug: "test",
        orgName: "Test",
        projectSlug: "test",
        projectName: "Test",
      });

      const cached = getCachedDsn("/nonexistent");
      expect(cached).toBeUndefined();
    });
  });

  describe("clearDsnCache", () => {
    test("clears specific directory cache", async () => {
      const dir1 = "/dir1";
      const dir2 = "/dir2";

      setCachedDsn(dir1, {
        dsn: "https://a@o1.ingest.sentry.io/1",
        projectId: "1",
        source: "env",
      });
      setCachedDsn(dir2, {
        dsn: "https://b@o2.ingest.sentry.io/2",
        projectId: "2",
        source: "env",
      });

      clearDsnCache(dir1);

      expect(getCachedDsn(dir1)).toBeUndefined();
      expect(getCachedDsn(dir2)).toBeDefined();
    });

    test("clears all cache when no directory specified", async () => {
      setCachedDsn("/dir1", {
        dsn: "https://a@o1.ingest.sentry.io/1",
        projectId: "1",
        source: "env",
      });
      setCachedDsn("/dir2", {
        dsn: "https://b@o2.ingest.sentry.io/2",
        projectId: "2",
        source: "env",
      });

      clearDsnCache();

      expect(getCachedDsn("/dir1")).toBeUndefined();
      expect(getCachedDsn("/dir2")).toBeUndefined();
    });
  });
});
