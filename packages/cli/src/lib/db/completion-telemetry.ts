/**
 * Deferred telemetry queue for shell completions.
 *
 * Shell completions write timing data here with zero Sentry SDK overhead.
 * The next normal CLI run reads, emits as Sentry metrics, and deletes.
 */

import { logger } from "../logger.js";
import { getDatabase } from "./index.js";

const log = logger.withTag("completion-telemetry");

/** A queued completion telemetry entry. */
export type CompletionTelemetryEntry = {
  id: number;
  commandPath: string;
  durationMs: number;
  resultCount: number;
};

/**
 * Queue a completion timing entry.
 *
 * Called during the `__complete` fast-path after completions are written
 * to stdout. Uses raw SQLite (no Sentry SDK) for ~1ms overhead.
 *
 * @param entry - Completion timing data
 */
export function queueCompletionTelemetry(entry: {
  commandPath: string;
  durationMs: number;
  resultCount: number;
}): void {
  try {
    const db = getDatabase();
    db.query(
      "INSERT INTO completion_telemetry_queue (command_path, duration_ms, result_count) VALUES (?, ?, ?)"
    ).run(entry.commandPath, Math.round(entry.durationMs), entry.resultCount);
  } catch (error) {
    log.debug("Failed to queue completion telemetry", error);
  }
}

/**
 * Drain all queued completion telemetry entries.
 *
 * Atomically reads and deletes all entries using `DELETE ... RETURNING`.
 * Called during normal CLI runs inside `withTelemetry()`.
 *
 * @returns The queued entries for emission as Sentry metrics
 */
export function drainCompletionTelemetry(): CompletionTelemetryEntry[] {
  try {
    const db = getDatabase();
    // Atomic read + delete — no race with concurrent __complete processes
    const rows = db
      .query(
        "DELETE FROM completion_telemetry_queue RETURNING id, command_path, duration_ms, result_count"
      )
      .all() as {
      id: number;
      command_path: string;
      duration_ms: number;
      result_count: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      commandPath: row.command_path,
      durationMs: row.duration_ms,
      resultCount: row.result_count,
    }));
  } catch (error) {
    log.debug("Failed to drain completion telemetry", error);
    return [];
  }
}
