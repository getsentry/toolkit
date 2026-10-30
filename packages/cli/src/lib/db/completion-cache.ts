/**
 * Entities seen during normal CLI usage, kept for shell completion.
 *
 * The `__complete` fast path makes no API calls, so it can only suggest what
 * earlier commands already fetched. The API layer records issue short IDs and
 * dashboards here as they are listed or viewed; `src/lib/complete.ts` reads
 * them back. Entries are best-effort hints: a stale one at worst suggests an
 * issue that was since merged or a dashboard that was deleted.
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
 * kind of the arguments that take them: issues by short ID, dashboards by
 * numeric ID, both with the title as description.
 */
export type CompletionEntityKind = "issue" | "dashboard";

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

/** Drop every remembered entity (called on logout). */
export function clearCompletionCache(): void {
  getDatabase().query("DELETE FROM completion_cache").run();
}
