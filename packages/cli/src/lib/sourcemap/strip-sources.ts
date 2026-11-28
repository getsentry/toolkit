/**
 * Strip path prefixes from the `sources` of a sourcemap, the way sentry-cli
 * v2's `sourcemaps upload --strip-prefix` / `--strip-common-prefix` did
 * (rust-sourcemap's `RewriteOptions::strip_prefixes`).
 */

import { logger } from "../logger.js";

const log = logger.withTag("sourcemap.strip-sources");

/** What to strip: one explicit prefix, or each map's common prefix. */
export type SourcesStrip = { prefix: string } | { common: true };

/** The parts of a regular or index sourcemap that this module reads. */
type SourcemapJson = {
  sources?: unknown;
  sourceRoot?: unknown;
  sections?: unknown;
};

/** Split a path into components that keep their leading separator. */
function splitPath(path: string): string[] {
  const parts: string[] = [];
  let last = 0;
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] === "/" || path[i] === "\\") {
      parts.push(path.slice(last, i));
      last = i;
    }
  }
  if (last < path.length) {
    parts.push(path.slice(last));
  }
  return parts;
}

/** Whether `path` is a POSIX or Windows drive absolute path. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[/\\]./.test(path);
}

/**
 * The longest common prefix of the absolute paths in `sources`, compared by
 * path component, as rust-sourcemap's `find_common_prefix` computes it.
 * Returns `undefined` when there is none (or it is only `/`). Relative
 * sources do not take part.
 *
 * With only one absolute source the prefix is that whole path, file name
 * included, so the strip (which needs the prefix plus `/`) leaves it alone.
 * sentry-cli behaves the same way.
 */
function findCommonSourcesPrefix(sources: string[]): string | undefined {
  const split = sources.filter(isAbsolutePath).map(splitPath);
  if (split.length === 0) {
    return;
  }
  split.sort((a, b) => a.length - b.length);
  const shortest = split[0] ?? [];
  let matched = shortest.length;
  for (const parts of split) {
    let n = 0;
    while (n < matched && parts[n] === shortest[n]) {
      n += 1;
    }
    matched = n;
  }
  const prefix = shortest.slice(0, matched).join("");
  return prefix && prefix !== "/" ? prefix : undefined;
}

/** Remove `prefix` (with a trailing `/` added if missing) from `source`. */
function stripPrefix(source: string, prefix: string): string {
  const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return source.startsWith(withSlash) ? source.slice(withSlash.length) : source;
}

/**
 * Prepend a `sourceRoot` to a source, unless the source is already absolute
 * (`/…`) or a URL, as v2 did before stripping.
 */
function applySourceRoot(root: string, source: string): string {
  if (
    source.startsWith("/") ||
    source.startsWith("http:") ||
    source.startsWith("https:")
  ) {
    return source;
  }
  return `${root.endsWith("/") ? root.slice(0, -1) : root}/${source}`;
}

/** String entries of a map's `sources` array. */
function stringSources(map: SourcemapJson): string[] {
  return Array.isArray(map.sources)
    ? map.sources.filter((s): s is string => typeof s === "string")
    : [];
}

/** The regular maps inside an index map's `sections`, or the map itself. */
function regularMaps(map: SourcemapJson): SourcemapJson[] {
  if (!Array.isArray(map.sections)) {
    return [map];
  }
  return map.sections.flatMap((section: unknown) => {
    const inner = (section as { map?: unknown } | null)?.map;
    return inner && typeof inner === "object" ? regularMaps(inner) : [];
  });
}

/**
 * Fold a map's `sourceRoot` into its `sources` and drop `sourceRoot`, so the
 * strip applies to the full source paths. Returns true when the map changed.
 */
function foldSourceRoot(map: SourcemapJson): boolean {
  const root = map.sourceRoot;
  if (typeof root !== "string" || root === "" || !Array.isArray(map.sources)) {
    return false;
  }
  map.sources = map.sources.map((s: unknown) =>
    typeof s === "string" ? applySourceRoot(root, s) : s,
  );
  delete map.sourceRoot;
  return true;
}

/**
 * Strip a prefix from the `sources` paths inside a sourcemap.
 *
 * Matches sentry-cli v2: a source that starts with the prefix plus `/` loses
 * it, others stay as they are. A non-empty `sourceRoot` is folded into
 * `sources` first. With `common`, the prefix is the common prefix of the
 * map's absolute sources (see {@link findCommonSourcesPrefix}); for an index
 * map, of all its sections' sources. When only one absolute source takes
 * part, nothing is stripped.
 *
 * @param json - Sourcemap JSON text
 * @param strip - The prefix to strip, or `{ common: true }`
 * @returns The rewritten JSON, or `undefined` when nothing changed or the
 *   text is not a JSON object
 */
export function stripSourcemapSources(
  json: string,
  strip: SourcesStrip,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    log.debug("Not stripping sources of a sourcemap that is not JSON", error);
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    return;
  }
  const map = parsed as SourcemapJson;
  const maps = regularMaps(map);
  let prefix: string | undefined;
  let changed = false;
  if ("prefix" in strip) {
    prefix = strip.prefix;
  } else if (Array.isArray(map.sections)) {
    // v2 flattened index maps first, so the common prefix spans every
    // section and is computed after each section's sourceRoot is applied.
    changed = maps.map(foldSourceRoot).some(Boolean);
    prefix = findCommonSourcesPrefix(maps.flatMap(stringSources));
  } else {
    // For a regular map, v2 computed the common prefix before applying
    // sourceRoot.
    prefix = findCommonSourcesPrefix(stringSources(map));
  }
  for (const m of maps) {
    changed = foldSourceRoot(m) || changed;
    const sources = m.sources;
    if (prefix && Array.isArray(sources)) {
      const p = prefix;
      m.sources = sources.map((s: unknown) =>
        typeof s === "string" ? stripPrefix(s, p) : s,
      );
      changed ||= (m.sources as unknown[]).some((s, i) => s !== sources[i]);
    }
  }
  return changed ? JSON.stringify(map) : undefined;
}
