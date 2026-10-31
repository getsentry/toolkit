import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearAuth, setAuthToken } from "../../src/lib/db/auth.js";
import {
  AuthError,
  HostScopeError,
  MalformedAuthTokenError,
} from "../../src/lib/errors.js";
import {
  resolveCliMcpCredential,
  withConfiguredTarget,
} from "../../src/lib/mcp.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";
import { parseMcpFlags } from "./mcp/parse-flags.js";

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

async function resolveCliMcpAccessToken(
  config: Parameters<typeof resolveCliMcpCredential>[0],
): Promise<string> {
  return (await resolveCliMcpCredential(config)).token;
}

describe("resolveCliMcpCredential", () => {
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
});

/** Target flags `sentry mcp <args>` hands the server, as `--host`/`--url`. */
async function targetFlags(args: string[], sentryUrl?: string) {
  const flags = withConfiguredTarget(await parseMcpFlags(args), sentryUrl);
  return {
    host: flags.host,
    url: flags.url,
    insecureHttp: flags["insecure-http"],
  };
}

describe("withConfiguredTarget", () => {
  test("uses SENTRY_HOST before SENTRY_URL for self-hosted instances", async () => {
    process.env.SENTRY_HOST = "http://sentry.internal:9000";
    process.env.SENTRY_URL = "https://sentry.example.com";

    expect(await targetFlags([])).toEqual({
      host: "sentry.internal:9000",
      url: undefined,
      insecureHttp: true,
    });
  });

  test("translates an insecure CLI URL into MCP host flags", async () => {
    expect(await targetFlags([], "http://sentry.internal:9000")).toEqual({
      host: "sentry.internal:9000",
      url: undefined,
      insecureHttp: true,
    });
  });

  test("translates a secure SENTRY_HOST origin into a host flag", async () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";

    // A documented `SENTRY_HOST=https://…` export must not reach the MCP
    // config raw (it rejects origins); it becomes a plain --host instead.
    expect(await targetFlags([])).toEqual({
      host: "sentry.example.com",
      url: undefined,
      insecureHttp: false,
    });
  });

  test("preserves an explicit MCP target over the CLI URL", async () => {
    expect(
      await targetFlags(["--host=sentry.example.com"], "http://localhost:9000"),
    ).toEqual({
      host: "sentry.example.com",
      url: undefined,
      insecureHttp: false,
    });
  });

  test("keeps an explicit --host --insecure-http over the CLI URL", async () => {
    // The CLI http URL must not sneak in an extra --host that MCP would
    // prefer over the user's explicit insecure target.
    expect(
      await targetFlags(
        ["--host=localhost:9000", "--insecure-http"],
        "http://sentry.example.com",
      ),
    ).toEqual({ host: "localhost:9000", url: undefined, insecureHttp: true });
  });
});
