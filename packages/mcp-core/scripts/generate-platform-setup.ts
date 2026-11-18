/**
 * Generates src/tools/support/project-setup/platforms.json: for each Sentry
 * platform ID, its display name, its setup docs page, and the docs page of
 * each core signal (traces, logs, metrics, session replay) that its SDK
 * supports. `create_project` returns this as setup knowledge.
 *
 * Sources:
 *   - getsentry/sentry static/app/data/platforms.tsx: platform IDs, names,
 *     and docs links, the same list Sentry's project creation uses.
 *   - docs.sentry.io/doctree.json: the published docs tree. A platform page
 *     has a `tracing`, `logs`, `metrics`, or `session-replay` child only when
 *     the docs say its SDK supports that signal.
 *
 * Usage (from packages/mcp-core):
 *   pnpm run generate-platform-setup
 *
 * The output is committed. The regenerate-platform-setup.yml workflow reruns
 * this daily and opens a PR when Sentry adds a platform or the docs change
 * which signals a platform supports.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLATFORMS_URL =
  "https://raw.githubusercontent.com/getsentry/sentry/master/static/app/data/platforms.tsx";
const DOCS_ORIGIN = "https://docs.sentry.io";
const OUTPUT_PATH = resolve(
  __dirname,
  "../src/tools/support/project-setup/platforms.json",
);

// Docs child page slug for each signal, in the order the result lists them.
const SIGNAL_PAGES = {
  traces: "tracing",
  logs: "logs",
  metrics: "metrics",
  sessionReplay: "session-replay",
} as const;

type SignalKey = keyof typeof SIGNAL_PAGES;

// Platforms whose link in platforms.tsx points at a broader page than the
// platform's own guide. Mirrors CANONICAL_OVERRIDES in getsentry/sentry
// scripts/genPlatformProductInfo.ts.
const DOCS_PATH_OVERRIDES: Record<string, string> = {
  "apple-ios": "/platforms/apple/guides/ios/",
  "apple-macos": "/platforms/apple/guides/macos/",
};

interface DocTreeNode {
  path: string;
  slug: string;
  frontmatter?: {
    title?: string;
    fallbackGuide?: string;
    sidebar_hidden?: boolean;
  };
  children?: DocTreeNode[];
}

const DocTreeNodeSchema: z.ZodType<DocTreeNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    slug: z.string(),
    frontmatter: z
      .object({
        title: z.string().optional(),
        fallbackGuide: z.string().optional(),
        sidebar_hidden: z.boolean().optional(),
      })
      .optional(),
    children: z.array(DocTreeNodeSchema).optional(),
  }),
);

interface PlatformEntry {
  id: string;
  name: string;
  link: string;
}

interface PlatformSetupEntry {
  name: string;
  docsUrl: string;
  signals: Partial<Record<SignalKey, string>>;
}

function readField(block: string, field: string): string | undefined {
  return block.match(
    new RegExp(`(?:^|\\n)\\s*${field}:\\s*['"]([^'"]*)['"]`),
  )?.[1];
}

/** Reads the static `platforms` array literal from platforms.tsx. */
function parsePlatforms(source: string): PlatformEntry[] {
  const body = source.split("export const platforms")[1]?.split("\n];")[0];
  if (!body) {
    throw new Error("platforms array not found in platforms.tsx");
  }
  const platforms: PlatformEntry[] = [];
  for (const block of body.split(/\n {2}\{\n/).slice(1)) {
    const id = readField(block, "id");
    const name = readField(block, "name");
    const link = readField(block, "link");
    if (!id || !name || !link || /\n\s*deprecated:\s*true/.test(block)) {
      continue;
    }
    platforms.push({ id, name, link });
  }
  if (platforms.length === 0) {
    throw new Error("no platforms parsed from platforms.tsx");
  }
  return platforms;
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function indexDocTree(root: DocTreeNode): Map<string, DocTreeNode> {
  const index = new Map<string, DocTreeNode>();
  const visit = (node: DocTreeNode) => {
    if (node.frontmatter?.sidebar_hidden) {
      return;
    }
    index.set(normalizePath(node.path), node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return index;
}

function hasSignalPages(node: DocTreeNode): boolean {
  const pages = new Set<string>(Object.values(SIGNAL_PAGES));
  return (node.children ?? []).some((child) => pages.has(child.slug));
}

/**
 * Finds the page whose children list the signals for a platform page. Guides
 * that share another guide's SDK, such as Express on Node.js, name it in
 * `fallbackGuide`. Integration pages, such as Django under Python, inherit
 * from the nearest ancestor that lists signals.
 */
function findSignalSource(
  index: Map<string, DocTreeNode>,
  path: string,
): DocTreeNode | null {
  const node = index.get(path);
  if (!node) {
    return null;
  }
  if (hasSignalPages(node)) {
    return node;
  }
  const fallbackGuide = node.frontmatter?.fallbackGuide;
  if (fallbackGuide) {
    const [lang, guide] = fallbackGuide.split(".");
    const fallback = index.get(`platforms/${lang}/guides/${guide}`);
    if (fallback && hasSignalPages(fallback)) {
      return fallback;
    }
  }
  const segments = path.split("/");
  while (segments.length > 2) {
    segments.pop();
    const ancestor = index.get(segments.join("/"));
    if (ancestor && hasSignalPages(ancestor)) {
      return ancestor;
    }
  }
  return node;
}

async function resolveRedirects(path: string): Promise<string> {
  const response = await fetch(new URL(path, DOCS_ORIGIN), {
    method: "HEAD",
    redirect: "follow",
  });
  return new URL(response.url).pathname;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  return await response.text();
}

async function main() {
  const [platformsSource, docTreeText] = await Promise.all([
    fetchText(PLATFORMS_URL),
    fetchText(`${DOCS_ORIGIN}/doctree.json`),
  ]);
  const platforms = parsePlatforms(platformsSource);
  const index = indexDocTree(DocTreeNodeSchema.parse(JSON.parse(docTreeText)));

  const output: Record<string, PlatformSetupEntry> = {};
  const skipped: string[] = [];
  for (const platform of platforms) {
    const linkPath =
      DOCS_PATH_OVERRIDES[platform.id] ?? new URL(platform.link).pathname;
    const path = normalizePath(await resolveRedirects(linkPath));
    // The platform list page is not a setup guide (for example `other`).
    if (path === "platforms" || !index.has(path)) {
      skipped.push(`${platform.id} (${path})`);
      continue;
    }
    const source = findSignalSource(index, path);
    const childSlugs = new Set(
      (source?.children ?? []).map((child) => child.slug),
    );
    const signals: Partial<Record<SignalKey, string>> = {};
    for (const [key, slug] of Object.entries(SIGNAL_PAGES) as [
      SignalKey,
      string,
    ][]) {
      if (source && childSlugs.has(slug)) {
        signals[key] = `${DOCS_ORIGIN}/${normalizePath(source.path)}/${slug}/`;
      }
    }
    output[platform.id] = {
      name: platform.name,
      docsUrl: `${DOCS_ORIGIN}/${path}/`,
      signals,
    };
  }

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Wrote ${Object.keys(output).length} platforms to ${OUTPUT_PATH}`,
  );
  if (skipped.length > 0) {
    console.log(`Skipped (no docs setup page): ${skipped.join(", ")}`);
  }
}

await main();
