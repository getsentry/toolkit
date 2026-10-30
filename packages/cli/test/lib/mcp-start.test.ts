import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearAuth,
  removeAccount,
  setActiveAccount,
  setAuthToken,
} from "../../src/lib/db/auth.js";
import { setUserInfo } from "../../src/lib/db/user.js";
import {
  HostScopeError,
  MalformedAuthTokenError,
} from "../../src/lib/errors.js";
import type { McpServerConfig } from "../../src/lib/mcp/config.js";
import {
  applySentryCliRcEnvShim,
  clearSentryCliRcCache,
} from "../../src/lib/sentryclirc.js";
import type { McpServeOptions } from "../../src/lib/mcp/server.js";
import {
  mintSntrysToken,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

type Served = { config: McpServerConfig; options: McpServeOptions };

const served: { calls: Served[] } = { calls: [] };

/**
 * Hooks around the CLI's `refreshToken`, to change the credential store at
 * the exact moments another process could.
 */
const refreshHooks = vi.hoisted(() => ({
  before: undefined as (() => Promise<void> | void) | undefined,
  after: undefined as (() => Promise<void> | void) | undefined,
}));

vi.mock("../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/db/auth.js")>();
  return {
    ...actual,
    refreshToken: async (...args: Parameters<typeof actual.refreshToken>) => {
      await refreshHooks.before?.();
      const result = await actual.refreshToken(...args);
      await refreshHooks.after?.();
      return result;
    },
  };
});

vi.mock("../../src/lib/mcp/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/mcp/server.js")>()),
  serveMcpStdio: vi.fn((config: McpServerConfig, options: McpServeOptions) => {
    served.calls.push({ config, options });
  }),
}));

useTestConfigDir("mcp-start-");
useEnvSandbox([
  "SENTRY_CLIENT_ID",
  "SENTRY_ACCESS_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

beforeEach(async () => {
  served.calls = [];
  await resetHostScopingState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetHostScopingState();
});

async function start(args: string[]): Promise<Served> {
  const { startMcpServer } = await import("../../src/lib/mcp.js");
  await expect(startMcpServer(args)).resolves.toBe(true);
  expect(served.calls).toHaveLength(1);
  const [call] = served.calls;
  if (!call) {
    throw new Error("serveMcpStdio was not called");
  }
  return call;
}

describe("startMcpServer credential wiring", () => {
  test("serves with the CLI session token", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    const { options } = await start([]);
    expect(options.accessToken).toBe("cli-session-token");
    expect(options.refreshAccessToken).toBeDefined();
  });

  test("refreshes the CLI session token after an upstream 401", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    const { options } = await start([]);

    // Simulate a refreshed credential landing in the store before the handler runs.
    setAuthToken("rotated-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    await expect(options.refreshAccessToken?.()).resolves.toBe("rotated-token");
  });
});

describe("startMcpServer account pinning", () => {
  const originalFetch = globalThis.fetch;
  const refreshedWith: string[] = [];

  /** Store a new account on sentry.io, as `sentry auth login` does. */
  function login(token: string, userId: string): string {
    const id = setAuthToken(token, 3600, `${token}-refresh`, {
      host: "https://sentry.io",
      newAccount: true,
    });
    setUserInfo({ userId, email: `${userId}@example.com` });
    return id;
  }

  beforeEach(async () => {
    await clearAuth();
    refreshedWith.length = 0;
    process.env.SENTRY_CLIENT_ID = "test-client-id";
    // Each refresh rotates the access token of whichever refresh token it got.
    globalThis.fetch = async (input, init) => {
      expect(new Request(input).url).toBe("https://sentry.io/oauth/token/");
      const body = init?.body;
      const refresh =
        body instanceof URLSearchParams ? body.get("refresh_token") : null;
      refreshedWith.push(refresh ?? "");
      return Response.json({
        access_token: `${refresh?.replace(/-refresh$/, "")}-rotated`,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: refresh,
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    refreshHooks.before = undefined;
    refreshHooks.after = undefined;
  });

  test("keeps refreshing the startup account after another process switches accounts", async () => {
    const a = login("a-token", "1");
    const b = login("b-token", "2");
    setActiveAccount(a);
    const { options } = await start([]);
    expect(options.accessToken).toBe("a-token");

    setActiveAccount(b);

    await expect(options.refreshAccessToken?.()).resolves.toBe(
      "a-token-rotated",
    );
    // A second refresh, after the first cleared the cached rows, stays on A.
    await expect(options.refreshAccessToken?.()).resolves.toBe(
      "a-token-rotated",
    );
    expect(refreshedWith).toEqual(["a-token-refresh", "a-token-refresh"]);
  });

  test("fails closed when the startup account is removed", async () => {
    const a = login("a-token", "1");
    login("b-token", "2");
    setActiveAccount(a);
    const { options } = await start([]);

    await removeAccount(a, { promoteNext: true });

    await expect(options.refreshAccessToken?.()).rejects.toThrow(
      "The account this MCP server started with is no longer available",
    );
    expect(refreshedWith).toEqual([]);
  });

  test("fails closed when another user logs in over the startup account", async () => {
    login("a-token", "1");
    const { options } = await start([]);

    // `sentry auth login --force` replaces the account's credentials in place.
    setAuthToken("c-token", 3600, "c-token-refresh", {
      host: "https://sentry.io",
    });
    setUserInfo({ userId: "3", email: "3@example.com" });

    await expect(options.refreshAccessToken?.()).rejects.toThrow(
      "The account this MCP server started with is no longer available",
    );
    expect(refreshedWith).toEqual([]);
  });

  test("pins the account whose token startup returned, even if the active account changes right after", async () => {
    const a = login("a-token", "1");
    const b = login("b-token", "2");
    setActiveAccount(a);
    refreshHooks.after = () => {
      refreshHooks.after = undefined;
      setActiveAccount(b);
    };

    const { options } = await start([]);
    expect(options.accessToken).toBe("a-token");

    await expect(options.refreshAccessToken?.()).resolves.toBe(
      "a-token-rotated",
    );
    expect(refreshedWith).toEqual(["a-token-refresh"]);
  });

  test("refuses another account's token when the startup account vanishes mid-refresh", async () => {
    const a = login("a-token", "1");
    login("b-token", "2");
    setActiveAccount(a);
    const { options } = await start([]);

    // Removed after the pin check but before the credential read, so the
    // CLI's account selection falls back to the remaining account.
    refreshHooks.before = () => removeAccount(a, { promoteNext: true });

    await expect(options.refreshAccessToken?.()).rejects.toThrow(
      "The account this MCP server started with is no longer available",
    );
  });

  test("keeps an env token after a stored login appears", async () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    process.env.SENTRY_HOST = "https://sentry.io";
    const { options } = await start([]);
    expect(options.accessToken).toBe("env-token");

    login("stored-token", "1");

    await expect(options.refreshAccessToken?.()).resolves.toBe("env-token");
  });
});

describe("startMcpServer static tokens", () => {
  test("uses --access-token without a CLI session and never refreshes it", async () => {
    await clearAuth();

    const { config, options } = await start(["--access-token=static-token"]);
    expect(options.accessToken).toBe("static-token");
    expect(options.refreshAccessToken).toBeUndefined();
    expect(config.sentryHost).toBe("sentry.io");
  });

  test("uses SENTRY_ACCESS_TOKEN without a CLI session", async () => {
    await clearAuth();
    process.env.SENTRY_ACCESS_TOKEN = "env-static-token";

    const { options } = await start([]);
    expect(options.accessToken).toBe("env-static-token");
    expect(options.refreshAccessToken).toBeUndefined();
  });

  test("prefers --access-token over SENTRY_ACCESS_TOKEN", async () => {
    process.env.SENTRY_ACCESS_TOKEN = "env-static-token";

    const { options } = await start(["--access-token", "flag-token"]);
    expect(options.accessToken).toBe("flag-token");
  });

  test("prefers a static token over the CLI session", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    const { options } = await start(["--access-token=static-token"]);
    expect(options.accessToken).toBe("static-token");
  });

  test("normalizes a padded static token", async () => {
    const { options } = await start(["--access-token=static-token\n"]);
    expect(options.accessToken).toBe("static-token");
  });

  test("rejects a malformed static token", async () => {
    const { startMcpServer } = await import("../../src/lib/mcp.js");
    await expect(
      startMcpServer(["--access-token=has a space"]),
    ).rejects.toBeInstanceOf(MalformedAuthTokenError);
    expect(served.calls).toHaveLength(0);
  });

  test("serves a static token on the self-hosted host it is configured for", async () => {
    const { config, options } = await start([
      "--access-token=static-token",
      "--host=sentry.internal:9000",
      "--insecure-http",
    ]);
    expect(options.accessToken).toBe("static-token");
    expect(config.sentryHost).toBe("sentry.internal:9000");
    expect(config.sentryProtocol).toBe("http");
  });

  test("routes SENTRY_HOST to the static token target", async () => {
    process.env.SENTRY_ACCESS_TOKEN = "env-static-token";
    process.env.SENTRY_HOST = "https://sentry.example.com";

    const { config } = await start([]);
    expect(config.sentryHost).toBe("sentry.example.com");
  });

  test("allows an org auth token on the host it was issued for", async () => {
    const token = mintSntrysToken({
      iat: 1,
      url: "https://sentry.example.com",
      org: "acme",
    });

    const { options } = await start([
      `--access-token=${token}`,
      "--host=sentry.example.com",
    ]);
    expect(options.accessToken).toBe(token);
  });

  test("refuses to send an org auth token to another host", async () => {
    const token = mintSntrysToken({
      iat: 1,
      url: "https://sentry.example.com",
      org: "acme",
    });

    const { startMcpServer } = await import("../../src/lib/mcp.js");
    await expect(
      startMcpServer([`--access-token=${token}`, "--host=evil.example.com"]),
    ).rejects.toBeInstanceOf(HostScopeError);
    expect(served.calls).toHaveLength(0);
  });
});

describe("startMcpServer .sentryclirc URLs", () => {
  /** Run from a directory whose `.sentryclirc` points at `url`. */
  async function inRcDir(url: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "mcp-start-rc-"));
    writeFileSync(join(dir, ".sentryclirc"), `[defaults]\nurl = ${url}\n`);
    rcDirs.push(dir);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    clearSentryCliRcCache();
    await applySentryCliRcEnvShim(dir);
  }

  const rcDirs: string[] = [];

  beforeEach(async () => {
    await clearAuth();
  });

  afterEach(() => {
    clearSentryCliRcCache();
    for (const dir of rcDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to send a static token to a self-hosted URL from a repo .sentryclirc", async () => {
    await inRcDir("https://evil.example.com");
    process.env.SENTRY_ACCESS_TOKEN = "env-static-token";

    const { startMcpServer } = await import("../../src/lib/mcp.js");
    await expect(startMcpServer([])).rejects.toBeInstanceOf(HostScopeError);
    await expect(
      startMcpServer(["--access-token=static-token"]),
    ).rejects.toBeInstanceOf(HostScopeError);
    expect(served.calls).toHaveLength(0);
  });

  test("serves a static token when an explicit --host overrides the rc URL", async () => {
    await inRcDir("https://evil.example.com");

    const { config } = await start([
      "--access-token=static-token",
      "--host=sentry.example.com",
    ]);
    expect(config.sentryHost).toBe("sentry.example.com");
  });

  test("serves a static token for a SaaS rc URL", async () => {
    await inRcDir("https://sentry.io");

    const { options } = await start(["--access-token=static-token"]);
    expect(options.accessToken).toBe("static-token");
  });

  test("serves an org token whose claim matches a self-hosted rc URL", async () => {
    await inRcDir("https://sentry.example.com");
    const token = mintSntrysToken({
      iat: 1,
      url: "https://sentry.example.com",
      org: "acme",
    });

    const fromFlag = await start([`--access-token=${token}`]);
    expect(fromFlag.options.accessToken).toBe(token);

    served.calls = [];
    process.env.SENTRY_ACCESS_TOKEN = token;
    const fromEnv = await start([]);
    expect(fromEnv.options.accessToken).toBe(token);
  });

  test("refuses an org token whose claim does not match the rc URL", async () => {
    await inRcDir("https://evil.example.com");
    const token = mintSntrysToken({
      iat: 1,
      url: "https://sentry.example.com",
      org: "acme",
    });

    const { startMcpServer } = await import("../../src/lib/mcp.js");
    await expect(
      startMcpServer([`--access-token=${token}`]),
    ).rejects.toBeInstanceOf(HostScopeError);
    expect(served.calls).toHaveLength(0);
  });

  test("serves a static token for an rc URL the user has logged in to", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.example.com",
    });
    await inRcDir("https://sentry.example.com");

    const { config } = await start(["--access-token=static-token"]);
    expect(config.sentryHost).toBe("sentry.example.com");
  });
});

describe("startMcpServer output flags", () => {
  test.each([["--help"], ["--version"]])(
    "prints %s to stdout without serving",
    async (flag) => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const { startMcpServer } = await import("../../src/lib/mcp.js");

      await expect(startMcpServer([flag])).resolves.toBe(false);

      expect(served.calls).toHaveLength(0);
      expect(write).toHaveBeenCalledWith(
        expect.stringMatching(/^(Usage: sentry mcp|sentry mcp \S+)/),
      );
    },
  );
});
