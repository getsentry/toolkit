import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearAuth, setAuthToken } from "../../src/lib/db/auth.js";
import {
  AuthError,
  HostScopeError,
  MalformedAuthTokenError,
} from "../../src/lib/errors.js";
import {
  prepareMcpServerArgs,
  resolveCliMcpAccessToken,
  startMcpServer,
} from "../../src/lib/mcp.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

useTestConfigDir("mcp-auth-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

beforeEach(async () => {
  await resetHostScopingState();
});

afterEach(async () => {
  await resetHostScopingState();
});

describe("resolveCliMcpAccessToken", () => {
  test("returns the active CLI session token for its scoped host", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    await expect(
      resolveCliMcpAccessToken({
        sentryHost: "sentry.io",
        sentryProtocol: "https",
      }),
    ).resolves.toBe("cli-session-token");
  });

  test("refuses to use a CLI token for another Sentry host", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.example.com",
    });

    await expect(
      resolveCliMcpAccessToken({
        sentryHost: "sentry.io",
        sentryProtocol: "https",
      }),
    ).rejects.toBeInstanceOf(HostScopeError);
  });

  test("directs an unauthenticated user to the CLI login flow", async () => {
    await clearAuth();

    await expect(
      resolveCliMcpAccessToken({
        sentryHost: "sentry.io",
        sentryProtocol: "https",
      }),
    ).rejects.toThrow(new AuthError("not_authenticated"));
  });

  test("normalizes a malformed env token instead of forwarding it", async () => {
    await clearAuth();
    // Env tokens skip the stored-row normalization, so a pasted newline would
    // otherwise reach the MCP server as a broken Authorization header.
    process.env.SENTRY_AUTH_TOKEN = "env-token\n";
    process.env.SENTRY_HOST = "https://sentry.io";

    await expect(
      resolveCliMcpAccessToken({
        sentryHost: "sentry.io",
        sentryProtocol: "https",
      }),
    ).resolves.toBe("env-token");
  });

  test("rejects an env token with embedded invalid characters", async () => {
    await clearAuth();
    process.env.SENTRY_AUTH_TOKEN = "env token with space";
    process.env.SENTRY_HOST = "https://sentry.io";

    await expect(
      resolveCliMcpAccessToken({
        sentryHost: "sentry.io",
        sentryProtocol: "https",
      }),
    ).rejects.toBeInstanceOf(MalformedAuthTokenError);
  });

  test("does not expose a second MCP authentication flow", async () => {
    await expect(startMcpServer(["auth", "login"])).rejects.toThrow(
      "Use `sentry auth` to manage credentials for `sentry mcp`.",
    );
  });
});

describe("prepareMcpServerArgs", () => {
  test("uses SENTRY_HOST before SENTRY_URL for self-hosted instances", () => {
    process.env.SENTRY_HOST = "http://sentry.internal:9000";
    process.env.SENTRY_URL = "https://sentry.example.com";

    expect(prepareMcpServerArgs([])).toEqual([
      "--host=sentry.internal:9000",
      "--insecure-http",
    ]);
  });

  test("translates an insecure CLI URL into MCP host flags", () => {
    expect(prepareMcpServerArgs([], "http://sentry.internal:9000")).toEqual([
      "--host=sentry.internal:9000",
      "--insecure-http",
    ]);
  });

  test("translates a secure SENTRY_HOST origin into a host flag", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";

    // A documented `SENTRY_HOST=https://…` export must not reach the MCP
    // parser raw (it rejects origins); it becomes a plain --host instead.
    expect(prepareMcpServerArgs([])).toEqual(["--host=sentry.example.com"]);
  });

  test("preserves an explicit MCP target over the CLI URL", () => {
    expect(
      prepareMcpServerArgs(
        ["--host=sentry.example.com"],
        "http://localhost:9000",
      ),
    ).toEqual(["--host=sentry.example.com"]);
  });

  test("keeps an explicit --host --insecure-http over the CLI URL", () => {
    // The CLI http URL must not sneak in an extra --host that MCP would
    // prefer over the user's explicit insecure target.
    expect(
      prepareMcpServerArgs(
        ["--host=localhost:9000", "--insecure-http"],
        "http://sentry.example.com",
      ),
    ).toEqual(["--host=localhost:9000", "--insecure-http"]);
  });
});
