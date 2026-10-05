import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearAuth, setAuthToken } from "../../src/lib/db/auth.js";
import { AuthError, HostScopeError } from "../../src/lib/errors.js";
import { resolveCliMcpAccessToken, startMcpServer } from "../../src/lib/mcp.js";
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
      })
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
      })
    ).rejects.toBeInstanceOf(HostScopeError);
  });

  test("directs an unauthenticated user to the CLI login flow", async () => {
    await clearAuth();

    await expect(
      resolveCliMcpAccessToken({
        sentryHost: "sentry.io",
        sentryProtocol: "https",
      })
    ).rejects.toThrow(new AuthError("not_authenticated"));
  });

  test("does not expose a second MCP authentication flow", async () => {
    await expect(startMcpServer(["auth", "login"])).rejects.toThrow(
      "Use `sentry auth` to manage credentials for `sentry mcp`."
    );
  });
});
