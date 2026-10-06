/**
 * One-time migration from config.json to SQLite.
 */

import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const _require = createRequire(import.meta.url);

import { normalizeAuthToken } from "../auth-header.js";
import { MalformedAuthTokenError } from "../errors.js";
import { logger } from "../logger.js";
import { getConfigDir } from "./index.js";
import type { Database } from "./sqlite.js";

const log = logger.withTag("migration");

const OLD_CONFIG_FILENAME = "config.json";
const MIGRATION_COMPLETED_KEY = "json_migration_completed";

/**
 * Check if migration was already completed by looking at SQLite metadata.
 * This is the authoritative source - not the presence of config.json.
 */
function isMigrationCompleted(db: Database): boolean {
  const row = db
    .query("SELECT value FROM metadata WHERE key = ?")
    .get(MIGRATION_COMPLETED_KEY) as { value: string } | null;
  return row?.value === "true";
}

/** Mark migration as completed in SQLite metadata. */
function markMigrationCompleted(db: Database): void {
  db.query("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
    MIGRATION_COMPLETED_KEY,
    "true",
  );
}

function oldConfigExists(): boolean {
  const configPath = join(getConfigDir(), OLD_CONFIG_FILENAME);
  const { existsSync } = _require("node:fs");
  return existsSync(configPath);
}

function readOldConfig(): OldConfig | null {
  const configPath = join(getConfigDir(), OLD_CONFIG_FILENAME);
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const { readFileSync } = _require("node:fs");
    const content = readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Attempt to delete the old config.json file.
 * Returns true if deletion succeeded (or file was already gone), false otherwise.
 */
function deleteOldConfig(): boolean {
  const configPath = join(getConfigDir(), OLD_CONFIG_FILENAME);
  try {
    rmSync(configPath);
    return true;
  } catch (error) {
    // ENOENT means file already deleted - that's fine
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    // Other errors (permissions, locked file) - deletion failed
    log.warn("Could not delete old config.json:", error);
    return false;
  }
}

type OldConfig = {
  auth?: {
    token?: unknown;
    refreshToken?: string;
    expiresAt?: number;
    issuedAt?: number;
  };
  defaults?: {
    organization?: string;
    project?: string;
  };
  projectCache?: Record<
    string,
    {
      orgSlug: string;
      orgName: string;
      projectSlug: string;
      projectName: string;
      cachedAt: number;
    }
  >;
  dsnCache?: Record<
    string,
    {
      dsn: string;
      projectId: string;
      orgId?: string;
      source: string;
      sourcePath?: string;
      resolved?: {
        orgSlug: string;
        orgName: string;
        projectSlug: string;
        projectName: string;
      };
      cachedAt: number;
    }
  >;
  projectAliases?: {
    aliases: Record<string, { orgSlug: string; projectSlug: string }>;
    cachedAt: number;
    dsnFingerprint?: string;
  };
};

/** Migrate once, retaining the original file and skipping auth if its access token is malformed. */
// one-time migration
export function migrateFromJson(db: Database): void {
  // Check SQLite metadata first - this is the authoritative source
  if (isMigrationCompleted(db)) {
    return;
  }

  // No old config file means nothing to migrate
  if (!oldConfigExists()) {
    // Mark as completed so we don't check every time
    markMigrationCompleted(db);
    return;
  }

  const oldConfig = readOldConfig();
  if (!oldConfig) {
    // Config exists but couldn't be read (corrupted?) - mark complete to avoid retry loops
    markMigrationCompleted(db);
    return;
  }

  let token: string | undefined;
  let invalidAuthToken = false;
  if (oldConfig.auth?.token !== undefined) {
    try {
      if (typeof oldConfig.auth.token !== "string") {
        throw new MalformedAuthTokenError();
      }
      token = normalizeAuthToken(oldConfig.auth.token);
    } catch (error) {
      if (!(error instanceof MalformedAuthTokenError)) {
        throw error;
      }
      // Do not block DB initialization (including login/logout) on a bad
      // credential. Preserve the original file instead of binding a token
      // that SQLite could truncate at an embedded NUL.
      invalidAuthToken = true;
    }
  }

  log.info("Migrating config to SQLite...");

  db.exec("BEGIN TRANSACTION");

  try {
    if (token && oldConfig.auth) {
      // Direct write (not via setAuthToken) — safe only because migration
      // runs during DB bootstrap, before getIdentityFingerprint() memoizes.
      db.query(`
        INSERT OR REPLACE INTO auth (id, token, refresh_token, expires_at, issued_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        token,
        oldConfig.auth.refreshToken ?? null,
        oldConfig.auth.expiresAt ?? null,
        oldConfig.auth.issuedAt ?? null,
        Date.now(),
      );
    }

    if (oldConfig.defaults?.organization) {
      db.query(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
      ).run("defaults.org", oldConfig.defaults.organization);
    }
    if (oldConfig.defaults?.project) {
      db.query(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
      ).run("defaults.project", oldConfig.defaults.project);
    }

    if (oldConfig.projectCache) {
      const insertStmt = db.query(`
        INSERT OR REPLACE INTO project_cache 
        (cache_key, org_slug, org_name, project_slug, project_name, cached_at, last_accessed)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [key, entry] of Object.entries(oldConfig.projectCache)) {
        // Skip malformed entries missing required fields
        if (
          !(
            entry?.orgSlug &&
            entry?.orgName &&
            entry?.projectSlug &&
            entry?.projectName
          ) ||
          entry?.cachedAt === null ||
          entry?.cachedAt === undefined
        ) {
          continue;
        }
        insertStmt.run(
          key,
          entry.orgSlug,
          entry.orgName,
          entry.projectSlug,
          entry.projectName,
          entry.cachedAt,
          entry.cachedAt, // last_accessed = cachedAt for migrated entries
        );
      }
    }

    if (oldConfig.dsnCache) {
      const insertStmt = db.query(`
        INSERT OR REPLACE INTO dsn_cache 
        (directory, dsn, project_id, org_id, source, source_path,
         resolved_org_slug, resolved_org_name, resolved_project_slug, resolved_project_name,
         cached_at, last_accessed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [directory, entry] of Object.entries(oldConfig.dsnCache)) {
        // Skip malformed entries missing required fields
        if (
          !(entry?.dsn && entry?.projectId && entry?.source) ||
          entry?.cachedAt === null ||
          entry?.cachedAt === undefined
        ) {
          continue;
        }
        insertStmt.run(
          directory,
          entry.dsn,
          entry.projectId,
          entry.orgId ?? null,
          entry.source,
          entry.sourcePath ?? null,
          entry.resolved?.orgSlug ?? null,
          entry.resolved?.orgName ?? null,
          entry.resolved?.projectSlug ?? null,
          entry.resolved?.projectName ?? null,
          entry.cachedAt,
          entry.cachedAt,
        );
      }
    }

    if (oldConfig.projectAliases?.aliases) {
      const insertStmt = db.query(`
        INSERT OR REPLACE INTO project_aliases 
        (alias, org_slug, project_slug, dsn_fingerprint, cached_at, last_accessed)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const fingerprint = oldConfig.projectAliases.dsnFingerprint ?? null;
      const cachedAt = oldConfig.projectAliases.cachedAt;

      // Skip all aliases if cachedAt is missing (required for NOT NULL column)
      if (cachedAt !== null && cachedAt !== undefined) {
        for (const [alias, entry] of Object.entries(
          oldConfig.projectAliases.aliases,
        )) {
          // Skip malformed entries missing required fields
          if (!(entry?.orgSlug && entry?.projectSlug)) {
            continue;
          }
          insertStmt.run(
            alias.toLowerCase(),
            entry.orgSlug,
            entry.projectSlug,
            fingerprint,
            cachedAt,
            cachedAt,
          );
        }
      }
    }

    // Mark migration as completed in SQLite BEFORE attempting file deletion.
    // This ensures we never re-run migration even if file deletion fails.
    markMigrationCompleted(db);
    db.exec("COMMIT");

    if (invalidAuthToken) {
      log.warn(
        "Malformed authentication credentials were not migrated. The original config.json was kept. " +
          "Run 'sentry auth login' to authenticate again, then remove the old file.",
      );
    } else {
      // Best-effort cleanup: SQLite metadata prevents re-import if it fails.
      deleteOldConfig();
    }
    log.success("Migration complete.");
  } catch (error) {
    db.exec("ROLLBACK");
    log.error("Migration failed, keeping config.json:", error);
    throw error;
  }
}
