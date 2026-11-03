import * as Sentry from "@sentry/cloudflare";
import type { DocPageHit, DocTreeNode } from "../types";
import { buildDocsUrl, fetchDocTree, normalizeDocPath } from "./fetcher";

/** Trailing slash, hoisted per lint/performance/useTopLevelRegex. */
const TRAILING_SLASH_RE = /\/$/;

/**
 * In-isolate cache for the parsed doctree.
 *
 * The CF Cache API holds the raw JSON for 12h (see fetcher.ts), but
 * parsing 6MB of JSON on every request is wasteful, so we keep the
 * parsed root in memory for the isolate's lifetime. Isolates are
 * short-lived and can be evicted at any time, so this is safe to
 * cache without invalidation.
 */
let doctreeCache: DocTreeNode | null = null;

/**
 * In-flight promise for deduplicating concurrent doctree fetches.
 *
 * When multiple tool calls fire in parallel (e.g. 3 search_docs calls),
 * only the first one should actually fetch the 6MB doctree.json. The
 * others await the same promise, avoiding redundant network requests
 * and the "Large HTTP payload" performance issue (CLI-DOCS-MCP-4).
 */
let doctreeInflight: Promise<DocTreeNode> | null = null;

/**
 * Parse and return the docs.sentry.io doctree, with in-isolate caching.
 *
 * Exported so callers can eagerly warm the cache at request start,
 * ensuring the doctree is ready before the agent needs it.
 */
export function getDoctree(): Promise<DocTreeNode> {
  if (doctreeCache) {
    return Promise.resolve(doctreeCache);
  }

  // Piggyback on in-flight fetch if one exists.
  if (doctreeInflight) {
    return doctreeInflight;
  }

  // Start fetch; concurrent callers will await this same promise.
  doctreeInflight = (async () => {
    try {
      const json = await fetchDocTree();
      doctreeCache = JSON.parse(json) as DocTreeNode;
      return doctreeCache;
    } finally {
      // Clear in-flight marker so next call retries on failure.
      doctreeInflight = null;
    }
  })();

  return doctreeInflight;
}

/**
 * Lib slug → canonical Sentry docs platform path.
 *
 * When a caller passes recognized library slugs, this seeds the agent with
 * the right docs.sentry.io paths instead of relying on full doctree search.
 *
 * For framework-flavored guides (nextjs, django, rails, etc.) the path
 * is `/platforms/<lang>/guides/<framework>/`; for the bare runtime/SDK
 * it's just `/platforms/<lang>/`.
 */
const LIB_TO_PLATFORM_PATH: Record<string, string> = {
  ".net": "/platforms/dotnet/",
  android: "/platforms/android/",
  angular: "/platforms/javascript/guides/angular/",
  astro: "/platforms/javascript/guides/astro/",
  "aws-lambda": "/platforms/javascript/guides/aws-lambda/",
  "azure-functions": "/platforms/javascript/guides/azure-functions/",
  browser: "/platforms/javascript/",
  bun: "/platforms/javascript/guides/bun/",
  capacitor: "/platforms/javascript/guides/capacitor/",
  celery: "/platforms/python/integrations/celery/",
  cloudflare: "/platforms/javascript/guides/cloudflare/",
  cocoa: "/platforms/apple/",
  dart: "/platforms/dart/",
  deno: "/platforms/javascript/guides/deno/",
  django: "/platforms/python/integrations/django/",
  dotnet: "/platforms/dotnet/",
  electron: "/platforms/javascript/guides/electron/",
  elixir: "/platforms/elixir/",
  ember: "/platforms/javascript/guides/ember/",
  express: "/platforms/javascript/guides/express/",
  fastapi: "/platforms/python/integrations/fastapi/",
  fastify: "/platforms/javascript/guides/fastify/",
  firebase: "/platforms/javascript/guides/firebase/",
  flask: "/platforms/python/integrations/flask/",
  flutter: "/platforms/dart/guides/flutter/",
  gatsby: "/platforms/javascript/guides/gatsby/",
  "gcp-functions": "/platforms/javascript/guides/gcp-functions/",
  // Other ecosystems
  go: "/platforms/go/",
  hapi: "/platforms/javascript/guides/hapi/",
  hono: "/platforms/javascript/guides/hono/",
  ios: "/platforms/apple/guides/ios/",
  java: "/platforms/java/",
  javascript: "/platforms/javascript/",
  koa: "/platforms/javascript/guides/koa/",
  kotlin: "/platforms/android/",
  laravel: "/platforms/php/guides/laravel/",
  nestjs: "/platforms/javascript/guides/nestjs/",
  next: "/platforms/javascript/guides/nextjs/",
  "next.js": "/platforms/javascript/guides/nextjs/",
  // JavaScript ecosystem
  nextjs: "/platforms/javascript/guides/nextjs/",
  node: "/platforms/javascript/guides/node/",
  "node.js": "/platforms/javascript/guides/node/",
  nuxt: "/platforms/javascript/guides/nuxt/",
  php: "/platforms/php/",
  // Python ecosystem
  python: "/platforms/python/",
  rails: "/platforms/ruby/guides/rails/",
  react: "/platforms/javascript/guides/react/",
  "react native": "/platforms/react-native/",
  "react-native": "/platforms/react-native/",
  "react-router": "/platforms/javascript/guides/react-router/",
  remix: "/platforms/javascript/guides/remix/",
  ruby: "/platforms/ruby/",
  rust: "/platforms/rust/",
  // Other JS frameworks / runtimes
  solid: "/platforms/javascript/guides/solid/",
  solidstart: "/platforms/javascript/guides/solidstart/",
  svelte: "/platforms/javascript/guides/svelte/",
  sveltekit: "/platforms/javascript/guides/sveltekit/",
  "tanstack-start": "/platforms/javascript/guides/tanstackstart-react/",
  "tanstack-start-react": "/platforms/javascript/guides/tanstackstart-react/",
  // TanStack Start (cover the common slug spellings the wizard might emit)
  "tanstackstart-react": "/platforms/javascript/guides/tanstackstart-react/",
  vue: "/platforms/javascript/guides/vue/",
};

/**
 * Feature slug → docs sub-path under a platform guide.
 *
 * Most Sentry platform guides follow the same convention:
 *   /platforms/<x>/<feature>/  (e.g. /platforms/javascript/guides/nextjs/tracing/)
 *
 * The feature slugs match the ones returned by skills.sentry.dev /
 * the existing get-available-features tool.
 */
const FEATURE_TO_SUBPATH: Record<string, string> = {
  "ai-monitoring": "tracing/instrumentation/ai-agents-module/",
  crons: "crons/",
  "error-monitoring": "", // base getting-started page covers errors
  logging: "logs/",
  logs: "logs/",
  "mcp-observability": "",
  metrics: "metrics/",
  performance: "tracing/",
  profiling: "profiling/",
  "session-replay": "session-replay/",
  "source-maps": "sourcemaps/",
  sourcemaps: "sourcemaps/",
  tracing: "tracing/",
  "user-feedback": "user-feedback/",
};

const FEATURE_EXTRA_PATHS: Record<string, string[]> = {
  "mcp-observability": ["/ai/monitoring/mcp/getting-started/"],
};

// ── Page discovery ──────────────────────────────────────────────────

/**
 * Resolve a lib slug to its canonical docs.sentry.io platform path.
 * Returns null if the lib isn't recognized.
 */
export function libToPlatformPath(lib: string): string | null {
  const normalized = lib.toLowerCase().trim();
  return LIB_TO_PLATFORM_PATH[normalized] ?? null;
}

/**
 * Build a candidate doc path for a (lib, feature) combo using the
 * hardcoded maps. Returns null if either lib or feature is unknown.
 */
export function libFeaturePath(lib: string, feature: string): string | null {
  const platformPath = libToPlatformPath(lib);
  if (!platformPath) {
    return null;
  }
  const subpath = FEATURE_TO_SUBPATH[feature.toLowerCase().trim()];
  if (subpath === undefined) {
    return null;
  }
  // Concatenate, ensuring we don't double-slash
  return `${platformPath.replace(TRAILING_SLASH_RE, "")}/${subpath}`.replace(
    TRAILING_SLASH_RE,
    "",
  );
}

/**
 * Default cap on seed paths returned to the tailor agent.
 *
 * Seeds are hints — a head start so the agent doesn't spend steps
 * discovering pages it could have been told about upfront. The real
 * guardrail is the MCP client timeout set by the caller, not this cap.
 *
 * 20 comfortably covers any single-lib stack (max ~11 paths) and most
 * multi-lib stacks. The agent fetches all seeds in parallel in one step,
 * so a larger seed set does not cost extra steps.
 */
const DEFAULT_SEED_LIMIT = 20;

/**
 * Find candidate doc pages for a (libs[], features[]) combo.
 *
 * Strategy:
 * 1. For each lib, add the platform's getting-started page (always preferred).
 * 2. For each (lib, feature) combo, add the feature's sub-page if mapped.
 * 3. Add global feature docs such as MCP Observability's setup guide,
 *    in feature-list order, until `limit` is reached.
 * 4. Returns deduplicated, normalized paths.
 *
 * This is the *seed* set the agent starts from. The agent is free to
 * call search_docs / fetch_doc_page to expand beyond these.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered seed selection keeps platform/feature precedence explicit
export function findPagesForLibsFeatures(
  libs: string[],
  features: string[],
  limit: number = DEFAULT_SEED_LIMIT,
): string[] {
  const paths = new Set<string>();

  // Always seed the platform path(s) first — the getting-started guide
  // is the most important page for any synthesis.
  //
  // Also seed the two sub-page patterns that Sentry platforms use for
  // package installation instructions:
  //   install/       — iOS, Node.js, most standalone JS frameworks
  //   manual-setup/  — Next.js, SvelteKit, Android, Flutter, React Native
  //
  // Both are fetched in parallel with the rest of the seeds so there is no
  // extra step cost. Pages that don't exist return empty and are silently
  // ignored by the agent. Platforms that embed install instructions in their
  // root index.mdx (Python, Ruby, Go, etc.) are already covered by the
  // platform root seed above.
  for (const lib of libs) {
    if (paths.size >= limit) {
      break;
    }
    const platformPath = libToPlatformPath(lib);
    if (platformPath) {
      const base = platformPath.replace(TRAILING_SLASH_RE, "");
      paths.add(normalizeDocPath(platformPath));
      paths.add(normalizeDocPath(`${base}/install/`));
      paths.add(normalizeDocPath(`${base}/manual-setup/`));
    }
  }

  // Then add per-feature paths up to the limit. Iterating features in
  // user-provided order means the user's first-listed features get the
  // remaining seed slots.
  outer: for (const feature of features) {
    for (const lib of libs) {
      if (paths.size >= limit) {
        break outer;
      }
      const path = libFeaturePath(lib, feature);
      if (path) {
        paths.add(normalizeDocPath(path));
      }
    }
    const extraPaths = FEATURE_EXTRA_PATHS[feature.toLowerCase().trim()] ?? [];
    for (const extraPath of extraPaths) {
      if (paths.size >= limit) {
        break outer;
      }
      paths.add(normalizeDocPath(extraPath));
    }
  }

  return [...paths];
}

// ── Doctree search ──────────────────────────────────────────────────

/**
 * Walk the doctree, yielding every node depth-first.
 *
 * Skips nodes flagged `sidebar_hidden` since those aren't user-facing.
 */
function* walkDoctree(node: DocTreeNode): Generator<DocTreeNode> {
  if (node.frontmatter?.sidebar_hidden) {
    return;
  }
  yield node;
  if (node.children) {
    for (const child of node.children) {
      yield* walkDoctree(child);
    }
  }
}

/**
 * Path segments that are semantically equivalent to "install" / "setup".
 * Used to boost pages like /manual-setup/ when the query is install-related,
 * so they rank alongside /install/ pages rather than scoring zero.
 */
const INSTALL_SYNONYMS_RE =
  /\/(install|manual-setup|manual-install|quick-start|getting-started)\//;

/** Terms which carry little meaning in a natural-language docs question. */
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "by",
  "do",
  "for",
  "how",
  "i",
  "in",
  "is",
  "of",
  "on",
  "the",
  "to",
  "what",
  "with",
  "you",
  "your",
]);

/** Bound per-node token checks for the full doctree traversal. */
export const MAX_SEARCH_TERMS = 24;

function searchTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*/g) ?? [];
  return [...new Set(terms.filter((term) => term.length >= 3))]
    .filter((term) => !SEARCH_STOP_WORDS.has(term))
    .slice(0, MAX_SEARCH_TERMS);
}

/** Score a node for relevance against a normalized query. */
function scoreNode(
  node: DocTreeNode,
  queryLower: string,
  terms: readonly string[],
  isInstallQuery: boolean,
): number {
  const title = node.frontmatter?.title?.toLowerCase() ?? "";
  const description = node.frontmatter?.description?.toLowerCase() ?? "";
  const path = node.path.toLowerCase();

  let score = 0;
  if (title === queryLower) {
    score += 100;
  }
  if (title.includes(queryLower)) {
    score += 25;
  }
  if (path.includes(queryLower)) {
    score += 15;
  }
  if (description.includes(queryLower)) {
    score += 5;
  }

  // Full questions rarely appear verbatim in a doctree. Score their meaningful
  // terms independently so a question such as "How do I configure Next.js
  // tracing?" can still surface the tracing guide.
  for (const term of terms) {
    if (title === term) {
      score += 30;
    }
    if (title.includes(term)) {
      score += 12;
    }
    if (path.includes(term)) {
      score += 8;
    }
    if (description.includes(term)) {
      score += 4;
    }
  }

  // When the query is install/setup-related, treat synonymous path segments
  // as near-matches. Score 12 — just below the 15 for exact path match —
  // so /manual-setup/ pages surface for "install" queries on platforms like
  // Next.js, Android, Flutter, and React Native that don't use /install/.
  if (isInstallQuery && INSTALL_SYNONYMS_RE.test(path)) {
    score += 12;
  }

  return score;
}

/**
 * Term-aware search over the doctree's titles, descriptions, and paths.
 *
 * Not a vector search — scoring uses exact phrases plus meaningful query terms,
 * which is fast and deterministic for agent terms and user questions alike.
 *
 * @param query    - Free-text search string (case-insensitive).
 * @param limit    - Max results to return (default 8).
 */
export function searchDocTree(
  root: DocTreeNode,
  query: string,
  limit = 8,
): DocPageHit[] {
  const queryLower = query.toLowerCase().trim();

  if (!queryLower) {
    return [];
  }
  const terms = searchTerms(queryLower);
  const isInstallQuery = ["install", "setup", "manual"].some((keyword) =>
    queryLower.includes(keyword),
  );

  const hits: Array<{ node: DocTreeNode; score: number }> = [];
  for (const node of walkDoctree(root)) {
    const score = scoreNode(node, queryLower, terms, isInstallQuery);
    if (score > 0) {
      hits.push({ node, score });
    }
  }

  hits.sort(
    (a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path),
  );
  return hits.slice(0, limit).map(({ node }) => ({
    description: node.frontmatter?.description,
    title: node.frontmatter?.title ?? node.slug ?? node.path,
    url: buildDocsUrl(node.path),
  }));
}

export function searchPages(query: string, limit = 8): Promise<DocPageHit[]> {
  return Sentry.startSpan(
    { name: "searchDoctree", op: "docs.search" },
    async (span) => {
      span.setAttribute("docs.query_term_count", searchTerms(query).length);

      const root = await getDoctree();
      const results = searchDocTree(root, query, limit);
      span.setAttribute("docs.hit_count", results.length);
      return results;
    },
  );
}
