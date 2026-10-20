/**
 * Name filters for list commands (`sentry org list <filter>`,
 * `sentry team list <org>/ <filter>`): a glob, or text matched with the
 * shared fuzzy search.
 */

import picomatch from "picomatch";
import { fuzzyMatch } from "./fuzzy.js";

/** Glob metacharacters: a filter with any of them is matched as a glob. */
const GLOB_CHARS_RE = /[*?[\]{}]/;

/** Whether `filter` is a glob (`acme-*`) rather than plain text. */
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
    return [...items];
  }
  if (isGlobFilter(needle)) {
    // Names aren't paths: `bash` lets `*` match `/` too, so `*-sdk` matches
    // the repository `getsentry/sentry-python-sdk`.
    const matches = picomatch(needle, { dot: true, bash: true });
    return items.filter((item) =>
      namesOf(item).some((name) => matches(name.toLowerCase())),
    );
  }
  const candidates = [...new Set(items.flatMap((item) => namesOf(item)))];
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
 * Split a list command's `[<target>] [<filter>]` positionals into the
 * target and name filter. With no second positional, a glob in the lone
 * argument is a filter, since no slug contains glob characters:
 * `web-*` → filter `web-*` (auto-detected org), `acme/web-*` → target
 * `acme/` and filter `web-*`. Any other lone argument stays the target.
 */
export function splitListTargetAndFilter(
  target: string | undefined,
  filter: string | undefined,
): { target?: string; filter?: string } {
  const trimmedFilter = filter?.trim() || undefined;
  if (trimmedFilter || !target) {
    return { target, filter: trimmedFilter };
  }
  const slash = target.indexOf("/");
  if (slash < 0) {
    return isGlobFilter(target) ? { filter: target.trim() } : { target };
  }
  const rest = target.slice(slash + 1);
  if (rest.includes("/") || !isGlobFilter(rest)) {
    return { target };
  }
  return { target: target.slice(0, slash + 1), filter: rest };
}
