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
import { parseMcpFlags } from "./mcp/parse-flags.js";

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
  serveMcpStdio: vi.fn(
    async (config: McpServerConfig, options: McpServeOptions) => {
      served.calls.push({ config, options });
    },
  ),
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

/** The command context's working directory that {@link serve} passes. */
let workingDir = process.cwd();

beforeEach(async () => {
  served.calls = [];
  workingDir = process.cwd();
  await resetHostScopingState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetHostScopingState();
});

/** Run `sentry mcp <args>` up to the (mocked) stdio server. */
async function serve(args: string[]): Promise<void> {
  const { serveMcp } = await import("../../src/lib/mcp.js");
  await serveMcp(await parseMcpFlags(args), workingDir);
}

async function start(args: string[]): Promise<Served> {
  await serve(args);
  expect(served.calls).toHaveLength(1);
  const [call] = served.calls;
  if (!call) {
    throw new Error("serveMcpStdio was not called");
  }
  return call;
}

describe("serveMcp credential wiring", () => {
  test("serves with the CLI session token", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    const { options } = await start([]);
    expect(options.accessToken).toBe("cli-session-token");
    expect(options.refreshAccessToken).toBeDefined();
  });

  test("serves SENTRY_AUTH_TOKEN over a stored login", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    process.env.SENTRY_AUTH_TOKEN = "env-token";

    const { options } = await start([]);
    expect(options.accessToken).toBe("env-token");
    // Refreshes stay on the env token, and the process env is left alone.
    await expect(options.refreshAccessToken?.()).resolves.toBe("env-token");
    expect(process.env.SENTRY_FORCE_ENV_TOKEN).toBeUndefined();
  });

  test("serves the legacy SENTRY_TOKEN over a stored login", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    process.env.SENTRY_TOKEN = "legacy-env-token";

    const { options } = await start([]);
    expect(options.accessToken).toBe("legacy-env-token");
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

describe("serveMcp account pinning", () => {
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

describe("serveMcp deprecated --access-token", () => {
  const output = { stderr: [] as string[], stdout: [] as string[] };

  beforeEach(async () => {
    const { resetDeprecationHintForTesting } =
      await import("../../src/lib/mcp.js");
    resetDeprecationHintForTesting();
    output.stderr = [];
    output.stdout = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.stdout.push(String(chunk));
      return true;
    });
  });

  test("serves --access-token as a forced SENTRY_AUTH_TOKEN", async () => {
    await clearAuth();

    const { config, options } = await start(["--access-token=static-token"]);
    expect(options.accessToken).toBe("static-token");
    expect(config.sentryHost).toBe("sentry.io");
    // The env-token path: a refresh re-reads the same env token.
    await expect(options.refreshAccessToken?.()).resolves.toBe("static-token");
    // Mapped in an env copy; the process environment is left alone.
    expect(process.env.SENTRY_AUTH_TOKEN).toBeUndefined();
    expect(process.env.SENTRY_FORCE_ENV_TOKEN).toBeUndefined();
  });

  test("serves the same as SENTRY_AUTH_TOKEN with SENTRY_FORCE_ENV_TOKEN=1", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    process.env.SENTRY_FORCE_ENV_TOKEN = "1";
    const fromEnv = await start([]);
    const refreshedFromEnv = await fromEnv.options.refreshAccessToken?.();
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_FORCE_ENV_TOKEN;

    served.calls = [];
    const fromFlag = await start(["--access-token=env-token"]);
    expect(fromFlag.options.accessToken).toBe(fromEnv.options.accessToken);
    expect(refreshedFromEnv).toBe("env-token");
    await expect(fromFlag.options.refreshAccessToken?.()).resolves.toBe(
      refreshedFromEnv,
    );
  });

  test("uses SENTRY_ACCESS_TOKEN without a CLI session", async () => {
    await clearAuth();
    process.env.SENTRY_ACCESS_TOKEN = "env-static-token";

    const { options } = await start([]);
    expect(options.accessToken).toBe("env-static-token");
  });

  test("prefers --access-token over SENTRY_ACCESS_TOKEN", async () => {
    process.env.SENTRY_ACCESS_TOKEN = "env-static-token";

    const { options } = await start(["--access-token", "flag-token"]);
    expect(options.accessToken).toBe("flag-token");
  });

  test("overrides a stored login, before and after startup", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    const { options } = await start(["--access-token=static-token"]);
    expect(options.accessToken).toBe("static-token");

    setAuthToken("other-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    await expect(options.refreshAccessToken?.()).resolves.toBe("static-token");
  });

  test("overrides SENTRY_AUTH_TOKEN and SENTRY_TOKEN", async () => {
    process.env.SENTRY_AUTH_TOKEN = "env-auth-token";
    process.env.SENTRY_TOKEN = "env-legacy-token";

    const { options } = await start(["--access-token=flag-token"]);
    expect(options.accessToken).toBe("flag-token");
    await expect(options.refreshAccessToken?.()).resolves.toBe("flag-token");
  });

  test("prints a one-time deprecation hint to stderr, never stdout or the token", async () => {
    await start(["--access-token=sntryu_secret-value"]);
    served.calls = [];
    await start(["--access-token=sntryu_secret-value"]);

    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      "Deprecation warning: --access-token is deprecated; set SENTRY_AUTH_TOKEN instead.\n",
    ]);
    expect(output.stderr.join("")).not.toContain("secret-value");
  });

  test("names SENTRY_ACCESS_TOKEN in its hint when that is the source", async () => {
    process.env.SENTRY_ACCESS_TOKEN = "env-static-token";
    await start([]);

    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("")).toContain(
      "SENTRY_ACCESS_TOKEN is deprecated; set SENTRY_AUTH_TOKEN",
    );
    expect(output.stderr.join("")).not.toContain("env-static-token");
  });

  test("warns about deprecated scope flags on stderr", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    const { config } = await start(["--organization-slug=acme"]);
    expect(config.organizationSlug).toBe("acme");
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      "Deprecation warning: --organization-slug is deprecated; use --org instead.\n",
    ]);
  });

  test("prints no hint without a deprecated token", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    await start([]);
    expect(output.stderr).toEqual([]);
  });

  test("keeps the token out of errors", async () => {
    const malformed = "sntryu_secret has a space";
    const malformedError = await serve([`--access-token=${malformed}`]).catch(
      (error: unknown) => error,
    );
    expect(malformedError).toBeInstanceOf(MalformedAuthTokenError);
    expect(String(malformedError)).not.toContain("secret");

    const orgToken = mintSntrysToken({
      iat: 1,
      url: "https://sentry.example.com",
      org: "acme",
    });
    const hostError = await serve([
      `--access-token=${orgToken}`,
      "--host=evil.example.com",
    ]).catch((error: unknown) => error);
    expect(hostError).toBeInstanceOf(HostScopeError);
    expect(String(hostError)).not.toContain(orgToken);
    expect(output.stderr.join("")).not.toContain(orgToken);
    expect(served.calls).toHaveLength(0);
  });

  test("normalizes a padded static token", async () => {
    const { options } = await start(["--access-token=static-token\n"]);
    expect(options.accessToken).toBe("static-token");
  });

  test("rejects a malformed static token", async () => {
    await expect(serve(["--access-token=has a space"])).rejects.toBeInstanceOf(
      MalformedAuthTokenError,
    );
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

    await expect(
      serve([`--access-token=${token}`, "--host=evil.example.com"]),
    ).rejects.toBeInstanceOf(HostScopeError);
    expect(served.calls).toHaveLength(0);
  });
});

describe("serveMcp .sentryclirc URLs", () => {
  /** Run from a directory whose `.sentryclirc` points at `url`. */
  async function inRcDir(url: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "mcp-start-rc-"));
    writeFileSync(join(dir, ".sentryclirc"), `[defaults]\nurl = ${url}\n`);
    rcDirs.push(dir);
    workingDir = dir;
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

    await expect(serve([])).rejects.toBeInstanceOf(HostScopeError);
    await expect(serve(["--access-token=static-token"])).rejects.toBeInstanceOf(
      HostScopeError,
    );
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

    await expect(serve([`--access-token=${token}`])).rejects.toBeInstanceOf(
      HostScopeError,
    );
    expect(served.calls).toHaveLength(0);
  });

  test("starts when the working directory has been deleted", async () => {
    // `process.cwd()` throws ENOENT once the directory is removed; the command
    // context falls back to `PWD`, which names a directory that is gone.
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT" });
    });
    workingDir = join(tmpdir(), "mcp-start-deleted-worktree");

    const { options } = await start(["--access-token=static-token"]);
    expect(options.accessToken).toBe("static-token");
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
