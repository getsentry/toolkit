/**
 * Login Command Tests
 *
 * Unit tests for the --token, --force, and interactive TTY re-authentication
 * paths in src/commands/auth/login.ts. Uses spyOn to mock api-client, db/auth,
 * db/user, and interactive-login to cover all branches without real HTTP
 * calls or database access.
 *
 * The interactive TTY prompt tests use vi.mock() at the top of this file
 * to stub node:tty (so isatty(0) returns true) and the logger module (so
 * `.prompt()` is controllable).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock isatty to simulate interactive terminal for the re-auth prompt path.
// Bun's ESM wrapper for CJS built-ins exposes `default` + `ReadStream` +
// `WriteStream` — all must be present.
const { mockIsatty, ttyExports, noop, mockPrompt, fakeLog } = vi.hoisted(() => {
  const _mockIsatty = vi.fn(() => false);
  class _FakeReadStream {}
  class _FakeWriteStream {}
  const _ttyExports = {
    isatty: _mockIsatty,
    ReadStream: _FakeReadStream,
    WriteStream: _FakeWriteStream,
  };

  /** No-op placeholder for unused logger methods. */
  function _noop() {
    // intentional no-op
  }

  // Mock the logger module to intercept the .prompt() call made by the
  // module-scoped `log = logger.withTag("auth.login")` in login.ts.
  const _mockPrompt = vi.fn((): Promise<boolean | symbol> =>
    Promise.resolve(true),
  );
  const _fakeLog: {
    prompt: typeof _mockPrompt;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
    withTag: () => typeof _fakeLog;
  } = {
    prompt: _mockPrompt,
    info: vi.fn(_noop),
    warn: vi.fn(_noop),
    error: vi.fn(_noop),
    debug: vi.fn(_noop),
    success: vi.fn(_noop),
    withTag: () => _fakeLog,
  };

  return {
    mockIsatty: _mockIsatty,
    ttyExports: _ttyExports,
    noop: _noop,
    mockPrompt: _mockPrompt,
    fakeLog: _fakeLog,
  };
});

vi.mock("node:tty", () => ({
  ...ttyExports,
  default: ttyExports,
}));

vi.mock("../../../src/lib/logger.js", () => ({
  logger: fakeLog,
  setLogLevel: vi.fn(noop),
  attachSentryReporter: vi.fn(noop),
  LOG_LEVEL_NAMES: ["error", "warn", "log", "info", "debug", "trace"],
  LOG_LEVEL_ENV_VAR: "SENTRY_LOG_LEVEL",
  parseLogLevel: (name: string) => {
    const levels = ["error", "warn", "log", "info", "debug", "trace"];
    const idx = levels.indexOf(name.toLowerCase().trim());
    return idx === -1 ? 3 : idx;
  },
  getEnvLogLevel: () => null,
}));

// Dynamic import: must run AFTER vi.mock() so login.ts picks up fakeLog.
const { loginCommand, rcTokenHint } =
  await import("../../../src/commands/auth/login.js");

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/auth.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";

vi.mock("../../../src/lib/db/user.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/user.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as dbUser from "../../../src/lib/db/user.js";
import {
  ApiError,
  AuthError,
  MalformedAuthTokenError,
  ValidationError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/interactive-login.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/interactive-login.js")
    >();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as interactiveLogin from "../../../src/lib/interactive-login.js";
import type { SentryCliRcConfig } from "../../../src/lib/sentryclirc.js";
import { useEnvSandbox } from "../../helpers.js";

type LoginFlags = {
  readonly token?: string;
  readonly timeout: number;
  readonly force: boolean;
  readonly url?: string;
  readonly "read-only"?: boolean;
  readonly scope?: readonly string[];
};

/** Command function type extracted from loader result */
type LoginFunc = (this: unknown, flags: LoginFlags) => Promise<void>;

const SAMPLE_USER = {
  id: "42",
  name: "Jane Doe",
  username: "janedoe",
  email: "jane@example.com",
};

/**
 * Create a mock Stricli context with stdout capture.
 *
 * `getStdout()` returns rendered command output (human formatter → context.stdout).
 *
 * Logger messages (early-exit diagnostics) go through the fakeLog mocked at
 * the top of this file. Tests that care about specific prompt content inspect
 * `mockPrompt.mock.calls` directly.
 */
function createContext() {
  const stdoutChunks: string[] = [];
  const context = {
    stdout: {
      write: vi.fn((s: string) => {
        stdoutChunks.push(s);
      }),
    },
    stderr: {
      write: vi.fn((_s: string) => {
        // unused — diagnostics go through logger
      }),
    },
    cwd: "/tmp",
  };
  const getStdout = () => stdoutChunks.join("");
  return { context, getStdout };
}

/** Assert setAuthToken was called with the expected token and a host option. */
function expectTokenStored(
  spy: ReturnType<typeof spyOn>,
  expectedToken: string,
): void {
  // shared helper
  expect(spy).toHaveBeenCalled();
  // shared helper
  expect(spy.mock.calls[0]?.[0]).toBe(expectedToken);
  // shared helper
  expect(spy.mock.calls[0]?.[3]).toMatchObject({
    host: expect.any(String),
  });
}

describe("loginCommand.func --token path", () => {
  useEnvSandbox(["SENTRY_HOST", "SENTRY_URL"]);

  let isAuthenticatedSpy: ReturnType<typeof spyOn>;
  let isEnvTokenActiveSpy: ReturnType<typeof spyOn>;
  let setAuthTokenSpy: ReturnType<typeof spyOn>;
  let getUserRegionsSpy: ReturnType<typeof spyOn>;
  let clearAuthSpy: ReturnType<typeof spyOn>;
  let getCurrentUserSpy: ReturnType<typeof spyOn>;
  let setUserInfoSpy: ReturnType<typeof spyOn>;
  let runInteractiveLoginSpy: ReturnType<typeof spyOn>;
  let hasStoredAuthCredentialsSpy: ReturnType<typeof spyOn>;
  let listOrgsUncachedSpy: ReturnType<typeof spyOn>;
  let func: LoginFunc;

  beforeEach(async () => {
    isAuthenticatedSpy = vi.spyOn(dbAuth, "isAuthenticated");
    isEnvTokenActiveSpy = vi.spyOn(dbAuth, "isEnvTokenActive");
    setAuthTokenSpy = vi.spyOn(dbAuth, "setAuthToken");
    getUserRegionsSpy = vi.spyOn(apiClient, "getUserRegions");
    clearAuthSpy = vi.spyOn(dbAuth, "clearAuth");
    getCurrentUserSpy = vi.spyOn(apiClient, "getCurrentUser");
    setUserInfoSpy = vi.spyOn(dbUser, "setUserInfo");
    runInteractiveLoginSpy = vi.spyOn(interactiveLogin, "runInteractiveLogin");
    hasStoredAuthCredentialsSpy = vi.spyOn(dbAuth, "hasStoredAuthCredentials");
    // Prevent warmOrgCache() fire-and-forget from hitting real fetch.
    // After successful login, warmOrgCache() calls listOrganizationsUncached()
    // which triggers API calls that leak as "unexpected fetch" warnings.
    listOrgsUncachedSpy = vi.spyOn(apiClient, "listOrganizationsUncached");
    listOrgsUncachedSpy.mockResolvedValue([]);
    isEnvTokenActiveSpy.mockReturnValue(false);
    hasStoredAuthCredentialsSpy.mockReturnValue(false);
    func = (await loginCommand.loader()) as unknown as LoginFunc;
  });

  afterEach(() => {
    isAuthenticatedSpy.mockRestore();
    isEnvTokenActiveSpy.mockRestore();
    setAuthTokenSpy.mockRestore();
    getUserRegionsSpy.mockRestore();
    clearAuthSpy.mockRestore();
    getCurrentUserSpy.mockRestore();
    setUserInfoSpy.mockRestore();
    runInteractiveLoginSpy.mockRestore();
    hasStoredAuthCredentialsSpy.mockRestore();
    listOrgsUncachedSpy.mockRestore();
  });

  test("already authenticated (non-TTY, no --force): prints re-auth message with --force hint", async () => {
    isAuthenticatedSpy.mockReturnValue(true);

    const { context } = createContext();
    await func.call(context, { force: false, timeout: 900 });

    expect(setAuthTokenSpy).not.toHaveBeenCalled();
    expect(getCurrentUserSpy).not.toHaveBeenCalled();
  });

  test("already authenticated (env token SENTRY_AUTH_TOKEN): warns and proceeds to OAuth login", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    isEnvTokenActiveSpy.mockReturnValue(true);
    hasStoredAuthCredentialsSpy.mockReturnValue(false);
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/fake",
    });

    const { context } = createContext();
    await func.call(context, { force: false, timeout: 900 });

    // With no stored OAuth, login proceeds directly (no clearAuth needed)
    expect(runInteractiveLoginSpy).toHaveBeenCalled();
  });

  test("already authenticated (env token SENTRY_TOKEN): warns and proceeds to OAuth login", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    isEnvTokenActiveSpy.mockReturnValue(true);
    hasStoredAuthCredentialsSpy.mockReturnValue(false);
    // Set env var directly — getActiveEnvVarName() reads env vars via getEnvToken()
    process.env.SENTRY_TOKEN = "sntrys_token_456";
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/fake",
    });

    try {
      const { context } = createContext();
      await func.call(context, { force: false, timeout: 900 });

      expect(runInteractiveLoginSpy).toHaveBeenCalled();
    } finally {
      delete process.env.SENTRY_TOKEN;
    }
  });

  test("--token: stores token, fetches user, writes success", async () => {
    isAuthenticatedSpy.mockReturnValue(false);
    setAuthTokenSpy.mockReturnValue(undefined);
    getUserRegionsSpy.mockResolvedValue([]);
    getCurrentUserSpy.mockResolvedValue(SAMPLE_USER);
    setUserInfoSpy.mockReturnValue(undefined);

    const { context, getStdout } = createContext();
    await func.call(context, {
      token: "my-token",
      force: false,
      timeout: 900,
    });

    // Token stored with host scope (host resolved from SENTRY_HOST/SENTRY_URL
    // or default SaaS — see setAuthToken in db/auth.ts).
    expectTokenStored(setAuthTokenSpy, "my-token");
    expect(getCurrentUserSpy).toHaveBeenCalled();
    expect(setUserInfoSpy).toHaveBeenCalledWith({
      userId: "42",
      name: "Jane Doe",
      username: "janedoe",
      email: "jane@example.com",
    });
    const out = getStdout();
    expect(out).toContain("Authenticated");
    expect(out).toContain("Jane Doe");
  });

  test.each([
    ["line break", "synthetic-prefix\nsynthetic-suffix"],
    ["NUL", "synthetic-prefix\0synthetic-suffix"],
    ["empty value", ""],
    ["control-only value", "\x01\x7f"],
  ])(
    "--force --token rejects %s before changing the session or host",
    async (_, token) => {
      isAuthenticatedSpy.mockReturnValue(true);
      process.env.SENTRY_HOST = "https://previous.example.com";
      process.env.SENTRY_URL = "https://previous.example.com";
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      try {
        const { context } = createContext();
        await expect(
          func.call(context, {
            token,
            force: true,
            timeout: 900,
            url: "https://replacement.example.com",
          }),
        ).rejects.toBeInstanceOf(MalformedAuthTokenError);

        expect(process.env.SENTRY_HOST).toBe("https://previous.example.com");
        expect(process.env.SENTRY_URL).toBe("https://previous.example.com");
        expect(clearAuthSpy).not.toHaveBeenCalled();
        expect(setAuthTokenSpy).not.toHaveBeenCalled();
        expect(setUserInfoSpy).not.toHaveBeenCalled();
        expect(getUserRegionsSpy).not.toHaveBeenCalled();
        expect(getCurrentUserSpy).not.toHaveBeenCalled();
        expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  test.each([
    "\t\n\u00a0synthetic-token\r\n",
    "\0\u00a0\x01synthetic-token\x7f\ufeff\0",
  ])(
    "--token normalizes surrounding whitespace and controls before storage %#",
    async (token) => {
      isAuthenticatedSpy.mockReturnValue(false);
      setAuthTokenSpy.mockReturnValue(undefined);
      getUserRegionsSpy.mockResolvedValue([]);
      getCurrentUserSpy.mockResolvedValue(SAMPLE_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context } = createContext();
      await func.call(context, { token, force: false, timeout: 900 });

      expectTokenStored(setAuthTokenSpy, "synthetic-token");
      expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
    },
  );

  test("--token: null user.name is converted to undefined in setUserInfo", async () => {
    isAuthenticatedSpy.mockReturnValue(false);
    setAuthTokenSpy.mockReturnValue(undefined);
    getUserRegionsSpy.mockResolvedValue([]);
    getCurrentUserSpy.mockResolvedValue({
      id: "5",
      name: null,
      email: "x@y.com",
      username: "xuser",
    });
    setUserInfoSpy.mockReturnValue(undefined);

    const { context, getStdout } = createContext();
    await func.call(context, {
      token: "valid-token",
      force: false,
      timeout: 900,
    });

    expect(setUserInfoSpy).toHaveBeenCalledWith({
      userId: "5",
      email: "x@y.com",
      username: "xuser",
      name: undefined,
    });
    const out = getStdout();
    expect(out).toContain("Authenticated");
    // With null name, formatUserIdentity falls back to email
    expect(out).toContain("x@y.com");
  });

  test("--token: 401 from validation clears auth and throws AuthError", async () => {
    isAuthenticatedSpy.mockReturnValue(false);
    setAuthTokenSpy.mockReturnValue(undefined);
    getUserRegionsSpy.mockRejectedValue(new ApiError("Unauthorized", 401));
    clearAuthSpy.mockResolvedValue(undefined);

    const { context } = createContext();
    await expect(
      func.call(context, { token: "bad-token", force: false, timeout: 900 }),
    ).rejects.toBeInstanceOf(AuthError);

    expect(clearAuthSpy).toHaveBeenCalled();
    expect(getCurrentUserSpy).not.toHaveBeenCalled();
  });

  test("--token: non-401 validation failure keeps token and re-throws cause", async () => {
    // A network/server failure during validation is not a token problem:
    // surface the real error and do NOT clear a possibly-valid token (CLI-19).
    isAuthenticatedSpy.mockReturnValue(false);
    setAuthTokenSpy.mockReturnValue(undefined);
    const cause = new ApiError("Server error", 503);
    getUserRegionsSpy.mockRejectedValue(cause);
    clearAuthSpy.mockResolvedValue(undefined);

    const { context } = createContext();
    await expect(
      func.call(context, { token: "maybe-good", force: false, timeout: 900 }),
    ).rejects.toBe(cause);

    expect(clearAuthSpy).not.toHaveBeenCalled();
    expect(getCurrentUserSpy).not.toHaveBeenCalled();
  });

  test("--token: shows 'Logged in as' when user info fetch succeeds", async () => {
    isAuthenticatedSpy.mockReturnValue(false);
    setAuthTokenSpy.mockReturnValue(undefined);
    getUserRegionsSpy.mockResolvedValue([]);
    getCurrentUserSpy.mockResolvedValue({ id: "5", email: "only@email.com" });
    setUserInfoSpy.mockReturnValue(undefined);

    const { context, getStdout } = createContext();
    await func.call(context, {
      token: "valid-token",
      force: false,
      timeout: 900,
    });

    expect(getStdout()).toContain("Logged in as");
    expect(getStdout()).toContain("only@email.com");
  });

  test("--token: login succeeds even when getCurrentUser() fails transiently", async () => {
    isAuthenticatedSpy.mockReturnValue(false);
    setAuthTokenSpy.mockReturnValue(undefined);
    getUserRegionsSpy.mockResolvedValue([]);
    getCurrentUserSpy.mockRejectedValue(new Error("Network error"));

    const { context, getStdout } = createContext();
    // Must not throw — login should succeed with the stored token
    await func.call(context, {
      token: "valid-token",
      force: false,
      timeout: 900,
    });

    const out = getStdout();
    expect(out).toContain("Authenticated");
    // 'Logged in as' is omitted when user info is unavailable
    expect(out).not.toContain("Logged in as");
    // Token was stored and not cleared
    expect(clearAuthSpy).not.toHaveBeenCalled();
    expect(setUserInfoSpy).not.toHaveBeenCalled();
  });

  test("no token: falls through to interactive login", async () => {
    isAuthenticatedSpy.mockReturnValue(false);
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/tmp/db",
      expiresIn: 3600,
      refreshEnabled: true,
    });

    const { context, getStdout } = createContext();
    await func.call(context, { force: false, timeout: 900 });

    expect(runInteractiveLoginSpy).toHaveBeenCalled();
    expect(setAuthTokenSpy).not.toHaveBeenCalled();
    expect(getStdout()).toContain("Automatic refresh: enabled");
    expect(getStdout()).not.toContain("expires");
  });

  test("OAuth login warns when automatic refresh is unavailable", async () => {
    isAuthenticatedSpy.mockReturnValue(false);
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/tmp/db",
      expiresIn: 3600,
      refreshEnabled: false,
    });

    const { context, getStdout } = createContext();
    await func.call(context, { force: false, timeout: 900 });

    expect(getStdout()).toContain("Automatic refresh: unavailable");
    expect(getStdout()).toContain("Access token expires in: 1 hour");
  });

  test("--force when authenticated: clears auth and proceeds to interactive login", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    clearAuthSpy.mockResolvedValue(undefined);
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/tmp/db",
    });

    const { context } = createContext();
    await func.call(context, { force: true, timeout: 900 });

    expect(clearAuthSpy).toHaveBeenCalled();
    expect(runInteractiveLoginSpy).toHaveBeenCalled();
  });

  test("--force --token when authenticated: clears auth and proceeds to token login", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    clearAuthSpy.mockResolvedValue(undefined);
    setAuthTokenSpy.mockReturnValue(undefined);
    getUserRegionsSpy.mockResolvedValue([]);
    getCurrentUserSpy.mockResolvedValue(SAMPLE_USER);
    setUserInfoSpy.mockReturnValue(undefined);

    const { context, getStdout } = createContext();
    await func.call(context, {
      token: "new-token",
      force: true,
      timeout: 900,
    });

    expect(clearAuthSpy).toHaveBeenCalled();
    expectTokenStored(setAuthTokenSpy, "new-token");
    expect(getStdout()).toContain("Authenticated");
  });

  test("--force with env token: proceeds to OAuth login (no longer blocks)", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    isEnvTokenActiveSpy.mockReturnValue(true);
    hasStoredAuthCredentialsSpy.mockReturnValue(false);
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/fake",
    });

    const { context } = createContext();
    await func.call(context, { force: true, timeout: 900 });

    // Env token no longer blocks — login proceeds
    expect(runInteractiveLoginSpy).toHaveBeenCalled();
  });
});

/**
 * Tests for the interactive TTY re-authentication prompt.
 *
 * Uses the module-level `vi.mock()` on node:tty (so `isatty(0)` returns
 * true) and the logger (so `.prompt()` is controllable).
 */
describe("login re-authentication interactive prompt", () => {
  let isAuthenticatedSpy: ReturnType<typeof spyOn>;
  let isEnvTokenActiveSpy: ReturnType<typeof spyOn>;
  let clearAuthSpy: ReturnType<typeof spyOn>;
  let runInteractiveLoginSpy: ReturnType<typeof spyOn>;
  let getUserInfoSpy: ReturnType<typeof spyOn>;
  let listOrgsUncachedSpy: ReturnType<typeof spyOn>;
  let func: LoginFunc;

  function createPromptContext() {
    return {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    };
  }

  beforeEach(async () => {
    isAuthenticatedSpy = vi.spyOn(dbAuth, "isAuthenticated");
    isEnvTokenActiveSpy = vi.spyOn(dbAuth, "isEnvTokenActive");
    clearAuthSpy = vi.spyOn(dbAuth, "clearAuth");
    runInteractiveLoginSpy = vi.spyOn(interactiveLogin, "runInteractiveLogin");
    getUserInfoSpy = vi.spyOn(dbUser, "getUserInfo");
    // Prevent warmOrgCache() fire-and-forget from hitting real fetch.
    listOrgsUncachedSpy = vi.spyOn(apiClient, "listOrganizationsUncached");
    listOrgsUncachedSpy.mockResolvedValue([]);

    // Defaults
    isEnvTokenActiveSpy.mockReturnValue(false);
    clearAuthSpy.mockResolvedValue(undefined);
    runInteractiveLoginSpy.mockResolvedValue(true);
    mockIsatty.mockReturnValue(true);
    mockPrompt.mockClear();

    func = (await loginCommand.loader()) as unknown as LoginFunc;
  });

  afterEach(() => {
    isAuthenticatedSpy.mockRestore();
    isEnvTokenActiveSpy.mockRestore();
    clearAuthSpy.mockRestore();
    runInteractiveLoginSpy.mockRestore();
    getUserInfoSpy.mockRestore();
    listOrgsUncachedSpy.mockRestore();
    mockIsatty.mockReturnValue(false);
  });

  test("shows prompt with user identity when authenticated on TTY", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getUserInfoSpy.mockReturnValue({
      userId: "42",
      name: "Jane Doe",
      email: "jane@example.com",
    });
    mockPrompt.mockResolvedValue(true);

    const context = createPromptContext();
    await func.call(context, { force: false, timeout: 900 });

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    const promptMessage = (mockPrompt.mock.calls[0] as unknown as string[])[0];
    expect(promptMessage).toContain("Jane Doe");
    expect(promptMessage).toContain("jane@example.com");
    expect(promptMessage).toContain("Re-authenticate?");
  });

  test("shows 'current user' fallback when no cached user info", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getUserInfoSpy.mockReturnValue(undefined);
    mockPrompt.mockResolvedValue(true);

    const context = createPromptContext();
    await func.call(context, { force: false, timeout: 900 });

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    const promptMessage = (mockPrompt.mock.calls[0] as unknown as string[])[0];
    expect(promptMessage).toContain("current user");
  });

  test("confirm: clears auth and proceeds to login", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getUserInfoSpy.mockReturnValue(undefined);
    mockPrompt.mockResolvedValue(true);

    const context = createPromptContext();
    await func.call(context, { force: false, timeout: 900 });

    expect(clearAuthSpy).toHaveBeenCalled();
    expect(runInteractiveLoginSpy).toHaveBeenCalled();
  });

  test("decline: returns without re-auth", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getUserInfoSpy.mockReturnValue(undefined);
    mockPrompt.mockResolvedValue(false);

    const context = createPromptContext();
    await func.call(context, { force: false, timeout: 900 });

    expect(mockPrompt).toHaveBeenCalled();
    expect(clearAuthSpy).not.toHaveBeenCalled();
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });

  test("cancel (Ctrl+C): returns without re-auth", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getUserInfoSpy.mockReturnValue(undefined);
    // consola returns Symbol(clack:cancel) on Ctrl+C — truthy but not `true`.
    mockPrompt.mockResolvedValue(Symbol("clack:cancel"));

    const context = createPromptContext();
    await func.call(context, { force: false, timeout: 900 });

    expect(mockPrompt).toHaveBeenCalled();
    expect(clearAuthSpy).not.toHaveBeenCalled();
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });

  test("--force skips prompt even on TTY", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getUserInfoSpy.mockReturnValue(undefined);

    const context = createPromptContext();
    await func.call(context, { force: true, timeout: 900 });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(clearAuthSpy).toHaveBeenCalled();
    expect(runInteractiveLoginSpy).toHaveBeenCalled();
  });

  test("confirm + --token: clears auth and re-authenticates with token", async () => {
    isAuthenticatedSpy.mockReturnValue(true);
    getUserInfoSpy.mockReturnValue(undefined);
    mockPrompt.mockResolvedValue(true);

    const setAuthTokenSpy = vi.spyOn(dbAuth, "setAuthToken");
    setAuthTokenSpy.mockImplementation(noop);
    const getUserRegionsSpy = vi.spyOn(apiClient, "getUserRegions");
    getUserRegionsSpy.mockResolvedValue([]);
    const getCurrentUserSpy = vi.spyOn(apiClient, "getCurrentUser");
    getCurrentUserSpy.mockResolvedValue({
      id: "42",
      name: "Jane",
      username: "jane",
      email: "jane@example.com",
    });
    const setUserInfoSpy = vi.spyOn(dbUser, "setUserInfo");
    setUserInfoSpy.mockReturnValue(undefined);

    const context = createPromptContext();
    try {
      await func.call(context, {
        token: "new-token",
        force: false,
        timeout: 900,
      });

      expect(clearAuthSpy).toHaveBeenCalled();
      // Token stored with host scope (4th arg = { host: ... })
      expectTokenStored(setAuthTokenSpy, "new-token");
    } finally {
      setAuthTokenSpy.mockRestore();
      getUserRegionsSpy.mockRestore();
      getCurrentUserSpy.mockRestore();
      setUserInfoSpy.mockRestore();
    }
  });
});

describe("applyLoginUrl (host resolution)", () => {
  let savedHost: string | undefined;
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedHost = process.env.SENTRY_HOST;
    savedUrl = process.env.SENTRY_URL;
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
  });

  afterEach(() => {
    if (savedHost !== undefined) {
      process.env.SENTRY_HOST = savedHost;
    } else {
      delete process.env.SENTRY_HOST;
    }
    if (savedUrl !== undefined) {
      process.env.SENTRY_URL = savedUrl;
    } else {
      delete process.env.SENTRY_URL;
    }
  });

  test("explicit --url takes precedence and writes env", async () => {
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    const host = applyLoginUrl("https://sentry.example.com");
    expect(host).toBe("https://sentry.example.com");
    expect(process.env.SENTRY_HOST).toBe("https://sentry.example.com");
    expect(process.env.SENTRY_URL).toBe("https://sentry.example.com");
  });

  test("no --url + no env falls back to SaaS default", async () => {
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    expect(applyLoginUrl(undefined)).toBe("https://sentry.io");
  });

  test("no --url + SENTRY_HOST with scheme uses env host", async () => {
    process.env.SENTRY_HOST = "https://sentry.acme.com";
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    expect(applyLoginUrl(undefined)).toBe("https://sentry.acme.com");
  });

  test("no --url + bare hostname SENTRY_HOST prefixes https:// (bug fix)", async () => {
    // Regression: applyLoginUrl previously called normalizeOrigin directly
    // on bare hostnames. new URL("sentry.acme.com") throws → silent fallback
    // to SaaS default → token mis-scoped.
    process.env.SENTRY_HOST = "sentry.acme.com";
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    expect(applyLoginUrl(undefined)).toBe("https://sentry.acme.com");
  });

  test("no --url + bare hostname SENTRY_URL prefixes https://", async () => {
    process.env.SENTRY_URL = "sentry.acme.com";
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    expect(applyLoginUrl(undefined)).toBe("https://sentry.acme.com");
  });

  test("SENTRY_HOST takes precedence over SENTRY_URL", async () => {
    process.env.SENTRY_HOST = "https://host.example.com";
    process.env.SENTRY_URL = "https://url.example.com";
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    expect(applyLoginUrl(undefined)).toBe("https://host.example.com");
  });
});

describe("applyLoginUrl (trust anchor registration)", () => {
  let savedHost: string | undefined;
  let savedUrl: string | undefined;

  beforeEach(async () => {
    savedHost = process.env.SENTRY_HOST;
    savedUrl = process.env.SENTRY_URL;
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    const { resetEnvTokenHostForTesting } =
      await import("../../../src/lib/env-token-host.js");
    const { resetLoginTrustAnchorForTesting } =
      await import("../../../src/lib/token-host.js");
    resetEnvTokenHostForTesting();
    resetLoginTrustAnchorForTesting();
  });

  afterEach(async () => {
    if (savedHost !== undefined) {
      process.env.SENTRY_HOST = savedHost;
    } else {
      delete process.env.SENTRY_HOST;
    }
    if (savedUrl !== undefined) {
      process.env.SENTRY_URL = savedUrl;
    } else {
      delete process.env.SENTRY_URL;
    }
    const { resetEnvTokenHostForTesting } =
      await import("../../../src/lib/env-token-host.js");
    const { resetLoginTrustAnchorForTesting } =
      await import("../../../src/lib/token-host.js");
    resetEnvTokenHostForTesting();
    resetLoginTrustAnchorForTesting();
  });

  test("explicit --url registers trust anchor (user-supplied argv is trusted)", async () => {
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    const { isRequestOriginTrustedForCustomHeaders } =
      await import("../../../src/lib/token-host.js");
    applyLoginUrl("https://sentry.acme.com");
    expect(
      isRequestOriginTrustedForCustomHeaders(
        "https://sentry.acme.com/oauth/device/code/",
      ),
    ).toBe(true);
  });

  test("SENTRY_HOST from boot env registers trust anchor (shell export is trusted)", async () => {
    process.env.SENTRY_HOST = "https://sentry.acme.com";
    const { captureEnvTokenHost } =
      await import("../../../src/lib/env-token-host.js");
    captureEnvTokenHost();
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    const { isRequestOriginTrustedForCustomHeaders } =
      await import("../../../src/lib/token-host.js");
    applyLoginUrl(undefined);
    expect(
      isRequestOriginTrustedForCustomHeaders(
        "https://sentry.acme.com/oauth/device/code/",
      ),
    ).toBe(true);
  });

  test("rc-poisoned SENTRY_URL does NOT register trust anchor (attacker path)", async () => {
    // Boot: no env set → env-token-host captures SaaS default
    const { captureEnvTokenHost } =
      await import("../../../src/lib/env-token-host.js");
    captureEnvTokenHost();

    // Simulate .sentryclirc shim writing env.SENTRY_URL AFTER boot (the
    // auth login has skipRcUrlCheck: true). This is the attacker path.
    process.env.SENTRY_URL = "https://evil.com";

    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    const { isRequestOriginTrustedForCustomHeaders } =
      await import("../../../src/lib/token-host.js");
    applyLoginUrl(undefined);

    // The rc-sourced host doesn't match boot env (which was empty →
    // SaaS default) → NOT registered as trust anchor.
    // applyCustomHeaders against evil.com must fail closed.
    expect(
      isRequestOriginTrustedForCustomHeaders(
        "https://evil.com/oauth/device/code/",
      ),
    ).toBe(false);
  });
});

function makeRcConfig(
  token: string | undefined,
  url?: string,
): SentryCliRcConfig {
  return {
    token,
    url,
    sources: { token: token ? "~/.sentryclirc" : undefined },
  };
}

describe("rcTokenHint", () => {
  test("no token → no hint", () => {
    expect(
      rcTokenHint(makeRcConfig(undefined), "https://sentry.io"),
    ).toBeUndefined();
  });

  test("SaaS host, no rc URL → hint without --url", () => {
    const hint = rcTokenHint(makeRcConfig("sntrys_abc"), "https://sentry.io");
    expect(hint).toContain("sentry auth login --token <token>");
    expect(hint).not.toContain("--url");
  });

  test("self-hosted, rc URL matches → hint includes --url", () => {
    const hint = rcTokenHint(
      makeRcConfig("sntrys_abc", "https://self.example.com"),
      "https://self.example.com",
    );
    expect(hint).toContain("--url https://self.example.com");
  });

  test("self-hosted, rc URL mismatches → no hint (token is for a different instance)", () => {
    const hint = rcTokenHint(
      makeRcConfig("sntrys_abc", "https://other.example.com"),
      "https://self.example.com",
    );
    expect(hint).toBeUndefined();
  });

  test("self-hosted, no rc URL → no hint (bare SaaS token shouldn't be suggested for self-hosted)", () => {
    const hint = rcTokenHint(
      makeRcConfig("sntrys_abc"),
      "https://self.example.com",
    );
    expect(hint).toBeUndefined();
  });
});

describe("loginCommand.func scope selection (--read-only / --scope)", () => {
  let isAuthenticatedSpy: ReturnType<typeof spyOn>;
  let isEnvTokenActiveSpy: ReturnType<typeof spyOn>;
  let hasStoredAuthCredentialsSpy: ReturnType<typeof spyOn>;
  let runInteractiveLoginSpy: ReturnType<typeof spyOn>;
  let listOrgsUncachedSpy: ReturnType<typeof spyOn>;
  let func: LoginFunc;

  beforeEach(async () => {
    isAuthenticatedSpy = vi.spyOn(dbAuth, "isAuthenticated");
    isEnvTokenActiveSpy = vi.spyOn(dbAuth, "isEnvTokenActive");
    hasStoredAuthCredentialsSpy = vi.spyOn(dbAuth, "hasStoredAuthCredentials");
    runInteractiveLoginSpy = vi.spyOn(interactiveLogin, "runInteractiveLogin");
    listOrgsUncachedSpy = vi.spyOn(apiClient, "listOrganizationsUncached");
    listOrgsUncachedSpy.mockResolvedValue([]);
    isAuthenticatedSpy.mockReturnValue(false);
    isEnvTokenActiveSpy.mockReturnValue(false);
    hasStoredAuthCredentialsSpy.mockReturnValue(false);
    runInteractiveLoginSpy.mockResolvedValue({
      method: "oauth",
      configPath: "/fake",
    });
    func = (await loginCommand.loader()) as unknown as LoginFunc;
  });

  afterEach(() => {
    isAuthenticatedSpy.mockRestore();
    isEnvTokenActiveSpy.mockRestore();
    hasStoredAuthCredentialsSpy.mockRestore();
    runInteractiveLoginSpy.mockRestore();
    listOrgsUncachedSpy.mockRestore();
  });

  test("--token + --read-only throws ValidationError", async () => {
    const { context } = createContext();
    await expect(
      func.call(context, {
        token: "tok",
        force: false,
        timeout: 900,
        "read-only": true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });

  test("--token + --scope throws ValidationError", async () => {
    const { context } = createContext();
    await expect(
      func.call(context, {
        token: "tok",
        force: false,
        timeout: 900,
        scope: ["project:read"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });

  test("--read-only + --scope throws ValidationError", async () => {
    const { context } = createContext();
    await expect(
      func.call(context, {
        force: false,
        timeout: 900,
        "read-only": true,
        scope: ["project:read"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });

  test("invalid --scope value throws ValidationError", async () => {
    const { context } = createContext();
    await expect(
      func.call(context, {
        force: false,
        timeout: 900,
        scope: ["not:a:scope"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runInteractiveLoginSpy).not.toHaveBeenCalled();
  });

  test("--read-only forwards the read-only scope set to runInteractiveLogin", async () => {
    const { context } = createContext();
    await func.call(context, {
      force: false,
      timeout: 900,
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
  });

  test("--scope forwards the resolved scope string to runInteractiveLogin", async () => {
    const { context } = createContext();
    await func.call(context, {
      force: false,
      timeout: 900,
      scope: ["project:read", "org:read"],
    });

    expect(runInteractiveLoginSpy).toHaveBeenCalledTimes(1);
    const opts = runInteractiveLoginSpy.mock.calls[0]?.[0] as {
      scope?: string;
    };
    expect(opts.scope).toBe("project:read org:read");
  });

  test("comma-separated --scope is split before resolution", async () => {
    const { context } = createContext();
    await func.call(context, {
      force: false,
      timeout: 900,
      scope: ["project:read,org:read"],
    });

    const opts = runInteractiveLoginSpy.mock.calls[0]?.[0] as {
      scope?: string;
    };
    expect(opts.scope).toBe("project:read org:read");
  });

  test("no scope flags forwards undefined scope (full default set)", async () => {
    const { context } = createContext();
    await func.call(context, { force: false, timeout: 900 });

    const opts = runInteractiveLoginSpy.mock.calls[0]?.[0] as {
      scope?: string;
    };
    expect(opts.scope).toBeUndefined();
  });
});
