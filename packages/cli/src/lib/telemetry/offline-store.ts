/**
 * SQLite-backed `OfflineStore` for telemetry envelopes that failed to send.
 *
 * `makeOfflineTransport` from `@sentry/core` stores an envelope here when its
 * send throws (network error or the request deadline), and the next CLI run
 * sends the stored envelopes again (see `offline-transport.ts`). Rows live in
 * `telemetry_envelope_queue` as Brotli-compressed serialized envelopes, in a
 * BLOB since attachments can be binary.
 *
 * The store is capped by entry count and total compressed bytes. Over a
 * cap, it drops envelopes without an error event first, then errors, oldest
 * first. Rows past their max age ({@link STORE_LIMITS}) are deleted on read
 * and write. Reads claim rows with `DELETE ... RETURNING`, so two CLI
 * processes never send the same envelope. Store failures never reach the
 * CLI: each operation logs at debug level and carries on.
 */

import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlib,
} from "node:zlib";
import {
  type Envelope,
  envelopeContainsItemType,
  type OfflineStore,
  parseEnvelope,
  serializeEnvelope,
  suppressTracing,
} from "@sentry/core";
import { getDatabase } from "../db/index.js";
import { logger } from "../logger.js";

const log = logger.withTag("telemetry-store");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows past their max age, given the limits and the current time. */
const EXPIRED = "created_at < CASE WHEN is_error THEN ? ELSE ? END";

/** Limits on what the store keeps. */
export type StoreLimits = {
  /** Most envelopes kept. */
  maxEntries: number;
  /** Most compressed bytes kept across all envelopes. */
  maxBytes: number;
  /** Max age, in milliseconds since stored, of an envelope with an error event. */
  maxErrorAgeMs: number;
  /** Max age of every other envelope. */
  maxAgeMs: number;
};

/**
 * Default limits.
 *
 * Relay drops sessions (`max_session_secs_in_past`) and transactions (the
 * metrics aggregator's `max_secs_in_past`) older than 5 days, so envelopes
 * without an error event keep 4 days, leaving a day for clock skew. Relay
 * accepts an error event for the project's retention (90 days by default)
 * and past that only replaces its timestamp, so errors keep 30 days.
 *
 * Brotli shrinks the CLI's envelopes about 8x, so the byte cap holds about
 * 30 MiB of them and only binds for unusually large ones.
 */
export const STORE_LIMITS: StoreLimits = {
  maxEntries: 100,
  maxBytes: 4 * 1024 * 1024,
  maxErrorAgeMs: 30 * DAY_MS,
  maxAgeMs: 4 * DAY_MS,
};

type StoredRow = {
  id: number;
  created_at: number;
  envelope: Uint8Array;
};

/** The store's operations. */
type EnvelopeStore = {
  /** Store an envelope, then drop expired rows and the rows over the caps. */
  push: OfflineStore["push"];
  /**
   * Claim up to `limit` of the oldest unexpired envelopes, deleting them from
   * the store. Pushing a claimed envelope back keeps its original age.
   */
  claim(limit: number): Envelope[];
};

/** Run a store operation without DB spans; log and fall back on failure. */
function guarded<T>(operation: string, fallback: T, fn: () => T): T {
  try {
    return suppressTracing(fn);
  } catch (error) {
    log.debug(`Failed to ${operation}`, error);
    return fallback;
  }
}

/**
 * Brotli quality for stored envelopes. On envelopes the CLI stored with
 * ingest stalled, 6 compressed about 8x (gzip: 7x, zstd level 3: 6.8x) at
 * well under a millisecond per envelope; 11 gained 6% for 50x the time.
 */
const BROTLI_QUALITY = 6;

/** The bytes the store keeps for an envelope. */
export function compressEnvelope(envelope: Envelope): Uint8Array {
  const serialized = serializeEnvelope(envelope);
  const bytes =
    typeof serialized === "string" ? Buffer.from(serialized) : serialized;
  return brotliCompressSync(bytes, {
    params: {
      [zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  });
}

/**
 * Create the store.
 *
 * @param limits - Caps and max age; defaults to {@link STORE_LIMITS}
 * @param now - Clock, injectable for tests
 */
export function createEnvelopeStore(
  limits: StoreLimits = STORE_LIMITS,
  now: () => number = Date.now,
): EnvelopeStore {
  /** When each envelope claimed by this process was first stored. */
  const storedAt = new WeakMap<Envelope, number>();

  function deleteExpired(db: ReturnType<typeof getDatabase>): void {
    const current = now();
    db.query(`DELETE FROM telemetry_envelope_queue WHERE ${EXPIRED}`).run(
      current - limits.maxErrorAgeMs,
      current - limits.maxAgeMs,
    );
  }

  function insert(envelope: Envelope): void {
    const bytes = compressEnvelope(envelope);
    // It could never be kept, and inserting it would put every row over
    // the byte cap in the trim below, emptying the store.
    if (bytes.byteLength > limits.maxBytes) {
      log.debug("Dropped unsent telemetry larger than the store's byte cap");
      return;
    }
    const createdAt = storedAt.get(envelope) ?? now();
    const isError = envelopeContainsItemType(envelope, ["event"]) ? 1 : 0;
    const db = getDatabase();
    db.transaction(() => {
      db.query(
        "INSERT INTO telemetry_envelope_queue (created_at, is_error, size, envelope) VALUES (?, ?, ?, ?)",
      ).run(createdAt, isError, bytes.byteLength, bytes);
      // Expired rows go first, in their own statement, so they don't count
      // against the caps in the trim below.
      deleteExpired(db);
      // Keep errors first, then the newest: rows past either cap are the
      // oldest envelopes without an error, then the oldest errors.
      db.query(
        `DELETE FROM telemetry_envelope_queue WHERE id IN (
          SELECT id FROM (
            SELECT id,
              ROW_NUMBER() OVER kept AS position,
              SUM(size) OVER kept AS total
            FROM telemetry_envelope_queue
            WINDOW kept AS (ORDER BY is_error DESC, created_at DESC, id DESC)
          ) WHERE position > ? OR total > ?
        )`,
      ).run(limits.maxEntries, limits.maxBytes);
    })();
  }

  function claim(limit: number): Envelope[] {
    return guarded("read stored telemetry", [], () => {
      const db = getDatabase();
      const rows = db.transaction(() => {
        deleteExpired(db);
        return db
          .query(
            `DELETE FROM telemetry_envelope_queue WHERE id IN (
              SELECT id FROM telemetry_envelope_queue
              ORDER BY created_at, id LIMIT ?
            ) RETURNING id, created_at, envelope`,
          )
          .all(limit) as StoredRow[];
      })();
      rows.sort((a, b) => a.created_at - b.created_at || a.id - b.id);
      const envelopes: Envelope[] = [];
      for (const row of rows) {
        try {
          const envelope = parseEnvelope(brotliDecompressSync(row.envelope));
          storedAt.set(envelope, row.created_at);
          envelopes.push(envelope);
        } catch (error) {
          log.debug(
            "Dropped a stored telemetry envelope that failed to parse",
            error,
          );
        }
      }
      return envelopes;
    });
  }

  return {
    push(envelope) {
      guarded("store unsent telemetry", undefined, () => insert(envelope));
      return Promise.resolve();
    },
    claim,
  };
}

/** Delete every stored envelope; used when telemetry is turned off. */
export function clearStoredEnvelopes(): void {
  guarded("clear stored telemetry", undefined, () => {
    const db = getDatabase();
    // Check first: this runs on every opted-out run, and a write to a
    // read-only database prints a warning.
    if (db.query("SELECT 1 FROM telemetry_envelope_queue LIMIT 1").get()) {
      db.query("DELETE FROM telemetry_envelope_queue").run();
    }
  });
}
