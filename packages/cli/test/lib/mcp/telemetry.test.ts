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
useEnvSandbox([
  "SENTRY_CLI_NO_TELEMETRY",
  "DO_NOT_TRACK",
  "SENTRY_RELEASE",
  "SENTRY_DSN",
]);

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
  initMcpTelemetry({ ...config, ...overrides });
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
    expect(options.release).toBe(CLI_VERSION);
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

  test("an empty DSN turns telemetry off, even with SENTRY_DSN set", async () => {
    process.env.SENTRY_DSN = "https://key@o1.ingest.sentry.io/1";
    const { initMcpTelemetry } = await import("../../../src/lib/mcp/server.js");
    initMcpTelemetry({ ...config, sentryDsn: "" });
    expect(sentry.init).not.toHaveBeenCalled();
  });

  test("ignores SENTRY_RELEASE so the reported release stays ours", async () => {
    process.env.SENTRY_RELEASE = "spoofed";
    const options = await initOptions({
      sentryDsn: "https://key@o1.ingest.sentry.io/1",
    });
    expect(options.release).toBe(CLI_VERSION);
  });

  test("tags @sentry/mcp-server installs", async () => {
    const { setAppIdentity } = await import("../../../src/lib/app-identity.js");
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    const options = await initOptions();
    expect(options.initialScope).toMatchObject({
      tags: {
        "app.server.distribution": "@sentry/mcp-server",
        "app.server.version": CLI_VERSION,
      },
    });
    expect(options.release).toBe(CLI_VERSION);
  });

  test("starts without telemetry when the working directory is gone", async () => {
    const { logger } = await import("../../../src/lib/logger.js");
    const { initMcpTelemetry } = await import("../../../src/lib/mcp/server.js");
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_cwd");
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const level = logger.level;
    logger.level = 4;
    try {
      expect(() => initMcpTelemetry(config)).not.toThrow();
      expect(sentry.init).not.toHaveBeenCalled();
      expect(stderr.mock.calls.join("\n")).toContain(
        "Working directory is unavailable, starting without telemetry: ENOENT: no such file or directory, uv_cwd",
      );
    } finally {
      logger.level = level;
      stderr.mockRestore();
      cwd.mockRestore();
    }
  });
});
