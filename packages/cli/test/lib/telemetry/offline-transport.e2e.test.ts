/**
 * E2E tests for the transport that stores telemetry it fails to send.
 *
 * Runs the real zstd transport (with a short request deadline) and the real
 * SQLite store against local ingest stand-ins: one that refuses connections,
 * one that stalls after connecting, and one that answers. Each "run" builds a
 * fresh transport, like a new CLI process.
 */

import { brotliDecompressSync } from "node:zlib";
import { createEnvelope, type Envelope, parseEnvelope } from "@sentry/core";
import { afterEach, describe, expect, test } from "vitest";
import { getDatabase } from "../../../src/lib/db/index.js";
import { makeStoringTransport } from "../../../src/lib/telemetry/offline-transport.js";
import { makeCompressedTransport } from "../../../src/lib/telemetry/zstd-transport.js";
import { useTestConfigDir } from "../../helpers.js";
import {
  closeIngestServers,
  noop,
  startMockIngest,
  startRefusedIngest,
  startStalledIngest,
} from "./ingest-servers.js";

const DEADLINE_MS = 300;

function eventEnvelope(id: string): Envelope {
  return createEnvelope({ event_id: id, sent_at: "2026-01-01T00:00:00Z" }, [
    [{ type: "event" }, { event_id: id, message: "hi" }],
  ] as never);
}

/** A transport for one CLI run, with the request deadline shortened. */
function runTransport(url: string) {
  return makeStoringTransport({ url, recordDroppedEvent: noop }, (options) =>
    makeCompressedTransport(options, DEADLINE_MS),
  );
}

function storedEventIds(): string[] {
  const rows = getDatabase()
    .query(
      "SELECT envelope FROM telemetry_envelope_queue ORDER BY created_at, id",
    )
    .all() as { envelope: Uint8Array }[];
  return rows.map(
    (row) =>
      parseEnvelope(brotliDecompressSync(row.envelope))[0].event_id as string,
  );
}

/** Event IDs in the bodies a mock ingest received (bodies are small, so uncompressed). */
function deliveredEventIds(captures: { body: Buffer }[]): string[] {
  return captures.map(
    (capture) =>
      JSON.parse(capture.body.toString().split("\n")[0] as string).event_id,
  );
}

describe("makeStoringTransport (e2e)", () => {
  useTestConfigDir("telemetry-offline-");
  afterEach(closeIngestServers);

  test("stores an envelope when ingest refuses the connection", async () => {
    const { url } = await startRefusedIngest();
    const transport = runTransport(url);

    await expect(transport.send(eventEnvelope("a"))).resolves.toEqual({});

    expect(storedEventIds()).toEqual(["a"]);
  });

  test("stores an envelope that times out, then skips the network", async () => {
    const ingest = await startStalledIngest();
    const transport = runTransport(ingest.url);

    const started = performance.now();
    await transport.send(eventEnvelope("a"));
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      DEADLINE_MS - 50,
    );
    expect(ingest.connections()).toBe(1);

    const later = performance.now();
    await transport.send(eventEnvelope("b"));
    await transport.send(eventEnvelope("c"));
    expect(performance.now() - later).toBeLessThan(DEADLINE_MS / 2);
    expect(ingest.connections()).toBe(1);

    expect(storedEventIds()).toEqual(["a", "b", "c"]);
  });

  test("sends in flight before the first timeout all finish within one deadline", async () => {
    const ingest = await startStalledIngest();
    const transport = runTransport(ingest.url);

    const started = performance.now();
    const first = transport.send(eventEnvelope("a"));
    const second = transport.send(eventEnvelope("b"));
    await Promise.all([first, second]);
    await transport.send(eventEnvelope("c"));
    await transport.flush(5000);

    expect(performance.now() - started).toBeLessThan(DEADLINE_MS * 1.8);
    expect(storedEventIds().sort()).toEqual(["a", "b", "c"]);
  });

  test("a later run with ingest healthy delivers what an earlier run stored", async () => {
    const down = await startRefusedIngest();
    const firstRun = runTransport(down.url);
    await firstRun.send(eventEnvelope("a"));
    await firstRun.send(eventEnvelope("b"));
    expect(storedEventIds()).toEqual(["a", "b"]);

    const ingest = await startMockIngest(() => ({ statusCode: 200 }));
    const secondRun = runTransport(ingest.url);
    secondRun.sendStored(10);
    await secondRun.flush(5000);

    expect(deliveredEventIds(ingest.captures).sort()).toEqual(["a", "b"]);
    expect(storedEventIds()).toEqual([]);
    const header = JSON.parse(
      ingest.captures[0]?.body.toString().split("\n")[0] as string,
    );
    expect(Date.parse(header.sent_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("a run sends at most the requested number of stored envelopes", async () => {
    const down = await startRefusedIngest();
    const firstRun = runTransport(down.url);
    for (const id of ["a", "b", "c"]) {
      await firstRun.send(eventEnvelope(id));
    }

    const ingest = await startMockIngest(() => ({ statusCode: 200 }));
    const secondRun = runTransport(ingest.url);
    secondRun.sendStored(2);
    await secondRun.flush(5000);

    expect(deliveredEventIds(ingest.captures).sort()).toEqual(["a", "b"]);
    expect(storedEventIds()).toEqual(["c"]);
  });

  test("stored envelopes that fail again go back to the store", async () => {
    const down = await startRefusedIngest();
    await runTransport(down.url).send(eventEnvelope("a"));

    const stillDown = runTransport(down.url);
    stillDown.sendStored(10);
    await stillDown.flush(5000);
    // The failed resend stores the envelope after the request settles.
    await new Promise((resolve) => setImmediate(resolve));

    expect(storedEventIds()).toEqual(["a"]);
  });

  test("drops a stored envelope that ingest rejects with a 4xx", async () => {
    const down = await startRefusedIngest();
    await runTransport(down.url).send(eventEnvelope("a"));

    const ingest = await startMockIngest(() => ({ statusCode: 400 }));
    const run = runTransport(ingest.url);
    run.sendStored(10);
    await run.flush(5000);

    expect(ingest.captures).toHaveLength(1);
    expect(storedEventIds()).toEqual([]);
  });

  test("drops an envelope that ingest answers with a 5xx and keeps sending", async () => {
    const ingest = await startMockIngest(() => ({ statusCode: 503 }));
    const transport = runTransport(ingest.url);

    await transport.send(eventEnvelope("a"));
    await transport.send(eventEnvelope("b"));

    expect(deliveredEventIds(ingest.captures)).toEqual(["a", "b"]);
    expect(storedEventIds()).toEqual([]);
  });

  test("never stores client reports", async () => {
    const { url } = await startRefusedIngest();
    const transport = runTransport(url);
    const report = createEnvelope({}, [
      [{ type: "client_report" }, { timestamp: 0, discarded_events: [] }],
    ] as never);

    await expect(transport.send(report)).rejects.toThrow();

    expect(
      getDatabase()
        .query("SELECT COUNT(*) AS count FROM telemetry_envelope_queue")
        .get(),
    ).toEqual({ count: 0 });
  });
});
