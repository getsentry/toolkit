import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearAuth, setAuthToken } from "../../src/lib/db/auth.js";
import {
  HostScopeError,
  MalformedAuthTokenError,
} from "../../src/lib/errors.js";
import type { McpServerConfig } from "../../src/lib/mcp/config.js";
import type { McpServeOptions } from "../../src/lib/mcp/server.js";
import {
  mintSntrysToken,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

type Served = { config: McpServerConfig; options: McpServeOptions };

const served: { calls: Served[] } = { calls: [] };

vi.mock("../../src/lib/mcp/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/mcp/server.js")>()),
  serveMcpStdio: vi.fn((config: McpServerConfig, options: McpServeOptions) => {
    served.calls.push({ config, options });
  }),
}));

useTestConfigDir("mcp-start-");
useEnvSandbox([
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
  await startMcpServer(args);
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

describe("startMcpServer output flags", () => {
  test.each([["--help"], ["--version"]])(
    "prints %s to stdout without serving",
    async (flag) => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const { startMcpServer } = await import("../../src/lib/mcp.js");

      await startMcpServer([flag]);

      expect(served.calls).toHaveLength(0);
      expect(write).toHaveBeenCalledWith(
        expect.stringMatching(/^(Usage: sentry mcp|sentry mcp \S+)/),
      );
    },
  );
});
