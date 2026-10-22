import * as Sentry from "@sentry/cloudflare";
import { trackFetchDuration } from "../metrics";

const BASE_URL = "https://docs.sentry.io";
const FETCH_TIMEOUT_MS = 15_000; // 15s — .md endpoint is CDN-served, fail fast if slow

// Regex literals are hoisted to module scope per the lint rule
// (lint/performance/useTopLevelRegex) — avoids re-compilation on every call.
const TRAILING_MD_RE = /\.md$/;
const TRAILING_SLASHES_RE = /\/+$/;

/**
 * Cache TTLs.
 *
 * - `doctree.json` is the global hierarchical sitemap (~6MB) and changes
 *   only when new docs are published. 12h keeps it fresh enough.
 * - Individual `.md` pages get a 1h TTL.
 */
const DOCTREE_TTL = 43_200; // 12 hours
const PAGE_TTL = 3600; // 1 hour

/**
 * Fetch a URL with Cloudflare Cache API caching.
 *
 * Cache hits return immediately. Misses go to docs.sentry.io with a
 * 15s timeout and store the body in the per-zone CF Cache for the
 * requested TTL. The Cache API is unavailable outside of CF Workers,
 * so the cache layer no-ops in non-CF runtimes.
 */
function cachedFetch(url: string, ttlSeconds: number): Promise<string> {
  return Sentry.startSpan(
    { op: "http.client", name: `fetch ${url}` },
    async (span) => {
      const start = Date.now();

      let cache: Cache | undefined;
      try {
        cache = (caches as CacheStorage & { default?: Cache })?.default;
      } catch {
        // Cache API not available (local dev / non-CF runtime)
      }

      const request = new Request(url);

      if (cache) {
        const cached = await cache.match(request);
        if (cached) {
          span.setAttribute("cache.hit", true);
          span.setAttribute("http.url", url);
          const body = await cached.text();
          const durationMs = Date.now() - start;
          trackFetchDuration(url, true, durationMs);
          return body;
        }
      }

      span.setAttribute("cache.hit", false);
      const response = await fetch(request, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      span.setAttribute("http.url", url);
      span.setAttribute("http.response.status_code", response.status);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
        );
      }

      const body = await response.text();
      span.setAttribute("http.response_content_length", body.length);

      // Store in CF Cache with the requested TTL
      if (cache) {
        const cacheResponse = new Response(body, {
          headers: {
            "Cache-Control": `public, max-age=${ttlSeconds}`,
            "Content-Type": url.endsWith(".json")
              ? "application/json; charset=utf-8"
              : "text/markdown; charset=utf-8",
          },
        });
        await cache.put(request, cacheResponse);
      }

      const durationMs = Date.now() - start;
      trackFetchDuration(url, false, durationMs);
      return body;
    },
  );
}

/**
 * Normalize a docs.sentry.io path so it works with the .md API.
 *
 * Accepts:
 *   - "/platforms/javascript/guides/nextjs/"
 *   - "/platforms/javascript/guides/nextjs"
 *   - "platforms/javascript/guides/nextjs"
 *   - "https://docs.sentry.io/platforms/javascript/guides/nextjs/"
 *   - "/platforms/javascript/guides/nextjs/.md" (no-op)
 *
 * Returns a path with a single leading slash and no trailing slash.
 */
export function normalizeDocPath(path: string): string {
  let p = path.trim();
  // Strip absolute URL prefix
  if (p.startsWith(BASE_URL)) {
    p = p.slice(BASE_URL.length);
  }
  // Strip trailing .md if a caller mistakenly included it
  p = p.replace(TRAILING_MD_RE, "");
  // Collapse trailing slashes
  p = p.replace(TRAILING_SLASHES_RE, "");
  // Ensure single leading slash
  if (!p.startsWith("/")) {
    p = `/${p}`;
  }
  return p;
}

/**
 * Fetch the pre-rendered Markdown for a single docs.sentry.io page.
 *
 * Hits `https://docs.sentry.io/<path>.md`. The .md endpoint returns
 * an LLM-friendly Markdown export with YAML frontmatter, no MDX components.
 *
 * @param path - Docs path (with or without leading slash, .md suffix, etc.)
 *               Examples: "/platforms/javascript/guides/nextjs/",
 *                         "platforms/javascript/guides/nextjs"
 */
export function fetchDocPage(path: string): Promise<string> {
  const normalized = normalizeDocPath(path);
  return cachedFetch(`${BASE_URL}${normalized}.md`, PAGE_TTL);
}

/**
 * Fetch the global doctree.json sitemap from docs.sentry.io.
 *
 * Returns the raw JSON string — caller is responsible for parsing.
 * Cached for 12h since it's ~6MB and changes infrequently.
 */
export function fetchDocTree(): Promise<string> {
  return cachedFetch(`${BASE_URL}/doctree.json`, DOCTREE_TTL);
}

/** Build the public docs.sentry.io URL for a given path (no .md suffix). */
export function buildDocsUrl(path: string): string {
  return `${BASE_URL}${normalizeDocPath(path)}/`;
}
