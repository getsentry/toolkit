/**
 * Replay Search
 *
 * Field resolution, normalization, and replay ID extraction utilities
 * shared by replay commands and explore --dataset replays.
 */

import {
  vListOrganizationReplaysData,
  vListReplays,
} from "@sentry/api/valibot";
import type {
  ReplayDetails,
  ReplayListItem,
  SentryEvent,
} from "../types/index.js";
import { tryNormalizeHexId } from "./hex-id.js";

type ReplayLike = ReplayListItem | ReplayDetails;

/** Minimal structural view of a Valibot schema, enough to walk object entries. */
type SchemaNode = {
  readonly type: string;
  readonly wrapped?: SchemaNode;
  readonly entries?: Readonly<Record<string, SchemaNode>>;
};

/** Default field set for replay rows shown in `sentry explore --dataset replays`. */
export const DEFAULT_REPLAY_EXPLORE_FIELDS = [
  "id",
  "started_at",
  "duration",
  "count_errors",
  "count_rage_clicks",
  "count_dead_clicks",
  "url",
  "user.email",
] as const;

/** Parse repeatable and comma-separated replay environment filters. */
export function parseReplayEnvironmentFilter(
  values: readonly string[] | undefined,
): string[] | undefined {
  const parsed = values
    ? Array.from(values)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  return parsed.length > 0 ? parsed : undefined;
}

function firstValue<T>(values: T[] | undefined): T | undefined {
  return values && values.length > 0 ? values[0] : undefined;
}

/** Return the best available human label for the replay user. */
export function getReplayUserLabel(replay: ReplayLike): string | undefined {
  const user = replay.user;
  if (!user) {
    return;
  }

  return (
    user.display_name ??
    user.username ??
    user.email ??
    user.id ??
    user.ip ??
    undefined
  );
}

/** Collect dotted leaf paths of an object schema, descending into optional wrappers. */
function collectLeafPaths(
  schema: SchemaNode,
  prefix: string,
  paths: string[],
): string[] {
  let inner = schema;
  while (inner.wrapped) {
    inner = inner.wrapped;
  }
  if (inner.type !== "object" || !inner.entries) {
    paths.push(prefix);
    return paths;
  }
  for (const [key, child] of Object.entries(inner.entries)) {
    collectLeafPaths(child, prefix ? `${prefix}.${key}` : key, paths);
  }
  return paths;
}

/** Root fields the replay index endpoint accepts in repeated `field=` params. */
const REPLAY_REQUEST_ROOTS: ReadonlySet<string> = new Set(
  vListOrganizationReplaysData.entries.query.wrapped.entries.field.wrapped.item
    .options,
);

function replayFieldRoot(path: string): string {
  return path.split(".", 1)[0] ?? path;
}

/**
 * Replay fields taken from the published `@sentry/api` schema: every dotted
 * path in a replay list row whose root the index endpoint accepts.
 */
const REPLAY_API_FIELDS: ReadonlySet<string> = new Set(
  collectLeafPaths(vListReplays.entries.data.item, "", []).filter((path) =>
    REPLAY_REQUEST_ROOTS.has(replayFieldRoot(path)),
  ),
);

/** A CLI-only replay field derived from one API root field. */
type DerivedReplayField = {
  root: string;
  resolve: (replay: ReplayLike) => unknown;
};

/**
 * Aliases and convenience columns the CLI adds on top of the API fields,
 * mostly to match Discover-style names agents already use.
 */
const DERIVED_REPLAY_FIELDS: Record<string, DerivedReplayField> = {
  browser: { root: "browser", resolve: (replay) => replay.browser?.name },
  count_screens: { root: "count_urls", resolve: (replay) => replay.count_urls },
  count_traces: {
    root: "trace_ids",
    resolve: (replay) => replay.trace_ids?.length,
  },
  device: { root: "device", resolve: (replay) => replay.device?.name },
  error_id: {
    root: "error_ids",
    resolve: (replay) => firstValue(replay.error_ids),
  },
  os: { root: "os", resolve: (replay) => replay.os?.name },
  release: {
    root: "releases",
    resolve: (replay) => firstValue(replay.releases),
  },
  screen: { root: "urls", resolve: (replay) => firstValue(replay.urls) },
  screens: { root: "urls", resolve: (replay) => replay.urls },
  sdk: { root: "sdk", resolve: (replay) => replay.sdk?.name },
  seen_by_me: { root: "has_viewed", resolve: (replay) => replay.has_viewed },
  trace: {
    root: "trace_ids",
    resolve: (replay) => firstValue(replay.trace_ids),
  },
  trace_id: {
    root: "trace_ids",
    resolve: (replay) => firstValue(replay.trace_ids),
  },
  url: { root: "urls", resolve: (replay) => firstValue(replay.urls) },
  user: { root: "user", resolve: getReplayUserLabel },
  "user.display": { root: "user", resolve: getReplayUserLabel },
  "user.ip_address": { root: "user", resolve: (replay) => replay.user?.ip },
  viewed_by_me: { root: "has_viewed", resolve: (replay) => replay.has_viewed },
};

function getDerivedReplayField(field: string): DerivedReplayField | undefined {
  return Object.hasOwn(DERIVED_REPLAY_FIELDS, field)
    ? DERIVED_REPLAY_FIELDS[field]
    : undefined;
}

/** Return whether the CLI can render a replay field in replay search outputs. */
export function isSupportedReplayField(field: string): boolean {
  return (
    REPLAY_API_FIELDS.has(field) || getDerivedReplayField(field) !== undefined
  );
}

/** List the replay fields the CLI can render in replay search outputs. */
export function listSupportedReplayFields(): string[] {
  return Array.from(
    new Set([...REPLAY_API_FIELDS, ...Object.keys(DERIVED_REPLAY_FIELDS)]),
  ).sort();
}

/**
 * Map requested replay output fields to the top-level replay API fields required
 * to materialize them.
 */
export function getReplayRequestFields(fields: string[]): string[] {
  const roots = new Set<string>(["id"]);

  for (const field of fields) {
    roots.add(getDerivedReplayField(field)?.root ?? replayFieldRoot(field));
  }

  return Array.from(roots);
}

/** Read a dotted path such as `user.geo.city` from a replay row. */
function getPathValue(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return;
    }
    current = Reflect.get(current, key);
  }
  return current;
}

/** Extract a replay field value for CLI search/display output. */
export function getReplayFieldValue(
  replay: ReplayLike,
  field: string,
): unknown {
  const derived = getDerivedReplayField(field);
  if (derived) {
    return derived.resolve(replay);
  }
  if (!REPLAY_API_FIELDS.has(field)) {
    throw new Error(`Unsupported replay field: ${field}`);
  }
  return getPathValue(replay, field);
}

// ---------------------------------------------------------------------------
// Replay ID extraction from events
// ---------------------------------------------------------------------------

/**
 * Extract the replay ID from the event's `contexts.replay` object.
 */
function getReplayIdFromReplayContext(
  event: Pick<SentryEvent, "contexts">,
): string | undefined {
  const replayContext = event.contexts?.replay;
  return typeof replayContext?.replay_id === "string"
    ? replayContext.replay_id
    : undefined;
}

/**
 * Extract the best replay ID from an event's known replay linkage fields.
 *
 * Checks both event tags (`replayId`, `replay.id`) and the replay context.
 * Returns the first valid, normalized replay ID found.
 */
export function getReplayIdFromEvent(
  event: Pick<SentryEvent, "contexts" | "tags">,
): string | undefined {
  const tagReplayId = event.tags?.find(
    (tag) => tag.key === "replayId" || tag.key === "replay.id",
  )?.value;

  return collectReplayIds([
    tagReplayId,
    getReplayIdFromReplayContext(event),
  ])[0];
}

/**
 * Normalize and deduplicate replay IDs while preserving first-seen order.
 *
 * Each value is passed through {@link tryNormalizeHexId} — invalid or
 * duplicate IDs are silently dropped.
 */
export function collectReplayIds(
  values: Iterable<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const replayIds: string[] = [];

  for (const value of values) {
    const replayId = tryNormalizeHexId(value);
    if (!replayId || seen.has(replayId)) {
      continue;
    }

    seen.add(replayId);
    replayIds.push(replayId);
  }

  return replayIds;
}
