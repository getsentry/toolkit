/**
 * Pagination cursor stack for bidirectional `--cursor next` / `--cursor prev` support.
 *
 * Stores a JSON array of page-start cursors ("cursor stack") plus a page index
 * for each (command, context) pair. This enables arbitrary forward/backward
 * navigation through paginated results.
 *
 * Each entry in the stack is an opaque cursor string — it may be a plain
 * Sentry API cursor, a compound cursor (issue list), or an extended cursor
 * with mid-page bookmarks (dashboard list). The stack treats them all equally.
 *
 * Cursors expire after a short TTL to prevent stale pagination.
 */

import { ValidationError } from "../errors.js";
import { CURSOR_KEYWORDS } from "../list-command.js";
import type { ResolvedTarget } from "../resolve-target.js";
import { getApiBaseUrl } from "../sentry-client.js";
import { getDatabase } from "./index.js";
import { safeParseJson } from "./json.js";
import { runUpsert } from "./utils.js";

/** Default TTL for stored cursors: 5 minutes */
const CURSOR_TTL_MS = 5 * 60 * 1000;

/** Direction derived from a `--cursor` flag value. */
export type CursorDirection = "next" | "prev" | "first";

/** Internal row shape from the pagination_cursors table. */
type PaginationCursorRow = {
  command_key: string;
  context: string;
  cursor_stack: string;
  page_index: number;
  expires_at: number;
};

/**
 * Pagination state for a (command, context) pair.
 *
 * The `stack` array contains one entry per visited page:
 * - `stack[0]` = `""` (first page, no cursor)
 * - `stack[1]` = cursor for page 2
 * - `stack[N]` = cursor for page N+1
 *
 * `index` is the page the user is currently viewing (0-based).
 */
export type PaginationState = {
  /** Array of page-start cursors. Index 0 is always `""` (first page). */
  stack: string[];
  /** Index of the currently viewed page (0-based). */
  index: number;
};

// ---------------------------------------------------------------------------
// Stack read / write
// ---------------------------------------------------------------------------

/**
 * Read the current pagination state from the DB.
 *
 * Returns `undefined` if no state exists or the stored state has expired.
 *
 * @param commandKey - Command identifier (e.g., "trace-list")
 * @param contextKey - Serialized query context
 */
export function getPaginationState(
  commandKey: string,
  contextKey: string,
): PaginationState | undefined {
  const db = getDatabase();
  const row = db
    .query(
      "SELECT cursor_stack, page_index, expires_at FROM pagination_cursors WHERE command_key = ? AND context = ?",
    )
    .get(commandKey, contextKey) as PaginationCursorRow | undefined;

  if (!row) {
    return;
  }

  if (row.expires_at <= Date.now()) {
    db.query(
      "DELETE FROM pagination_cursors WHERE command_key = ? AND context = ?",
    ).run(commandKey, contextKey);
    return;
  }

  // Corrupt cursor stacks (partial writes, manual edits, migration drift) must
  // not crash paginated commands. Treat any parse/validation failure as a fresh
  // first page by deleting the bad row and returning a cache miss.
  const stack = safeParseJson<string[]>(
    row.cursor_stack,
    (value): value is string[] => Array.isArray(value),
  );
  if (!stack) {
    db.query(
      "DELETE FROM pagination_cursors WHERE command_key = ? AND context = ?",
    ).run(commandKey, contextKey);
    return;
  }

  return { stack, index: row.page_index };
}

/**
 * Write pagination state to the DB, refreshing the TTL.
 *
 * @param commandKey - Command identifier
 * @param contextKey - Serialized query context
 * @param state - The pagination state to persist
 * @param ttlMs - Time-to-live in milliseconds (default: 5 minutes)
 */
function savePaginationState(
  commandKey: string,
  contextKey: string,
  state: PaginationState,
  ttlMs = CURSOR_TTL_MS,
): void {
  const db = getDatabase();
  runUpsert(
    db,
    "pagination_cursors",
    {
      command_key: commandKey,
      context: contextKey,
      cursor_stack: JSON.stringify(state.stack),
      page_index: state.index,
      expires_at: Date.now() + ttlMs,
    },
    ["command_key", "context"],
  );
}

// ---------------------------------------------------------------------------
// Cursor resolution + state advance
// ---------------------------------------------------------------------------

/**
 * Result from resolving a `--cursor` flag value.
 *
 * `cursor` is `undefined` when the resolved page is the first page (no API
 * cursor needed). `direction` indicates which navigation keyword was used
 * (or `"next"` for raw cursor passthrough).
 */
export type ResolvedCursor = {
  /** API cursor string, or `undefined` for the first page. */
  cursor: string | undefined;
  /** Navigation direction that was resolved. */
  direction: CursorDirection;
};

/**
 * Resolve a `--cursor` flag value to an API cursor and navigation direction.
 *
 * Keyword resolution:
 * - `"next"` / `"last"` — advance to the next stored page
 * - `"prev"` / `"previous"` — go back to the previous page
 * - `"first"` — jump back to the first page
 * - raw string — passthrough (power user: treated as "next" direction)
 * - `undefined` — no flag provided (first page, fresh start → resets state)
 *
 * @param cursorFlag - Raw value of `--cursor` (undefined if not set)
 * @param commandKey - Command identifier for cursor storage
 * @param contextKey - Serialized query context for cursor storage
 * @returns Resolved cursor and direction
 * @throws ValidationError when navigation is impossible (e.g., prev on first page)
 */
export function resolveCursor(
  cursorFlag: string | undefined,
  commandKey: string,
  contextKey: string,
): ResolvedCursor {
  if (!cursorFlag) {
    // No --cursor flag → fresh start. Use "first" so advancePaginationState
    // resets the index to 0 instead of incrementing stale state within TTL.
    return { cursor: undefined, direction: "first" };
  }

  // Raw cursor passthrough (power user)
  if (!CURSOR_KEYWORDS.has(cursorFlag)) {
    return { cursor: cursorFlag, direction: "next" };
  }

  const state = getPaginationState(commandKey, contextKey);

  // "first" — jump to the beginning regardless of state
  if (cursorFlag === "first") {
    return { cursor: undefined, direction: "first" };
  }

  // "next" / "last" — advance one page
  if (cursorFlag === "next" || cursorFlag === "last") {
    if (!state || state.index + 1 >= state.stack.length) {
      throw new ValidationError(
        "No next page saved for this query. Run without --cursor first.",
        "cursor",
      );
    }
    const nextCursor = state.stack[state.index + 1] as string;
    return {
      cursor: nextCursor === "" ? undefined : nextCursor,
      direction: "next",
    };
  }

  // "prev" / "previous" — go back one page
  if (!state || state.index <= 0) {
    throw new ValidationError(
      "Already on the first page — cannot go back further.",
      "cursor",
    );
  }
  const prevCursor = state.stack[state.index - 1] as string;
  return {
    cursor: prevCursor === "" ? undefined : prevCursor,
    direction: "prev",
  };
}

/**
 * Update the cursor stack after a page has been fetched and displayed.
 *
 * Call this after every successful fetch to keep the stack in sync:
 *
 * - **Forward (`"next"`)**: increment index, store `nextCursor` at index+1.
 *   Truncates any entries beyond index+1 (handles back-then-forward correctly).
 * - **Backward (`"prev"`)**: decrement index. `nextCursor` refreshes the
 *   entry at index+1 (in case the data shifted since we last visited).
 * - **First (`"first"`)**: reset index to 0, store `nextCursor` at index 1.
 *   Truncates everything else.
 * - **Fresh start** (no prior state): initialise stack as `["", nextCursor]`
 *   at index 0.
 *
 * When `nextCursor` is `undefined` (last page), the stack is truncated to
 * `index + 1` entries so `-c next` correctly errors with "no next page".
 *
 * @param commandKey - Command identifier
 * @param contextKey - Serialized query context
 * @param direction - Which direction the user navigated
 * @param nextCursor - Cursor for the page after the one just displayed (undefined if last page)
 */
export function advancePaginationState(
  commandKey: string,
  contextKey: string,
  direction: CursorDirection,
  nextCursor: string | undefined,
): void {
  const state = getPaginationState(commandKey, contextKey);

  if (!state) {
    // First page ever — initialise the stack
    const stack = nextCursor ? ["", nextCursor] : [""];
    savePaginationState(commandKey, contextKey, { stack, index: 0 });
    return;
  }

  switch (direction) {
    case "next": {
      const newIndex = state.index + 1;
      // Truncate anything beyond the new position (back-then-forward scenario)
      const stack = state.stack.slice(0, newIndex + 1);
      if (nextCursor) {
        stack[newIndex + 1] = nextCursor;
      }
      savePaginationState(commandKey, contextKey, {
        stack,
        index: newIndex,
      });
      break;
    }

    case "prev": {
      const newIndex = Math.max(0, state.index - 1);
      // Refresh the "next" entry from this position in case data shifted
      const stack = [...state.stack];
      if (nextCursor) {
        stack[newIndex + 1] = nextCursor;
      }
      // Truncate beyond newIndex + 2 to keep only the immediate next
      savePaginationState(commandKey, contextKey, {
        stack: stack.slice(0, nextCursor ? newIndex + 2 : newIndex + 1),
        index: newIndex,
      });
      break;
    }

    case "first": {
      const stack = nextCursor ? ["", nextCursor] : [""];
      savePaginationState(commandKey, contextKey, { stack, index: 0 });
      break;
    }

    default:
      break;
  }
}

/**
 * Remove all stored pagination state for a command and context.
 *
 * Called when results are empty or the listing context has changed.
 *
 * @param commandKey - Command identifier
 * @param contextKey - Serialized query context to clear
 */
export function clearPaginationState(
  commandKey: string,
  contextKey: string,
): void {
  const db = getDatabase();
  db.query(
    "DELETE FROM pagination_cursors WHERE command_key = ? AND context = ?",
  ).run(commandKey, contextKey);
}

/**
 * Check whether a previous page exists in the stored pagination state.
 *
 * Used by commands to decide whether to show the `-c prev` hint.
 *
 * @param commandKey - Command identifier
 * @param contextKey - Serialized query context
 * @returns `true` if the current page index > 0
 */
export function hasPreviousPage(
  commandKey: string,
  contextKey: string,
): boolean {
  const state = getPaginationState(commandKey, contextKey);
  return !!state && state.index > 0;
}

// ---------------------------------------------------------------------------
// Context key builders (unchanged)
// ---------------------------------------------------------------------------

/**
 * Escape a user-provided value for safe inclusion in a context key.
 *
 * Context keys use `|` as a segment delimiter. If user input (e.g., a search
 * query or platform filter) contains `|`, it must be escaped to prevent
 * delimiter injection that could cause cache collisions between different
 * query combinations.
 *
 * @param value - Raw user-provided string
 * @returns Escaped string with `|` replaced by `%7C`
 */
export function escapeContextKeyValue(value: string): string {
  return value.replaceAll("|", "%7C");
}

/**
 * Build a composite context key for pagination cursor storage.
 *
 * Encodes the API host, a type discriminant, a scope string, and optional
 * key-value params (sort, query, period, platform, …) so cursors from
 * different searches are never mixed.
 *
 * @param type  - Discriminant for the kind of listing (e.g. "org", "trace", "multi")
 * @param scope - Scoping string (e.g. org slug, "org/project", sorted target fingerprint)
 * @param params - Optional extra segments. Only defined values are included;
 *   each value is escaped via {@link escapeContextKeyValue}.
 * @returns Composite context key string
 *
 * @example
 * // Simple org-scoped key (equivalent to legacy buildOrgContextKey)
 * buildPaginationContextKey("org", "my-org")
 * // → "host:https://sentry.io|type:org:my-org"
 *
 * // Trace list with sort + query
 * buildPaginationContextKey("trace", "my-org/my-project", { sort: "date", q: "GET" })
 * // → "host:https://sentry.io|type:trace:my-org/my-project|sort:date|q:GET"
 */
export function buildPaginationContextKey(
  type: string,
  scope: string,
  params?: Record<string, string | undefined>,
): string {
  let key = `host:${getApiBaseUrl()}|type:${type}:${scope}`;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) {
        key += `|${name}:${escapeContextKeyValue(value)}`;
      }
    }
  }
  return key;
}

/**
 * Build a context key for org-scoped pagination cursor storage.
 *
 * Encodes the API base URL and org slug so cursors from different hosts or
 * orgs are never mixed up in the cursor cache.
 *
 * @param org - Organization slug
 * @returns Composite context key string
 */
export function buildOrgContextKey(org: string): string {
  return buildPaginationContextKey("org", org);
}

// ---------------------------------------------------------------------------
// Compound cursor utilities — shared between multi-project list commands
// ---------------------------------------------------------------------------

/** Separator for compound cursor entries (pipe — not present in Sentry cursors). */
export const CURSOR_SEP = "|";

/**
 * Encode per-target cursors as a pipe-separated string for storage.
 *
 * The position of each entry matches the **sorted** target order encoded in
 * the context key fingerprint, so we only need to store the cursor values —
 * no org/project metadata is needed in the cursor string itself.
 *
 * Empty string = project exhausted (no more pages).
 *
 * @example "1735689600:0:0||1735689601:0:0" — 3 targets, middle one exhausted
 */
export function encodeCompoundCursor(cursors: (string | null)[]): string {
  return cursors.map((c) => c ?? "").join(CURSOR_SEP);
}

/**
 * Decode a compound cursor string back to an array of per-target cursors.
 *
 * Returns `null` for exhausted entries (empty segments) and `string` for active
 * cursors. Returns an empty array if `raw` is empty or looks like a legacy
 * JSON cursor (starts with `[`), causing a fresh start.
 */
export function decodeCompoundCursor(raw: string): (string | null)[] {
  // Guard against legacy JSON compound cursors or corrupted data
  if (!raw || raw.startsWith("[")) {
    return [];
  }
  return raw.split(CURSOR_SEP).map((s) => (s === "" ? null : s));
}

/**
 * Associate a stored compound cursor with its targets.
 *
 * Missing entries start fresh; empty entries mark exhausted targets. Extra
 * entries are ignored, and legacy JSON cursors start all targets fresh.
 *
 * @param raw - Stored cursor, or undefined for the first page
 * @param sortedKeys - Target keys in the same sorted order used when encoding
 * @returns Resume cursors and the keys of targets that should not be fetched
 */
export function decodeTargetCursors(
  raw: string | undefined,
  sortedKeys: readonly string[],
): { startCursors: Map<string, string>; exhausted: Set<string> } {
  const startCursors = new Map<string, string>();
  const exhausted = new Set<string>();
  for (const [index, cursor] of decodeCompoundCursor(raw ?? "").entries()) {
    const key = sortedKeys[index];
    if (key === undefined) {
      break;
    }
    if (cursor) {
      startCursors.set(key, cursor);
    } else {
      exhausted.add(key);
    }
  }
  return { startCursors, exhausted };
}

/**
 * Build a compound cursor context key encoding the full target set and optional
 * query filters so a cursor from one search is never reused for a different search.
 *
 * @param targets - Resolved org/project targets (sorted internally by key)
 * @param filters - Optional filter parameters for commands that have them
 *   (sort, query, period, limit). When provided they are appended so cursors are
 *   isolated per unique query.
 */
export function buildMultiTargetContextKey(
  targets: ResolvedTarget[],
  filters?: { sort?: string; query?: string; period?: string; limit?: number },
): string {
  const host = getApiBaseUrl();
  const targetFingerprint = targets
    .map((t) => escapeContextKeyValue(`${t.org}/${t.project}`))
    .sort()
    .join(",");
  const base = `host:${host}|type:multi:${targetFingerprint}`;
  if (!filters) {
    return base;
  }
  const escapedPeriod = escapeContextKeyValue(filters.period ?? "90d");
  const escapedSort = filters.sort
    ? escapeContextKeyValue(filters.sort)
    : undefined;
  const escapedQuery = filters.query
    ? escapeContextKeyValue(filters.query)
    : undefined;
  return (
    `${base}` +
    (escapedSort ? `|sort:${escapedSort}` : "") +
    `|period:${escapedPeriod}` +
    (escapedQuery ? `|q:${escapedQuery}` : "") +
    (filters.limit === undefined ? "" : `|limit:${filters.limit}`)
  );
}

/**
 * Build a compound context key for multi-org pagination cursor storage.
 *
 * Analogous to {@link buildMultiTargetContextKey} but keyed by org slugs
 * rather than org/project pairs. Used by metric alert rules and other
 * org-scoped commands that may fetch from multiple orgs simultaneously.
 *
 * Cursors from different org sets or queries are never mixed because the
 * context key encodes both.
 *
 * @param orgs - Organization slugs (sorted internally)
 * @param query - Optional client-side name filter; included so cursors from
 *   different filter values don't collide
 * @returns Composite context key string
 */
export function buildMultiOrgContextKey(
  orgs: string[],
  query: string | undefined,
): string {
  const sortedOrgs = [...orgs].sort().map(escapeContextKeyValue).join(",");
  return buildPaginationContextKey("multi-org", sortedOrgs, { q: query });
}
