import * as Sentry from "@sentry/cloudflare";
import { trackAgentCacheLookup } from "../metrics";

/**
 * CF Cache TTL for agent results.
 *
 * 1 hour matches the doc page TTL — we don't want feature listings to
 * lag behind the docs that back them. Repeat wizard runs for the same
 * platform combo within an hour reuse the same cached answer.
 */
const FEATURES_TTL_SECONDS = 3600;

/** Cache scope label used in the cache key URL and metric attributes. */
const FEATURES_SCOPE = "features";
const QUERY_SCOPE = "query";

export interface DocsQueryContext {
  frameworks?: string[];
  languages?: string[];
  sentryConfigured?: boolean;
}

export interface CachedDocsQuery {
  answer: string;
  sources: string[];
}

/**
 * Resolve the Cloudflare Cache API instance, or `undefined` if it isn't
 * available in the current runtime (e.g. local non-CF dev).
 */
function getCache(): Cache | undefined {
  try {
    return (caches as CacheStorage & { default?: Cache })?.default;
  } catch {
    // Cache API is unavailable outside the Worker runtime.
  }
}

/**
 * Build a stable cache URL key for a sorted set of libs.
 *
 * The CF Cache API requires URL-shaped keys, so we synthesize a fake
 * `https://docs-mcp.local/cache/features?libs=…` URL. Lib names are
 * lower-cased, trimmed, and sorted before joining so `[react, nextjs]`
 * and `[nextjs, React]` collide on the same cache entry.
 */
function featuresKey(libs: string[]): string {
  const sorted = [...libs]
    .map((v) => v.toLowerCase().trim())
    .sort((a, b) => a.localeCompare(b));
  const search = new URLSearchParams({ libs: sorted.join(",") });
  return `https://docs-mcp.local/cache/${FEATURES_SCOPE}?${search.toString()}`;
}

function normalizeValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.toLowerCase().trim()))]
    .filter(Boolean)
    .sort();
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDocsVersion(version: string | undefined): string {
  return version?.trim() || "unknown";
}

/** Build a stable query cache key from the question and approved metadata only. */
export function buildDocsQueryCacheKey(
  query: string,
  context: DocsQueryContext | undefined,
  docsVersion?: string,
): string {
  const normalizedContext = {
    cacheSchemaVersion: 2,
    docsVersion: normalizeDocsVersion(docsVersion),
    frameworks: normalizeValues(context?.frameworks),
    languages: normalizeValues(context?.languages),
    sentryConfigured: Boolean(context?.sentryConfigured),
  };
  const search = new URLSearchParams({
    context: JSON.stringify(normalizedContext),
    query: normalizeQuery(query),
  });
  return `https://docs-mcp.local/cache/${QUERY_SCOPE}?${search.toString()}`;
}

/**
 * Look up a cached feature listing for a sorted set of libs.
 *
 * Returns null on cache miss, when the Cache API is unavailable, or on
 * any runtime error (corrupt entry, transient `cache.match` / `text()`
 * failure). All paths emit a `docs_mcp.agent.cache` metric so we can
 * see hit-rates separately from outright failures.
 */
export async function cacheGetFeatures(
  libs: string[],
): Promise<string[] | null> {
  const cache = getCache();
  if (!cache) {
    trackAgentCacheLookup(FEATURES_SCOPE, false);
    return null;
  }

  try {
    const cached = await cache.match(new Request(featuresKey(libs)));
    if (!cached) {
      trackAgentCacheLookup(FEATURES_SCOPE, false);
      return null;
    }
    const { features } = JSON.parse(await cached.text()) as {
      features: string[];
    };
    trackAgentCacheLookup(FEATURES_SCOPE, true);
    return features;
  } catch (err) {
    // Anything in the read path failing — corrupt entry, runtime hiccup
    // in cache.match / cached.text — should degrade to a cache miss
    // rather than fail the agent.
    Sentry.addBreadcrumb({
      category: "docs.cache",
      level: "warning",
      message: `Failed to read cached entry for ${FEATURES_SCOPE}: ${err instanceof Error ? err.message : String(err)}`,
    });
    trackAgentCacheLookup(FEATURES_SCOPE, false);
    return null;
  }
}

/**
 * Store a feature listing for a sorted set of libs. 1h TTL.
 *
 * Best-effort — failures are silent (cache writes are non-critical).
 */
export async function cachePutFeatures(
  libs: string[],
  features: string[],
): Promise<void> {
  const cache = getCache();
  if (!cache) {
    return;
  }
  const response = new Response(JSON.stringify({ features }), {
    headers: {
      "Cache-Control": `public, max-age=${FEATURES_TTL_SECONDS}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  await cache.put(new Request(featuresKey(libs)), response);
}

/** Read a cached, already citation-validated docs query result. */
export async function cacheGetDocsQuery(
  query: string,
  context: DocsQueryContext | undefined,
  docsVersion?: string,
): Promise<CachedDocsQuery | null> {
  const cache = getCache();
  if (!cache) {
    trackAgentCacheLookup(QUERY_SCOPE, false);
    return null;
  }

  try {
    const cached = await cache.match(
      new Request(buildDocsQueryCacheKey(query, context, docsVersion)),
    );
    if (!cached) {
      trackAgentCacheLookup(QUERY_SCOPE, false);
      return null;
    }
    const result = JSON.parse(await cached.text()) as CachedDocsQuery;
    if (!(result.answer && Array.isArray(result.sources))) {
      throw new Error("Invalid cached docs query result");
    }
    trackAgentCacheLookup(QUERY_SCOPE, true);
    return result;
  } catch {
    trackAgentCacheLookup(QUERY_SCOPE, false);
    return null;
  }
}

/** Best-effort one-hour cache write for a citation-validated query result. */
export async function cachePutDocsQuery(
  query: string,
  context: DocsQueryContext | undefined,
  result: CachedDocsQuery,
  docsVersion?: string,
): Promise<void> {
  const cache = getCache();
  if (!cache) {
    return;
  }
  const response = new Response(JSON.stringify(result), {
    headers: {
      "Cache-Control": `public, max-age=${FEATURES_TTL_SECONDS}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  await cache.put(
    new Request(buildDocsQueryCacheKey(query, context, docsVersion)),
    response,
  );
}
