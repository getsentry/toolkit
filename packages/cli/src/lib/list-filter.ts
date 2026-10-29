/**
 * Name filters for list commands (`sentry org list <filter>`,
 * `sentry team list <org>/back*`, `sentry repo list <org>/sentry`): a glob,
 * or text matched with the shared fuzzy search.
 */

import picomatch from "picomatch";
import { fuzzyMatch } from "./fuzzy.js";

/** Glob metacharacters: a filter with any of them is matched as a glob. */
const GLOB_CHARS_RE = /[*?[\]{}]/;

/**
 * Whether `filter` is a glob (`acme-*`) rather than plain text. The target
 * grammar uses it to tell a name filter from a project (`parseListTarget`).
 */
export function isGlobFilter(filter: string): boolean {
  return GLOB_CHARS_RE.test(filter);
}

/**
 * Items with a name matching `filter`, ignoring case. `namesOf` gives each
 * item's names (e.g. slug and display name). A glob must match a whole name
 * and keeps the input order. Plain text uses {@link fuzzyMatch} search
 * (exact, prefix, substring, then small typos), best matches first; ties
 * keep the input order. An empty filter returns every item.
 */
export function filterByName<T>(
  items: readonly T[],
  filter: string | undefined,
  namesOf: (item: T) => readonly string[],
): T[] {
  const needle = filter?.trim().toLowerCase();
  if (!needle) {
    return Array.from(items);
  }
  if (isGlobFilter(needle)) {
    // Names aren't paths: `bash` lets `*` match `/` too, so `*-sdk` matches
    // the repository `getsentry/sentry-python-sdk`.
    const matches = picomatch(needle, { dot: true, bash: true });
    return items.filter((item) =>
      namesOf(item).some((name) => matches(name.toLowerCase())),
    );
  }
  const candidates = Array.from(
    new Set(items.flatMap((item) => namesOf(item))),
  );
  const rankOf = new Map(
    fuzzyMatch(needle, candidates, { mode: "search" }).map((name, rank) => [
      name,
      rank,
    ]),
  );
  // An item ranks by its best-matching name; the sort is stable.
  return items
    .map((item) => ({
      item,
      rank: Math.min(
        ...namesOf(item).map(
          (name) => rankOf.get(name) ?? Number.POSITIVE_INFINITY,
        ),
      ),
    }))
    .filter(({ rank }) => rank !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

/**
 * Characters that make a filter unsafe to send as Sentry's `?query=`:
 * `tokenize_query` reads `:` and quotes as search syntax, and globs with
 * negation, extglobs, or escapes have no required literal text.
 */
const UNSEARCHABLE_RE = /[:"'\\!()|+@]|\s{2}/;

/** Glob parts that stand for something other than literal text. */
const GLOB_WILDCARD_RE = /\[[^\]]*\]|\{[^}]*\}|[*?[\]{}]/;

/** Shortest literal part of a glob worth sending to the server. */
const MIN_GLOB_SEARCH_LENGTH = 2;

/**
 * Text for Sentry's list `?query=` (a case-insensitive substring match on
 * names) that every name matching `filter` contains, or `undefined` when
 * the server can't narrow it. Plain text is sent as is. A glob sends its
 * longest literal part (`web-*` → `web-`), since each match contains it.
 */
export function serverSearchText(filter: string): string | undefined {
  const needle = filter.trim();
  if (!needle || UNSEARCHABLE_RE.test(needle)) {
    return;
  }
  if (!isGlobFilter(needle)) {
    return needle;
  }
  const longest = needle
    .split(GLOB_WILDCARD_RE)
    .map((part) => part.trim())
    .reduce((best, part) => (part.length > best.length ? part : best), "");
  return longest.length >= MIN_GLOB_SEARCH_LENGTH ? longest : undefined;
}

/**
 * Items whose names match `filter` (see {@link filterByName}), fetching as
 * little as possible. With `search` (a fetch narrowed by Sentry's
 * `?query=`), the server narrows the set first. Plain text that no name
 * contains then falls back to fuzzy matching over `fetchAll`, so typos still
 * find their target. A glob never needs the fallback: every match contains
 * the text it sent.
 */
export async function fetchByName<T>(options: {
  filter: string;
  namesOf: (item: T) => readonly string[];
  fetchAll: () => Promise<T[]>;
  search?: (query: string) => Promise<T[]>;
}): Promise<T[]> {
  const { filter, namesOf, fetchAll, search } = options;
  const query = search ? serverSearchText(filter) : undefined;
  if (search && query !== undefined) {
    const narrowed = filterByName(await search(query), filter, namesOf);
    if (narrowed.length > 0 || isGlobFilter(filter)) {
      return narrowed;
    }
  }
  return filterByName(await fetchAll(), filter, namesOf);
}

/**
 * The list target for `<org>/` with a name filter: `acme/web-*`, or
 * `acme/frontend` for text, which matches names when it names no project.
 *
 * @param quote - Applied to a target with a filter, e.g. `shellQuote` for a
 *   command meant to be copied into a shell
 */
export function orgFilterTarget(
  org: string,
  filter: string | undefined,
  quote: (arg: string) => string = (arg) => arg,
): string {
  return filter ? quote(`${org}/${filter}`) : `${org}/`;
}
