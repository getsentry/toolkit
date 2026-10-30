import type { NodeOptions } from "@sentry/node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CLI_VERSION, SENTRY_CLI_DSN } from "../../../src/lib/constants.js";
import type { McpServerConfig } from "../../../src/lib/mcp/config.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

const sentry = vi.hoisted(() => ({
  init: vi.fn((_options: NodeOptions) => undefined),
}));

vi.mock("@sentry/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/node")>()),
  init: sentry.init,
}));

useTestConfigDir("mcp-telemetry-");
useEnvSandbox(["SENTRY_CLI_NO_TELEMETRY", "DO_NOT_TRACK"]);

const config: McpServerConfig = {
  sentryHost: "sentry.io",
  sentryProtocol: "https",
  agentProviderFromFlag: false,
  experimental: false,
  finalSkills: new Set(),
};

/** The options the server passed to `Sentry.init`. */
async function initOptions(
  overrides: Partial<McpServerConfig> = {},
): Promise<NodeOptions> {
  const { initMcpTelemetry } = await import("../../../src/lib/mcp/server.js");
  initMcpTelemetry({ ...config, ...overrides }, {});
  const options = sentry.init.mock.lastCall?.[0];
  if (!options) {
    throw new Error("Sentry.init was not called");
  }
  return options;
}

beforeEach(() => {
  sentry.init.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("initMcpTelemetry", () => {
  test("reports to the CLI's project when no DSN is configured", async () => {
    const options = await initOptions();
    expect(options.dsn).toBe(SENTRY_CLI_DSN);
    expect(options.enabled).toBe(true);
    expect(options.initialScope).toMatchObject({
      tags: {
        "app.server.distribution": "sentry mcp",
        "app.server.version": CLI_VERSION,
      },
    });
  });

  test("honors the CLI's telemetry opt-out", async () => {
    process.env.SENTRY_CLI_NO_TELEMETRY = "1";
    const options = await initOptions();
    expect(options.dsn).toBe(SENTRY_CLI_DSN);
    expect(options.enabled).toBe(false);
  });

  test("an explicit DSN wins and ignores the CLI opt-out", async () => {
    process.env.SENTRY_CLI_NO_TELEMETRY = "1";
    const dsn = "https://key@o1.ingest.sentry.io/1";
    const options = await initOptions({ sentryDsn: dsn });
    expect(options.dsn).toBe(dsn);
    expect(options.enabled).toBe(true);
  });

  test("tags @sentry/mcp-server installs", async () => {
    vi.stubGlobal("SENTRY_MCP_SERVER_VERSION", "1.2.3");
    vi.resetModules();
    const options = await initOptions();
    expect(options.initialScope).toMatchObject({
      tags: {
        "app.server.distribution": "@sentry/mcp-server",
        "app.server.version": "1.2.3",
      },
    });
  });
});
