/**
 * Telemetry Exit E2E Tests
 *
 * Runs the npm bundle with telemetry on against a local mock ingest server.
 * `test/fixtures/ingest-redirect.cjs` sends the CLI's ingest requests to the
 * mock, so no test sends telemetry to Sentry. The SEA binary ignores
 * `--require` and `NODE_OPTIONS`, so these tests always use the bundle.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { BUNDLE_BIN_PATH, ensureBundleBuilt } from "./bundle-setup.js";

const PRELOAD_PATH = join(
  import.meta.dirname,
  "../fixtures/ingest-redirect.cjs",
);

/** Longer than any exit wait the CLI allows, much shorter than a hang. */
const HANG_TIMEOUT_MS = 15_000;

/** `release finalize` without auth exits with this code before any API call. */
const NOT_AUTHENTICATED_EXIT_CODE = 10;

type ReceivedEnvelope = {
  types: string[];
  /** True when the mock had already answered another request. */
  afterFirstResponse: boolean;
};

type MockIngest = {
  port: number;
  envelopes: ReceivedEnvelope[];
  close: () => Promise<void>;
};

type CliRun = {
  exitCode: number | null;
  hung: boolean;
};

function noop(): void {
  // Intentionally empty — absorbs async spawn errors
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  if (encoding === "zstd" && zlib.zstdDecompressSync) {
    return zlib.zstdDecompressSync(body);
  }
  if (encoding === "gzip") {
    return zlib.gunzipSync(body);
  }
  return body;
}

/** Item types of an envelope: lines alternate item header and payload. */
function envelopeItemTypes(body: Buffer): string[] {
  const lines = body.toString("utf8").split("\n").slice(1);
  const types: string[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const header = lines[i];
    if (header) {
      types.push((JSON.parse(header) as { type: string }).type);
    }
  }
  return types;
}

/**
 * Start a mock ingest server that answers `200 {}` after `delayMs`, or never
 * when `delayMs` is `null`. With `stallBody`, it sends the headers and part of
 * the body, then keeps the connection open.
 */
async function startMockIngest(
  delayMs: number | null,
  { stallBody = false } = {},
): Promise<MockIngest> {
  const envelopes: ReceivedEnvelope[] = [];
  let responses = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = decodeBody(
        Buffer.concat(chunks),
        req.headers["content-encoding"],
      );
      envelopes.push({
        types: envelopeItemTypes(body),
        afterFirstResponse: responses > 0,
      });
      if (delayMs === null) {
        return;
      }
      setTimeout(() => {
        responses += 1;
        res.writeHead(200, { "content-type": "application/json" });
        if (stallBody) {
          res.write("{");
        } else {
          res.end("{}");
        }
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    envelopes,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function cliEnv(
  ingest: MockIngest,
  telemetry: boolean,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MOCK_INGEST_PORT: String(ingest.port),
    SENTRY_CLI_NO_UPDATE_CHECK: "1",
  };
  // The CLI disables its force exit under NODE_ENV=test.
  delete env.NODE_ENV;
  delete env.SENTRY_AUTH_TOKEN;
  delete env.SENTRY_TOKEN;
  delete env.DO_NOT_TRACK;
  if (telemetry) {
    delete env.SENTRY_CLI_NO_TELEMETRY;
  } else {
    env.SENTRY_CLI_NO_TELEMETRY = "1";
  }
  return env;
}

async function runCli(
  ingest: MockIngest,
  args: string[],
  { telemetry = true } = {},
): Promise<CliRun> {
  const proc = spawn(
    process.execPath,
    ["--require", PRELOAD_PATH, BUNDLE_BIN_PATH, ...args],
    { env: cliEnv(ingest, telemetry), stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.on("error", noop);
  proc.stdout.resume();
  proc.stderr.resume();

  let hung = false;
  const killTimer = setTimeout(() => {
    hung = true;
    proc.kill("SIGKILL");
  }, HANG_TIMEOUT_MS);
  const exitCode = await new Promise<number | null>((resolve) =>
    proc.on("close", (code) => resolve(code)),
  );
  clearTimeout(killTimer);
  return { exitCode, hung };
}

describe("telemetry at exit", () => {
  let ingest: MockIngest | undefined;

  beforeAll(async () => {
    await ensureBundleBuilt();
  }, 120_000); // Cold CI builds include the MCP runtime dependencies

  afterEach(async () => {
    await ingest?.close();
    ingest = undefined;
  });

  test("sends every exit envelope in one round trip", async () => {
    // Longer than the old 100 ms macOS force exit, so a second round trip
    // loses data there and is visible in the arrival order everywhere.
    ingest = await startMockIngest(300);

    const run = await runCli(ingest, ["release", "finalize", "1.0.0"]);

    expect(run.hung).toBe(false);
    expect(run.exitCode).toBe(NOT_AUTHENTICATED_EXIT_CODE);
    const types = ingest.envelopes.flatMap((envelope) => envelope.types);
    expect(types).toEqual(
      expect.arrayContaining(["transaction", "session", "trace_metric"]),
    );
    expect(
      ingest.envelopes.filter((envelope) => envelope.afterFirstResponse),
    ).toEqual([]);
  }, 30_000);

  test("exits when ingest never answers", async () => {
    ingest = await startMockIngest(null);

    const run = await runCli(ingest, ["release", "finalize", "1.0.0"]);

    expect(run.hung).toBe(false);
    expect(run.exitCode).toBe(NOT_AUTHENTICATED_EXIT_CODE);
    expect(ingest.envelopes.flatMap((envelope) => envelope.types)).toEqual(
      expect.arrayContaining(["transaction", "session"]),
    );
  }, 30_000);

  test("exits when an ingest response stalls after its headers", async () => {
    ingest = await startMockIngest(0, { stallBody: true });

    const run = await runCli(ingest, ["release", "finalize", "1.0.0"]);

    expect(run.hung).toBe(false);
    expect(run.exitCode).toBe(NOT_AUTHENTICATED_EXIT_CODE);
  }, 30_000);

  test("process exits without waiting for flush timeout", async () => {
    ingest = await startMockIngest(0);

    const disabledStart = performance.now();
    const disabled = await runCli(ingest, ["--version"], { telemetry: false });
    const disabledDuration = performance.now() - disabledStart;

    const enabledStart = performance.now();
    const enabled = await runCli(ingest, ["--version"]);
    const enabledDuration = performance.now() - enabledStart;

    expect(disabled.exitCode).toBe(0);
    expect(enabled.exitCode).toBe(0);

    // Allow 1000ms overhead for Sentry init + the mock round trip + CI
    // scheduling jitter, but NOT the old 3000ms+ timeout behavior.
    expect(enabledDuration).toBeLessThan(disabledDuration * 1.5 + 1000);
    expect(enabledDuration).toBeLessThan(2000);
  }, 30_000);
});
