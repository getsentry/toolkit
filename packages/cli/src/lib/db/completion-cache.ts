/**
 * Entities seen during normal CLI usage, kept for shell completion.
 *
 * The `__complete` fast path makes no API calls, so it can only suggest what
 * earlier commands already fetched. The API layer records the entities of
 * {@link CompletionEntityKind} here as they are listed or viewed;
 * `src/lib/complete.ts` reads them back. Entries are best-effort hints: a
 * stale one at worst suggests an issue that was since merged or a release
 * that was deleted.
 *
 * This module is imported by the `__complete` fast path, so it must not pull
 * in the Sentry SDK; best-effort error reporting for writes lives in
 * `src/lib/api/completion-seed.ts`.
 *
 * Storage: `completion_cache` SQLite table (schema v20). Each kind keeps at
 * most {@link MAX_ENTITIES_PER_ORG} entries per org, rows expire with the
 * other caches in `maybeCleanupCaches()`, and logout clears the table.
 */

import { getDatabase, maybeCleanupCaches } from "./index.js";
import { runUpsert } from "./utils.js";

/**
 * Entity types stored for shell completion, named after the completion
 * kind of the arguments that take them. Each is stored as the value those
 * arguments read, with a description:
 *
 * - `issue`: short ID, with the title
 * - `dashboard`: numeric ID, with the title
 * - `environment`: name
 * - `release`: version, with the short version
 * - `team`: slug, with the name
 * - `owner`: `team:<id>` actor, with the team slug
 * - `monitor`: slug, with the name
 * - `workflow`: alert (workflow) ID, with the name
 * - `integration`: native integration ID, with provider and name
 * - `sentry-app`: installed Sentry App slug, with the name
 * - `app-link-field`: `name=` of a field of a Sentry App's issue-link
 *   form, and `name=value` for its fixed choices, with the app
 * - `dsn`: public DSN of a client key, with the key name
 * - `tag-key`: key of a tag seen on an issue, with its label
 * - `span-attribute`, `log-attribute`, `metric-attribute`: key of an
 *   attribute of the spans, logs, or trace metrics dataset, as `--field`
 *   and `--query` take it, with its type
 */
export type CompletionEntityKind =
  | "issue"
  | "dashboard"
  | "environment"
  | "release"
  | "team"
  | "owner"
  | "monitor"
  | "workflow"
  | "integration"
  | "sentry-app"
  | "app-link-field"
  | "dsn"
  | "tag-key"
  | "span-attribute"
  | "log-attribute"
  | "metric-attribute";

/** Most recently seen entries kept per kind and org. */
export const MAX_ENTITIES_PER_ORG = 500;

/** One entity to remember for completion. */
export type CompletionEntity = {
  /** Text the shell inserts (e.g. `CLI-1A2` or a dashboard ID). */
  value: string;
  /** Description shown next to the value (e.g. the issue title). */
  label?: string;
};

/** A remembered entity together with the org it belongs to. */
export type CachedCompletionEntity = CompletionEntity & { orgSlug: string };

type CompletionCacheRow = {
  org_slug: string;
  value: string;
  label: string | null;
};

/**
 * Remember entities for shell completion.
 *
 * Entries earlier in `entities` are treated as more recent, so a list keeps
 * its API order when completion shows the most recent entries first. Only
 * the newest {@link MAX_ENTITIES_PER_ORG} entries per kind and org are kept.
 *
 * @param kind - Entity type
 * @param orgSlug - Organization that owns the entities
 * @param entities - Entities in display order; entries without a value are skipped
 */
export function cacheCompletionEntities(
  kind: CompletionEntityKind,
  orgSlug: string,
  entities: readonly CompletionEntity[],
): void {
  const valid = entities
    .filter((entity) => entity.value)
    .slice(0, MAX_ENTITIES_PER_ORG);
  if (!orgSlug || valid.length === 0) {
    return;
  }

  const db = getDatabase();
  db.transaction(() => {
    // Rank this batch above everything already stored, even when two writes
    // land in the same millisecond, so the newest batch always sorts first.
    const latest = db
      .query(
        "SELECT MAX(last_seen) AS latest FROM completion_cache WHERE kind = ? AND org_slug = ?",
      )
      .get(kind, orgSlug) as { latest: number | null } | undefined;
    const now = Math.max(Date.now(), (latest?.latest ?? 0) + valid.length);
    valid.forEach((entity, index) => {
      runUpsert(
        db,
        "completion_cache",
        {
          kind,
          org_slug: orgSlug,
          value: entity.value,
          label: entity.label ?? null,
          last_seen: now - index,
        },
        ["kind", "org_slug", "value"],
      );
    });
    db.query(
      `DELETE FROM completion_cache
       WHERE kind = ? AND org_slug = ? AND rowid NOT IN (
         SELECT rowid FROM completion_cache
         WHERE kind = ? AND org_slug = ?
         ORDER BY last_seen DESC
         LIMIT ?
       )`,
    ).run(kind, orgSlug, kind, orgSlug, MAX_ENTITIES_PER_ORG);
  })();
  maybeCleanupCaches();
}

/**
 * Read remembered entities of one kind, most recently seen first.
 *
 * @param kind - Entity type
 * @param orgSlugs - Only return entities from these orgs
 */
export function getCachedCompletionEntities(
  kind: CompletionEntityKind,
  orgSlugs: readonly string[],
): CachedCompletionEntity[] {
  if (orgSlugs.length === 0) {
    return [];
  }
  const placeholders = orgSlugs.map(() => "?").join(", ");
  const rows = getDatabase()
    .query(
      `SELECT org_slug, value, label FROM completion_cache
       WHERE kind = ? AND org_slug IN (${placeholders})
       ORDER BY last_seen DESC`,
    )
    .all(kind, ...orgSlugs) as CompletionCacheRow[];

  return rows.map((row) => ({
    orgSlug: row.org_slug,
    value: row.value,
    label: row.label ?? undefined,
  }));
}

/**
 * When an entity of `kind` from `orgSlug` was last stored, or `undefined`
 * when none is.
 */
export function getLatestCompletionSeen(
  kind: CompletionEntityKind,
  orgSlug: string,
): number | undefined {
  const row = getDatabase()
    .query(
      "SELECT MAX(last_seen) AS latest FROM completion_cache WHERE kind = ? AND org_slug = ?",
    )
    .get(kind, orgSlug) as { latest: number | null } | undefined;
  return row?.latest ?? undefined;
}

/**
 * Orgs the user worked in since `since`, most recent first: orgs of the
 * projects commands resolved, and of the entities they listed or viewed.
 * Entities of `exceptKinds` are left out, so a cache warm-up does not count
 * as use of the org it warms.
 */
export function getRecentlyUsedOrgs(
  since: number,
  exceptKinds: readonly CompletionEntityKind[] = [],
): string[] {
  const kindFilter = exceptKinds.length
    ? `AND kind NOT IN (${exceptKinds.map(() => "?").join(", ")})`
    : "";
  const rows = getDatabase()
    .query(
      `SELECT org_slug, MAX(used) AS used FROM (
         SELECT org_slug, last_accessed AS used FROM project_cache
         WHERE last_accessed >= ?
         UNION ALL
         SELECT org_slug, last_seen AS used FROM completion_cache
         WHERE last_seen >= ? ${kindFilter}
       )
       GROUP BY org_slug
       ORDER BY used DESC, org_slug`,
    )
    .all(since, since, ...exceptKinds) as { org_slug: string }[];
  return rows.map((row) => row.org_slug);
}

/** Drop every remembered entity (called on logout). */
export function clearCompletionCache(): void {
  getDatabase().query("DELETE FROM completion_cache").run();
}
