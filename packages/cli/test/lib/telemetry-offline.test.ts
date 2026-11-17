/**
 * How `withTelemetry` uses the store of telemetry that failed to send:
 * it resends stored envelopes when telemetry is on, clears them when the
 * user opted out, and leaves them alone in library mode.
 */

import { createEnvelope, type Envelope } from "@sentry/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getDatabase } from "../../src/lib/db/index.js";
import { initSentry, withTelemetry } from "../../src/lib/telemetry.js";
import { createEnvelopeStore } from "../../src/lib/telemetry/offline-store.js";
import { useTestConfigDir } from "../helpers.js";

const sent = vi.hoisted(() => [] as Envelope[]);

// Record envelopes instead of sending them to the production DSN.
vi.mock("../../src/lib/telemetry/zstd-transport.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/lib/telemetry/zstd-transport.js")
    >();
  return {
    ...actual,
    makeCompressedTransport: () => ({
      send: (envelope: Envelope) => {
        sent.push(envelope);
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }),
  };
});

const NO_TELEMETRY = "SENTRY_CLI_NO_TELEMETRY";

function storedCount(): number {
  return (
    getDatabase()
      .query("SELECT COUNT(*) AS count FROM telemetry_envelope_queue")
      .get() as { count: number }
  ).count;
}

async function storeEnvelope(id: string): Promise<void> {
  await createEnvelopeStore().push(
    createEnvelope({ event_id: id }, [
      [{ type: "event" }, { event_id: id }],
    ] as never),
  );
}

describe("withTelemetry and stored telemetry", () => {
  useTestConfigDir("telemetry-offline-run-");
  let savedNoTelemetry: string | undefined;

  beforeEach(async () => {
    savedNoTelemetry = process.env[NO_TELEMETRY];
    sent.length = 0;
    await storeEnvelope("stored");
  });

  afterEach(() => {
    if (savedNoTelemetry === undefined) {
      delete process.env[NO_TELEMETRY];
    } else {
      process.env[NO_TELEMETRY] = savedNoTelemetry;
    }
    initSentry(false);
  });

  test("sends stored envelopes when telemetry is on", async () => {
    delete process.env[NO_TELEMETRY];

    await withTelemetry(() => undefined);

    expect(sent.map((envelope) => envelope[0].event_id)).toContain("stored");
    expect(storedCount()).toBe(0);
  });

  test("clears stored envelopes when telemetry is off", async () => {
    process.env[NO_TELEMETRY] = "1";

    await withTelemetry(() => undefined);

    expect(storedCount()).toBe(0);
    expect(sent).toEqual([]);
  });

  test("library mode leaves the store alone", async () => {
    process.env[NO_TELEMETRY] = "1";
    await withTelemetry(() => undefined, { libraryMode: true });

    delete process.env[NO_TELEMETRY];
    await withTelemetry(() => undefined, { libraryMode: true });

    expect(storedCount()).toBe(1);
    expect(sent.map((envelope) => envelope[0].event_id)).not.toContain(
      "stored",
    );
  });
});
