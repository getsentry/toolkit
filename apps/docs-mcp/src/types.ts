// ── Cloudflare Worker Env ───────────────────────────────────────────

/** Runtime shape of Cloudflare's version_metadata binding. */
export interface WorkerVersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

export interface Env {
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** OpenRouter API key — routes both the primary and fallback docs agent models. */
  OPENROUTER_API_KEY?: string;
}

// ── Sentry Docs Types ───────────────────────────────────────────────

/** A single node in the docs.sentry.io doctree.json. */
export interface DocTreeNode {
  /** Child nodes nested under this path. */
  children?: DocTreeNode[];
  /** Frontmatter fields parsed from the page's MDX. */
  frontmatter?: {
    description?: string;
    sidebar_hidden?: boolean;
    sidebar_order?: number;
    title?: string;
  };
  /** Path relative to docs.sentry.io root, e.g. "/platforms/javascript/guides/nextjs/". */
  path: string;
  /** Slug fragment, e.g. "nextjs". */
  slug?: string;
}

/** A search hit returned by searchPages(). */
export interface DocPageHit {
  /** Optional one-line summary from frontmatter. */
  description?: string;
  /** Display title from frontmatter. */
  title: string;
  /** Absolute docs.sentry.io URL of the page (without the .md suffix). */
  url: string;
}
