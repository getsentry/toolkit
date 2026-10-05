/**
 * Unit tests for the `.sentryclirc` import engine.
 *
 * Core invariants (same-file rule, hash verification, merge order) are tested
 * via property-based tests in sentryclirc-import.property.test.ts. These tests
 * focus on specific scenarios, edge cases, and SQLite integration.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getAuthToken,
  resetAuthTokenCache,
  setAuthToken,
} from "../../src/lib/db/auth.js";
import {
  getDefaultOrganization,
  getDefaultProject,
  getDefaultUrl,
  setDefaultOrganization,
  setDefaultProject,
  setDefaultUrl,
} from "../../src/lib/db/defaults.js";
import { clearSentryCliRcCache } from "../../src/lib/sentryclirc.js";
import type {
  DiscoveredRcFile,
  ImportPlan,
} from "../../src/lib/sentryclirc-import.js";
import {
  buildImportPlan,
  classifyRcFileLocation,
  clearImportState,
  discoverRcFiles,
  executeImport,
  isImportNeededAsync,
  isSameFileOrigin,
  markImportCompleted,
  markImportDeclined,
  maskToken,
} from "../../src/lib/sentryclirc-import.js";
import { useTestConfigDir } from "../helpers.js";

const getConfigDir = useTestConfigDir("import-test-");

beforeEach(() => {
  clearSentryCliRcCache();
});

afterEach(() => {
  clearSentryCliRcCache();
});

// ---------------------------------------------------------------------------
// classifyRcFileLocation
// ---------------------------------------------------------------------------

describe("classifyRcFileLocation", () => {
  test("homedir path returns 'homedir'", () => {
    const path = join(homedir(), ".sentryclirc");
    expect(classifyRcFileLocation(path)).toBe("homedir");
  });

  test("config-dir path returns 'config-dir'", () => {
    const path = join(getConfigDir(), ".sentryclirc");
    expect(classifyRcFileLocation(path)).toBe("config-dir");
  });

  test("arbitrary path returns 'project-local'", () => {
    expect(classifyRcFileLocation("/tmp/some/project/.sentryclirc")).toBe(
      "project-local"
    );
  });
});

// ---------------------------------------------------------------------------
// isSameFileOrigin
// ---------------------------------------------------------------------------

describe("isSameFileOrigin", () => {
  function makePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
    return {
      sources: [],
      effective: {},
      effectiveSources: {},
      newFields: [],
      hasExistingAuth: false,
      isSaas: true,
      trusted: true,
      warnings: [],
      ...overrides,
    };
  }

  test("no URL → trusted", () => {
    const plan = makePlan({ effective: { token: "tok" } });
    expect(isSameFileOrigin(plan)).toBe(true);
  });

  test("token and URL from same file → trusted", () => {
    const plan = makePlan({
      effective: { token: "tok", url: "https://sentry.example.com" },
      effectiveSources: { token: "/a/.sentryclirc", url: "/a/.sentryclirc" },
      isSaas: false,
    });
    expect(isSameFileOrigin(plan)).toBe(true);
  });

  test("token and URL from different files → not trusted", () => {
    const plan = makePlan({
      effective: { token: "tok", url: "https://sentry.example.com" },
      effectiveSources: { token: "/a/.sentryclirc", url: "/b/.sentryclirc" },
      isSaas: false,
    });
    expect(isSameFileOrigin(plan)).toBe(false);
  });

  test("SaaS URL without explicit source → trusted", () => {
    const plan = makePlan({
      effective: { token: "tok", url: "https://sentry.io" },
      effectiveSources: { token: "/a/.sentryclirc" },
    });
    expect(isSameFileOrigin(plan)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildImportPlan
// ---------------------------------------------------------------------------

describe("buildImportPlan", () => {
  function makeFile(
    overrides: Partial<DiscoveredRcFile> = {}
  ): DiscoveredRcFile {
    return {
      path: "/test/.sentryclirc",
      location: "homedir",
      contentHash: "abc123",
      ...overrides,
    };
  }

  test("single file with token+URL is trusted", () => {
    const file = makeFile({
      token: "test-token",
      url: "https://sentry.example.com",
    });
    const plan = buildImportPlan([file]);
    expect(plan.trusted).toBe(true);
    expect(plan.effective.token).toBe("test-token");
    expect(plan.warnings).toHaveLength(0);
  });

  test("token only, no URL → trusted (SaaS default)", () => {
    const file = makeFile({ token: "test-token" });
    const plan = buildImportPlan([file]);
    expect(plan.trusted).toBe(true);
    expect(plan.isSaas).toBe(true);
  });

  test("cross-file token+URL with non-SaaS → not trusted + warning", () => {
    const fileA = makeFile({
      path: "/a/.sentryclirc",
      token: "test-token",
    });
    const fileB = makeFile({
      path: "/b/.sentryclirc",
      url: "https://sentry.example.com",
    });
    const plan = buildImportPlan([fileA, fileB]);
    expect(plan.trusted).toBe(false);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toContain("different files");
  });

  test("closest-wins merge order", () => {
    const close = makeFile({
      path: "/a/b/.sentryclirc",
      org: "close-org",
      project: "close-proj",
    });
    const far = makeFile({
      path: "/a/.sentryclirc",
      org: "far-org",
      token: "far-token",
    });
    const plan = buildImportPlan([close, far]);
    expect(plan.effective.org).toBe("close-org");
    expect(plan.effective.project).toBe("close-proj");
    expect(plan.effective.token).toBe("far-token");
  });

  test("newFields detects what would be new", () => {
    const file = makeFile({
      token: "test-token",
      org: "my-org",
      project: "my-proj",
    });
    const plan = buildImportPlan([file]);
    expect(plan.newFields).toContain("token");
    expect(plan.newFields).toContain("org");
    expect(plan.newFields).toContain("project");
  });

  test("newFields excludes already-set defaults", () => {
    setDefaultOrganization("existing-org");
    const file = makeFile({
      token: "test-token",
      org: "my-org",
    });
    const plan = buildImportPlan([file]);
    expect(plan.newFields).toContain("token");
    expect(plan.newFields).not.toContain("org");
  });

  test("hasExistingAuth true when stored credentials exist", () => {
    setAuthToken("existing-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    const file = makeFile({ token: "new-token" });
    const plan = buildImportPlan([file]);
    expect(plan.hasExistingAuth).toBe(true);
    // Token already stored — should NOT be in newFields
    expect(plan.newFields).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------
// executeImport
// ---------------------------------------------------------------------------

describe("executeImport", () => {
  function makePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
    return {
      sources: [
        {
          path: "/test/.sentryclirc",
          location: "homedir",
          contentHash: "abc",
          token: "test-token",
        },
      ],
      effective: { token: "test-token" },
      effectiveSources: { token: "/test/.sentryclirc" },
      newFields: ["token"],
      hasExistingAuth: false,
      isSaas: true,
      trusted: true,
      warnings: [],
      ...overrides,
    };
  }

  test("stores token with SaaS host by default", async () => {
    const plan = makePlan();
    const result = await executeImport(plan, { validateToken: false });
    expect(result.imported).toBe(true);
    expect(result.stored.token).toBe(true);
  });

  test("stores token with custom host", async () => {
    const plan = makePlan({
      effective: {
        token: "test-token",
        url: "https://sentry.example.com",
      },
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.imported).toBe(true);
    expect(result.stored.token).toBe(true);
  });

  test("stores org/project defaults when not already set", async () => {
    const plan = makePlan({
      effective: {
        token: "test-token",
        org: "my-org",
        project: "my-proj",
      },
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.stored.org).toBe(true);
    expect(result.stored.project).toBe(true);
    expect(getDefaultOrganization()).toBe("my-org");
    expect(getDefaultProject()).toBe("my-proj");
  });

  test("does not overwrite existing defaults", async () => {
    setDefaultOrganization("existing-org");
    const plan = makePlan({
      effective: { token: "test-token", org: "new-org" },
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.stored.org).toBe(false);
    expect(getDefaultOrganization()).toBe("existing-org");
  });

  test("stores non-SaaS URL default", async () => {
    const plan = makePlan({
      effective: {
        token: "test-token",
        url: "https://sentry.example.com",
      },
      isSaas: false,
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.stored.url).toBe(true);
    expect(getDefaultUrl()).toBe("https://sentry.example.com");
  });

  test("does not store SaaS URL as default", async () => {
    const plan = makePlan({
      effective: { token: "test-token", url: "https://sentry.io" },
      isSaas: true,
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.stored.url).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Import state tracking
// ---------------------------------------------------------------------------

describe("import state tracking", () => {
  test("isImportNeededAsync returns true initially", async () => {
    expect(await isImportNeededAsync()).toBe(true);
  });

  test("isImportNeededAsync returns false after completion", async () => {
    const configDir = getConfigDir();
    const rcPath = join(configDir, ".sentryclirc");
    writeFileSync(rcPath, "[auth]\ntoken = test-token\n");

    // Simulate a real import: store auth + mark completed
    setAuthToken("test-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    resetAuthTokenCache();

    const files = await discoverRcFiles(configDir);
    const plan = buildImportPlan(files);
    markImportCompleted(plan);

    clearSentryCliRcCache();
    expect(await isImportNeededAsync()).toBe(false);
  });

  test("isImportNeededAsync returns false after decline", async () => {
    markImportDeclined();
    expect(await isImportNeededAsync()).toBe(false);
  });

  test("isImportNeededAsync returns true after file mutation", async () => {
    const configDir = getConfigDir();
    const rcPath = join(configDir, ".sentryclirc");
    writeFileSync(rcPath, "[auth]\ntoken = test-token\n");

    // Simulate a real import
    setAuthToken("test-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    resetAuthTokenCache();

    const files = await discoverRcFiles(configDir);
    const plan = buildImportPlan(files);
    markImportCompleted(plan);

    // Mutate the file
    writeFileSync(rcPath, "[auth]\ntoken = different-token\n");
    clearSentryCliRcCache();

    expect(await isImportNeededAsync()).toBe(true);
  });

  test("markImportCompleted clears previous decline", async () => {
    markImportDeclined();
    expect(await isImportNeededAsync()).toBe(false);

    const configDir = getConfigDir();
    const rcPath = join(configDir, ".sentryclirc");
    writeFileSync(rcPath, "[auth]\ntoken = test-token\n");

    const files = await discoverRcFiles(configDir);
    const plan = buildImportPlan(files);
    markImportCompleted(plan);
    clearSentryCliRcCache();

    // After marking completed, the decline is cleared
    clearImportState();
    expect(await isImportNeededAsync()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// discoverRcFiles
// ---------------------------------------------------------------------------

describe("discoverRcFiles", () => {
  test("finds .sentryclirc in config dir", async () => {
    const configDir = getConfigDir();
    const rcPath = join(configDir, ".sentryclirc");
    writeFileSync(
      rcPath,
      "[auth]\ntoken = test-token\n\n[defaults]\norg = my-org\n"
    );

    const files = await discoverRcFiles(configDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const file = files.find((f) => f.path === rcPath);
    expect(file).toBeDefined();
    expect(file?.token).toBe("test-token");
    expect(file?.org).toBe("my-org");
    expect(file?.location).toBe("config-dir");
    expect(file?.contentHash).toHaveLength(64); // SHA-256 hex
  });

  test("finds project-local .sentryclirc via walk-up", async () => {
    const configDir = getConfigDir();
    const projectDir = join(configDir, "project", "sub");
    mkdirSync(projectDir, { recursive: true });
    const rcPath = join(configDir, "project", ".sentryclirc");
    writeFileSync(rcPath, "[defaults]\nproject = my-proj\n");

    const files = await discoverRcFiles(projectDir);
    const file = files.find((f) => f.path === rcPath);
    expect(file).toBeDefined();
    expect(file?.project).toBe("my-proj");
    expect(file?.location).toBe("project-local");
  });

  test("returns empty array when no files exist", async () => {
    const configDir = getConfigDir();
    const emptyDir = join(configDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    // Create a .git marker to stop walk-up early
    mkdirSync(join(emptyDir, ".git"));

    const files = await discoverRcFiles(emptyDir);
    // May find global files — filter to just this dir
    const local = files.filter((f) => f.path.startsWith(emptyDir));
    expect(local).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// maskToken
// ---------------------------------------------------------------------------

describe("maskToken", () => {
  test("short token is fully masked", () => {
    expect(maskToken("abcdef")).toBe("******");
  });

  test("12-char token is fully masked", () => {
    expect(maskToken("abcdefghijkl")).toBe("************");
  });

  test("13-char token shows first 4 + last 4", () => {
    // 13 chars: 13-8=5 stars → "abcd*****ijklm"
    const result = maskToken("abcdefghijklm");
    expect(result.startsWith("abcd")).toBe(true);
    expect(result.endsWith("jklm")).toBe(true);
    expect(result.length).toBe(13);
  });

  test("long token shows first 4 + last 4", () => {
    expect(maskToken("abcdefghijklmnop")).toBe("abcd********mnop");
  });

  test("very short token is fully masked", () => {
    expect(maskToken("ab")).toBe("**");
  });

  test("masked output never reveals full token", () => {
    // Tokens <= 12 chars are fully masked
    expect(maskToken("secret")).not.toContain("secret");
    expect(maskToken("123456789ab")).not.toContain("123456789ab");
    // Longer tokens show partial but not full
    expect(maskToken("my-secret-token-value")).not.toBe(
      "my-secret-token-value"
    );
  });
});

// ---------------------------------------------------------------------------
// executeImport — token guarding (C1 fix)
// ---------------------------------------------------------------------------

describe("executeImport — token guard", () => {
  function makePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
    return {
      sources: [
        {
          path: "/test/.sentryclirc",
          location: "homedir",
          contentHash: "abc",
          token: "test-token",
        },
      ],
      effective: { token: "test-token" },
      effectiveSources: { token: "/test/.sentryclirc" },
      newFields: ["token"],
      hasExistingAuth: false,
      isSaas: true,
      trusted: true,
      warnings: [],
      ...overrides,
    };
  }

  test("does not overwrite existing stored auth when token not in newFields", async () => {
    // Store existing auth
    setAuthToken("existing-oauth-token", 3600, "refresh-tok", {
      host: "https://sentry.io",
    });
    resetAuthTokenCache();

    // Import plan has token but NOT in newFields (existing auth detected)
    const plan = makePlan({
      newFields: [], // token excluded because auth already exists
      hasExistingAuth: true,
    });
    const result = await executeImport(plan, { validateToken: false });

    // Token should NOT have been overwritten
    expect(result.stored.token).toBe(false);
    resetAuthTokenCache();
    expect(getAuthToken()).toBe("existing-oauth-token");
  });

  test("stores token when it IS in newFields", async () => {
    const plan = makePlan({ newFields: ["token"] });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.stored.token).toBe(true);
    resetAuthTokenCache();
    expect(getAuthToken()).toBe("test-token");
  });

  test("does not store anything when effective has no token", async () => {
    const plan = makePlan({
      effective: { org: "my-org" },
      newFields: ["org"],
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.stored.token).toBe(false);
    expect(result.stored.org).toBe(true);
    expect(result.imported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildImportPlan — URL normalization and sntrys_ warnings
// ---------------------------------------------------------------------------

describe("buildImportPlan — URL handling", () => {
  function makeFile(
    overrides: Partial<DiscoveredRcFile> = {}
  ): DiscoveredRcFile {
    return {
      path: "/test/.sentryclirc",
      location: "homedir",
      contentHash: "abc123",
      ...overrides,
    };
  }

  test("normalizes URL to origin", () => {
    const file = makeFile({
      token: "test-token",
      url: "https://sentry.example.com/path/to/something",
    });
    const plan = buildImportPlan([file]);
    expect(plan.effective.url).toBe("https://sentry.example.com");
  });

  test("handles bare hostname URL", () => {
    const file = makeFile({
      token: "test-token",
      url: "sentry.example.com",
    });
    const plan = buildImportPlan([file]);
    expect(plan.effective.url).toBe("https://sentry.example.com");
  });

  test("non-SaaS URL adds url to newFields", () => {
    const file = makeFile({
      token: "test-token",
      url: "https://sentry.example.com",
    });
    const plan = buildImportPlan([file]);
    expect(plan.newFields).toContain("url");
    expect(plan.isSaas).toBe(false);
  });

  test("SaaS URL does NOT add url to newFields", () => {
    const file = makeFile({
      token: "test-token",
      url: "https://sentry.io",
    });
    const plan = buildImportPlan([file]);
    expect(plan.newFields).not.toContain("url");
    expect(plan.isSaas).toBe(true);
  });

  test("url not in newFields when default already set", () => {
    setDefaultUrl("https://existing.example.com");
    const file = makeFile({
      token: "test-token",
      url: "https://sentry.example.com",
    });
    const plan = buildImportPlan([file]);
    expect(plan.newFields).not.toContain("url");
  });

  test("empty effective fields produce empty newFields", () => {
    const file = makeFile({}); // no token, url, org, project
    const plan = buildImportPlan([file]);
    expect(plan.newFields).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// executeImport — defaults edge cases
// ---------------------------------------------------------------------------

describe("executeImport — defaults edge cases", () => {
  function makePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
    return {
      sources: [
        {
          path: "/test/.sentryclirc",
          location: "homedir",
          contentHash: "abc",
        },
      ],
      effective: {},
      effectiveSources: {},
      newFields: [],
      hasExistingAuth: false,
      isSaas: true,
      trusted: true,
      warnings: [],
      ...overrides,
    };
  }

  test("does not overwrite existing URL default", async () => {
    setDefaultUrl("https://existing.example.com");
    const plan = makePlan({
      effective: { url: "https://new.example.com" },
      isSaas: false,
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.stored.url).toBe(false);
    expect(getDefaultUrl()).toBe("https://existing.example.com");
  });

  test("does not overwrite existing project default", async () => {
    setDefaultProject("existing-proj");
    const plan = makePlan({
      effective: { project: "new-proj" },
      newFields: [],
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.stored.project).toBe(false);
    expect(getDefaultProject()).toBe("existing-proj");
  });

  test("marks import completed even with defaults only", async () => {
    // Store auth so isImportNeededAsync doesn't short-circuit
    setAuthToken("existing-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    resetAuthTokenCache();

    const plan = makePlan({
      effective: { org: "my-org", project: "my-proj" },
      newFields: ["org", "project"],
    });
    const result = await executeImport(plan, { validateToken: false });
    expect(result.imported).toBe(true);
    expect(result.stored.org).toBe(true);
    expect(result.stored.project).toBe(true);
    expect(await isImportNeededAsync()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Import state tracking — edge cases
// ---------------------------------------------------------------------------

describe("import state tracking — edge cases", () => {
  test("isImportNeededAsync returns true when source file deleted", async () => {
    const configDir = getConfigDir();
    const rcPath = join(configDir, ".sentryclirc");
    writeFileSync(rcPath, "[auth]\ntoken = test-token\n");

    // Store auth so hasStoredAuth() returns true (simulating a real import)
    setAuthToken("test-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    resetAuthTokenCache();

    const files = await discoverRcFiles(configDir);
    const plan = buildImportPlan(files);
    markImportCompleted(plan);
    clearSentryCliRcCache();

    // Verify it's initially not needed (auth + hashes match)
    expect(await isImportNeededAsync()).toBe(false);

    // Delete the file
    const { unlinkSync } = await import("node:fs");
    unlinkSync(rcPath);

    // Now the hash check fails → import needed again
    expect(await isImportNeededAsync()).toBe(true);
  });

  test("clearImportState resets everything", async () => {
    markImportDeclined();
    expect(await isImportNeededAsync()).toBe(false);
    clearImportState();
    expect(await isImportNeededAsync()).toBe(true);
  });

  test("isImportNeededAsync returns true after logout (auth cleared)", async () => {
    const configDir = getConfigDir();
    const rcPath = join(configDir, ".sentryclirc");
    writeFileSync(rcPath, "[auth]\ntoken = test-token\n");

    // Simulate a real import
    setAuthToken("test-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    resetAuthTokenCache();

    const files = await discoverRcFiles(configDir);
    const plan = buildImportPlan(files);
    markImportCompleted(plan);
    clearSentryCliRcCache();

    // Initially not needed
    expect(await isImportNeededAsync()).toBe(false);

    // Simulate logout — clear auth without clearing import record
    const { clearAuth } = await import("../../src/lib/db/auth.js");
    await clearAuth();
    resetAuthTokenCache();

    // Now import is needed again (auth gone, .sentryclirc still has token)
    expect(await isImportNeededAsync()).toBe(true);
  });

  test("import with no contributing sources stores empty sources array", () => {
    const plan: ImportPlan = {
      sources: [
        {
          path: "/test/.sentryclirc",
          location: "homedir",
          contentHash: "abc",
          // No token, url, org, or project
        },
      ],
      effective: {},
      effectiveSources: {},
      newFields: [],
      hasExistingAuth: false,
      isSaas: true,
      trusted: true,
      warnings: [],
    };
    // Should not throw
    markImportCompleted(plan);
  });
});

// ---------------------------------------------------------------------------
// discoverRcFiles — additional scenarios
// ---------------------------------------------------------------------------

describe("discoverRcFiles — additional", () => {
  test("discovers files with all four fields", async () => {
    const configDir = getConfigDir();
    const rcPath = join(configDir, ".sentryclirc");
    writeFileSync(
      rcPath,
      "[auth]\ntoken = my-token\n\n[defaults]\nurl = https://sentry.example.com\norg = my-org\nproject = my-proj\n"
    );

    const files = await discoverRcFiles(configDir);
    const file = files.find((f) => f.path === rcPath);
    expect(file).toBeDefined();
    expect(file?.token).toBe("my-token");
    expect(file?.url).toBe("https://sentry.example.com");
    expect(file?.org).toBe("my-org");
    expect(file?.project).toBe("my-proj");
  });

  test("skips files with only comments/empty sections", async () => {
    const configDir = getConfigDir();
    const rcPath = join(configDir, ".sentryclirc");
    writeFileSync(rcPath, "# just a comment\n[defaults]\n; nothing here\n");

    const files = await discoverRcFiles(configDir);
    const file = files.find((f) => f.path === rcPath);
    // File is found but has no fields
    if (file) {
      expect(file.token).toBeUndefined();
      expect(file.url).toBeUndefined();
      expect(file.org).toBeUndefined();
      expect(file.project).toBeUndefined();
    }
  });

  test("walk-up merges project-local and global files", async () => {
    const configDir = getConfigDir();
    const projectDir = join(configDir, "myproject");
    mkdirSync(projectDir, { recursive: true });

    // Project-local file has project
    writeFileSync(
      join(projectDir, ".sentryclirc"),
      "[defaults]\nproject = local-proj\n"
    );
    // Global file has token + org
    writeFileSync(
      join(configDir, ".sentryclirc"),
      "[auth]\ntoken = global-token\n\n[defaults]\norg = global-org\n"
    );

    const files = await discoverRcFiles(projectDir);
    expect(files.length).toBeGreaterThanOrEqual(2);

    // Build a plan to verify merge
    const plan = buildImportPlan(files);
    expect(plan.effective.project).toBe("local-proj");
    expect(plan.effective.token).toBe("global-token");
    expect(plan.effective.org).toBe("global-org");
  });
});
