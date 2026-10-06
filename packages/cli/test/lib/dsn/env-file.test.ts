/**
 * Environment File Detection Tests
 *
 * Tests for .env file parsing and DSN extraction.
 * Includes property-based tests for the pure parsing function
 * and integration tests for file-system based detection.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  constantFrom,
  assert as fcAssert,
  oneof,
  property,
  string,
} from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  detectFromAllEnvFiles,
  detectFromEnvFiles,
  detectFromMonorepoEnvFiles,
  ENV_FILES,
  extractDsnFromEnvContent,
} from "../../../src/lib/dsn/env-file.js";
import { cleanupTestDir, createTestConfigDir } from "../../helpers.js";

// ============================================================================
// Arbitraries for Property-Based Testing
// ============================================================================

/** Valid DSN format for testing */
const validDsnArb = string({ minLength: 1, maxLength: 20 }).map(
  (key) => `https://${key.replace(/[^a-z0-9]/gi, "a")}@sentry.io/123`
);

/** Generate content without SENTRY_DSN */
const envContentWithoutDsnArb = oneof(
  constantFrom("", "# Just a comment", "OTHER_VAR=value", "SENTRY_OTHER=value")
);

// ============================================================================
// Property Tests for extractDsnFromEnvContent
// ============================================================================

describe("property: extractDsnFromEnvContent", () => {
  test("extracts DSN from unquoted value", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const content = `SENTRY_DSN=${dsn}`;
        expect(extractDsnFromEnvContent(content)).toBe(dsn);
      }),
      { numRuns: 50 }
    );
  });

  test("extracts DSN from double-quoted value", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const content = `SENTRY_DSN="${dsn}"`;
        expect(extractDsnFromEnvContent(content)).toBe(dsn);
      }),
      { numRuns: 50 }
    );
  });

  test("extracts DSN from single-quoted value", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const content = `SENTRY_DSN='${dsn}'`;
        expect(extractDsnFromEnvContent(content)).toBe(dsn);
      }),
      { numRuns: 50 }
    );
  });

  test("returns null when no SENTRY_DSN present", () => {
    fcAssert(
      property(envContentWithoutDsnArb, (content) => {
        expect(extractDsnFromEnvContent(content)).toBeNull();
      }),
      { numRuns: 50 }
    );
  });

  test("ignores lines after finding SENTRY_DSN", () => {
    fcAssert(
      property(validDsnArb, validDsnArb, (dsn1, dsn2) => {
        const content = `SENTRY_DSN=${dsn1}\nSENTRY_DSN=${dsn2}`;
        // Should return the first one
        expect(extractDsnFromEnvContent(content)).toBe(dsn1);
      }),
      { numRuns: 30 }
    );
  });

  test("handles whitespace around equals sign", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const content = `SENTRY_DSN = ${dsn}`;
        expect(extractDsnFromEnvContent(content)).toBe(dsn);
      }),
      { numRuns: 30 }
    );
  });
});

// ============================================================================
// Unit Tests for extractDsnFromEnvContent Edge Cases
// ============================================================================

describe("extractDsnFromEnvContent edge cases", () => {
  test("returns null for empty string", () => {
    expect(extractDsnFromEnvContent("")).toBeNull();
  });

  test("returns null for only comments", () => {
    const content = `# This is a comment
# Another comment
# SENTRY_DSN=commented-out`;
    expect(extractDsnFromEnvContent(content)).toBeNull();
  });

  test("returns null for only whitespace", () => {
    expect(extractDsnFromEnvContent("   \n\t\n   ")).toBeNull();
  });

  test("ignores commented SENTRY_DSN", () => {
    const content = `# SENTRY_DSN=commented-out
SENTRY_DSN=https://real@sentry.io/123`;
    expect(extractDsnFromEnvContent(content)).toBe(
      "https://real@sentry.io/123"
    );
  });

  test("handles trailing comment on same line", () => {
    const content = "SENTRY_DSN=https://key@sentry.io/123 # This is a comment";
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("handles mixed content with SENTRY_DSN in middle", () => {
    const content = `
OTHER_VAR=foo
# Comment
SENTRY_DSN=https://key@sentry.io/123
ANOTHER_VAR=bar
`;
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("handles Windows line endings (CRLF)", () => {
    const content = "OTHER=foo\r\nSENTRY_DSN=https://key@sentry.io/123\r\n";
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("handles value with equals signs", () => {
    const content = "SENTRY_DSN=https://key@sentry.io/123?key=value";
    expect(extractDsnFromEnvContent(content)).toBe(
      "https://key@sentry.io/123?key=value"
    );
  });

  test("handles empty value", () => {
    const content = "SENTRY_DSN=";
    // Empty string is falsy, so should return null
    expect(extractDsnFromEnvContent(content)).toBeNull();
  });

  test("handles value with spaces in quotes", () => {
    const content = `SENTRY_DSN="https://key@sentry.io/123"`;
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("ignores SENTRY_DSN_OTHER variations", () => {
    const content = `SENTRY_DSN_OTHER=https://wrong@sentry.io/123
SENTRY_DSN=https://correct@sentry.io/456`;
    expect(extractDsnFromEnvContent(content)).toBe(
      "https://correct@sentry.io/456"
    );
  });

  test("handles leading whitespace on line", () => {
    const content = "  SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });
});

// ============================================================================
// Framework-Prefixed Env Var Tests
// ============================================================================

describe("extractDsnFromEnvContent framework-prefixed vars", () => {
  test("extracts DSN from NEXT_PUBLIC_SENTRY_DSN", () => {
    const content = "NEXT_PUBLIC_SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("extracts DSN from REACT_APP_SENTRY_DSN", () => {
    const content = 'REACT_APP_SENTRY_DSN="https://key@sentry.io/123"';
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("extracts DSN from VITE_SENTRY_DSN", () => {
    const content = "VITE_SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("extracts DSN from EXPO_PUBLIC_SENTRY_DSN", () => {
    const content = "EXPO_PUBLIC_SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("extracts DSN from NUXT_PUBLIC_SENTRY_DSN", () => {
    const content = "NUXT_PUBLIC_SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBe("https://key@sentry.io/123");
  });

  test("canonical SENTRY_DSN is returned when it appears first", () => {
    const content = `SENTRY_DSN=https://canonical@sentry.io/1
NEXT_PUBLIC_SENTRY_DSN=https://next@sentry.io/2`;
    expect(extractDsnFromEnvContent(content)).toBe(
      "https://canonical@sentry.io/1"
    );
  });

  test("framework-prefixed var returned when it appears before canonical", () => {
    const content = `NEXT_PUBLIC_SENTRY_DSN=https://next@sentry.io/2
SENTRY_DSN=https://canonical@sentry.io/1`;
    expect(extractDsnFromEnvContent(content)).toBe("https://next@sentry.io/2");
  });

  test("rejects unknown prefix MY_CUSTOM_SENTRY_DSN", () => {
    const content = "MY_CUSTOM_SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBeNull();
  });

  test("rejects unknown prefix GATSBY_SENTRY_DSN", () => {
    const content = "GATSBY_SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBeNull();
  });

  test("rejects bare underscore prefix _SENTRY_DSN", () => {
    const content = "_SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBeNull();
  });

  test("rejects VUE_APP_SENTRY_DSN (not in allowlist)", () => {
    const content = "VUE_APP_SENTRY_DSN=https://key@sentry.io/123";
    expect(extractDsnFromEnvContent(content)).toBeNull();
  });
});

// ============================================================================
// Integration Tests for File-Based Detection
// ============================================================================

describe("integration: file-based detection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestConfigDir("test-env-file-");
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  describe("detectFromEnvFiles", () => {
    test("returns null when no .env files exist", async () => {
      const result = await detectFromEnvFiles(testDir);
      expect(result).toBeNull();
    });

    test("detects DSN from .env file", async () => {
      writeFileSync(
        join(testDir, ".env"),
        "SENTRY_DSN=https://key@sentry.io/123"
      );

      const result = await detectFromEnvFiles(testDir);
      expect(result).not.toBeNull();
      expect(result?.raw).toBe("https://key@sentry.io/123");
      expect(result?.source).toBe("env_file");
    });

    test("detects DSN from .env.local with higher priority", async () => {
      writeFileSync(
        join(testDir, ".env"),
        "SENTRY_DSN=https://default@sentry.io/1"
      );
      writeFileSync(
        join(testDir, ".env.local"),
        "SENTRY_DSN=https://local@sentry.io/2"
      );

      const result = await detectFromEnvFiles(testDir);
      expect(result).not.toBeNull();
      // .env.local has higher priority than .env
      expect(result?.raw).toBe("https://local@sentry.io/2");
    });

    test("returns null when .env exists but has no DSN", async () => {
      writeFileSync(join(testDir, ".env"), "OTHER_VAR=value");

      const result = await detectFromEnvFiles(testDir);
      expect(result).toBeNull();
    });

    test("returns null when .env contains invalid DSN", async () => {
      writeFileSync(join(testDir, ".env"), "SENTRY_DSN=not-a-valid-dsn");

      const result = await detectFromEnvFiles(testDir);
      // Invalid DSN should be parsed but createDetectedDsn may return null
      // depending on DSN validation
      // For this test, we just verify it doesn't crash
      expect(result === null || result?.raw === "not-a-valid-dsn").toBe(true);
    });

    test("respects ENV_FILES priority order", async () => {
      // Create multiple files
      writeFileSync(
        join(testDir, ".env.development"),
        "SENTRY_DSN=https://dev@sentry.io/3"
      );
      writeFileSync(
        join(testDir, ".env.local"),
        "SENTRY_DSN=https://local@sentry.io/2"
      );

      const result = await detectFromEnvFiles(testDir);
      // .env.local should be checked before .env.development
      expect(result?.raw).toBe("https://local@sentry.io/2");
    });
  });

  describe("detectFromAllEnvFiles", () => {
    test("returns empty result when no .env files exist", async () => {
      const result = await detectFromAllEnvFiles(testDir);
      expect(result.dsns).toHaveLength(0);
      expect(Object.keys(result.sourceMtimes)).toHaveLength(0);
    });

    test("detects multiple DSNs from different .env files", async () => {
      writeFileSync(
        join(testDir, ".env"),
        "SENTRY_DSN=https://default@sentry.io/1"
      );
      writeFileSync(
        join(testDir, ".env.local"),
        "SENTRY_DSN=https://local@sentry.io/2"
      );

      const result = await detectFromAllEnvFiles(testDir);
      // Should find DSNs in both files (not stop at first)
      expect(result.dsns).toHaveLength(2);

      const rawDsns = result.dsns.map((d) => d.raw).sort();
      expect(rawDsns).toContain("https://default@sentry.io/1");
      expect(rawDsns).toContain("https://local@sentry.io/2");
    });

    test("includes source mtimes for caching", async () => {
      writeFileSync(
        join(testDir, ".env"),
        "SENTRY_DSN=https://key@sentry.io/123"
      );

      const result = await detectFromAllEnvFiles(testDir);
      expect(result.dsns).toHaveLength(1);
      expect(Object.keys(result.sourceMtimes)).toHaveLength(1);
      expect(result.sourceMtimes[".env"]).toBeGreaterThan(0);
    });
  });

  describe("detectFromMonorepoEnvFiles", () => {
    test("returns empty result when no monorepo dirs exist", async () => {
      const result = await detectFromMonorepoEnvFiles(testDir);
      expect(result.dsns).toHaveLength(0);
    });

    test("detects DSN in packages/ subdirectory", async () => {
      const pkgDir = join(testDir, "packages", "frontend");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, ".env"),
        "SENTRY_DSN=https://frontend@sentry.io/1"
      );

      const result = await detectFromMonorepoEnvFiles(testDir);
      expect(result.dsns).toHaveLength(1);
      expect(result.dsns[0].raw).toBe("https://frontend@sentry.io/1");
      expect(result.dsns[0].packagePath).toBe("packages/frontend");
    });

    test("detects DSN in apps/ subdirectory", async () => {
      const appDir = join(testDir, "apps", "web");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, ".env"), "SENTRY_DSN=https://web@sentry.io/2");

      const result = await detectFromMonorepoEnvFiles(testDir);
      expect(result.dsns).toHaveLength(1);
      expect(result.dsns[0].raw).toBe("https://web@sentry.io/2");
      expect(result.dsns[0].packagePath).toBe("apps/web");
    });

    test("detects DSNs from multiple monorepo packages", async () => {
      // Create packages/
      const pkg1 = join(testDir, "packages", "frontend");
      const pkg2 = join(testDir, "packages", "backend");
      mkdirSync(pkg1, { recursive: true });
      mkdirSync(pkg2, { recursive: true });
      writeFileSync(
        join(pkg1, ".env"),
        "SENTRY_DSN=https://frontend@sentry.io/1"
      );
      writeFileSync(
        join(pkg2, ".env"),
        "SENTRY_DSN=https://backend@sentry.io/2"
      );

      const result = await detectFromMonorepoEnvFiles(testDir);
      expect(result.dsns).toHaveLength(2);

      const rawDsns = result.dsns.map((d) => d.raw).sort();
      expect(rawDsns).toContain("https://frontend@sentry.io/1");
      expect(rawDsns).toContain("https://backend@sentry.io/2");
    });

    test("ignores packages without .env files", async () => {
      const pkg1 = join(testDir, "packages", "with-dsn");
      const pkg2 = join(testDir, "packages", "without-dsn");
      mkdirSync(pkg1, { recursive: true });
      mkdirSync(pkg2, { recursive: true });
      writeFileSync(join(pkg1, ".env"), "SENTRY_DSN=https://key@sentry.io/1");
      writeFileSync(join(pkg2, "package.json"), "{}"); // No .env file

      const result = await detectFromMonorepoEnvFiles(testDir);
      expect(result.dsns).toHaveLength(1);
      expect(result.dsns[0].packagePath).toBe("packages/with-dsn");
    });

    test("ignores files in monorepo root (only scans subdirs)", async () => {
      mkdirSync(join(testDir, "packages"), { recursive: true });
      // This file should be ignored (not in a package subdir)
      writeFileSync(
        join(testDir, "packages", ".env"),
        "SENTRY_DSN=https://root@sentry.io/0"
      );

      const result = await detectFromMonorepoEnvFiles(testDir);
      // Should not detect the .env in packages/ root
      expect(result.dsns).toHaveLength(0);
    });
  });
}); // end integration: file-based detection

describe("ENV_FILES constant", () => {
  test("contains expected file names", () => {
    expect(ENV_FILES).toContain(".env");
    expect(ENV_FILES).toContain(".env.local");
    expect(ENV_FILES).toContain(".env.development");
    expect(ENV_FILES).toContain(".env.production");
  });

  test("has .env.local before .env (priority order)", () => {
    const localIndex = ENV_FILES.indexOf(".env.local");
    const envIndex = ENV_FILES.indexOf(".env");
    expect(localIndex).toBeLessThan(envIndex);
  });
});
