/**
 * Load the docs.sentry.io page index for `sentry docs`.
 *
 * The source is `https://docs.sentry.io/doctree.json`, the docs site's own
 * page tree (about 6 MB, 400 KB compressed). Parsing and tokenizing it costs
 * far more than a search, so after each download the CLI keeps a compact copy
 * under `<config dir>/cache/docs/`: the pages (path, title, description,
 * parent) and their inverted index, so a search reads only the postings of
 * its own words:
 *
 * - Younger than {@link FRESH_FOR_MS}: used as is, with no request.
 * - Older: revalidated with `If-None-Match`; a 304 only bumps its age.
 * - The request fails: the stale copy is used, with a warning.
 *
 * `--fresh` skips the age check, and `SENTRY_NO_CACHE=1` skips the copy.
 *
 * @module
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { customFetch } from "./custom-ca.js";
import { getConfigDir } from "./db/index.js";
import {
  buildPostings,
  DOCS_ORIGIN,
  type DocsIndex,
  type DocsIndexPage,
  type DocsPostings,
} from "./docs-search.js";
import { getEnv } from "./env.js";
import { CliError, EXIT } from "./errors.js";
import { logger } from "./logger.js";

const log = logger.withTag("docs-index");

export const DOCTREE_URL = `${DOCS_ORIGIN}/doctree.json`;

/** Bump when the cached format changes; older files are ignored. */
const CACHE_VERSION = 1;
const CACHE_FILE = `index-v${CACHE_VERSION}.json`;

/** How long a cached index is used without asking the docs site. */
export const FRESH_FOR_MS = 6 * 60 * 60 * 1000;
/** Timeout for downloading and parsing the whole doctree. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/**
 * Timeout for the docs site to answer a revalidation, when a stale copy can
 * answer instead. It covers the response headers only: once the site says
 * the index changed, the new copy gets the full download timeout.
 */
const REVALIDATE_TIMEOUT_MS = 3000;

/** A node of docs.sentry.io's `doctree.json`. */
type DocTreeNode = {
  path?: string;
  slug?: string;
  frontmatter?: {
    title?: string;
    description?: string;
    sidebar_hidden?: boolean;
  };
  children?: DocTreeNode[];
};

/** One page on disk: `[path, title, description, parent]`. */
type CachedPage = [string, string, string, number];

type CachedIndex = {
  version: number;
  etag?: string;
  fetchedAt: number;
  pages: CachedPage[];
  postings: DocsPostings;
};

export type LoadedDocsIndex = {
  readonly index: DocsIndex;
  /** Set when a stale copy answered because the refresh failed. */
  readonly warning?: string;
};

export type LoadDocsIndexOptions = {
  /** Revalidate even when the cached copy is fresh. */
  readonly fresh?: boolean;
  /** Current time, for tests. */
  readonly now?: number;
};

/** Pages older than the current docs version live at `<path>__v<version>`. */
const VERSIONED_PATH_RE = /__v[\d.x]+$/;
const EDGE_SLASHES_RE = /^\/+|\/+$/g;

function cachePath(): string {
  return join(getConfigDir(), "cache", "docs", CACHE_FILE);
}

/** A page title for a node without one: `source-maps` → `Source maps`. */
function titleFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Flatten the doctree into compact pages. Pages hidden from the sidebar and
 * old versioned copies are dropped; their children are too.
 */
export function buildPagesFromDoctree(root: DocTreeNode): CachedPage[] {
  const pages: CachedPage[] = [];
  const stack: { node: DocTreeNode; parent: number }[] = [
    { node: root, parent: -1 },
  ];
  while (stack.length > 0) {
    const { node, parent } = stack.pop() as {
      node: DocTreeNode;
      parent: number;
    };
    if (node.frontmatter?.sidebar_hidden) {
      continue;
    }
    const trimmed = (node.path ?? "").replace(EDGE_SLASHES_RE, "");
    if (VERSIONED_PATH_RE.test(trimmed)) {
      continue;
    }
    const path = `/${trimmed}`;
    const title =
      node.frontmatter?.title?.trim() ||
      titleFromSlug(node.slug ?? trimmed.split("/").at(-1) ?? "");
    const index = pages.length;
    pages.push([
      path,
      title,
      node.frontmatter?.description?.trim() ?? "",
      parent,
    ]);
    // Reverse so that children keep their order when popped.
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) {
        stack.push({ node: child, parent: index });
      }
    }
  }
  return pages;
}

function toPages(pages: readonly CachedPage[]): DocsIndexPage[] {
  return pages.map(([path, title, description, parent]) => ({
    path,
    title,
    description,
    parent,
  }));
}

function toIndex(cache: CachedIndex): DocsIndex {
  return { pages: toPages(cache.pages), postings: cache.postings };
}

function isCachedIndex(value: unknown): value is CachedIndex {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CachedIndex>;
  return (
    candidate.version === CACHE_VERSION &&
    typeof candidate.fetchedAt === "number" &&
    Array.isArray(candidate.pages) &&
    typeof candidate.postings === "object" &&
    candidate.postings !== null
  );
}

async function readCache(): Promise<CachedIndex | undefined> {
  let text: string;
  try {
    text = await readFile(cachePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.debug("Could not read the cached docs index", error);
    }
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isCachedIndex(parsed) ? parsed : undefined;
  } catch (error) {
    log.debug("Ignoring a corrupt cached docs index", error);
    return;
  }
}

/** Write the cache atomically so a concurrent run never reads half a file. */
async function writeCache(cache: CachedIndex): Promise<void> {
  const path = cachePath();
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(join(getConfigDir(), "cache", "docs"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    log.debug("Could not write the docs index cache", error);
  }
}

type FetchResult =
  | { kind: "not-modified" }
  | { kind: "updated"; etag?: string; pages: CachedPage[] };

async function fetchDoctree(
  etag: string | undefined,
  answerTimeoutMs: number,
): Promise<FetchResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (etag) {
    headers["If-None-Match"] = etag;
  }
  const controller = new AbortController();
  const abortAfter = (ms: number) =>
    setTimeout(
      () =>
        controller.abort(
          new DOMException(`Timed out after ${ms / 1000}s`, "TimeoutError"),
        ),
      ms,
    );
  let timer = abortAfter(answerTimeoutMs);
  try {
    const response = await customFetch(DOCTREE_URL, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 304) {
      return { kind: "not-modified" };
    }
    if (!response.ok) {
      throw new Error(`${DOCTREE_URL} returned HTTP ${response.status}`);
    }
    // A changed index is a full download, so a short revalidation timeout
    // would keep a slow network on the old copy forever.
    clearTimeout(timer);
    timer = abortAfter(DOWNLOAD_TIMEOUT_MS);
    const tree = (await response.json()) as DocTreeNode;
    return {
      kind: "updated",
      etag: response.headers.get("etag") ?? undefined,
      pages: buildPagesFromDoctree(tree),
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeAge(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) {
    return "less than an hour";
  }
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/**
 * Load the docs index from the cache, revalidating or downloading it when
 * needed.
 *
 * @throws {CliError} When there is no cached copy and the download fails.
 */
export async function loadDocsIndex(
  options: LoadDocsIndexOptions = {},
): Promise<LoadedDocsIndex> {
  const now = options.now ?? Date.now();
  const cacheDisabled = getEnv().SENTRY_NO_CACHE === "1";
  const cached = cacheDisabled ? undefined : await readCache();

  if (cached && !options.fresh && now - cached.fetchedAt < FRESH_FOR_MS) {
    return { index: toIndex(cached) };
  }

  let result: FetchResult;
  try {
    result = await fetchDoctree(
      cached?.etag,
      cached ? REVALIDATE_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS,
    );
  } catch (error) {
    if (cached) {
      log.debug("Docs index refresh failed; using the cached copy", error);
      return {
        index: toIndex(cached),
        warning: `Could not refresh the docs index; using a copy from ${describeAge(now - cached.fetchedAt)} ago.`,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Could not download the Sentry docs index from ${DOCTREE_URL}: ${detail}`,
      EXIT.API,
    );
  }

  if (result.kind === "not-modified" && cached) {
    if (!cacheDisabled) {
      await writeCache({ ...cached, fetchedAt: now });
    }
    return { index: toIndex(cached) };
  }
  if (result.kind === "not-modified") {
    // A 304 without a cached copy can only come from a misbehaving proxy.
    throw new CliError(
      `The Sentry docs index at ${DOCTREE_URL} returned an unexpected 304.`,
      EXIT.API,
    );
  }

  const fresh: CachedIndex = {
    version: CACHE_VERSION,
    etag: result.etag,
    fetchedAt: now,
    pages: result.pages,
    postings: buildPostings(toPages(result.pages)),
  };
  if (!cacheDisabled) {
    await writeCache(fresh);
  }
  return { index: toIndex(fresh) };
}
