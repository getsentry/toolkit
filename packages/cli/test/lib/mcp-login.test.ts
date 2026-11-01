/**
 * `sentry mcp`'s login fallback: with no credential in a TTY, the OAuth device
 * flow targets the same Sentry instance the MCP server serves, including one
 * picked with the deprecated `--host`/`--url` flags.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { HostScopeError } from "../../src/lib/errors.js";
import { resolveEffectiveLoginHost } from "../../src/lib/login-host-guard.js";
import type { McpServerConfig } from "../../src/lib/mcp/config.js";
import type { McpServeOptions } from "../../src/lib/mcp/server.js";
import { registerLoginTrustAnchor } from "../../src/lib/token-host.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";
import { parseMcpFlags } from "./mcp/parse-flags.js";

type Served = { config: McpServerConfig; options: McpServeOptions };

const state = vi.hoisted(() => ({
  served: [] as Served[],
  /** The host each login ran against. */
  loginHosts: [] as string[],
}));

vi.mock("node:tty", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:tty")>()),
  isatty: () => true,
}));

vi.mock("../../src/lib/interactive-login.js", () => ({
  runInteractiveLogin: vi.fn(async () => {
    const host = resolveEffectiveLoginHost();
    state.loginHosts.push(host);
    setAuthToken("login-token", undefined, undefined, { host });
    return { method: "oauth" };
  }),
}));

vi.mock("../../src/lib/mcp/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/mcp/server.js")>()),
  serveMcpStdio: vi.fn(
    async (config: McpServerConfig, options: McpServeOptions) => {
      state.served.push({ config, options });
    },
  ),
}));

useTestConfigDir("mcp-login-");
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
  state.served = [];
  state.loginHosts = [];
  await resetHostScopingState();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetHostScopingState();
});

async function serve(args: string[]): Promise<void> {
  const { serveMcp } = await import("../../src/lib/mcp.js");
  await serveMcp(await parseMcpFlags(args), process.cwd());
}

describe("serveMcp login fallback", () => {
  test("logs in to SaaS without a target", async () => {
    await serve([]);
    expect(state.loginHosts).toEqual(["https://sentry.io"]);
    expect(state.served[0]?.options.accessToken).toBe("login-token");
  });

  test("logs in to the --host target", async () => {
    registerLoginTrustAnchor("https://sentry.example.com");

    await serve(["--host=sentry.example.com"]);
    expect(state.loginHosts).toEqual(["https://sentry.example.com"]);
    expect(state.served[0]?.config.sentryHost).toBe("sentry.example.com");
    expect(state.served[0]?.options.accessToken).toBe("login-token");
  });

  test("logs in to the --url target", async () => {
    registerLoginTrustAnchor("https://sentry.example.com");

    await serve(["--url=https://sentry.example.com"]);
    expect(state.loginHosts).toEqual(["https://sentry.example.com"]);
    expect(state.served[0]?.options.accessToken).toBe("login-token");
  });

  test("logs in to a plain-HTTP --host target", async () => {
    registerLoginTrustAnchor("http://sentry.internal:9000");

    await serve(["--host=sentry.internal:9000", "--insecure-http"]);
    expect(state.loginHosts).toEqual(["http://sentry.internal:9000"]);
    expect(state.served[0]?.config.sentryProtocol).toBe("http");
    expect(state.served[0]?.options.accessToken).toBe("login-token");
  });

  test("logs in over plain HTTP for SENTRY_HOST with --insecure-http", async () => {
    registerLoginTrustAnchor("http://sentry.internal:9000");
    process.env.SENTRY_HOST = "sentry.internal:9000";

    await serve(["--insecure-http"]);
    expect(state.loginHosts).toEqual(["http://sentry.internal:9000"]);
    expect(state.served[0]?.config.sentryProtocol).toBe("http");
  });

  test("refuses to log in to an unconfirmed --host target", async () => {
    await expect(serve(["--host=sentry.example.com"])).rejects.toBeInstanceOf(
      HostScopeError,
    );
    // Not a SaaS login that the host check then rejects.
    expect(state.loginHosts).toEqual([]);
    expect(state.served).toEqual([]);
  });
});
