import type {
  ListTraceItemAttributesOptions,
  TraceItemAttributeDefinition,
  TraceItemAttributeValueType,
} from "./traces.js";
import { listTraceItemAttributes } from "../api-client.js";
import { ValidationError } from "../errors.js";
import { logger } from "../logger.js";
import { safeParseJson } from "../db/json.js";
import { MAX_PAGINATION_PAGES } from "./infrastructure.js";

const CURSOR_PREFIX = "attributes1~";

/** A server page to replay, plus keys already delivered to the caller. */
type AttributeBookmark = {
  cursor: string | null;
  seen: string[];
};

/** One type's candidate rows and the raw pages each row came from. */
export type AttributeTypePage = {
  type: TraceItemAttributeValueType;
  data: TraceItemAttributeDefinition[];
  start: AttributeBookmark;
  positions: (string | undefined)[];
  /** Keys on each raw page fetched, by that page's cursor ("" for the first). */
  pageKeys: Map<string, Set<string>>;
  nextCursor?: string;
};

/** Map key for a raw page's cursor (the first page has none). */
const pageId = (cursor: string | null | undefined): string => cursor ?? "";

/** Versioned resume token: replay this raw page and skip delivered keys. */
function encodeBookmark(
  cursor: string | undefined,
  seen: Iterable<string>,
): string {
  return (
    CURSOR_PREFIX +
    Buffer.from(
      JSON.stringify({ cursor: cursor ?? null, seen: [...seen] }),
    ).toString("base64url")
  );
}

/** Read our bookmark, or accept an unprefixed backend cursor as a fresh page. */
function decodeBookmark(raw: string | undefined): AttributeBookmark {
  if (!raw?.startsWith(CURSOR_PREFIX)) {
    return { cursor: raw ?? null, seen: [] };
  }
  const bookmark = safeParseJson<AttributeBookmark>(
    Buffer.from(raw.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    (value): value is AttributeBookmark =>
      typeof value === "object" &&
      value !== null &&
      "cursor" in value &&
      (value.cursor === null || typeof value.cursor === "string") &&
      "seen" in value &&
      Array.isArray(value.seen) &&
      value.seen.every((key: unknown) => typeof key === "string"),
  );
  if (!bookmark) {
    throw new ValidationError("Invalid attribute pagination cursor.", "cursor");
  }
  return bookmark;
}

/**
 * Page through attribute candidates without interpreting server offsets.
 *
 * The endpoint includes look-ahead, virtual and synthetic keys, and serializes
 * aliases after stored keys. Returned row positions therefore do not match
 * its offsets. Replay unfinished pages and deduplicate by key instead of
 * discarding a presumed look-ahead row. The ordinary cursor stack expires
 * these bookmarks after five minutes.
 */
export async function fetchAttributeTypePage(
  org: string,
  type: TraceItemAttributeValueType,
  options: Omit<
    ListTraceItemAttributesOptions,
    "attributeTypes" | "perPage" | "cursor"
  >,
  limit: number,
  rawCursor: string | undefined,
): Promise<AttributeTypePage> {
  const start = decodeBookmark(rawCursor);
  let seen = new Set(start.seen);
  const data: TraceItemAttributeDefinition[] = [];
  const positions: (string | undefined)[] = [];
  const pageKeys = new Map<string, Set<string>>();
  let cursor = start.cursor ?? undefined;

  // Attribute pages overlap and include rows outside the server's offset
  // coordinate system, so paginate()'s row-count bookmarks do not apply.
  // oxlint-disable-next-line sentry-cli/no-manual-pagination -- requires key bookmarks and cross-page deduplication
  for (let pageIndex = 0; pageIndex < MAX_PAGINATION_PAGES; pageIndex++) {
    const page = await listTraceItemAttributes(org, {
      ...options,
      attributeTypes: [type],
      perPage: limit,
      cursor,
    });
    const keysOnPage = new Set(page.data.map((row) => row.key));
    pageKeys.set(pageId(cursor), keysOnPage);
    for (const [index, attribute] of page.data.entries()) {
      if (seen.has(attribute.key)) {
        continue;
      }
      seen.add(attribute.key);
      data.push(attribute);
      positions.push(cursor);
      if (data.length === limit) {
        const pending = page.data
          .slice(index + 1)
          .some((row) => !seen.has(row.key));
        const next = pending ? cursor : page.nextCursor;
        return {
          type,
          data,
          start,
          positions,
          pageKeys,
          nextCursor:
            pending || next
              ? encodeBookmark(
                  next,
                  [...seen].filter((key) => keysOnPage.has(key)),
                )
              : undefined,
        };
      }
    }
    if (!page.nextCursor) {
      return { type, data, start, positions, pageKeys };
    }
    // Moving on to the next raw page: only this page's keys can reappear.
    cursor = page.nextCursor;
    seen = keysOnPage;
  }
  logger.warn(
    `Attribute pagination reached ${MAX_PAGINATION_PAGES} pages. Use the returned cursor to continue.`,
  );
  return {
    type,
    data,
    start,
    positions,
    pageKeys,
    nextCursor: encodeBookmark(cursor, seen),
  };
}

/** Resume after the prefix actually selected from one type's candidate rows. */
export function attributeCursorAfter(
  page: AttributeTypePage,
  count: number,
): string | null {
  if (count >= page.data.length) {
    return page.nextCursor ?? null;
  }
  const seen = new Set(page.start.seen);
  for (const attribute of page.data.slice(0, count)) {
    seen.add(attribute.key);
  }
  // Resuming partway through a page: keep only keys on that page.
  const replay =
    count > 0 ? page.positions[count - 1] : (page.start.cursor ?? undefined);
  const keysOnPage = page.pageKeys.get(pageId(replay)) ?? new Set<string>();
  return encodeBookmark(
    replay,
    [...seen].filter((key) => keysOnPage.has(key)),
  );
}
