/** Regression coverage for credentials in legacy JSON configuration. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearAuth,
  getAuthConfig,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import {
  getDefaultOrganization,
  getDefaultProject,
} from "../../../src/lib/db/defaults.js";
import { closeDatabase, getDatabase } from "../../../src/lib/db/index.js";
import { clearMetadata, getMetadata } from "../../../src/lib/db/utils.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("json-auth-migration-");
useEnvSandbox(["SENTRY_AUTH_TOKEN", "SENTRY_TOKEN", "SENTRY_FORCE_ENV_TOKEN"]);

let stderr: ReturnType<typeof vi.spyOn<typeof process.stderr, "write">>;

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

function writeLegacyConfig(token: unknown) {
  const path = join(getConfigDir(), "config.json");
  const contents = JSON.stringify({
    auth: { token, refreshToken: "synthetic-legacy-refresh" },
    defaults: { organization: "synthetic-org", project: "synthetic-project" },
    projectCache: {
      "synthetic-cache-key": {
        orgSlug: "synthetic-org",
        orgName: "Synthetic organization",
        projectSlug: "synthetic-project",
        projectName: "Synthetic project",
        cachedAt: Date.now(),
      },
    },
  });
  writeFileSync(path, contents);
  return { path, contents };
}

describe("legacy auth migration", () => {
  test("normalizes surrounding ASCII controls before writing credentials", () => {
    const { path } = writeLegacyConfig("\0\x01\t synthetic-token \r\n\0");

    expect(getAuthConfig()).toMatchObject({
      token: "synthetic-token",
      refreshToken: "synthetic-legacy-refresh",
    });
    expect(existsSync(path)).toBe(false);
  });

  test.each([
    ["internal NUL", "synthetic-secret\0tail"],
    ["internal LF", "synthetic-secret\ntail"],
    ["empty string", ""],
    ["number", 123],
    ["null", null],
    ["object", { value: "synthetic-secret" }],
  ])("preserves the original config and migrates other settings for %s", (_, token) => {
    const { path, contents } = writeLegacyConfig(token);

    // Opening the DB must remain possible so login/logout can recover.
    const db = getDatabase();
    expect(getAuthConfig()).toBeUndefined();
    expect(db.query("SELECT * FROM auth").get()).toBeNull();
    expect(getDefaultOrganization()).toBe("synthetic-org");
    expect(getDefaultProject()).toBe("synthetic-project");
    expect(
      db
        .query("SELECT org_slug FROM project_cache WHERE cache_key = ?")
        .get("synthetic-cache-key")
    ).toEqual({ org_slug: "synthetic-org" });
    expect(
      getMetadata(db, ["json_migration_completed"]).get(
        "json_migration_completed"
      )
    ).toBe("true");
    expect(readFileSync(path, "utf8")).toBe(contents);

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain(
      "Malformed authentication credentials were not migrated"
    );
    expect(output).toContain("config.json was kept");
    expect(output).toContain("sentry auth login");
    expect(output).not.toContain("synthetic-secret");
    expect(output).not.toContain("synthetic-legacy-refresh");
  });

  test("keeps an existing SQLite session when legacy credentials are invalid", () => {
    setAuthToken(
      "synthetic-existing-token",
      3600,
      "synthetic-existing-refresh"
    );
    const before = getAuthConfig();
    const db = getDatabase();
    clearMetadata(db, ["json_migration_completed"]);
    closeDatabase();
    const { path, contents } = writeLegacyConfig("synthetic-secret\0tail");

    expect(getAuthConfig()).toEqual(before);
    expect(getDefaultOrganization()).toBe("synthetic-org");
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  test("does not re-import the retained file after a new login or logout", async () => {
    const { path } = writeLegacyConfig("synthetic-secret\0tail");
    expect(getAuthConfig()).toBeUndefined();

    setAuthToken("synthetic-replacement-token");
    // Even fixing the retained file must not overwrite the new session.
    writeLegacyConfig("synthetic-old-token");
    closeDatabase();
    expect(getAuthConfig()?.token).toBe("synthetic-replacement-token");

    await clearAuth();
    closeDatabase();
    expect(getAuthConfig()).toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });
});
