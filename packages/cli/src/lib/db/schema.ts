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
import { uuidv7 } from "uuidv7";
import { getEnv } from "../env.js";
import { stringifyUnknown } from "../errors.js";
import { logger } from "../logger.js";
import { storedCredentialIdentity } from "./identity-hash.js";
import type { Database } from "./sqlite.js";

const _require = createRequire(import.meta.url);

export const CURRENT_SCHEMA_VERSION = 19;

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
  /**
   * The table only holds data the CLI can fetch or detect again, so repair
   * may drop and recreate it when its shape is wrong or a newer CLI wrote it.
   */
  rebuildable?: boolean;
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
  /**
   * Stored Sentry accounts (one row per login). Replaces the single-row
   * `auth` and `user_info` tables in schema v18.
   *
   * Exactly one row is active at a time (`is_active = 1`); every
   * credential read targets that row. `user_id` is NULL until the login
   * flow learns who the token belongs to. Rows sharing `(host, user_id)`
   * are deduplicated when user info is recorded, so re-logging in to the
   * same account updates it instead of adding a duplicate.
   */
  accounts: {
    columns: {
      account_id: { type: "TEXT", primaryKey: true },
      // Origin URL (scheme://host[:port]) this token was issued against.
      // Enforced at the fetch layer: credentials are only attached to requests
      // whose origin matches this host (with SaaS equivalence). NULL only for
      // rows migrated from pre-v16 `auth` rows; backfilled lazily on read.
      host: { type: "TEXT" },
      user_id: { type: "TEXT" },
      email: { type: "TEXT" },
      username: { type: "TEXT" },
      name: { type: "TEXT" },
      token: { type: "TEXT" },
      refresh_token: { type: "TEXT" },
      expires_at: { type: "INTEGER" },
      issued_at: { type: "INTEGER" },
      is_active: { type: "INTEGER", notNull: true, default: "0" },
      created_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
      updated_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
      // When this account last became active (login, switch, or logout
      // promotion). Logout promotes the most recently used account.
      last_used_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
  },

  project_cache: {
    rebuildable: true,
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
    rebuildable: true,
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
    rebuildable: true,
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
    rebuildable: true,
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
    rebuildable: true,
    columns: {
      org_slug: { type: "TEXT", notNull: true },
      org_id: { type: "TEXT", addedInVersion: 8 },
      org_name: { type: "TEXT", addedInVersion: 9 },
      org_role: { type: "TEXT", addedInVersion: 10 },
      region_url: { type: "TEXT", notNull: true },
      credential_identity: { type: "TEXT", notNull: true, addedInVersion: 17 },
      account_id: { type: "TEXT", addedInVersion: 19 },
      source_origin: { type: "TEXT", notNull: true, addedInVersion: 17 },
      response_origin: { type: "TEXT", notNull: true, addedInVersion: 17 },
      updated_at: {
        type: "INTEGER",
        notNull: true,
        default: "(unixepoch() * 1000)",
      },
    },
    compositePrimaryKey: ["credential_identity", "source_origin", "org_slug"],
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
    rebuildable: true,
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
    rebuildable: true,
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
    rebuildable: true,
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
  compositePrimaryKey?: string[],
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
  schema: TableSchema,
): string {
  return columnDefsToDDL(
    tableName,
    Object.entries(schema.columns),
    schema.compositePrimaryKey,
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
    ([, col]) => col.addedInVersion === undefined,
  );

  if (baseColumns.length === 0) {
    throw new Error(
      `Table ${tableName} has no base columns (all columns were added in migrations)`,
    );
  }

  return columnDefsToDDL(tableName, baseColumns, schema.compositePrimaryKey);
}

/** Generated DDL statements for all tables (used for repair and init) */
export const EXPECTED_TABLES: Record<string, string> = Object.fromEntries(
  Object.entries(TABLE_SCHEMAS).map(([name, schema]) => [
    name,
    generateTableDDL(name, schema),
  ]),
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
      .filter(([, cols]) => cols.length > 0),
  );

/** Check if a table exists in the database */
export function tableExists(db: Database, table: string): boolean {
  const result = db
    .query(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(table) as { count: number };
  return result.count > 0;
}

/** Check if a column exists in a table */
export function hasColumn(
  db: Database,
  table: string,
  column: string,
): boolean {
  const result = db
    .query(
      `SELECT COUNT(*) as count FROM pragma_table_info('${table}') WHERE name='${column}'`,
    )
    .get() as { count: number };
  return result.count > 0;
}

/** Primary key columns a table schema declares, in key order. */
function declaredPrimaryKey(schema: TableSchema): string[] {
  return (
    schema.compositePrimaryKey ??
    Object.entries(schema.columns)
      .filter(([, col]) => col.primaryKey)
      .map(([name]) => name)
  );
}

/**
 * Check if a table's primary key is exactly `expectedColumns`, in order.
 *
 * Reads `pragma_table_info`, so single-column and composite keys compare the
 * same way. A table written by another CLI version can have a different key
 * with the same columns, which makes `ON CONFLICT` upserts fail.
 */
function hasPrimaryKey(
  db: Database,
  table: string,
  expectedColumns: string[],
): boolean {
  const rows = db
    .query(
      `SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`,
    )
    .all() as { name: string }[];
  return (
    rows.length === expectedColumns.length &&
    rows.every((row, i) => row.name === expectedColumns[i])
  );
}

/** Add a column to a table if it doesn't exist */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Schema issue types for diagnostics */
export type SchemaIssue =
  | { type: "missing_table"; table: string }
  | { type: "missing_column"; table: string; column: string }
  | { type: "wrong_primary_key"; table: string }
  | { type: "newer_schema"; version: number };

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
  if (schema && !hasPrimaryKey(db, tableName, declaredPrimaryKey(schema))) {
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

  const storedVersion = getSchemaVersion(db);
  if (storedVersion > CURRENT_SCHEMA_VERSION) {
    issues.push({ type: "newer_schema", version: storedVersion });
  }

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
          `Failed to add column ${tableName}.${col.name}: ${msg}`,
        );
      }
    }
  }
}

/**
 * Drop and recreate rebuildable tables that have the wrong primary key.
 *
 * SQLite cannot ALTER a primary key, so the table must be recreated. This
 * covers CLI-72 (pagination_cursors created with a single-column PK) and a
 * table whose key changed in another CLI version (#1611: `org_regions` from
 * a newer CLI). Tables holding data the CLI cannot rebuild are reported
 * instead of dropped.
 */
function repairWrongPrimaryKeys(db: Database, result: RepairResult): void {
  for (const [tableName, schema] of Object.entries(TABLE_SCHEMAS)) {
    if (!tableExists(db, tableName)) {
      continue;
    }
    if (hasPrimaryKey(db, tableName, declaredPrimaryKey(schema))) {
      continue;
    }
    if (!schema.rebuildable) {
      result.failed.push(
        `Table ${tableName} has an unexpected primary key and holds data that cannot be rebuilt`,
      );
      continue;
    }
    try {
      db.exec(`DROP TABLE ${tableName}`);
      db.exec(EXPECTED_TABLES[tableName] as string);
      result.fixed.push(
        `Recreated table ${tableName} with correct primary key`,
      );
    } catch (e) {
      const msg = stringifyUnknown(e);
      result.failed.push(`Failed to recreate table ${tableName}: ${msg}`);
    }
  }
}

/** Names of tables that only hold data the CLI can fetch or detect again. */
const REBUILDABLE_TABLES = Object.entries(TABLE_SCHEMAS)
  .filter(([, schema]) => schema.rebuildable)
  .map(([name]) => name);

/**
 * Rebuild every cache table when a newer CLI last wrote the database.
 *
 * A newer CLI can change what cached rows mean without changing their
 * shape, so this version cannot trust them. Caches refill on demand.
 */
function rebuildCachesFromNewerSchema(
  db: Database,
  result: RepairResult,
): void {
  const storedVersion = getSchemaVersion(db);
  if (storedVersion <= CURRENT_SCHEMA_VERSION) {
    return;
  }
  try {
    db.transaction(() => {
      for (const tableName of REBUILDABLE_TABLES) {
        db.exec(`DROP TABLE IF EXISTS ${tableName}`);
        db.exec(EXPECTED_TABLES[tableName] as string);
      }
    })();
    result.fixed.push(
      `Rebuilt cached data written by a newer CLI (schema ${storedVersion})`,
    );
  } catch (e) {
    const msg = stringifyUnknown(e);
    result.failed.push(`Failed to rebuild cache tables: ${msg}`);
  }
}

/**
 * Repair schema issues by creating missing tables, adding missing columns,
 * and recreating tables with incorrect primary key constraints. When a newer
 * CLI last wrote the database, every cache table is rebuilt first.
 *
 * Any fix sets the stored version to {@link CURRENT_SCHEMA_VERSION}, so a
 * newer CLI re-runs its later migrations against what this version wrote.
 *
 * @param db - The raw database connection (not the traced wrapper)
 * @returns Lists of fixed and failed repairs
 */
export function repairSchema(db: Database): RepairResult {
  const result: RepairResult = { fixed: [], failed: [] };

  rebuildCachesFromNewerSchema(db, result);
  repairMissingTables(db, result);
  repairMissingColumns(db, result);
  repairWrongPrimaryKeys(db, result);

  if (result.fixed.length > 0) {
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      db.query("UPDATE schema_version SET version = ?").run(
        CURRENT_SCHEMA_VERSION,
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
  error: unknown,
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
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
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
      CURRENT_SCHEMA_VERSION,
    );
  }
}

function getSchemaVersion(db: Database): number {
  if (!tableExists(db, "schema_version")) {
    return 0;
  }
  const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as {
    version: number;
  } | null;
  return row?.version ?? 0;
}

type LegacyAuthRow = {
  token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  issued_at: number | null;
  updated_at: number | null;
  host: string | null;
};

type LegacyUserRow = {
  user_id: string | null;
  email: string | null;
  username: string | null;
  name: string | null;
};

/**
 * Copy the pre-v18 single-row credential (`auth`) and identity
 * (`user_info`) into one active `accounts` row, then drop both tables.
 *
 * A NULL `host` (rows from before v16) is carried over as-is; the auth
 * layer backfills it lazily from the boot-time URL snapshot.
 */
/** Tag cached org rows with the stored account whose credentials wrote them. */
function backfillOrgRegionAccounts(db: Database): void {
  if (!tableExists(db, "accounts")) {
    return;
  }
  const accounts = db
    .query("SELECT account_id, token, refresh_token FROM accounts")
    .all() as {
    account_id: string;
    token: string | null;
    refresh_token: string | null;
  }[];
  const update = db.query(
    "UPDATE org_regions SET account_id = ? WHERE credential_identity = ? AND account_id IS NULL",
  );
  for (const account of accounts) {
    const identity = storedCredentialIdentity(account);
    if (identity) {
      update.run(account.account_id, identity);
    }
  }
}

function migrateSingleAuthToAccounts(db: Database): void {
  db.exec(EXPECTED_TABLES.accounts as string);

  const auth = tableExists(db, "auth")
    ? (db
        .query(
          `SELECT token, refresh_token, expires_at, issued_at, updated_at, ${
            hasColumn(db, "auth", "host") ? "host" : "NULL AS host"
          } FROM auth WHERE id = 1`,
        )
        .get() as LegacyAuthRow | undefined)
    : undefined;
  const user =
    auth?.token && tableExists(db, "user_info")
      ? (db
          .query(
            `SELECT user_id, email, username, ${
              hasColumn(db, "user_info", "name") ? "name" : "NULL AS name"
            } FROM user_info WHERE id = 1`,
          )
          .get() as LegacyUserRow | undefined)
      : undefined;

  if (auth?.token) {
    const now = Date.now();
    // A newer CLI hands its active login back through `auth` before a
    // downgrade (see prepareDatabaseForDowngrade), so on the way back up the
    // login may already exist. Refresh that row instead of duplicating it.
    const existing = db
      .query(
        `SELECT account_id FROM accounts
         WHERE token = ? OR (user_id IS NOT NULL AND user_id = ? AND host IS ?)
         LIMIT 1`,
      )
      .get(auth.token, user?.user_id ?? null, auth.host) as
      | { account_id: string }
      | undefined;
    db.query("UPDATE accounts SET is_active = 0").run();
    if (existing) {
      db.query(
        `UPDATE accounts SET token = ?, refresh_token = ?, expires_at = ?,
          issued_at = ?, is_active = 1, updated_at = ?, last_used_at = ?
         WHERE account_id = ?`,
      ).run(
        auth.token,
        auth.refresh_token,
        auth.expires_at,
        auth.issued_at,
        auth.updated_at ?? now,
        now,
        existing.account_id,
      );
    } else {
      db.query(
        `INSERT INTO accounts (account_id, host, user_id, email, username, name,
        token, refresh_token, expires_at, issued_at, is_active, created_at, updated_at,
        last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        uuidv7(),
        auth.host,
        user?.user_id ?? null,
        user?.email ?? null,
        user?.username ?? null,
        user?.name ?? null,
        auth.token,
        auth.refresh_token,
        auth.expires_at,
        auth.issued_at,
        now,
        auth.updated_at ?? now,
        now,
      );
    }
  }

  db.exec("DROP TABLE IF EXISTS auth");
  db.exec("DROP TABLE IF EXISTS user_info");
}

/**
 * Newest schema an older CLI can read without knowing about `accounts` or
 * org-region provenance: v17 rebuilt `org_regions` with a new key and v18
 * moved the login out of `auth`.
 */
const PRE_ACCOUNTS_SCHEMA_VERSION = 16;

/** `auth` and `user_info` as CLI versions before schema v18 read them. */
const LEGACY_AUTH_DDL = `CREATE TABLE auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    issued_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    host TEXT
  )`;
const LEGACY_USER_INFO_DDL = `CREATE TABLE user_info (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_id TEXT NOT NULL,
    email TEXT,
    username TEXT,
    name TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`;

/** Copy the active account into the single-row tables older CLIs read. */
function exportActiveAccountToLegacyTables(db: Database): void {
  db.exec("DROP TABLE IF EXISTS auth");
  db.exec("DROP TABLE IF EXISTS user_info");
  db.exec(LEGACY_AUTH_DDL);
  db.exec(LEGACY_USER_INFO_DDL);

  const account = db
    .query(
      `SELECT host, user_id, email, username, name, token, refresh_token,
        expires_at, issued_at, updated_at
       FROM accounts WHERE is_active = 1 LIMIT 1`,
    )
    .get() as (LegacyAuthRow & LegacyUserRow) | undefined;
  if (!account?.token) {
    return;
  }

  db.query(
    `INSERT INTO auth (id, token, refresh_token, expires_at, issued_at, updated_at, host)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account.token,
    account.refresh_token,
    account.expires_at,
    account.issued_at,
    account.updated_at ?? Date.now(),
    account.host,
  );
  if (account.user_id) {
    db.query(
      "INSERT INTO user_info (id, user_id, email, username, name) VALUES (1, ?, ?, ?, ?)",
    ).run(account.user_id, account.email, account.username, account.name);
  }
}

/**
 * Leave the database readable by an older CLI before `sentry cli upgrade`
 * installs one (#1611).
 *
 * Older CLIs only migrate forward and create missing tables with
 * `CREATE TABLE IF NOT EXISTS`, so this:
 * - drops every cache table, letting the older CLI recreate them in its own
 *   shape (v17 changed the `org_regions` key, which breaks older upserts);
 * - copies the active login into the pre-v18 `auth`/`user_info` tables, so
 *   the older CLI stays logged in;
 * - sets the stored version to {@link PRE_ACCOUNTS_SCHEMA_VERSION}, so this
 *   CLI re-runs its later migrations when it comes back and picks up any
 *   login or token refresh the older CLI wrote to `auth`.
 *
 * Every migration after that version must therefore be safe to re-run.
 */
export function prepareDatabaseForDowngrade(db: Database): void {
  db.transaction(() => {
    for (const tableName of REBUILDABLE_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    }
    if (tableExists(db, "accounts")) {
      exportActiveAccountToLegacyTables(db);
    }
    db.query("UPDATE schema_version SET version = ?").run(
      PRE_ACCOUNTS_SCHEMA_VERSION,
    );
  })();
}

/**
 * Make a database last written by a newer CLI usable by this version.
 *
 * Older CLIs never ran this check, so a downgrade left upserts failing
 * against tables whose key had changed (#1611). Repair rebuilds the caches
 * and records this version, so the newer CLI re-migrates when it returns.
 */
function adaptNewerSchema(db: Database, storedVersion: number): void {
  const versions = `schema ${storedVersion}; this CLI uses ${CURRENT_SCHEMA_VERSION}`;
  if (getEnv()[NO_AUTO_REPAIR_ENV] === "1") {
    logger.warn(
      `The local database was written by a newer Sentry CLI (${versions}). Run \`sentry cli fix\` to adapt it.`,
    );
    return;
  }
  const { failed } = repairSchema(db);
  if (failed.length > 0) {
    logger.warn(
      `Could not adapt the local database written by a newer Sentry CLI (${versions}): ${failed.join("; ")}. Run \`sentry cli fix\`.`,
    );
    return;
  }
  logger.info(
    `The local database was written by a newer Sentry CLI (${versions}). Cleared cached data so this version can use it.`,
  );
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
// sequential migration steps are inherently linear
export function runMigrations(db: Database): void {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    adaptNewerSchema(db, currentVersion);
    return;
  }

  // Migration 1 -> 2: Add org_regions and instance_info tables. The
  // `user_info` table this step also created was folded into `accounts` in v18.
  if (currentVersion < 2) {
    db.exec(`
      ${EXPECTED_TABLES.org_regions};
      ${EXPECTED_TABLES.instance_info};
    `);
  }

  // Migration 2 -> 3: Add name column to user_info table
  if (currentVersion < 3 && tableExists(db, "user_info")) {
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
    !hasPrimaryKey(db, "pagination_cursors", ["command_key", "context"])
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
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
      ).run("defaults.org", row.organization);
    }
    if (row?.project) {
      db.query(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
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
  // The column is NULL for existing rows; the first credential read backfills
  // it from the boot-time explicit host (or SaaS), before later config shims
  // can change SENTRY_URL.
  if (currentVersion < 16 && tableExists(db, "auth")) {
    addColumnIfMissing(db, "auth", "host", "TEXT");
  }

  // Legacy region rows have no credential or response provenance. Rebuild the
  // reconstructible cache rather than assigning foreign data to a new login.
  if (currentVersion < 17) {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS org_regions");
      db.exec(EXPECTED_TABLES.org_regions as string);
    })();
  }

  // Migration 17 -> 18: Multi-account support. Fold the single-row `auth`
  // and `user_info` tables into `accounts`; the migrated login stays active.
  if (currentVersion < 18) {
    db.transaction(() => migrateSingleAuthToAccounts(db))();
  }

  // Migration 18 -> 19: Record which account each cached org belongs to, so
  // commands targeting an org can use that account without a manual switch.
  if (currentVersion < 19) {
    db.transaction(() => {
      addColumnIfMissing(db, "org_regions", "account_id", "TEXT");
      backfillOrgRegionAccounts(db);
    })();
  }

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    db.query("UPDATE schema_version SET version = ?").run(
      CURRENT_SCHEMA_VERSION,
    );
  }
}
