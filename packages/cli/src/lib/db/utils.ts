/**
 * SQL builder utilities for common database operations.
 * Reduces boilerplate for UPSERT and other repetitive patterns.
 */

import { getDatabase } from "./index.js";
import type { SQLQueryBindings } from "./sqlite.js";

/** Valid SQLite binding value (re-exported from sqlite.ts adapter) */
export type SqlValue = SQLQueryBindings;

/**
 * Result of building an SQL query with parameterized values.
 */
export type SqlQuery = {
  /** The SQL string with ? placeholders */
  sql: string;
  /** The values to bind to the placeholders */
  values: SqlValue[];
};

/**
 * Options for the upsert function.
 */
export type UpsertOptions<T> = {
  /** Columns to exclude from the UPDATE SET clause */
  excludeFromUpdate?: (keyof T)[];
};

/**
 * Build an UPSERT (INSERT ... ON CONFLICT DO UPDATE) statement for SQLite.
 *
 * This helper eliminates repetitive UPSERT boilerplate by automatically
 * generating the INSERT and ON CONFLICT DO UPDATE clauses from an object.
 *
 * @param table - The table name to insert into
 * @param data - Object with column names as keys and values to insert
 * @param conflictColumns - Column(s) that form the unique constraint
 * @param options - Optional configuration
 * @returns Object with { sql, values } ready for db.query(sql).run(...values)
 *
 * @example
 * // Simple upsert
 * const { sql, values } = upsert('auth', { id: 1, token: 'abc' }, ['id']);
 * db.query(sql).run(...values);
 * // INSERT INTO auth (id, token) VALUES (?, ?)
 * // ON CONFLICT(id) DO UPDATE SET token = excluded.token
 *
 * @example
 * // Exclude columns from update
 * const { sql, values } = upsert(
 *   'users',
 *   { id: 1, name: 'Bob', created_at: now },
 *   ['id'],
 *   { excludeFromUpdate: ['created_at'] }
 * );
 * // created_at won't be updated on conflict, only on insert
 */
export function upsert<T extends Record<string, SqlValue>>(
  table: string,
  data: T,
  conflictColumns: (keyof T)[],
  options: UpsertOptions<T> = {}
): SqlQuery {
  const columns = Object.keys(data);
  const values = Object.values(data) as SqlValue[];

  if (columns.length === 0) {
    throw new Error("upsert: data object must have at least one column");
  }

  if (conflictColumns.length === 0) {
    throw new Error("upsert: must specify at least one conflict column");
  }

  const placeholders = columns.map(() => "?").join(", ");

  const conflictSet = new Set(conflictColumns as string[]);
  const excludeSet = new Set((options.excludeFromUpdate ?? []) as string[]);

  const updateColumns = columns.filter(
    (col) => !(conflictSet.has(col) || excludeSet.has(col))
  );

  const updateClause =
    updateColumns.length > 0
      ? `DO UPDATE SET ${updateColumns.map((col) => `${col} = excluded.${col}`).join(", ")}`
      : "DO NOTHING";

  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${(conflictColumns as string[]).join(", ")}) ${updateClause}`;

  return { sql, values };
}

/** Minimal db interface needed for query execution and metadata helpers */
type QueryRunner = {
  query(sql: string): {
    run(...values: SqlValue[]): void;
    all(...values: SqlValue[]): Record<string, SqlValue>[];
  };
  transaction<T>(fn: () => T): () => T;
};

/**
 * Execute an UPSERT statement directly on the database.
 *
 * Convenience wrapper that combines upsert() SQL generation with execution.
 * For advanced options like excludeFromUpdate, use upsert() directly.
 *
 * @param db - The database instance to execute on
 * @param table - The table name to insert into
 * @param data - Object with column names as keys and values to insert
 * @param conflictColumns - Column(s) that form the unique constraint
 *
 * @example
 * runUpsert(db, 'auth', { id: 1, token: 'abc' }, ['id']);
 */
export function runUpsert<T extends Record<string, SqlValue>>(
  db: QueryRunner,
  table: string,
  data: T,
  conflictColumns: (keyof T)[]
): void {
  const { sql, values } = upsert(table, data, conflictColumns);
  db.query(sql).run(...values);
}

// ---------------------------------------------------------------------------
// Metadata table helpers
// ---------------------------------------------------------------------------

type MetadataRow = { key: string; value: string };

/**
 * Read multiple values from the `metadata` key-value table in a single query.
 *
 * @param db - Database instance
 * @param keys - The metadata keys to read
 * @returns Map of key → value for keys that exist. Missing keys are omitted.
 *
 * @example
 * const m = getMetadata(db, ["install.method", "install.path"]);
 * const method = m.get("install.method"); // string | undefined
 */
export function getMetadata(
  db: QueryRunner,
  keys: string[]
): Map<string, string> {
  if (keys.length === 0) {
    return new Map();
  }
  const placeholders = keys.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT key, value FROM metadata WHERE key IN (${placeholders})`)
    .all(...keys) as MetadataRow[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

/**
 * Write multiple key-value pairs to the `metadata` table in a single transaction.
 *
 * @param db - Database instance
 * @param entries - Object mapping metadata keys to string values
 *
 * @example
 * setMetadata(db, { "install.method": "binary", "install.path": "/usr/bin/sentry" });
 */
export function setMetadata(
  db: QueryRunner,
  entries: Record<string, string>
): void {
  const pairs = Object.entries(entries);
  if (pairs.length === 0) {
    return;
  }
  db.transaction(() => {
    for (const [key, value] of pairs) {
      runUpsert(db, "metadata", { key, value }, ["key"]);
    }
  })();
}

/**
 * Delete multiple keys from the `metadata` table in a single query.
 *
 * @param db - Database instance
 * @param keys - The metadata keys to delete
 *
 * @example
 * clearMetadata(db, ["install.method", "install.path", "install.version"]);
 */
export function clearMetadata(db: QueryRunner, keys: string[]): void {
  if (keys.length === 0) {
    return;
  }
  const placeholders = keys.map(() => "?").join(", ");
  db.query(`DELETE FROM metadata WHERE key IN (${placeholders})`).run(...keys);
}

// ---------------------------------------------------------------------------
// Cache entry helpers
// ---------------------------------------------------------------------------

/**
 * Update the `last_accessed` timestamp for a cache entry.
 *
 * Shared helper to avoid duplicating the same UPDATE pattern in every
 * cache module. Calls `getDatabase()` internally.
 *
 * @param table - Cache table name (e.g., "dsn_cache", "project_cache")
 * @param keyColumn - Name of the primary key column (e.g., "directory", "cache_key")
 * @param keyValue - The key value identifying the row to touch
 */
export function touchCacheEntry(
  table: string,
  keyColumn: string,
  keyValue: string
): void {
  const db = getDatabase();
  db.query(`UPDATE ${table} SET last_accessed = ? WHERE ${keyColumn} = ?`).run(
    Date.now(),
    keyValue
  );
}
