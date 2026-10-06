/**
 * Logout Command Tests
 *
 * Tests for the logoutCommand func() in src/commands/auth/logout.ts.
 * Covers the env-token-aware branches added for headless auth support.
 *
 * Now that logout uses CommandOutput, success output goes to stdout via the
 * rendering pipeline, and error cases throw typed errors (AuthError).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logoutCommand } from "../../../src/commands/auth/logout.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbIndex from "../../../src/lib/db/index.js";
import { AuthError } from "../../../src/lib/errors.js";

type LogoutFunc = (
  this: unknown,
  flags: Record<string, never>
) => Promise<void>;

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
          /* captured by mock */
        }),
      },
      cwd: "/tmp",
    },
    getOutput: () => stdoutChunks.join(""),
  };
}

describe("logoutCommand.func", () => {
  let isAuthenticatedSpy: ReturnType<typeof spyOn>;
  let isEnvTokenActiveSpy: ReturnType<typeof spyOn>;
  let getAuthConfigSpy: ReturnType<typeof spyOn>;
  let clearAuthSpy: ReturnType<typeof spyOn>;
  let getDbPathSpy: ReturnType<typeof spyOn>;
  let func: LogoutFunc;

  beforeEach(async () => {
    isAuthenticatedSpy = vi.spyOn(dbAuth, "isAuthenticated");
    isEnvTokenActiveSpy = vi.spyOn(dbAuth, "isEnvTokenActive");
    getAuthConfigSpy = vi.spyOn(dbAuth, "getAuthConfig");
    clearAuthSpy = vi.spyOn(dbAuth, "clearAuth");
    getDbPathSpy = vi.spyOn(dbIndex, "getDbPath");

    clearAuthSpy.mockResolvedValue(undefined);
    getDbPathSpy.mockReturnValue("/fake/db/path");

    func = (await logoutCommand.loader()) as unknown as LogoutFunc;
  });

  afterEach(() => {
    isAuthenticatedSpy.mockRestore();
    isEnvTokenActiveSpy.mockRestore();
    getAuthConfigSpy.mockRestore();
    clearAuthSpy.mockRestore();
    getDbPathSpy.mockRestore();
  });

  test("not authenticated: returns loggedOut false with message", async () => {
    isAuthenticatedSpy.mockReturnValue(false);
    const { context, getOutput } = createContext();

    await func.call(context, {});

    expect(clearAuthSpy).not.toHaveBeenCalled();
    expect(getOutput()).toContain("Not currently authenticated");
  });

  test("OAuth token: clears auth and writes success to stdout", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getAuthConfigSpy.mockReturnValue({
      token: "sntrys_oauth_123",
      source: "oauth",
    });
    const { context, getOutput } = createContext();

    await func.call(context, {});

    expect(clearAuthSpy).toHaveBeenCalled();
    expect(getOutput()).toContain("Logged out successfully");
    expect(getOutput()).toContain("/fake/db/path");
  });

  test("env token (SENTRY_AUTH_TOKEN): throws AuthError with env var message", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    isEnvTokenActiveSpy.mockReturnValue(true);
    getAuthConfigSpy.mockReturnValue({
      token: "sntrys_env_123",
      source: "env:SENTRY_AUTH_TOKEN",
    });
    const { context } = createContext();

    try {
      await func.call(context, {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      const msg = (err as AuthError).message;
      expect(msg).toContain("SENTRY_AUTH_TOKEN");
      expect(msg).toContain("environment variable");
      expect(msg).toContain("Unset");
    }
    expect(clearAuthSpy).not.toHaveBeenCalled();
  });

  test("env token (SENTRY_TOKEN): shows correct env var name in error", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getAuthConfigSpy.mockReturnValue({
      token: "sntrys_token_456",
      source: "env:SENTRY_TOKEN",
    });
    // Clear SENTRY_AUTH_TOKEN so SENTRY_TOKEN takes priority
    const savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
    // Set env var directly — getActiveEnvVarName() reads env vars via getEnvToken()
    process.env.SENTRY_TOKEN = "sntrys_token_456";
    const { context } = createContext();

    try {
      await func.call(context, {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      const msg = (err as AuthError).message;
      expect(msg).toContain("SENTRY_TOKEN");
    } finally {
      delete process.env.SENTRY_TOKEN;
      if (savedAuthToken !== undefined) {
        process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
      }
    }
    expect(clearAuthSpy).not.toHaveBeenCalled();
  });

  test("OAuth source with env var set: clears stored OAuth (env var still present)", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    // Effective source is OAuth even though env var is set
    getAuthConfigSpy.mockReturnValue({
      token: "sntrys_oauth",
      source: "oauth",
    });
    const { context, getOutput } = createContext();

    await func.call(context, {});

    expect(clearAuthSpy).toHaveBeenCalled();
    expect(getOutput()).toContain("Logged out successfully");
  });
});
