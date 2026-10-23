import { z } from "zod";
import { searchPages } from "../sentry-docs/doctree";
import {
  buildDocsUrl,
  fetchDocPage,
  normalizeDocPath,
} from "../sentry-docs/fetcher";

// Keep the concrete Zod schemas: Mastra vendors AI SDK schema types with
// distinct private brands, so widening these objects through tool() breaks typing.

/**
 * Truncate a fetched doc page to keep the agent's context window bounded.
 *
 * The head of the doc always contains the canonical setup steps; the
 * tail is usually changelog/reference and not needed for synthesis.
 */
const MAX_PAGE_CHARS = 25_000;

/**
 * `search_docs` — discovery tool the agents use to find relevant docs.sentry.io pages.
 * Returns up to 8 hits with `url`, `title`, `description`.
 */
export function createSearchDocsTool() {
  return {
    description:
      "Search docs.sentry.io for pages relevant to a query. Returns up to 8 matching pages with their URL, title, and description. Use this to discover the right doc page when you don't already have its path.",
    execute: async ({ query }: { query: string }) => {
      const hits = await searchPages(query, 8);
      return { hits };
    },
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Free-text search, e.g. 'celery integration', 'session replay privacy', 'sourcemaps webpack'",
        ),
    }),
  };
}

/**
 * `fetch_doc_page` — page reader. Returns the pre-rendered Markdown for a path.
 * The body is truncated to MAX_PAGE_CHARS to keep the agent's context bounded.
 */
export function createFetchDocPageTool(fetchedUrls?: string[]) {
  return {
    description:
      "Fetch the full pre-rendered Markdown of a docs.sentry.io page. Pass the path you got from search_docs (or a known path like '/platforms/javascript/guides/nextjs/'). A successful response includes its canonical url; only cite urls returned by successful fetches.",
    execute: async ({ path }: { path: string }) => {
      const normalizedPath = normalizeDocPath(path);
      const url = buildDocsUrl(normalizedPath);
      try {
        const content = await fetchDocPage(normalizedPath);
        fetchedUrls?.push(url);
        const truncated =
          content.length > MAX_PAGE_CHARS
            ? `${content.slice(0, MAX_PAGE_CHARS)}\n\n[... truncated, ${content.length - MAX_PAGE_CHARS} more chars ...]`
            : content;
        return { content: truncated, path: normalizedPath, url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message, path };
      }
    },
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe(
          "Docs path or full docs.sentry.io URL. The .md suffix is added automatically.",
        ),
    }),
  };
}
