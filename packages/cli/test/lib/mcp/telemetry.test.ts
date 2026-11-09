import { createEnvelope, type Envelope } from "@sentry/core";
import type { NodeOptions } from "@sentry/node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CLI_VERSION, SENTRY_CLI_DSN } from "../../../src/lib/constants.js";
import type { McpServerConfig } from "../../../src/lib/mcp/config.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";
import {
  closeIngestServers,
  noop,
  startMockIngest,
  startRefusedIngest,
} from "../telemetry/ingest-servers.js";

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
  "DEFAULT_SENTRY_DSN",
]);

const config: McpServerConfig = {
  sentryHost: "sentry.io",
  sentryProtocol: "https",
  agentProviderFromFlag: false,
  experimental: false,
  finalSkills: new Set(),
  disabledSkills: [],
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

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  await closeIngestServers();
});

function eventEnvelope(id: string): Envelope {
  return createEnvelope({ event_id: id }, [
    [{ type: "event" }, { event_id: id, message: "hi" }],
  ] as never);
}

/**
 * The database and store modules the server will load (modules are reset
 * after each test), with the database already open. Opening it with
 * telemetry on `require`s the telemetry module, which fails under vitest.
 */
async function openStore() {
  const { getDatabase } = await import("../../../src/lib/db/index.js");
  const { createEnvelopeStore } =
    await import("../../../src/lib/telemetry/offline-store.js");
  const optedOut = process.env.SENTRY_CLI_NO_TELEMETRY;
  process.env.SENTRY_CLI_NO_TELEMETRY = "1";
  getDatabase();
  if (optedOut === undefined) {
    delete process.env.SENTRY_CLI_NO_TELEMETRY;
  }
  return {
    store: createEnvelopeStore(),
    storedCount: () =>
      (
        getDatabase()
          .query("SELECT COUNT(*) AS count FROM telemetry_envelope_queue")
          .get() as { count: number }
      ).count,
  };
}

/** The transport the server's `Sentry.init` options build for `url`. */
function buildTransport(options: NodeOptions, url: string) {
  if (!options.transport) {
    throw new Error("Sentry.init got no transport");
  }
  return options.transport({ url, recordDroppedEvent: noop } as never);
}

describe("initMcpTelemetry", () => {
  test("reports to the CLI's project", async () => {
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

  test.each(["SENTRY_CLI_NO_TELEMETRY", "DO_NOT_TRACK"])(
    "honors the CLI's telemetry opt-out (%s)",
    async (name) => {
      process.env[name] = "1";
      const options = await initOptions();
      expect(options.dsn).toBe(SENTRY_CLI_DSN);
      expect(options.enabled).toBe(false);
    },
  );

  // A server started from a project shell or IDE inherits the app's DSN.
  test("ignores SENTRY_DSN and DEFAULT_SENTRY_DSN from the environment", async () => {
    const appDsn = "https://key@o1.ingest.sentry.io/1";
    process.env.SENTRY_DSN = appDsn;
    process.env.DEFAULT_SENTRY_DSN = appDsn;
    const options = await initOptions();
    expect(options.dsn).toBe(SENTRY_CLI_DSN);
    expect(options.enabled).toBe(true);
  });

  test("ignores SENTRY_RELEASE so the reported release stays ours", async () => {
    process.env.SENTRY_RELEASE = "spoofed";
    const options = await initOptions();
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

  test("stores telemetry that fails to send", async () => {
    const { storedCount } = await openStore();
    const { url } = await startRefusedIngest();
    const transport = buildTransport(await initOptions(), url);

    await expect(transport.send(eventEnvelope("a"))).resolves.toEqual({});

    expect(storedCount()).toBe(1);
  });

  test("sends what earlier runs stored at startup", async () => {
    const { store, storedCount } = await openStore();
    await store.push(eventEnvelope("stored"));
    const ingest = await startMockIngest(() => ({ statusCode: 200 }));
    // The real `init` builds the transport; the mock does the same so the
    // server's startup drain has one.
    sentry.init.mockImplementationOnce((options) => {
      buildTransport(options, ingest.url);
    });

    await initOptions();

    await vi.waitFor(() => expect(ingest.captures).toHaveLength(1));
    expect(storedCount()).toBe(0);
  });

  test("opting out clears stored telemetry", async () => {
    const { store, storedCount } = await openStore();
    await store.push(eventEnvelope("stored"));
    expect(storedCount()).toBe(1);
    process.env.SENTRY_CLI_NO_TELEMETRY = "1";

    await initOptions();

    expect(storedCount()).toBe(0);
  });
});
