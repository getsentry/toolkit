/**
 * Status Command Tests
 *
 * Tests for the statusCommand func() in src/commands/auth/status.ts.
 * Focuses on the env-token-aware branches and the structured data output.
 * Uses spyOn to mock db/auth, db/defaults, db/user, and api-client.
 *
 * The command returns { data: AuthStatusData } which is rendered to stdout
 * by the buildCommand wrapper. Tests assert on stdout content for human
 * output and parse JSON for --json output.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { statusCommand } from "../../../src/commands/auth/status.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/auth.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";

vi.mock("../../../src/lib/db/defaults.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/defaults.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbDefaults from "../../../src/lib/db/defaults.js";

vi.mock("../../../src/lib/db/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/index.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbIndex from "../../../src/lib/db/index.js";

vi.mock("../../../src/lib/db/user.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/user.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbUser from "../../../src/lib/db/user.js";
import { AuthError } from "../../../src/lib/errors.js";

type StatusFlags = {
  readonly "show-token": boolean;
  readonly json: boolean;
};
type StatusFunc = (this: unknown, flags: StatusFlags) => Promise<void>;

/**
 * Create a mock Stricli context with stdout capture.
 */
function createContext() {
  const stdoutChunks: string[] = [];
  return {
    context: {
      stdout: {
        write: vi.fn((s: string) => {
          stdoutChunks.push(s);
        }),
      },
      stderr: {
        write: vi.fn((_s: string) => {
          /* unused */
        }),
      },
      cwd: "/tmp",
    },
    getOutput: () => stdoutChunks.join(""),
  };
}

describe("statusCommand.func", () => {
  let getAuthConfigSpy: ReturnType<typeof spyOn>;
  let getAuthTokenSpy: ReturnType<typeof spyOn>;
  let isAuthenticatedSpy: ReturnType<typeof spyOn>;
  let getUserInfoSpy: ReturnType<typeof spyOn>;
  let getDefaultOrgSpy: ReturnType<typeof spyOn>;
  let getDefaultProjectSpy: ReturnType<typeof spyOn>;
  let getDbPathSpy: ReturnType<typeof spyOn>;
  let listOrgsSpy: ReturnType<typeof spyOn>;
  let func: StatusFunc;

  beforeEach(async () => {
    getAuthConfigSpy = vi.spyOn(dbAuth, "getAuthConfig");
    getAuthTokenSpy = vi.spyOn(dbAuth, "getAuthToken");
    isAuthenticatedSpy = vi.spyOn(dbAuth, "isAuthenticated");
    getUserInfoSpy = vi.spyOn(dbUser, "getUserInfo");
    getDefaultOrgSpy = vi.spyOn(dbDefaults, "getDefaultOrganization");
    getDefaultProjectSpy = vi.spyOn(dbDefaults, "getDefaultProject");
    getDbPathSpy = vi.spyOn(dbIndex, "getDbPath");
    listOrgsSpy = vi.spyOn(apiClient, "listOrganizationsUncached");

    // Defaults that most tests override
    getAuthTokenSpy.mockReturnValue("fake-oauth-token");
    getUserInfoSpy.mockReturnValue(null);
    getDefaultOrgSpy.mockReturnValue(null);
    getDefaultProjectSpy.mockReturnValue(null);
    getDbPathSpy.mockReturnValue("/fake/db/path");
    listOrgsSpy.mockResolvedValue([]);

    func = (await statusCommand.loader()) as unknown as StatusFunc;
  });

  afterEach(() => {
    getAuthConfigSpy.mockRestore();
    getAuthTokenSpy.mockRestore();
    isAuthenticatedSpy.mockRestore();
    getUserInfoSpy.mockRestore();
    getDefaultOrgSpy.mockRestore();
    getDefaultProjectSpy.mockRestore();
    getDbPathSpy.mockRestore();
    listOrgsSpy.mockRestore();
  });

  /** Default flags for most tests (human output) */
  const humanFlags: StatusFlags = { "show-token": false, json: false };
  /** JSON output flags */
  const jsonFlags: StatusFlags = { "show-token": false, json: true };

  describe("not authenticated", () => {
    test("throws AuthError with skipAutoAuth when not authenticated", async () => {
      getAuthConfigSpy.mockReturnValue(undefined);
      isAuthenticatedSpy.mockReturnValue(false);

      const { context } = createContext();

      try {
        await func.call(context, humanFlags);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).skipAutoAuth).toBe(true);
      }
    });
  });

  describe("OAuth token", () => {
    test("shows config path for OAuth tokens", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc123def456",
        source: "oauth",
        expiresAt: Date.now() + 3_600_000,
        refreshToken: "refresh_xyz",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("/fake/db/path");
    });

    test("shows 'Authenticated' without env var mention for OAuth", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc123def456",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("Authenticated");
      expect(getOutput()).not.toContain("environment variable");
    });

    test("identifies access token expiration precisely", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc123def456",
        source: "oauth",
        expiresAt: Date.now() + 3_600_000,
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("Access token expires");
    });

    test("shows automatic refresh enabled with refresh token", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc123def456",
        source: "oauth",
        refreshToken: "refresh_xyz",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("Access token");
      expect(getOutput()).toContain("Automatic refresh");
      expect(getOutput()).toContain("enabled");
    });

    test("identifies a stored manual token without implying refresh is broken", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc123def456",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("API token");
      expect(getOutput()).not.toContain("Automatic refresh");
      expect(getOutput()).not.toContain("disabled");
    });
  });

  describe("env var token (SENTRY_AUTH_TOKEN)", () => {
    test("hides config path for env var tokens", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_env_token_123",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).not.toContain("/fake/db/path");
    });

    test("shows 'Authenticated via SENTRY_AUTH_TOKEN environment variable'", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_env_token_123",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      // Plain mode strips markdown escapes: SENTRY_AUTH_TOKEN (not SENTRY\_AUTH\_TOKEN)
      expect(getOutput()).toContain("SENTRY_AUTH_TOKEN");
      expect(getOutput()).toContain("environment variable");
    });

    test("does not show expiration or auto-refresh for env tokens", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_env_token_123",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).not.toContain("expires");
      expect(getOutput()).not.toContain("Automatic refresh");
    });

    test("masks token by default for env tokens", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_env_token_123_long_enough",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      const out = getOutput();
      expect(out).toContain("Token");
      expect(out).not.toContain("sntrys_env_token_123_long_enough");
    });

    test("shows full token with --show-token for env tokens", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_env_token_123_long_enough",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, { ...humanFlags, "show-token": true });

      expect(getOutput()).toContain("sntrys_env_token_123_long_enough");
    });

    test("hint says 'organization' for sntrys_ env tokens", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_env_token_123",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      getAuthTokenSpy.mockReturnValue("sntrys_env_token_123");

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("organization");
    });

    test("hint says 'user' for non-sntrys_ env tokens", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "some_oauth_env_token",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      getAuthTokenSpy.mockReturnValue("some_oauth_env_token");

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("which user");
    });
  });

  describe("env var token (SENTRY_TOKEN)", () => {
    test("shows 'Authenticated via SENTRY_TOKEN environment variable'", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_token_456",
        source: "env:SENTRY_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      // Plain mode strips markdown escapes: SENTRY_TOKEN (not SENTRY\_TOKEN)
      expect(getOutput()).toContain("SENTRY_TOKEN");
      expect(getOutput()).toContain("environment variable");
    });
  });

  describe("credential verification", () => {
    test("shows error when verification fails", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      listOrgsSpy.mockRejectedValue(new Error("Network error"));

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("Could not verify credentials");
    });

    test("shows org list on successful verification", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      listOrgsSpy.mockResolvedValue([{ name: "My Org", slug: "my-org" }]);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("Access verified");
      expect(getOutput()).toContain("My Org");
      expect(getOutput()).toContain("my-org");
    });
  });

  describe("defaults", () => {
    test("shows defaults when org and project are set", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      getDefaultOrgSpy.mockReturnValue("my-org");
      getDefaultProjectSpy.mockReturnValue("my-project");

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("Defaults");
      expect(getOutput()).toContain("my-org");
      expect(getOutput()).toContain("my-project");
    });

    test("hides defaults section when none set", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).not.toContain("Defaults");
    });
  });

  describe("user info", () => {
    test("shows user identity when available for OAuth", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      getUserInfoSpy.mockReturnValue({
        name: "Jane Doe",
        email: "jane@example.com",
      });

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).toContain("User");
      expect(getOutput()).toContain("Jane Doe");
    });

    test("skips cached user info for env var tokens", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_env_token_123",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      getUserInfoSpy.mockReturnValue({
        userId: "12345",
        name: "Stale User",
        email: "stale@example.com",
        username: "staleuser",
      });

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).not.toContain("Stale User");
      expect(getOutput()).not.toContain("stale@example.com");
    });

    test("JSON user field is undefined for env var tokens even with cached user info", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_env_token_123",
        source: "env:SENTRY_AUTH_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      getUserInfoSpy.mockReturnValue({
        userId: "12345",
        name: "Stale User",
        email: "stale@example.com",
      });

      const { context, getOutput } = createContext();
      await func.call(context, jsonFlags);

      const parsed = JSON.parse(getOutput());
      expect(parsed.user).toBeUndefined();
    });

    test("does not skip cached user info for SENTRY_TOKEN env var either", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_token_456",
        source: "env:SENTRY_TOKEN",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      getUserInfoSpy.mockReturnValue({
        userId: "99",
        name: "Old User",
        email: "old@example.com",
      });

      const { context, getOutput } = createContext();
      await func.call(context, humanFlags);

      expect(getOutput()).not.toContain("Old User");
      expect(getOutput()).not.toContain("old@example.com");
    });
  });

  describe("JSON output", () => {
    test("outputs valid JSON with all fields", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc123def456",
        source: "oauth",
        expiresAt: Date.now() + 3_600_000,
        refreshToken: "refresh_xyz",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      getUserInfoSpy.mockReturnValue({
        name: "Jane Doe",
        email: "jane@example.com",
        username: "janedoe",
      });
      getDefaultOrgSpy.mockReturnValue("my-org");
      getDefaultProjectSpy.mockReturnValue("my-project");
      listOrgsSpy.mockResolvedValue([{ name: "My Org", slug: "my-org" }]);

      const { context, getOutput } = createContext();
      await func.call(context, jsonFlags);

      const parsed = JSON.parse(getOutput());
      expect(parsed.authenticated).toBe(true);
      expect(parsed.source).toBe("oauth");
      expect(parsed.configPath).toBe("/fake/db/path");
      expect(parsed.user.name).toBe("Jane Doe");
      expect(parsed.token.display).toContain("...");
      expect(parsed.token.refreshEnabled).toBe(true);
      expect(parsed.defaults.organization).toBe("my-org");
      expect(parsed.defaults.project).toBe("my-project");
      expect(parsed.verification.success).toBe(true);
      expect(parsed.verification.organizations).toHaveLength(1);
    });

    test("JSON token is masked by default", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc123def456",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);

      const { context, getOutput } = createContext();
      await func.call(context, jsonFlags);

      const parsed = JSON.parse(getOutput());
      expect(parsed.token.display).not.toBe("sntrys_abc123def456");
      expect(parsed.token.display).toContain("...");
    });

    test("JSON includes verification error on failure", async () => {
      getAuthConfigSpy.mockReturnValue({
        token: "sntrys_abc",
        source: "oauth",
      });
      isAuthenticatedSpy.mockReturnValue(true);
      listOrgsSpy.mockRejectedValue(new Error("Network error"));

      const { context, getOutput } = createContext();
      await func.call(context, jsonFlags);

      const parsed = JSON.parse(getOutput());
      expect(parsed.verification.success).toBe(false);
      expect(parsed.verification.error).toContain("Network error");
    });
  });
});
