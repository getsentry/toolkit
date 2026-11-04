/**
 * SQLite-backed `OfflineStore` for telemetry envelopes that failed to send.
 *
 * `makeOfflineTransport` from `@sentry/core` stores an envelope here when its
 * send throws (network error or the request deadline), and the next CLI run
 * sends the stored envelopes again (see `offline-transport.ts`). Rows live in
 * `telemetry_envelope_queue` as serialized envelope bytes, since attachments
 * can be binary.
 *
 * The store is capped by entry count and total bytes, dropping the oldest
 * rows first, and rows older than {@link STORE_LIMITS.maxAgeMs} are deleted
 * on read. Reads claim rows with `DELETE ... RETURNING`, so two CLI processes
 * never send the same envelope. Store failures never reach the CLI: each
 * operation logs at debug level and carries on.
 */

import {
  type Envelope,
  type OfflineStore,
  parseEnvelope,
  serializeEnvelope,
  suppressTracing,
} from "@sentry/core";
import { getDatabase } from "../db/index.js";
import { logger } from "../logger.js";

const log = logger.withTag("telemetry-store");

/** Limits on what the store keeps. */
export type StoreLimits = {
  /** Most envelopes kept; the oldest beyond this are dropped. */
  maxEntries: number;
  /** Most serialized bytes kept across all envelopes; oldest dropped first. */
  maxBytes: number;
  /** Rows older than this (milliseconds since stored) are deleted on read. */
  maxAgeMs: number;
};

/**
 * Default limits.
 *
 * The max age stays under Relay's strictest limit on how old data may be:
 * sessions (`max_session_secs_in_past`) and transactions (the metrics
 * aggregator's `max_secs_in_past`) older than 5 days are dropped. Errors,
 * logs, spans, and metrics are accepted for the project's retention (90 days
 * by default), so 4 days keeps every item type deliverable with a day to
 * spare for clock skew.
 */
export const STORE_LIMITS: StoreLimits = {
  maxEntries: 100,
  maxBytes: 4 * 1024 * 1024,
  maxAgeMs: 4 * 24 * 60 * 60 * 1000,
};

type StoredRow = {
  id: number;
  created_at: number;
  envelope: Uint8Array;
};

/** The store's operations. */
type EnvelopeStore = {
  /** Store an envelope, then drop expired rows and the oldest over the caps. */
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

function toBytes(serialized: string | Uint8Array): Uint8Array {
  return typeof serialized === "string"
    ? Buffer.from(serialized, "utf-8")
    : serialized;
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

  function insert(envelope: Envelope): void {
    const bytes = toBytes(serializeEnvelope(envelope));
    const createdAt = storedAt.get(envelope) ?? now();
    const db = getDatabase();
    db.transaction(() => {
      db.query(
        "INSERT INTO telemetry_envelope_queue (created_at, size, envelope) VALUES (?, ?, ?)",
      ).run(createdAt, bytes.byteLength, bytes);
      db.query(
        `DELETE FROM telemetry_envelope_queue WHERE created_at < ? OR id IN (
          SELECT id FROM (
            SELECT id,
              ROW_NUMBER() OVER newest AS position,
              SUM(size) OVER newest AS total
            FROM telemetry_envelope_queue
            WINDOW newest AS (ORDER BY created_at DESC, id DESC)
          ) WHERE position > ? OR total > ?
        )`,
      ).run(now() - limits.maxAgeMs, limits.maxEntries, limits.maxBytes);
    })();
  }

  function claim(limit: number): Envelope[] {
    return guarded("read stored telemetry", [], () => {
      const db = getDatabase();
      const rows = db.transaction(() => {
        db.query(
          "DELETE FROM telemetry_envelope_queue WHERE created_at < ?",
        ).run(now() - limits.maxAgeMs);
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
          const envelope = parseEnvelope(row.envelope);
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
