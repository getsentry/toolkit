import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

type CapturedOptions = {
  resolveAccessToken?: (config: unknown) => Promise<string>;
  onUpstreamUnauthorized?: (
    setAccessToken: (token: string) => void,
  ) => void | Promise<void>;
};

const captured: { options?: CapturedOptions } = {};

vi.mock("@sentry/mcp-server", () => ({
  runMcpServer: vi.fn(async (_args: string[], options: CapturedOptions) => {
    captured.options = options;
  }),
}));

useTestConfigDir("mcp-start-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

beforeEach(async () => {
  captured.options = undefined;
  await resetHostScopingState();
});

afterEach(async () => {
  await resetHostScopingState();
});

describe("startMcpServer credential wiring", () => {
  test("resolves the CLI session token for the MCP server", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    const { startMcpServer } = await import("../../src/lib/mcp.js");
    await startMcpServer([]);

    const resolve = captured.options?.resolveAccessToken;
    expect(resolve).toBeDefined();
    await expect(
      resolve?.({ sentryHost: "sentry.io", sentryProtocol: "https" }),
    ).resolves.toBe("cli-session-token");
  });

  test("refreshes and writes back a new token on upstream 401", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    const { startMcpServer } = await import("../../src/lib/mcp.js");
    await startMcpServer([]);

    // The 401 handler needs the resolved target; prime it via resolveAccessToken.
    await captured.options?.resolveAccessToken?.({
      sentryHost: "sentry.io",
      sentryProtocol: "https",
    });

    // Simulate a refreshed credential landing in the store before the handler runs.
    setAuthToken("rotated-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    let written: string | undefined;
    await captured.options?.onUpstreamUnauthorized?.((token) => {
      written = token;
    });

    expect(written).toBe("rotated-token");
  });

  test("ignores an upstream 401 before any token has been resolved", async () => {
    setAuthToken("cli-session-token", undefined, undefined, {
      host: "https://sentry.io",
    });

    const { startMcpServer } = await import("../../src/lib/mcp.js");
    await startMcpServer([]);

    let written: string | undefined;
    await captured.options?.onUpstreamUnauthorized?.((token) => {
      written = token;
    });

    expect(written).toBeUndefined();
  });
});
