/**
 * Configuration Management Tests
 *
 * Integration tests for SQLite-based config storage.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearAuth,
  getAuthConfig,
  getAuthToken,
  isAuthenticated,
  refreshToken,
  setAuthToken,
} from "../../src/lib/db/auth.js";
import {
  getDefaultOrganization,
  getDefaultProject,
  setDefaultOrganization,
  setDefaultProject,
} from "../../src/lib/db/defaults.js";
import {
  CONFIG_DIR_ENV_VAR,
  closeDatabase,
  getDbPath,
  resolveConfigDir,
} from "../../src/lib/db/index.js";
import {
  clearProjectAliases,
  getProjectAliases,
  getProjectByAlias,
  setProjectAliases,
} from "../../src/lib/db/project-aliases.js";
import {
  clearProjectCache,
  getCachedProject,
  getCachedProjectByDsnKey,
  setCachedProject,
  setCachedProjectByDsnKey,
} from "../../src/lib/db/project-cache.js";
import { useTestConfigDir } from "../helpers.js";

/**
 * Test isolation: Each test gets its own config directory via useTestConfigDir().
 * The helper creates a unique temp directory in beforeEach and restores
 * the env var in afterEach (never deleting it).
 */
const getConfigDir = useTestConfigDir("test-config-");

let savedAuthToken: string | undefined;
beforeEach(() => {
  savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
  delete process.env.SENTRY_AUTH_TOKEN;
});
afterEach(() => {
  if (savedAuthToken !== undefined) {
    process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
  }
});

describe("auth token management", () => {
  test("setAuthToken stores token", async () => {
    await setAuthToken("test-token-123");

    const token = await getAuthToken();
    expect(token).toBe("test-token-123");
  });

  test("setAuthToken with expiration sets expiresAt", async () => {
    const before = Date.now();
    await setAuthToken("expiring-token", 3600); // 1 hour
    const after = Date.now();

    const auth = await getAuthConfig();
    expect(auth?.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(auth?.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  test("setAuthToken stores refresh token", async () => {
    await setAuthToken("access-token", 3600, "refresh-token");

    const auth = await getAuthConfig();
    expect(auth?.refreshToken).toBe("refresh-token");
  });

  test("getAuthToken returns undefined for expired token", async () => {
    // Set a token that expires in the future, then we'll manipulate it
    await setAuthToken("expired-token", -1); // Negative expires immediately

    const token = await getAuthToken();
    expect(token).toBeUndefined();
  });

  test("getAuthToken returns token if not expired", async () => {
    await setAuthToken("valid-token", 3600); // 1 hour

    const token = await getAuthToken();
    expect(token).toBe("valid-token");
  });

  test("clearAuth removes auth data", async () => {
    await setAuthToken("token-to-clear");
    expect(await getAuthToken()).toBe("token-to-clear");

    await clearAuth();
    expect(await getAuthToken()).toBeUndefined();
  });

  test("isAuthenticated returns true with valid token", async () => {
    await setAuthToken("valid-token");
    expect(isAuthenticated()).toBe(true);
  });

  test("isAuthenticated returns false without token", async () => {
    expect(isAuthenticated()).toBe(false);
  });

  test("isAuthenticated returns false with expired token", async () => {
    await setAuthToken("expired", -1); // Negative expires immediately
    expect(isAuthenticated()).toBe(false);
  });
});

describe("defaults management", () => {
  test("setDefaultOrganization stores organization", async () => {
    setDefaultOrganization("my-org");

    const org = getDefaultOrganization();
    expect(org).toBe("my-org");
  });

  test("setDefaultProject stores project", async () => {
    setDefaultProject("my-project");

    const project = getDefaultProject();
    expect(project).toBe("my-project");
  });

  test("individual setters store both org and project", async () => {
    setDefaultOrganization("my-org");
    setDefaultProject("my-project");

    expect(getDefaultOrganization()).toBe("my-org");
    expect(getDefaultProject()).toBe("my-project");
  });

  test("individual setters preserve other defaults", async () => {
    setDefaultOrganization("org1");
    setDefaultProject("project1");
    setDefaultOrganization("org2"); // Only update org

    expect(getDefaultOrganization()).toBe("org2");
    expect(getDefaultProject()).toBe("project1");
  });

  test("getDefaultOrganization returns null when not set", async () => {
    const org = getDefaultOrganization();
    expect(org).toBeNull();
  });

  test("getDefaultProject returns null when not set", async () => {
    const project = getDefaultProject();
    expect(project).toBeNull();
  });
});

describe("refreshToken error handling", () => {
  test("network error during refresh does not clear auth", async () => {
    // Set up a token that needs refresh (expired but has refresh token)
    await setAuthToken("still-valid-token", -1, "my-refresh-token"); // Expired

    // Set required env var for OAuth
    process.env.SENTRY_CLIENT_ID = "test-client-id";

    // Mock fetch to simulate network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch failed: network error");
    };

    try {
      await refreshToken();
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Expected to throw ApiError for network failure
      expect(error).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Auth should NOT be cleared on network error
    const auth = await getAuthConfig();
    expect(auth?.token).toBe("still-valid-token");
    expect(auth?.refreshToken).toBe("my-refresh-token");
  });

  test("auth error during refresh clears auth", async () => {
    // Set up a token that needs refresh
    await setAuthToken("revoked-token", -1, "invalid-refresh-token"); // Expired

    process.env.SENTRY_CLIENT_ID = "test-client-id";

    // Mock fetch to simulate server rejecting refresh token
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token revoked",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );

    try {
      await refreshToken();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Auth SHOULD be cleared when server rejects refresh token
    const auth = await getAuthConfig();
    expect(auth).toBeUndefined();
  });
});

describe("project aliases", () => {
  test("setProjectAliases stores aliases", async () => {
    setProjectAliases({
      e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      w: { orgSlug: "sentry", projectSlug: "spotlight-website" },
    });

    const aliases = getProjectAliases();
    expect(aliases).toEqual({
      e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      w: { orgSlug: "sentry", projectSlug: "spotlight-website" },
    });
  });

  test("getProjectAliases returns stored aliases", async () => {
    setProjectAliases({
      f: { orgSlug: "my-org", projectSlug: "frontend" },
      b: { orgSlug: "my-org", projectSlug: "backend" },
    });

    const aliases = getProjectAliases();
    expect(aliases).toEqual({
      f: { orgSlug: "my-org", projectSlug: "frontend" },
      b: { orgSlug: "my-org", projectSlug: "backend" },
    });
  });

  test("getProjectAliases returns undefined when not set", async () => {
    const aliases = getProjectAliases();
    expect(aliases).toBeUndefined();
  });

  test("getProjectByAlias returns correct project", async () => {
    setProjectAliases({
      e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      w: { orgSlug: "sentry", projectSlug: "spotlight-website" },
      s: { orgSlug: "sentry", projectSlug: "spotlight" },
    });

    const project = getProjectByAlias("e");
    expect(project).toEqual({
      orgSlug: "sentry",
      projectSlug: "spotlight-electron",
    });
  });

  test("getProjectByAlias is case-insensitive", async () => {
    setProjectAliases({
      e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
    });

    expect(getProjectByAlias("E")).toEqual({
      orgSlug: "sentry",
      projectSlug: "spotlight-electron",
    });
    expect(getProjectByAlias("e")).toEqual({
      orgSlug: "sentry",
      projectSlug: "spotlight-electron",
    });
  });

  test("getProjectByAlias returns undefined for unknown alias", async () => {
    setProjectAliases({
      e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
    });

    const project = getProjectByAlias("x");
    expect(project).toBeUndefined();
  });

  test("getProjectByAlias returns undefined when no aliases set", async () => {
    const project = getProjectByAlias("e");
    expect(project).toBeUndefined();
  });

  test("clearProjectAliases removes all aliases", async () => {
    setProjectAliases({
      e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
    });

    clearProjectAliases();

    const aliases = getProjectAliases();
    expect(aliases).toBeUndefined();
  });

  test("setProjectAliases overwrites existing aliases", async () => {
    setProjectAliases({
      old: { orgSlug: "org1", projectSlug: "project1" },
    });

    setProjectAliases({
      new: { orgSlug: "org2", projectSlug: "project2" },
    });

    const aliases = getProjectAliases();
    expect(aliases).toEqual({
      new: { orgSlug: "org2", projectSlug: "project2" },
    });
    expect(aliases?.old).toBeUndefined();
  });
});

describe("DSN-fingerprinted project aliases", () => {
  test("getProjectByAlias returns alias when fingerprint matches", async () => {
    setProjectAliases(
      {
        e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      },
      "123:456,123:789"
    );

    // Same fingerprint
    const project = getProjectByAlias("e", "123:456,123:789");
    expect(project).toEqual({
      orgSlug: "sentry",
      projectSlug: "spotlight-electron",
    });
  });

  test("getProjectByAlias returns undefined when fingerprint mismatches", async () => {
    setProjectAliases(
      {
        e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      },
      "123:456,123:789"
    );

    // Different fingerprint (different DSN context)
    const project = getProjectByAlias("e", "999:111");
    expect(project).toBeUndefined();
  });

  test("getProjectByAlias returns alias when no fingerprint stored (legacy cache)", async () => {
    // No fingerprint stored
    setProjectAliases({
      e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
    });

    // Should work without fingerprint validation (legacy cache)
    const project = getProjectByAlias("e", "123:456");
    expect(project).toEqual({
      orgSlug: "sentry",
      projectSlug: "spotlight-electron",
    });
  });

  test("getProjectByAlias returns alias when no current fingerprint provided", async () => {
    setProjectAliases(
      {
        e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      },
      "123:456,123:789"
    );

    // No current fingerprint provided - skip validation
    const project = getProjectByAlias("e");
    expect(project).toEqual({
      orgSlug: "sentry",
      projectSlug: "spotlight-electron",
    });
  });

  test("fingerprint does not affect case-insensitive lookup", async () => {
    setProjectAliases(
      {
        e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      },
      "123:456"
    );

    // Uppercase alias with matching fingerprint
    const project = getProjectByAlias("E", "123:456");
    expect(project).toEqual({
      orgSlug: "sentry",
      projectSlug: "spotlight-electron",
    });
  });

  test("getProjectByAlias rejects when current fingerprint is empty but cached is not", async () => {
    // Cache was created with SaaS DSNs
    setProjectAliases(
      {
        e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      },
      "123:456"
    );

    // Current context has no SaaS DSNs (empty fingerprint)
    // This should reject - different workspace/context
    const project = getProjectByAlias("e", "");
    expect(project).toBeUndefined();
  });

  test("getProjectByAlias rejects when cached fingerprint is empty but current is not", async () => {
    // Cache was created with only self-hosted DSNs (empty fingerprint)
    setProjectAliases(
      {
        e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      },
      ""
    );

    // Current context has SaaS DSNs
    // This should reject - different workspace/context
    const project = getProjectByAlias("e", "123:456");
    expect(project).toBeUndefined();
  });

  test("getProjectByAlias accepts when both fingerprints are empty", async () => {
    // Cache was created with only self-hosted DSNs
    setProjectAliases(
      {
        e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
      },
      ""
    );

    // Current context also has only self-hosted DSNs
    const project = getProjectByAlias("e", "");
    expect(project).toEqual({
      orgSlug: "sentry",
      projectSlug: "spotlight-electron",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DSN Key-based Project Cache
// ─────────────────────────────────────────────────────────────────────────────

describe("getCachedProjectByDsnKey / setCachedProjectByDsnKey", () => {
  test("caches and retrieves project by DSN public key", async () => {
    setCachedProjectByDsnKey("abc123publickey", {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const cached = getCachedProjectByDsnKey("abc123publickey");
    expect(cached).toBeDefined();
    expect(cached?.orgSlug).toBe("my-org");
    expect(cached?.projectSlug).toBe("my-project");
    expect(cached?.cachedAt).toBeDefined();
  });

  test("returns undefined for unknown DSN key", async () => {
    const cached = getCachedProjectByDsnKey("nonexistent-key");
    expect(cached).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Project Cache (by orgId:projectId)
// ─────────────────────────────────────────────────────────────────────────────

describe("getCachedProject / setCachedProject / clearProjectCache", () => {
  test("caches and retrieves project by orgId and projectId", async () => {
    setCachedProject("123", "456", {
      orgSlug: "my-org",
      orgName: "My Organization",
      projectSlug: "my-project",
      projectName: "My Project",
    });

    const cached = getCachedProject("123", "456");
    expect(cached).toBeDefined();
    expect(cached?.orgSlug).toBe("my-org");
    expect(cached?.projectSlug).toBe("my-project");
    expect(cached?.cachedAt).toBeDefined();
  });

  test("returns undefined for unknown orgId:projectId", async () => {
    const cached = getCachedProject("999", "999");
    expect(cached).toBeUndefined();
  });

  test("clearProjectCache removes all cached projects", async () => {
    setCachedProject("123", "456", {
      orgSlug: "org1",
      orgName: "Org 1",
      projectSlug: "project1",
      projectName: "Project 1",
    });
    setCachedProjectByDsnKey("key1", {
      orgSlug: "org2",
      orgName: "Org 2",
      projectSlug: "project2",
      projectName: "Project 2",
    });

    clearProjectCache();

    expect(getCachedProject("123", "456")).toBeUndefined();
    expect(getCachedProjectByDsnKey("key1")).toBeUndefined();
  });

  test("multiple projects can be cached independently", async () => {
    setCachedProject("123", "456", {
      orgSlug: "org1",
      orgName: "Org 1",
      projectSlug: "project1",
      projectName: "Project 1",
    });
    setCachedProject("123", "789", {
      orgSlug: "org1",
      orgName: "Org 1",
      projectSlug: "project2",
      projectName: "Project 2",
    });

    const cached1 = getCachedProject("123", "456");
    const cached2 = getCachedProject("123", "789");

    expect(cached1?.projectSlug).toBe("project1");
    expect(cached2?.projectSlug).toBe("project2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config Path
// ─────────────────────────────────────────────────────────────────────────────

describe("getDbPath", () => {
  test("returns the database file path", () => {
    const path = getDbPath();
    expect(path).toContain("cli.db");
    expect(path).toContain(getConfigDir());
  });
});

describe("resolveConfigDir", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "resolve-config-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("prefers the SENTRY_CONFIG_DIR override over everything", () => {
    const override = join(home, "custom-config");
    mkdirSync(join(home, ".sentry"));
    expect(
      resolveConfigDir(
        {
          [CONFIG_DIR_ENV_VAR]: override,
          XDG_CONFIG_HOME: join(home, "xdg"),
        },
        home
      )
    ).toBe(override);
  });

  test("uses the legacy ~/.sentry directory when it already exists", () => {
    const legacy = join(home, ".sentry");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "cli.db"), ""); // simulate a prior config install
    expect(resolveConfigDir({}, home)).toBe(legacy);
  });

  test("ignores a bare ~/.sentry/bin (installer artifact) and falls back to XDG", () => {
    const legacy = join(home, ".sentry");
    mkdirSync(join(legacy, "bin"), { recursive: true });
    expect(resolveConfigDir({}, home)).toBe(join(home, ".config", "sentry"));
  });

  test("uses XDG_CONFIG_HOME/sentry when set to an absolute path", () => {
    const xdg = join(home, "xdg-config");
    expect(resolveConfigDir({ XDG_CONFIG_HOME: xdg }, home)).toBe(
      join(xdg, "sentry")
    );
  });

  test("falls back to ~/.config/sentry when XDG_CONFIG_HOME is unset", () => {
    expect(resolveConfigDir({}, home)).toBe(join(home, ".config", "sentry"));
  });

  test("ignores a non-absolute XDG_CONFIG_HOME per the XDG spec", () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "relative/path" }, home)).toBe(
      join(home, ".config", "sentry")
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON Migration
// ─────────────────────────────────────────────────────────────────────────────

describe("JSON to SQLite migration", () => {
  test("migrates existing config.json on first access", async () => {
    // Close any existing database
    closeDatabase();

    // Create a config.json file in the test directory
    const testConfigDir = process.env[CONFIG_DIR_ENV_VAR]!;
    const configPath = join(testConfigDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: {
          token: "migrated-token",
          refreshToken: "migrated-refresh",
          expiresAt: Date.now() + 3_600_000,
          issuedAt: Date.now(),
        },
        defaults: {
          organization: "migrated-org",
          project: "migrated-project",
        },
      })
    );

    // Access the database (triggers migration)
    const token = await getAuthToken();
    expect(token).toBe("migrated-token");

    const auth = await getAuthConfig();
    expect(auth?.refreshToken).toBe("migrated-refresh");

    const org = getDefaultOrganization();
    expect(org).toBe("migrated-org");

    const project = getDefaultProject();
    expect(project).toBe("migrated-project");

    // config.json should be deleted after migration
    const configExists = await access(configPath).then(
      () => true,
      () => false
    );
    expect(configExists).toBe(false);
  });
});
