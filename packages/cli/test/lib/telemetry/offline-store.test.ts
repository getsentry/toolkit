/**
 * Tests for the SQLite store of telemetry envelopes that failed to send.
 * Claims from several processes at once are covered in
 * test/lib/db/concurrent.test.ts.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEnvelope, type Envelope } from "@sentry/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CONFIG_DIR_ENV_VAR,
  closeDatabase,
  getDatabase,
} from "../../../src/lib/db/index.js";
import { __setDriverForTests } from "../../../src/lib/db/sqlite.js";
import {
  clearStoredEnvelopes,
  compressEnvelope,
  createEnvelopeStore,
  STORE_LIMITS,
  type StoreLimits,
} from "../../../src/lib/telemetry/offline-store.js";
import { useTestConfigDir } from "../../helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function eventEnvelope(id: string, message = "hi"): Envelope {
  return createEnvelope({ event_id: id, sent_at: "2026-01-01T00:00:00Z" }, [
    [{ type: "event" }, { event_id: id, message }],
  ] as never);
}

/** An envelope without an error event; the header ID only labels it. */
function transactionEnvelope(id: string): Envelope {
  return createEnvelope({ event_id: id }, [
    [{ type: "transaction" }, { event_id: id, type: "transaction" }],
  ] as never);
}

function eventIds(envelopes: Envelope[]): unknown[] {
  return envelopes.map((envelope) => envelope[0].event_id);
}

function storedCount(): number {
  return (
    getDatabase()
      .query("SELECT COUNT(*) AS count FROM telemetry_envelope_queue")
      .get() as { count: number }
  ).count;
}

/** A store on a settable clock. */
function storeAt(limits: StoreLimits = STORE_LIMITS) {
  const clock = { now: 1_000_000 };
  return { clock, store: createEnvelopeStore(limits, () => clock.now) };
}

describe.each(["node", "wasm"] as const)(
  "createEnvelopeStore [%s driver]",
  (kind) => {
    useTestConfigDir("telemetry-store-");

    beforeEach(() => {
      __setDriverForTests(kind);
    });

    afterEach(() => {
      closeDatabase();
      __setDriverForTests(null);
    });

    test("round-trips JSON and binary items", async () => {
      const { store } = storeAt();
      const bytes = new Uint8Array([0, 1, 2, 255, 10, 13]);
      const envelope = createEnvelope({ event_id: "a" }, [
        [{ type: "event" }, { event_id: "a", message: "é ✓" }],
        [
          { type: "attachment", length: bytes.length, filename: "f.bin" },
          bytes,
        ],
      ] as never);

      await store.push(envelope);
      const [claimed] = store.claim(10);

      expect(claimed?.[0]).toEqual(envelope[0]);
      expect(claimed?.[1][0]).toEqual(envelope[1][0]);
      expect(claimed?.[1][1]?.[0]).toEqual(envelope[1][1]?.[0]);
      expect(Buffer.from(claimed?.[1][1]?.[1] as Uint8Array)).toEqual(
        Buffer.from(bytes),
      );
    });

    test("claims the oldest first and deletes what it claims", async () => {
      const { clock, store } = storeAt();
      for (const id of ["a", "b", "c"]) {
        await store.push(eventEnvelope(id));
        clock.now += 1;
      }

      expect(eventIds(store.claim(2))).toEqual(["a", "b"]);
      expect(storedCount()).toBe(1);
      expect(eventIds(store.claim(2))).toEqual(["c"]);
      expect(store.claim(2)).toEqual([]);
    });

    test("keeps only the newest maxEntries envelopes", async () => {
      const { clock, store } = storeAt({ ...STORE_LIMITS, maxEntries: 3 });
      for (const id of ["a", "b", "c", "d", "e"]) {
        await store.push(transactionEnvelope(id));
        clock.now += 1;
      }

      expect(eventIds(store.claim(10))).toEqual(["c", "d", "e"]);
    });

    test("keeps the newest envelopes that fit in maxBytes", async () => {
      // The cap counts stored, compressed bytes.
      const size = compressEnvelope(eventEnvelope("a")).byteLength;
      const { clock, store } = storeAt({ ...STORE_LIMITS, maxBytes: size * 2 });
      for (const id of ["a", "b", "c"]) {
        await store.push(eventEnvelope(id));
        clock.now += 1;
      }
      expect(eventIds(store.claim(10))).toEqual(["b", "c"]);

      // One envelope bigger than the cap is not kept, and doesn't push out
      // the envelopes that fit.
      await store.push(eventEnvelope("d"));
      await store.push(
        eventEnvelope("big", randomBytes(size * 4).toString("hex")),
      );
      expect(eventIds(store.claim(10))).toEqual(["d"]);
    });

    test("over a cap, drops envelopes without an error before errors", async () => {
      const { clock, store } = storeAt({ ...STORE_LIMITS, maxEntries: 3 });
      await store.push(eventEnvelope("e1"));
      clock.now += 1;
      for (const id of ["t1", "t2"]) {
        await store.push(transactionEnvelope(id));
        clock.now += 1;
      }
      await store.push(eventEnvelope("e2"));
      clock.now += 1;
      await store.push(transactionEnvelope("t3"));

      expect(eventIds(store.claim(10))).toEqual(["e1", "e2", "t3"]);
    });

    test("expired rows don't count against the caps", async () => {
      const { clock, store } = storeAt({ ...STORE_LIMITS, maxEntries: 2 });
      for (const id of ["e1", "e2"]) {
        await store.push(eventEnvelope(id));
      }
      clock.now += STORE_LIMITS.maxErrorAgeMs + 1;
      // The expired errors would rank first and push this out of the cap.
      await store.push(transactionEnvelope("t1"));

      expect(eventIds(store.claim(10))).toEqual(["t1"]);
    });

    test("deletes envelopes without an error event after maxAgeMs", async () => {
      const { clock, store } = storeAt();
      await store.push(transactionEnvelope("old"));
      clock.now += STORE_LIMITS.maxAgeMs - 1;
      await store.push(transactionEnvelope("new"));
      clock.now += 2;

      expect(eventIds(store.claim(10))).toEqual(["new"]);
      expect(storedCount()).toBe(0);
    });

    test("keeps errors until maxErrorAgeMs", async () => {
      const { clock, store } = storeAt();
      await store.push(eventEnvelope("error"));
      await store.push(transactionEnvelope("transaction"));
      clock.now += STORE_LIMITS.maxAgeMs + 1;
      expect(eventIds(store.claim(10))).toEqual(["error"]);

      await store.push(eventEnvelope("old error"));
      clock.now += STORE_LIMITS.maxErrorAgeMs + 1;
      expect(store.claim(10)).toEqual([]);
      expect(storedCount()).toBe(0);
    });

    test("a claimed envelope pushed back keeps its original age", async () => {
      const { clock, store } = storeAt();
      await store.push(transactionEnvelope("a"));
      clock.now += 3 * DAY_MS;
      const [claimed] = store.claim(1);
      await store.push(claimed as Envelope);
      clock.now += 2 * DAY_MS;

      expect(store.claim(10)).toEqual([]);
    });

    test("drops a row that no longer parses", async () => {
      const { store } = storeAt();
      getDatabase()
        .query(
          "INSERT INTO telemetry_envelope_queue (created_at, size, envelope) VALUES (?, 3, ?)",
        )
        .run(1_000_000, Buffer.from("{{{"));
      await store.push(eventEnvelope("a"));

      expect(eventIds(store.claim(10))).toEqual(["a"]);
      expect(storedCount()).toBe(0);
    });

    test("keeps working in memory when cli.db can't be opened", async () => {
      const { store } = storeAt();
      const blocker = join(process.env[CONFIG_DIR_ENV_VAR] as string, "file");
      writeFileSync(blocker, "");
      closeDatabase();
      process.env[CONFIG_DIR_ENV_VAR] = join(blocker, "nested");

      await expect(store.push(eventEnvelope("a"))).resolves.toBeUndefined();
      expect(eventIds(store.claim(10))).toEqual(["a"]);
      expect(() => clearStoredEnvelopes()).not.toThrow();
    });
  },
);

describe("clearStoredEnvelopes", () => {
  useTestConfigDir("telemetry-store-clear-");

  test("deletes every stored envelope", async () => {
    const { store } = storeAt();
    await store.push(eventEnvelope("a"));
    await store.push(eventEnvelope("b"));

    clearStoredEnvelopes();

    expect(storedCount()).toBe(0);
  });
});
