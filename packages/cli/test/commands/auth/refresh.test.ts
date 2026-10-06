/**
 * Refresh Command Tests
 *
 * Tests for the refreshCommand func() in src/commands/auth/refresh.ts.
 * Covers the env-token guard and the main refresh flow.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { refreshCommand } from "../../../src/commands/auth/refresh.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";
import { AuthError, ValidationError } from "../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as interactiveLogin from "../../../src/lib/interactive-login.js";

type RefreshFlags = {
  readonly json: boolean;
  readonly force: boolean;
  readonly "read-only"?: boolean;
  readonly scope?: readonly string[];
};
type RefreshFunc = (this: unknown, flags: RefreshFlags) => Promise<void>;

function createContext() {
  const stdoutLines: string[] = [];
  const context = {
    stdout: {
      write: vi.fn((s: string) => {
        stdoutLines.push(s);
      }),
    },
    stderr: {
      write: vi.fn((_s: string) => {
        /* no-op */
      }),
    },
    cwd: "/tmp",
  };
  return { context, getStdout: () => stdoutLines.join("") };
}

describe("refreshCommand.func", () => {
  let isEnvTokenActiveSpy: ReturnType<typeof spyOn>;
  let getAuthConfigSpy: ReturnType<typeof spyOn>;
  let refreshTokenSpy: ReturnType<typeof spyOn>;
  let func: RefreshFunc;

  beforeEach(async () => {
    isEnvTokenActiveSpy = vi.spyOn(dbAuth, "isEnvTokenActive");
    getAuthConfigSpy = vi.spyOn(dbAuth, "getAuthConfig");
    refreshTokenSpy = vi.spyOn(dbAuth, "refreshToken");
    func = (await refreshCommand.loader()) as unknown as RefreshFunc;
  });

  afterEach(() => {
    isEnvTokenActiveSpy.mockRestore();
    getAuthConfigSpy.mockRestore();
    refreshTokenSpy.mockRestore();
  });

  test("env token (SENTRY_AUTH_TOKEN): throws AuthError with specific env var name", async () => {
    isEnvTokenActiveSpy.mockReturnValue(true);
    getAuthConfigSpy.mockReturnValue({
      token: "sntrys_env_123",
      source: "env:SENTRY_AUTH_TOKEN",
    });

    const { context } = createContext();

    try {
      await func.call(context, { json: false, force: false });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain(
        "Cannot refresh an environment variable token"
      );
      expect((err as AuthError).message).toContain("Update SENTRY_AUTH_TOKEN");
    }

    expect(refreshTokenSpy).not.toHaveBeenCalled();
  });

  test("env token (SENTRY_TOKEN): throws AuthError with SENTRY_TOKEN in message", async () => {
    isEnvTokenActiveSpy.mockReturnValue(true);
    // Clear SENTRY_AUTH_TOKEN so SENTRY_TOKEN takes priority
    const savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
    // Set env var directly — getActiveEnvVarName() reads env vars via getEnvToken()
    process.env.SENTRY_TOKEN = "sntrys_token_456";

    const { context } = createContext();

    try {
      await func.call(context, { json: false, force: false });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain("Update SENTRY_TOKEN");
      // Should NOT say SENTRY_AUTH_TOKEN
      expect((err as AuthError).message).not.toContain("SENTRY_AUTH_TOKEN");
    } finally {
      delete process.env.SENTRY_TOKEN;
      if (savedAuthToken !== undefined) {
        process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
      }
    }

    expect(refreshTokenSpy).not.toHaveBeenCalled();
  });

  test("no refresh token: throws AuthError about missing refresh token", async () => {
    isEnvTokenActiveSpy.mockReturnValue(false);
    getAuthConfigSpy.mockReturnValue({
      token: "manual_token",
      source: "oauth",
    });

    const { context } = createContext();

    try {
      await func.call(context, { json: false, force: false });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain("No refresh token");
    }
  });

  test("successful refresh: shows success message", async () => {
    isEnvTokenActiveSpy.mockReturnValue(false);
    getAuthConfigSpy.mockReturnValue({
      token: "old_token",
      source: "oauth",
      refreshToken: "refresh_abc",
    });
    refreshTokenSpy.mockResolvedValue({
      token: "new_token",
      refreshed: true,
      expiresIn: 3600,
      expiresAt: Date.now() + 3_600_000,
    });

    const { context, getStdout } = createContext();
    await func.call(context, { json: false, force: false });

    expect(getStdout()).toContain("Access token refreshed successfully");
    expect(getStdout()).toContain("Access token valid for");
    expect(getStdout()).toContain("1 hour");
  });

  test("token still valid: shows still-valid message", async () => {
    isEnvTokenActiveSpy.mockReturnValue(false);
    getAuthConfigSpy.mockReturnValue({
      token: "current_token",
      source: "oauth",
      refreshToken: "refresh_abc",
    });
    refreshTokenSpy.mockResolvedValue({
      token: "current_token",
      refreshed: false,
      expiresIn: 1800,
    });

    const { context, getStdout } = createContext();
    await func.call(context, { json: false, force: false });

    expect(getStdout()).toContain("Access token is still valid");
    expect(getStdout()).toContain("30 minutes");
    expect(getStdout()).toContain("--force");
  });

  test("unknown lifetime does not render a zero-second validity", async () => {
    isEnvTokenActiveSpy.mockReturnValue(false);
    getAuthConfigSpy.mockReturnValue({
      token: "old_token",
      source: "oauth",
      refreshToken: "refresh_abc",
    });
    refreshTokenSpy.mockResolvedValue({
      token: "new_token",
      refreshed: true,
    });

    const { context, getStdout } = createContext();
    await func.call(context, { json: false, force: false });

    expect(getStdout()).toContain("Access token refreshed successfully");
    expect(getStdout()).not.toContain("0 seconds");
    expect(getStdout()).not.toContain("valid for");
  });

  test("--json: outputs JSON for successful refresh", async () => {
    isEnvTokenActiveSpy.mockReturnValue(false);
    getAuthConfigSpy.mockReturnValue({
      token: "old_token",
      source: "oauth",
      refreshToken: "refresh_abc",
    });
    refreshTokenSpy.mockResolvedValue({
      token: "new_token",
      refreshed: true,
      expiresIn: 3600,
      expiresAt: Date.now() + 3_600_000,
    });

    const { context, getStdout } = createContext();
    await func.call(context, { json: true, force: false });

    const parsed = JSON.parse(getStdout());
    expect(parsed.success).toBe(true);
    expect(parsed.refreshed).toBe(true);
    expect(parsed.expiresIn).toBe(3600);
  });
});

describe("refreshCommand.func scope re-authentication (--scope / --read-only)", () => {
  let isEnvTokenActiveSpy: ReturnType<typeof spyOn>;
  let getAuthConfigSpy: ReturnType<typeof spyOn>;
  let refreshTokenSpy: ReturnType<typeof spyOn>;
  let runInteractiveLoginSpy: ReturnType<typeof spyOn>;
  let func: RefreshFunc;

  beforeEach(async () => {
    isEnvTokenActiveSpy = vi.spyOn(dbAuth, "isEnvTokenActive");
    getAuthConfigSpy = vi.spyOn(dbAuth, "getAuthConfig");
    refreshTokenSpy = vi.spyOn(dbAuth, "refreshToken");
    runInteractiveLoginSpy = vi.spyOn(interactiveLogin, "runInteractiveLogin");
    isEnvTokenActiveSpy.mockReturnValue(false);
    getAuthConfigSpy.mockReturnValue({
      token: "old_token",
      source: "oauth",
      refreshToken: "refresh_abc",
    });
    func = (await refreshCommand.loader()) as unknown as RefreshFunc;
  });

  afterEach(() => {
    isEnvTokenActiveSpy.mockRestore();
    getAuthConfigSpy.mockRestore();
    refreshTokenSpy.mockRestore();
    runInteractiveLoginSpy.mockRestore();
  });

  test("--scope triggers device flow with resolved scope string", async () => {
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/fake",
      expiresIn: 3600,
    });

    const { context, getStdout } = createContext();
    await func.call(context, {
      json: false,
      force: false,
      scope: ["project:read", "org:read"],
    });

    expect(runInteractiveLoginSpy).toHaveBeenCalledTimes(1);
    const opts = runInteractiveLoginSpy.mock.calls[0]?.[0] as {
      scope?: string;
    };
    expect(opts.scope).toBe("project:read org:read");

    // Should NOT call the standard token refresh path
    expect(refreshTokenSpy).not.toHaveBeenCalled();

    expect(getStdout()).toContain("Re-authenticated with updated scopes");
  });

  test("--read-only triggers device flow with read-only scopes", async () => {
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/fake",
      expiresIn: 3600,
    });

    const { context } = createContext();
    await func.call(context, {
      json: false,
      force: false,
      "read-only": true,
    });

    expect(runInteractiveLoginSpy).toHaveBeenCalledTimes(1);
    const opts = runInteractiveLoginSpy.mock.calls[0]?.[0] as {
      scope?: string;
    };
    expect(opts.scope).toBeDefined();
    for (const scope of opts.scope!.split(" ")) {
      expect(scope.endsWith(":read")).toBe(true);
    }
    expect(refreshTokenSpy).not.toHaveBeenCalled();
  });

  test("--read-only + --scope throws ValidationError", async () => {
    const { context } = createContext();
    await expect(
      func.call(context, {
        json: false,
        force: false,
        "read-only": true,
        scope: ["project:read"],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
    expect(refreshTokenSpy).not.toHaveBeenCalled();
  });

  test("invalid --scope value throws ValidationError", async () => {
    const { context } = createContext();
    await expect(
      func.call(context, {
        json: false,
        force: false,
        scope: ["not:valid"],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });

  test("env token + --scope still throws AuthError (can't re-scope env tokens)", async () => {
    isEnvTokenActiveSpy.mockReturnValue(true);
    getAuthConfigSpy.mockReturnValue({
      token: "env_token",
      source: "env:SENTRY_AUTH_TOKEN",
    });

    const { context } = createContext();
    await expect(
      func.call(context, {
        json: false,
        force: false,
        scope: ["project:read"],
      })
    ).rejects.toBeInstanceOf(AuthError);
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });

  test("comma-separated --scope is split correctly", async () => {
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/fake",
    });

    const { context } = createContext();
    await func.call(context, {
      json: false,
      force: false,
      scope: ["project:read,org:read"],
    });

    const opts = runInteractiveLoginSpy.mock.calls[0]?.[0] as {
      scope?: string;
    };
    expect(opts.scope).toBe("project:read org:read");
  });

  test("no scope flags uses standard token refresh path", async () => {
    refreshTokenSpy.mockResolvedValue({
      token: "new_token",
      refreshed: true,
      expiresIn: 3600,
      expiresAt: Date.now() + 3_600_000,
    });

    const { context } = createContext();
    await func.call(context, { json: false, force: false });

    expect(refreshTokenSpy).toHaveBeenCalled();
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });
});
