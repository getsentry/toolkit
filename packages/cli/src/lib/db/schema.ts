/**
 * Database schema DDL and version management.
 *
 * This module defines the canonical schema for the CLI's SQLite database,
 * handles migrations between versions, and provides repair utilities for
 * fixing schema inconsistencies.
 *
 * Schema is defined once in TABLE_SCHEMAS and used to generate:
 * - DDL statements for table creation
 * - Column lists for schema repair
 * - Migration checks
 */

import { createRequire } from "node:module";
import { getEnv } from "../env.js";
import { stringifyUnknown } from "../errors.js";
import { logger } from "../logger.js";
import type { Database } from "./sqlite.js";

const _require = createRequire(import.meta.url);

export const CURRENT_SCHEMA_VERSION = 16;

/** Environment variable to disable auto-repair */
const NO_AUTO_REPAIR_ENV = "SENTRY_CLI_NO_AUTO_REPAIR";

type SqliteType = "TEXT" | "INTEGER";

export type ColumnDef = {
  type: SqliteType;
  primaryKey?: boolean;
  notNull?: boolean;
  default?: string;
  check?: string;
  /** Schema version when this column was added (for repair tracking) */
  addedInVersion?: number;
};

export type TableSchema = {
  columns: Record<string, ColumnDef>;
  /**
   * Composite primary key columns. When set, the DDL generator emits a
   * table-level `PRIMARY KEY (col1, col2, ...)` constraint instead of
   * per-column `PRIMARY KEY` attributes. Individual columns listed here
   * should NOT also set `primaryKey: true`.
   */
  compositePrimaryKey?: string[];
};

/**
 * Canonical schema definitions for all tables.
 * DDL and repair info are generated from this single source of truth.
 */
export const TABLE_SCHEMAS: Record<string, TableSchema> = {
  schema_version: {
    columns: {
      version: { type: "INTEGER", primaryKey: true },
    },
  },
  auth: {
    columns: {
      id: { type: "INTEGER", primaryKey: true, check: "id = 1" },
      token: { type: "TEXT" },
      refresh_token: { type: "TEXT" },
      expires_at: { type: "INTEGER" },
      issued_at: { type: "INTEGER" },
      updated_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
      // Origin URL (scheme://host[:port]) this token was issued against.
      // Enforced at the fetch layer: credentials are only attached to requests
      // whose origin matches this host (with SaaS equivalence). Nullable for
      // rows created before schema v16; migrated lazily in getAuthConfig.
      host: { type: "TEXT", addedInVersion: 16 },
    },
  },

  project_cache: {
    columns: {
      cache_key: { type: "TEXT", primaryKey: true },
      org_slug: { type: "TEXT", notNull: true },
      org_name: { type: "TEXT", notNull: true },
      project_slug: { type: "TEXT", notNull: true },
      project_name: { type: "TEXT", notNull: true },
      project_id: { type: "TEXT", addedInVersion: 7 },
      cached_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
      last_accessed: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },
  dsn_cache: {
    columns: {
      directory: { type: "TEXT", primaryKey: true },
      dsn: { type: "TEXT", notNull: true },
      project_id: { type: "TEXT", notNull: true },
      org_id: { type: "TEXT" },
      source: { type: "TEXT", notNull: true },
      source_path: { type: "TEXT" },
      resolved_org_slug: { type: "TEXT" },
      resolved_org_name: { type: "TEXT" },
      resolved_project_slug: { type: "TEXT" },
      resolved_project_name: { type: "TEXT" },
      fingerprint: { type: "TEXT", addedInVersion: 4 },
      all_dsns_json: { type: "TEXT", addedInVersion: 4 },
      source_mtimes_json: { type: "TEXT", addedInVersion: 4 },
      dir_mtimes_json: { type: "TEXT", addedInVersion: 4 },
      root_dir_mtime: { type: "INTEGER", addedInVersion: 4 },
      ttl_expires_at: { type: "INTEGER", addedInVersion: 4 },
      cached_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
      last_accessed: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },
  project_aliases: {
    columns: {
      alias: { type: "TEXT", primaryKey: true },
      org_slug: { type: "TEXT", notNull: true },
      project_slug: { type: "TEXT", notNull: true },
      dsn_fingerprint: { type: "TEXT" },
      cached_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
      last_accessed: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },
  pagination_cursors: {
    columns: {
      command_key: { type: "TEXT", notNull: true },
      context: { type: "TEXT", notNull: true },
      cursor_stack: { type: "TEXT", notNull: true },
      page_index: { type: "INTEGER", notNull: true, default: "0" },
      expires_at: { type: "INTEGER", notNull: true },
    },
    compositePrimaryKey: ["command_key", "context"],
  },
  metadata: {
    columns: {
      key: { type: "TEXT", primaryKey: true },
      value: { type: "TEXT", notNull: true },
    },
  },
  org_regions: {
    columns: {
      org_slug: { type: "TEXT", primaryKey: true },
      org_id: { type: "TEXT", addedInVersion: 8 },
      org_name: { type: "TEXT", addedInVersion: 9 },
      org_role: { type: "TEXT", addedInVersion: 10 },
      region_url: { type: "TEXT", notNull: true },
      updated_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },
  user_info: {
    columns: {
      id: { type: "INTEGER", primaryKey: true, check: "id = 1" },
      user_id: { type: "TEXT", notNull: true },
      email: { type: "TEXT" },
      username: { type: "TEXT" },
      name: { type: "TEXT", addedInVersion: 3 },
      updated_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },
  instance_info: {
    columns: {
      id: { type: "INTEGER", primaryKey: true, check: "id = 1" },
      instance_id: { type: "TEXT", notNull: true },
      created_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },
  repo_cache: {
    columns: {
      // Composite PK (org_slug) — one row per org caches the full repo list
      org_slug: { type: "TEXT", primaryKey: true },
      // JSON array of SentryRepository — stored as blob since we re-hydrate
      // the whole list on cache hit (no per-repo lookups). Keeps the cache
      // simple and matches the typical usage pattern (match git origin →
      // find one repo by name/url).
      repos_json: { type: "TEXT", notNull: true },
      cached_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },
  /**
   * Mapping from numeric issue group IDs to organization slugs.
   *
   * Populated after `sentry issue view <numeric-id>` falls back to the legacy
   * unscoped `/api/0/issues/{id}/` endpoint and extracts the org from the
   * response permalink. Subsequent runs consult this cache to route directly
   * via the org-scoped endpoint, avoiding the redundant unscoped lookup
   * flagged as a "Consecutive HTTP" performance issue in Sentry.
   *
   * Entries are best-effort: a stale mapping (issue moved / deleted / access
   * revoked) causes a 404 on the cached org call, which the caller evicts and
   * falls back from. Cleared on logout (scoped to the current user's
   * permissions).
   */
  issue_org_cache: {
    columns: {
      // Numeric issue group ID (e.g., "7413562541"). TEXT to sidestep the
      // 2^53 JavaScript number limit if Sentry's group IDs ever exceed it.
      issue_id: { type: "TEXT", primaryKey: true },
      org_slug: { type: "TEXT", notNull: true },
      cached_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },
  project_root_cache: {
    columns: {
      cwd: { type: "TEXT", primaryKey: true },
      project_root: { type: "TEXT", notNull: true },
      reason: { type: "TEXT", notNull: true },
      cwd_mtime: { type: "INTEGER", notNull: true },
      cached_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
      ttl_expires_at: { type: "INTEGER", notNull: true },
    },
  },
  /**
   * Queue for deferred completion telemetry.
   *
   * Shell completions write timing data here (zero Sentry SDK overhead).
   * The next normal CLI run flushes entries as Sentry metrics and deletes them.
   */
  completion_telemetry_queue: {
    columns: {
      id: { type: "INTEGER", primaryKey: true },
      created_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
      command_path: { type: "TEXT", notNull: true },
      duration_ms: { type: "INTEGER", notNull: true },
      result_count: { type: "INTEGER", notNull: true },
    },
  },
};

/** Generate CREATE TABLE DDL from column definitions */
function columnDefsToDDL(
  tableName: string,
  columns: [string, ColumnDef][],
  compositePrimaryKey?: string[]
): string {
  const columnDefs = columns.map(([name, col]) => {
    const parts = [name, col.type];
    if (col.primaryKey) {
      parts.push("PRIMARY KEY");
    }
    if (col.check) {
      parts.push(`CHECK (${col.check})`);
    }
    if (col.notNull) {
      parts.push("NOT NULL");
    }
    if (col.default) {
      parts.push(`DEFAULT ${col.default}`);
    }
    return parts.join(" ");
  });

  if (compositePrimaryKey && compositePrimaryKey.length > 0) {
    columnDefs.push(`PRIMARY KEY (${compositePrimaryKey.join(", ")})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n    ${columnDefs.join(",\n    ")}\n  )`;
}

/** Generate CREATE TABLE DDL from a table schema */
export function generateTableDDL(
  tableName: string,
  schema: TableSchema
): string {
  return columnDefsToDDL(
    tableName,
    Object.entries(schema.columns),
    schema.compositePrimaryKey
  );
}

/**
 * Generate CREATE TABLE DDL excluding columns added in migrations.
 * Useful for testing schema repair by creating "pre-migration" tables.
 *
 * @throws Error if table has no base columns (all columns were added in migrations)
 */
export function generatePreMigrationTableDDL(tableName: string): string {
  const schema = TABLE_SCHEMAS[tableName];
  if (!schema) {
    throw new Error(`Unknown table: ${tableName}`);
  }

  const baseColumns = Object.entries(schema.columns).filter(
    ([, col]) => col.addedInVersion === undefined
  );

  if (baseColumns.length === 0) {
    throw new Error(
      `Table ${tableName} has no base columns (all columns were added in migrations)`
    );
  }

  return columnDefsToDDL(tableName, baseColumns, schema.compositePrimaryKey);
}

/** Generated DDL statements for all tables (used for repair and init) */
export const EXPECTED_TABLES: Record<string, string> = Object.fromEntries(
  Object.entries(TABLE_SCHEMAS).map(([name, schema]) => [
    name,
    generateTableDDL(name, schema),
  ])
);

/** Column info for repair operations */
type RepairColumnDef = { name: string; type: SqliteType };

/**
 * Columns that may need repair (added in migrations).
 * Generated from TABLE_SCHEMAS where addedInVersion is set.
 */
export const EXPECTED_COLUMNS: Record<string, RepairColumnDef[]> =
  Object.fromEntries(
    Object.entries(TABLE_SCHEMAS)
      .map(([tableName, schema]) => {
        const migratedColumns = Object.entries(schema.columns)
          .filter(([, col]) => col.addedInVersion !== undefined)
          .map(([name, col]) => ({ name, type: col.type }));
        return [tableName, migratedColumns] as const;
      })
      .filter(([, cols]) => cols.length > 0)
  );

/** Check if a table exists in the database */
export function tableExists(db: Database, table: string): boolean {
  const result = db
    .query(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?"
    )
    .get(table) as { count: number };
  return result.count > 0;
}

/** Check if a column exists in a table */
export function hasColumn(
  db: Database,
  table: string,
  column: string
): boolean {
  const result = db
    .query(
      `SELECT COUNT(*) as count FROM pragma_table_info('${table}') WHERE name='${column}'`
    )
    .get() as { count: number };
  return result.count > 0;
}

/**
 * Check if a table has the expected composite primary key.
 *
 * Inspects the CREATE TABLE DDL stored in sqlite_master to verify
 * the table has a table-level PRIMARY KEY constraint matching the
 * expected columns. Returns false if the table uses per-column
 * PRIMARY KEY instead (e.g., `command_key TEXT PRIMARY KEY`).
 */
function hasCompositePrimaryKey(
  db: Database,
  table: string,
  expectedColumns: string[]
): boolean {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined;

  if (!row) {
    return false;
  }

  const expectedPK = `PRIMARY KEY (${expectedColumns.join(", ")})`;
  return row.sql.includes(expectedPK);
}

/** Add a column to a table if it doesn't exist */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string
): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Schema issue types for diagnostics */
export type SchemaIssue =
  | { type: "missing_table"; table: string }
  | { type: "missing_column"; table: string; column: string }
  | { type: "wrong_primary_key"; table: string };

function findMissingColumns(db: Database, tableName: string): SchemaIssue[] {
  const columns = EXPECTED_COLUMNS[tableName];
  if (!columns) {
    return [];
  }
  return columns
    .filter((col) => !hasColumn(db, tableName, col.name))
    .map((col) => ({
      type: "missing_column" as const,
      table: tableName,
      column: col.name,
    }));
}

function findPrimaryKeyIssues(db: Database, tableName: string): SchemaIssue[] {
  const schema = TABLE_SCHEMAS[tableName];
  if (
    schema?.compositePrimaryKey &&
    !hasCompositePrimaryKey(db, tableName, schema.compositePrimaryKey)
  ) {
    return [{ type: "wrong_primary_key", table: tableName }];
  }
  return [];
}

/**
 * Check schema and return list of issues.
 * Used for diagnostics and dry-run mode in `sentry cli fix`.
 */
export function getSchemaIssues(db: Database): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  for (const tableName of Object.keys(EXPECTED_TABLES)) {
    if (!tableExists(db, tableName)) {
      issues.push({ type: "missing_table", table: tableName });
      continue;
    }

    issues.push(...findMissingColumns(db, tableName));
    issues.push(...findPrimaryKeyIssues(db, tableName));
  }

  return issues;
}

/** Result of a schema repair operation */
export type RepairResult = {
  fixed: string[];
  failed: string[];
};

function repairMissingTables(db: Database, result: RepairResult): void {
  for (const [tableName, ddl] of Object.entries(EXPECTED_TABLES)) {
    if (tableExists(db, tableName)) {
      continue;
    }
    try {
      db.exec(ddl);
      result.fixed.push(`Created table ${tableName}`);
    } catch (e) {
      const msg = stringifyUnknown(e);
      result.failed.push(`Failed to create table ${tableName}: ${msg}`);
    }
  }
}

function repairMissingColumns(db: Database, result: RepairResult): void {
  for (const [tableName, columns] of Object.entries(EXPECTED_COLUMNS)) {
    if (!tableExists(db, tableName)) {
      continue;
    }
    for (const col of columns) {
      if (hasColumn(db, tableName, col.name)) {
        continue;
      }
      try {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.type}`);
        result.fixed.push(`Added column ${tableName}.${col.name}`);
      } catch (e) {
        const msg = stringifyUnknown(e);
        result.failed.push(
          `Failed to add column ${tableName}.${col.name}: ${msg}`
        );
      }
    }
  }
}

/**
 * Drop and recreate tables that have incorrect primary key constraints.
 *
 * This fixes the CLI-72 bug where pagination_cursors was created with a
 * single-column PK (`command_key TEXT PRIMARY KEY`) instead of the expected
 * composite PK (`PRIMARY KEY (command_key, context)`). SQLite does not
 * support ALTER TABLE to change primary keys, so the table must be dropped
 * and recreated. The data loss is acceptable since pagination cursors are
 * ephemeral (5-minute TTL).
 */
function repairWrongPrimaryKeys(db: Database, result: RepairResult): void {
  for (const [tableName, schema] of Object.entries(TABLE_SCHEMAS)) {
    if (!schema.compositePrimaryKey) {
      continue;
    }
    if (!tableExists(db, tableName)) {
      continue;
    }
    if (hasCompositePrimaryKey(db, tableName, schema.compositePrimaryKey)) {
      continue;
    }
    try {
      db.exec(`DROP TABLE ${tableName}`);
      db.exec(EXPECTED_TABLES[tableName] as string);
      result.fixed.push(
        `Recreated table ${tableName} with correct primary key`
      );
    } catch (e) {
      const msg = stringifyUnknown(e);
      result.failed.push(`Failed to recreate table ${tableName}: ${msg}`);
    }
  }
}

/**
 * Repair schema issues by creating missing tables, adding missing columns,
 * and recreating tables with incorrect primary key constraints.
 *
 * @param db - The raw database connection (not the traced wrapper)
 * @returns Lists of fixed and failed repairs
 */
export function repairSchema(db: Database): RepairResult {
  const result: RepairResult = { fixed: [], failed: [] };

  repairMissingTables(db, result);
  repairMissingColumns(db, result);
  repairWrongPrimaryKeys(db, result);

  if (result.fixed.length > 0) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      db.query("UPDATE schema_version SET version = ?").run(
        CURRENT_SCHEMA_VERSION
      );
    } catch {
      // Ignore version update failures - schema is still fixed
    }
  }

  return result;
}

/** Track if we're currently repairing to prevent infinite loops */
let isRepairing = false;

/**
 * Check if an error is a schema-related SQLite error that can be auto-repaired.
 *
 * Matches by message content rather than error name because the two SQLite
 * backends throw different error types (`node:sqlite` throws a plain `Error`,
 * `node-sqlite3-wasm` throws `SQLite3Error`) but share identical message
 * strings for these cases.
 */
function isSchemaError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("no such column") ||
    msg.includes("no such table") ||
    msg.includes("has no column named") ||
    msg.includes("on conflict clause does not match")
  );
}

/**
 * Check if an error is a SQLite "readonly database" error.
 *
 * This happens when the CLI's local database file or its containing directory
 * lacks write permissions (e.g., installed globally in a protected path,
 * read-only filesystem, or changed permissions).
 *
 * Matches by message content rather than error name because the two SQLite
 * backends throw different error types (`node:sqlite` plain `Error`,
 * `node-sqlite3-wasm` `SQLite3Error`) with identical message strings.
 *
 * Note: this matches the runtime write-time error. The WASM driver can also
 * fail to *open* a read-only DB at construction with a different message
 * ("Could not open the database"); that path is not covered here.
 */
export function isReadonlyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message
    .toLowerCase()
    .includes("attempt to write a readonly database");
}

/** Result of a repair attempt */
export type RepairAttemptResult<T> =
  | { attempted: false }
  | { attempted: true; result: T };

/**
 * Attempt to repair the database schema and retry a failed operation.
 *
 * This function is the core of the auto-repair system. When a database operation
 * fails due to a schema error (missing table/column), this function:
 * 1. Checks if auto-repair is enabled and applicable
 * 2. Runs repairSchema() to fix missing tables/columns
 * 3. Retries the original operation
 *
 * @param operation - The failed operation to retry after repair
 * @param error - The error that triggered the repair attempt
 * @returns An object indicating whether repair was attempted and the result.
 *          When `attempted` is false, the caller should re-throw the original error.
 *          When `attempted` is true, use `result` (which may be undefined for queries
 *          like stmt.get() that legitimately return undefined).
 */
export function tryRepairAndRetry<T>(
  operation: () => T,
  error: unknown
): RepairAttemptResult<T> {
  // Skip repair if disabled via environment variable
  if (getEnv()[NO_AUTO_REPAIR_ENV] === "1") {
    return { attempted: false };
  }

  // Only repair schema-related errors
  if (!isSchemaError(error)) {
    return { attempted: false };
  }

  // Prevent infinite loops if repair itself causes errors
  if (isRepairing) {
    return { attempted: false };
  }

  isRepairing = true;
  let repairSucceeded = false;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // Dynamic imports to avoid circular dependencies with db/index.js
    const { getRawDatabase } = _require("./index.js") as {
      getRawDatabase: () => Database;
    };

    const rawDb = getRawDatabase();
    const { fixed } = repairSchema(rawDb);

    if (fixed.length > 0) {
      logger.info(`Auto-repaired database: ${fixed.join(", ")}`);
      repairSucceeded = true;
    }
  } catch {
    // Repair failed - caller will re-throw original error
  } finally {
    isRepairing = false;
  }

  // Retry operation AFTER try-catch so any new error from operation() propagates
  // instead of being swallowed and replaced with the original error
  if (repairSucceeded) {
    return { attempted: true, result: operation() };
  }

  return { attempted: false };
}

export function initSchema(db: Database): void {
  const ddlStatements = Object.values(EXPECTED_TABLES).join(";\n\n");
  db.exec(ddlStatements);

  const versionRow = db
    .query("SELECT version FROM schema_version LIMIT 1")
    .get() as { version: number } | null;

  if (!versionRow) {
    db.query("INSERT OR IGNORE INTO schema_version (version) VALUES (?)").run(
      CURRENT_SCHEMA_VERSION
    );
  }
}

function getSchemaVersion(db: Database): number {
  const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as {
    version: number;
  } | null;
  return row?.version ?? 0;
}

/**
 * Run migrations for schema changes between versions.
 *
 * Note: Auto-repair handles missing tables/columns as a safety net, but explicit
 * migrations are still needed for:
 * - Data transformations (e.g., splitting a column)
 * - Column renames (requires data copy in SQLite)
 * - Complex constraints
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sequential migration steps are inherently linear
export function runMigrations(db: Database): void {
  const currentVersion = getSchemaVersion(db);

  // Migration 1 -> 2: Add org_regions, user_info, and instance_info tables
  if (currentVersion < 2) {
    db.exec(`
      ${EXPECTED_TABLES.org_regions};
      ${EXPECTED_TABLES.user_info};
      ${EXPECTED_TABLES.instance_info};
    `);
  }

  // Migration 2 -> 3: Add name column to user_info table
  if (currentVersion < 3) {
    addColumnIfMissing(db, "user_info", "name", "TEXT");
  }

  // Migration 3 -> 4: Add detection caching columns to dsn_cache and project_root_cache table
  if (currentVersion < 4) {
    addColumnIfMissing(db, "dsn_cache", "fingerprint", "TEXT");
    addColumnIfMissing(db, "dsn_cache", "all_dsns_json", "TEXT");
    addColumnIfMissing(db, "dsn_cache", "source_mtimes_json", "TEXT");
    addColumnIfMissing(db, "dsn_cache", "dir_mtimes_json", "TEXT");
    addColumnIfMissing(db, "dsn_cache", "root_dir_mtime", "INTEGER");
    addColumnIfMissing(db, "dsn_cache", "ttl_expires_at", "INTEGER");

    db.exec(EXPECTED_TABLES.project_root_cache as string);
  }

  // Migration 4 -> 5: Add pagination_cursors table for --cursor last support
  if (currentVersion < 5) {
    db.exec(EXPECTED_TABLES.pagination_cursors as string);
  }

  // Migration 5 -> 6: Repair pagination_cursors if created with wrong PK (CLI-72)
  // Earlier versions could create the table with a single-column PK instead of
  // the composite PK (command_key, context). DROP + CREATE is safe because
  // pagination cursors are ephemeral (5-minute TTL).
  if (
    currentVersion < 6 &&
    tableExists(db, "pagination_cursors") &&
    !hasCompositePrimaryKey(db, "pagination_cursors", [
      "command_key",
      "context",
    ])
  ) {
    db.exec("DROP TABLE pagination_cursors");
    db.exec(EXPECTED_TABLES.pagination_cursors as string);
  }

  // Migration 6 -> 7: Add project_id column to project_cache for numeric project filtering
  if (currentVersion < 7) {
    addColumnIfMissing(db, "project_cache", "project_id", "TEXT");
  }

  // Migration 7 -> 8: Add org_id column to org_regions for numeric ID lookups
  if (currentVersion < 8) {
    addColumnIfMissing(db, "org_regions", "org_id", "TEXT");
  }

  // Migration 8 -> 9: Add org_name column to org_regions for cached org listing
  if (currentVersion < 9) {
    addColumnIfMissing(db, "org_regions", "org_name", "TEXT");
  }

  // Migration 9 -> 10: Add org_role column to org_regions for cached role lookups
  if (currentVersion < 10) {
    addColumnIfMissing(db, "org_regions", "org_role", "TEXT");
  }

  // Migration 10 -> 11: Add completion_telemetry_queue table
  if (currentVersion < 11) {
    db.exec(EXPECTED_TABLES.completion_telemetry_queue as string);
  }

  // Migration 11 -> 12: Replace pagination_cursors with cursor-stack schema.
  // The old table stored a single cursor string; the new schema stores a JSON
  // array (cursor_stack) + page_index for bidirectional navigation.
  // Cursors are ephemeral (5-min TTL), so DROP + CREATE loses nothing.
  if (currentVersion < 12) {
    if (tableExists(db, "pagination_cursors")) {
      db.exec("DROP TABLE pagination_cursors");
    }
    db.exec(EXPECTED_TABLES.pagination_cursors as string);
  }

  // Migration 12 -> 13: Consolidate defaults into metadata KV table.
  // The single-row `defaults` table was never written by production code.
  // Move any data (from JSON migration or manual DB edits) to metadata,
  // then drop the table. New defaults use metadata keys: defaults.org,
  // defaults.project, defaults.telemetry, defaults.url.
  if (currentVersion < 13 && tableExists(db, "defaults")) {
    const row = db
      .query("SELECT organization, project FROM defaults WHERE id = 1")
      .get() as { organization: string | null; project: string | null } | null;
    if (row?.organization) {
      db.query(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
      ).run("defaults.org", row.organization);
    }
    if (row?.project) {
      db.query(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
      ).run("defaults.project", row.project);
    }
    db.exec("DROP TABLE defaults");
  }

  // Migration 13 -> 14: Add repo_cache table for offline Sentry repository
  // lookups (used by `issue resolve --in @commit` to match git origin →
  // Sentry-registered repo without an extra API round trip).
  if (currentVersion < 14) {
    db.exec(EXPECTED_TABLES.repo_cache as string);
  }

  // Migration 14 -> 15: Add issue_org_cache table for numeric-id → org
  // mappings used by `issue view <numeric-id>` to skip the legacy unscoped
  // `/api/0/issues/{id}/` endpoint on repeat runs.
  if (currentVersion < 15) {
    db.exec(EXPECTED_TABLES.issue_org_cache as string);
  }

  // Migration 15 -> 16: Add host column to auth table for host-scoped tokens.
  // The column is NULL for existing rows; getAuthConfig lazily backfills it
  // with the currently-configured host on first access after upgrade, so
  // users who already have SENTRY_HOST/SENTRY_URL set at upgrade time are
  // migrated cleanly to the host-scoped model.
  if (currentVersion < 16) {
    addColumnIfMissing(db, "auth", "host", "TEXT");
  }

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    db.query("UPDATE schema_version SET version = ?").run(
      CURRENT_SCHEMA_VERSION
    );
  }
}
