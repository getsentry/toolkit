/**
 * DSN Detector Tests (New Module)
 *
 * Tests for the new cached DSN detection with conflict detection.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearDsnCache, getCachedDsn } from "../../../src/lib/db/dsn-cache.js";
import {
  detectAllDsns,
  detectDsn,
  getDsnSourceDescription,
} from "../../../src/lib/dsn/detector.js";
import { useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("test-dsn-detector-");

describe("DSN Detector (New Module)", () => {
  let testDir: string;

  beforeEach(async () => {
    // Create project dir inside the config dir managed by useTestConfigDir.
    // Add .git to create a project root boundary so detectDsn doesn't
    // walk up into the real project and find its DSNs.
    testDir = join(getConfigDir(), "project");
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, ".git"), { recursive: true });
    // Clear any cached DSN for the test directory
    clearDsnCache(testDir);
    // Clear SENTRY_DSN env var
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
  });

  describe("detectDsn with caching", () => {
    test("caches DSN after first detection", async () => {
      const dsn = "https://key@o123.ingest.sentry.io/456";
      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${dsn}`);

      // First detection
      const result1 = await detectDsn(testDir);
      expect(result1?.raw).toBe(dsn);

      // Check cache was created
      const cached = getCachedDsn(testDir);
      expect(cached).toBeDefined();
      expect(cached?.dsn).toBe(dsn);
      expect(cached?.source).toBe("env_file");
      expect(cached?.sourcePath).toBe(".env");

      // Second detection should use cache
      const result2 = await detectDsn(testDir);
      expect(result2?.raw).toBe(dsn);
    });

    test("updates cache when DSN changes", async () => {
      const dsn1 = "https://key1@o111.ingest.sentry.io/111";
      const dsn2 = "https://key2@o222.ingest.sentry.io/222";

      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${dsn1}`);

      // First detection
      const result1 = await detectDsn(testDir);
      expect(result1?.raw).toBe(dsn1);

      // Change DSN
      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${dsn2}`);

      // Second detection should detect change
      const result2 = await detectDsn(testDir);
      expect(result2?.raw).toBe(dsn2);

      // Cache should be updated
      const cached = getCachedDsn(testDir);
      expect(cached?.dsn).toBe(dsn2);
    });

    test("code DSN takes priority over env file", async () => {
      const envFileDsn = "https://file@o111.ingest.sentry.io/111";
      const codeDsn = "https://code@o222.ingest.sentry.io/222";

      // Set up both env file and code file
      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${envFileDsn}`);
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src/config.ts"),
        `Sentry.init({ dsn: "${codeDsn}" })`
      );

      // Code DSN takes priority over .env file DSN
      // Priority order: code > env_file > env_var
      const result = await detectDsn(testDir);
      expect(result?.raw).toBe(codeDsn);
      expect(result?.source).toBe("code");
    });

    test("code DSN takes priority over env var", async () => {
      const envVarDsn = "https://var@o111.ingest.sentry.io/111";
      const codeDsn = "https://code@o222.ingest.sentry.io/222";

      // Set env var
      process.env.SENTRY_DSN = envVarDsn;

      // Set up code file
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src/config.ts"),
        `Sentry.init({ dsn: "${codeDsn}" })`
      );

      // Should return code DSN (highest priority)
      const result = await detectDsn(testDir);
      expect(result?.raw).toBe(codeDsn);
      expect(result?.source).toBe("code");
    });

    test("env file takes priority over env var", async () => {
      const envVarDsn = "https://var@o111.ingest.sentry.io/111";
      const envFileDsn = "https://file@o222.ingest.sentry.io/222";

      // Set env var
      process.env.SENTRY_DSN = envVarDsn;

      // Set up env file
      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${envFileDsn}`);

      // Should return env file DSN (higher priority than env var)
      const result = await detectDsn(testDir);
      expect(result?.raw).toBe(envFileDsn);
      expect(result?.source).toBe("env_file");
    });

    test("env var is used when no code or env file exists", async () => {
      const envVarDsn = "https://var@o111.ingest.sentry.io/111";

      // Only set env var
      process.env.SENTRY_DSN = envVarDsn;

      // Should return env var DSN (lowest priority, but only one available)
      const result = await detectDsn(testDir);
      expect(result?.raw).toBe(envVarDsn);
      expect(result?.source).toBe("env");
    });

    test("env var DSN is cached and verified without full scan", async () => {
      const envVarDsn = "https://var@o111.ingest.sentry.io/111";
      const changedDsn = "https://changed@o222.ingest.sentry.io/222";

      // Only set env var
      process.env.SENTRY_DSN = envVarDsn;

      // First detection - should detect and cache
      const result1 = await detectDsn(testDir);
      expect(result1?.raw).toBe(envVarDsn);
      expect(result1?.source).toBe("env");

      // Verify it's cached
      const cached = getCachedDsn(testDir);
      expect(cached?.dsn).toBe(envVarDsn);
      expect(cached?.source).toBe("env");

      // Second detection - should use cache verification (not full scan)
      const result2 = await detectDsn(testDir);
      expect(result2?.raw).toBe(envVarDsn);
      expect(result2?.source).toBe("env");

      // Change env var - should detect the change
      process.env.SENTRY_DSN = changedDsn;
      const result3 = await detectDsn(testDir);
      expect(result3?.raw).toBe(changedDsn);
      expect(result3?.source).toBe("env");

      // Cache should be updated
      const updatedCache = getCachedDsn(testDir);
      expect(updatedCache?.dsn).toBe(changedDsn);
    });

    test("cache verification respects priority when code DSN is added after env var", async () => {
      const envVarDsn = "https://var@o111.ingest.sentry.io/111";
      const codeDsn = "https://code@o222.ingest.sentry.io/222";

      // First, detect with only env var
      process.env.SENTRY_DSN = envVarDsn;
      const result1 = await detectDsn(testDir);
      expect(result1?.raw).toBe(envVarDsn);
      expect(result1?.source).toBe("env");

      // Verify it's cached
      const cached = getCachedDsn(testDir);
      expect(cached?.source).toBe("env");

      // Now add a code DSN (higher priority)
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src/config.ts"),
        `Sentry.init({ dsn: "${codeDsn}" })`
      );

      // Next detection should find the code DSN (higher priority)
      // even though env var is still cached
      const result2 = await detectDsn(testDir);
      expect(result2?.raw).toBe(codeDsn);
      expect(result2?.source).toBe("code");

      // Cache should be updated to code DSN
      const updatedCache = getCachedDsn(testDir);
      expect(updatedCache?.dsn).toBe(codeDsn);
      expect(updatedCache?.source).toBe("code");
    });

    test("skips node_modules and dist directories", async () => {
      const nodeModulesDsn = "https://nm@o111.ingest.sentry.io/111";
      const distDsn = "https://dist@o222.ingest.sentry.io/222";

      // Put DSNs in directories that should be skipped
      mkdirSync(join(testDir, "node_modules/some-package"), {
        recursive: true,
      });
      writeFileSync(
        join(testDir, "node_modules/some-package/index.js"),
        `Sentry.init({ dsn: "${nodeModulesDsn}" })`
      );

      mkdirSync(join(testDir, "dist"), { recursive: true });
      writeFileSync(
        join(testDir, "dist/bundle.js"),
        `Sentry.init({ dsn: "${distDsn}" })`
      );

      // Should not find any DSN (skipped directories)
      const result = await detectDsn(testDir);
      expect(result).toBeNull();
    });
  });

  describe("detectAllDsns (monorepo support)", () => {
    test("detects single DSN", async () => {
      const dsn = "https://key@o123.ingest.sentry.io/456";
      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${dsn}`);

      const result = await detectAllDsns(testDir);

      expect(result.hasMultiple).toBe(false);
      expect(result.primary?.raw).toBe(dsn);
      expect(result.all).toHaveLength(1);
    });

    test("detects multiple DSNs in different files", async () => {
      const dsn1 = "https://a@o111.ingest.sentry.io/111";
      const dsn2 = "https://b@o222.ingest.sentry.io/222";

      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${dsn1}`);
      writeFileSync(join(testDir, ".env.local"), `SENTRY_DSN=${dsn2}`);

      const result = await detectAllDsns(testDir);

      expect(result.hasMultiple).toBe(true);
      // Primary is now first found, not null
      expect(result.primary?.raw).toBe(dsn2); // .env.local has higher priority
      expect(result.all).toHaveLength(2);
    });

    test("deduplicates same DSN in multiple files", async () => {
      const dsn = "https://key@o123.ingest.sentry.io/456";

      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${dsn}`);
      writeFileSync(join(testDir, ".env.local"), `SENTRY_DSN=${dsn}`);

      const result = await detectAllDsns(testDir);

      expect(result.hasMultiple).toBe(false);
      expect(result.primary?.raw).toBe(dsn);
      // Should dedupe
      expect(result.all).toHaveLength(1);
    });

    test("detects multiple DSNs from env file and code", async () => {
      const envDsn = "https://env@o111.ingest.sentry.io/111";
      const codeDsn = "https://code@o222.ingest.sentry.io/222";

      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${envDsn}`);
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src/config.ts"),
        `Sentry.init({ dsn: "${codeDsn}" })`
      );

      const result = await detectAllDsns(testDir);

      expect(result.hasMultiple).toBe(true);
      // Code DSNs have highest priority (code > env_file > env_var)
      expect(result.primary?.raw).toBe(codeDsn);
      expect(result.all).toHaveLength(2);
    });

    test("includes env var in detection", async () => {
      const envVarDsn = "https://var@o111.ingest.sentry.io/111";
      const envFileDsn = "https://file@o222.ingest.sentry.io/222";

      process.env.SENTRY_DSN = envVarDsn;
      writeFileSync(join(testDir, ".env"), `SENTRY_DSN=${envFileDsn}`);

      const result = await detectAllDsns(testDir);

      expect(result.hasMultiple).toBe(true);
      expect(result.all).toHaveLength(2);
      expect(result.all.map((d) => d.raw)).toContain(envVarDsn);
      expect(result.all.map((d) => d.raw)).toContain(envFileDsn);
    });

    test("detects DSNs in monorepo package directories", async () => {
      const frontendDsn = "https://frontend@o111.ingest.sentry.io/111";
      const backendDsn = "https://backend@o222.ingest.sentry.io/222";

      // Create monorepo structure
      mkdirSync(join(testDir, "packages/frontend"), { recursive: true });
      mkdirSync(join(testDir, "packages/backend"), { recursive: true });

      writeFileSync(
        join(testDir, "packages/frontend/.env"),
        `SENTRY_DSN=${frontendDsn}`
      );
      writeFileSync(
        join(testDir, "packages/backend/.env"),
        `SENTRY_DSN=${backendDsn}`
      );

      const result = await detectAllDsns(testDir);

      expect(result.hasMultiple).toBe(true);
      expect(result.all).toHaveLength(2);
      expect(result.all.map((d) => d.raw)).toContain(frontendDsn);
      expect(result.all.map((d) => d.raw)).toContain(backendDsn);

      // Check packagePath is set correctly
      const frontend = result.all.find((d) => d.raw === frontendDsn);
      const backend = result.all.find((d) => d.raw === backendDsn);
      expect(frontend?.packagePath).toBe("packages/frontend");
      expect(backend?.packagePath).toBe("packages/backend");
    });

    test("detects DSNs in apps directory", async () => {
      const webDsn = "https://web@o111.ingest.sentry.io/111";
      const mobileDsn = "https://mobile@o222.ingest.sentry.io/222";

      // Create apps structure (common in Turborepo)
      mkdirSync(join(testDir, "apps/web"), { recursive: true });
      mkdirSync(join(testDir, "apps/mobile"), { recursive: true });

      writeFileSync(join(testDir, "apps/web/.env"), `SENTRY_DSN=${webDsn}`);
      writeFileSync(
        join(testDir, "apps/mobile/.env"),
        `SENTRY_DSN=${mobileDsn}`
      );

      const result = await detectAllDsns(testDir);

      expect(result.hasMultiple).toBe(true);
      expect(result.all).toHaveLength(2);

      const web = result.all.find((d) => d.raw === webDsn);
      const mobile = result.all.find((d) => d.raw === mobileDsn);
      expect(web?.packagePath).toBe("apps/web");
      expect(mobile?.packagePath).toBe("apps/mobile");
    });
  });

  describe("getDsnSourceDescription", () => {
    test("describes env source", () => {
      const dsn = {
        raw: "https://key@o1.ingest.sentry.io/1",
        source: "env" as const,
        protocol: "https",
        publicKey: "key",
        host: "o1.ingest.sentry.io",
        projectId: "1",
        orgId: "1",
      };

      expect(getDsnSourceDescription(dsn)).toBe(
        "SENTRY_DSN environment variable"
      );
    });

    test("describes env source with framework-prefixed var name", () => {
      const dsn = {
        raw: "https://key@o1.ingest.sentry.io/1",
        source: "env" as const,
        sourcePath: "NEXT_PUBLIC_SENTRY_DSN",
        protocol: "https",
        publicKey: "key",
        host: "o1.ingest.sentry.io",
        projectId: "1",
        orgId: "1",
      };

      expect(getDsnSourceDescription(dsn)).toBe(
        "NEXT_PUBLIC_SENTRY_DSN environment variable"
      );
    });

    test("describes env_file source with path", () => {
      const dsn = {
        raw: "https://key@o1.ingest.sentry.io/1",
        source: "env_file" as const,
        sourcePath: ".env.local",
        protocol: "https",
        publicKey: "key",
        host: "o1.ingest.sentry.io",
        projectId: "1",
        orgId: "1",
      };

      expect(getDsnSourceDescription(dsn)).toBe(".env.local");
    });

    test("describes code source with path", () => {
      const dsn = {
        raw: "https://key@o1.ingest.sentry.io/1",
        source: "code" as const,
        sourcePath: "src/instrumentation.ts",
        protocol: "https",
        publicKey: "key",
        host: "o1.ingest.sentry.io",
        projectId: "1",
        orgId: "1",
      };

      expect(getDsnSourceDescription(dsn)).toBe("src/instrumentation.ts");
    });

    test("describes inferred source", () => {
      const dsn = {
        raw: "https://key@o1.ingest.sentry.io/1",
        source: "inferred" as const,
        protocol: "https",
        publicKey: "key",
        host: "o1.ingest.sentry.io",
        projectId: "1",
        orgId: "1",
      };

      expect(getDsnSourceDescription(dsn)).toBe("directory name inference");
    });
  });
});
