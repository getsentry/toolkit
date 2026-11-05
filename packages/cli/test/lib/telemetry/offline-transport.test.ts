/**
 * Tests for the circuit breaker of the transport that stores telemetry it
 * fails to send. The inner transport is a stand-in that fails or answers on
 * demand, and the breaker runs on a settable clock. Wire-level behavior is
 * covered in offline-transport.e2e.test.ts.
 */

import { brotliDecompressSync } from "node:zlib";
import { createEnvelope, type Envelope, parseEnvelope } from "@sentry/core";
import { describe, expect, test, vi } from "vitest";
import { getDatabase } from "../../../src/lib/db/index.js";
import { createEnvelopeStore } from "../../../src/lib/telemetry/offline-store.js";
import {
  BREAKER_COOLDOWN_MS,
  makeStoringTransport,
} from "../../../src/lib/telemetry/offline-transport.js";
import { useTestConfigDir } from "../../helpers.js";
import { noop } from "./ingest-servers.js";

function eventEnvelope(id: string): Envelope {
  return createEnvelope({ event_id: id }, [
    [{ type: "event" }, { event_id: id, message: "hi" }],
  ] as never);
}

function storedEventIds(): unknown[] {
  const rows = getDatabase()
    .query(
      "SELECT envelope FROM telemetry_envelope_queue ORDER BY created_at, id",
    )
    .all() as { envelope: Uint8Array }[];
  return rows.map(
    (row) => parseEnvelope(brotliDecompressSync(row.envelope))[0].event_id,
  );
}

/**
 * A storing transport over a stand-in ingest. `ingest.up` decides whether a
 * send answers 200 or throws; `ingest.sent` lists every envelope it saw.
 */
function setup() {
  const clock = { now: 1_000_000 };
  const ingest = { up: false, sent: [] as unknown[] };
  const transport = makeStoringTransport(
    { url: "http://127.0.0.1:9/api/0/envelope/", recordDroppedEvent: noop },
    () => ({
      send: async (envelope) => {
        ingest.sent.push(envelope[0].event_id);
        if (!ingest.up) {
          throw new Error("connect ECONNREFUSED");
        }
        return { statusCode: 200 };
      },
      flush: () => Promise.resolve(true),
    }),
    () => clock.now,
  );
  return { clock, ingest, transport };
}

describe("makeStoringTransport breaker", () => {
  useTestConfigDir("telemetry-breaker-");

  test("probes after the cooldown, re-opens on failure, and drains on recovery", async () => {
    const { clock, ingest, transport } = setup();

    // The first failure opens the breaker; later envelopes skip the network.
    await transport.send(eventEnvelope("a"));
    await transport.send(eventEnvelope("b"));
    clock.now += BREAKER_COOLDOWN_MS - 1;
    await transport.send(eventEnvelope("c"));
    expect(ingest.sent).toEqual(["a"]);
    expect(storedEventIds()).toEqual(["a", "b", "c"]);

    // After the cooldown, one envelope goes out as a probe. It fails, so the
    // breaker opens again for a full cooldown.
    clock.now += 1;
    await transport.send(eventEnvelope("d"));
    expect(ingest.sent).toEqual(["a", "d"]);
    clock.now += BREAKER_COOLDOWN_MS - 1;
    await transport.send(eventEnvelope("e"));
    expect(ingest.sent).toEqual(["a", "d"]);
    expect(storedEventIds()).toEqual(["a", "b", "c", "d", "e"]);

    // Ingest is back: the next probe succeeds, closes the breaker, and sends
    // the stored envelopes.
    ingest.up = true;
    clock.now += 1;
    await transport.send(eventEnvelope("f"));
    await vi.waitFor(() => expect(storedEventIds()).toEqual([]));
    await vi.waitFor(() =>
      expect(ingest.sent).toEqual(["a", "d", "f", "a", "b", "c", "d", "e"]),
    );

    // Closed again: later envelopes go straight out.
    await transport.send(eventEnvelope("g"));
    expect(ingest.sent.at(-1)).toBe("g");
    expect(storedEventIds()).toEqual([]);
  });

  test("stores envelopes sent while the probe is in flight", async () => {
    const clock = { now: 1_000_000 };
    const sent: unknown[] = [];
    let answerProbe: () => void = noop;
    let calls = 0;
    const transport = makeStoringTransport(
      { url: "http://127.0.0.1:9/api/0/envelope/", recordDroppedEvent: noop },
      () => ({
        send: (envelope) => {
          sent.push(envelope[0].event_id);
          calls += 1;
          if (calls === 1) {
            return Promise.reject(new Error("connect ECONNREFUSED"));
          }
          if (calls === 2) {
            return new Promise((resolve) => {
              answerProbe = () => resolve({ statusCode: 200 });
            });
          }
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      }),
      () => clock.now,
    );

    await transport.send(eventEnvelope("a"));
    clock.now += BREAKER_COOLDOWN_MS;
    const probe = transport.send(eventEnvelope("probe"));
    await transport.send(eventEnvelope("during"));
    expect(sent).toEqual(["a", "probe"]);
    expect(storedEventIds()).toEqual(["a", "during"]);

    answerProbe();
    await probe;
    await vi.waitFor(() => expect(storedEventIds()).toEqual([]));
    expect(sent).toEqual(["a", "probe", "a", "during"]);
  });

  test("drops runtime metrics instead of storing them", async () => {
    const { clock, ingest, transport } = setup();
    const metrics = createEnvelope({ event_id: "m" }, [
      [{ type: "trace_metric" }, { items: [] }],
    ] as never);

    // A failed send opens the breaker but keeps nothing. The send rejects,
    // which the SDK client catches.
    await expect(transport.send(metrics)).rejects.toThrow("ECONNREFUSED");
    expect(ingest.sent).toEqual(["m"]);
    expect(storedEventIds()).toEqual([]);

    // With the breaker open, metrics skip the network and are dropped too,
    // while other envelopes are still stored.
    await expect(transport.send(metrics)).rejects.toThrow("shouldSend");
    await transport.send(eventEnvelope("a"));
    expect(ingest.sent).toEqual(["m"]);
    expect(storedEventIds()).toEqual(["a"]);

    // A metrics envelope can still be the probe that closes the breaker.
    ingest.up = true;
    clock.now += BREAKER_COOLDOWN_MS;
    await transport.send(metrics);
    await vi.waitFor(() => expect(storedEventIds()).toEqual([]));
    expect(ingest.sent).toEqual(["m", "m", "a"]);
  });

  test("a response after a failure in the same batch doesn't drain more", async () => {
    const store = createEnvelopeStore();
    for (let i = 0; i < 25; i++) {
      await store.push(eventEnvelope(`s${i}`));
    }
    let calls = 0;
    const transport = makeStoringTransport(
      { url: "http://127.0.0.1:9/api/0/envelope/", recordDroppedEvent: noop },
      () => ({
        // The first send of the batch fails at once; the rest answer a
        // moment later, after the failure has opened the breaker.
        send: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("connect ECONNREFUSED");
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { statusCode: 200 };
        },
        flush: () => Promise.resolve(true),
      }),
    );

    transport.sendStored(10);

    // One batch only: 9 delivered, the failed one requeued, 15 untouched.
    await vi.waitFor(() => expect(calls).toBe(10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(10);
    expect(storedEventIds()).toHaveLength(16);
  });

  test("sendStored does nothing while the breaker is open", async () => {
    const { ingest, transport } = setup();
    await transport.send(eventEnvelope("a"));

    ingest.up = true;
    transport.sendStored(10);

    expect(ingest.sent).toEqual(["a"]);
    expect(storedEventIds()).toEqual(["a"]);
  });
});
