/**
 * Ranking benchmark for `sentry docs`.
 *
 * Runs every query in `docs-benchmark.json` against the live docs index and
 * reports where the expected page ranks: hit@1, hit@3, and mean reciprocal
 * rank over the top 8 results. The same tasks are used to compare the
 * command with an agent that fetches the docs on its own.
 *
 * Usage:
 *   pnpm run bench:docs                         # fetch docs.sentry.io/doctree.json
 *   pnpm run bench:docs -- --doctree tree.json  # use a saved doctree
 *   pnpm run bench:docs -- --json               # machine-readable output
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildPagesFromDoctree, DOCTREE_URL } from "../src/lib/docs-index.js";
import {
  buildPostings,
  DOCS_ORIGIN,
  type DocsIndex,
  searchDocs,
} from "../src/lib/docs-search.js";

type BenchmarkTask = {
  readonly task: string;
  readonly query: string;
  readonly patterns?: readonly string[];
  readonly expected: readonly string[];
};

const LIMIT = 8;

const { values } = parseArgs({
  // pnpm passes the `--` of `pnpm run bench:docs -- --json` through.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    doctree: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

async function loadDoctree(): Promise<unknown> {
  if (values.doctree) {
    return JSON.parse(readFileSync(values.doctree, "utf8"));
  }
  const response = await fetch(DOCTREE_URL);
  if (!response.ok) {
    throw new Error(`${DOCTREE_URL} returned HTTP ${response.status}`);
  }
  return await response.json();
}

function toPath(url: string): string {
  const path = url.slice(DOCS_ORIGIN.length).replace(/\.md$/, "");
  return path === "/index" ? "/" : path;
}

const tree = await loadDoctree();
const pages = buildPagesFromDoctree(
  tree as Parameters<typeof buildPagesFromDoctree>[0],
).map(([path, title, description, parent]) => ({
  path,
  title,
  description,
  parent,
}));
const index: DocsIndex = { pages, postings: buildPostings(pages) };
const { tasks } = JSON.parse(
  readFileSync(new URL("./docs-benchmark.json", import.meta.url), "utf8"),
) as { tasks: BenchmarkTask[] };

const rows = tasks.map((task) => {
  const { results } = searchDocs(index, {
    query: task.query,
    patterns: task.patterns,
    limit: LIMIT,
  });
  const paths = results.map((result) => toPath(result.url));
  const position = paths.findIndex((path) => task.expected.includes(path));
  return {
    query: task.query,
    rank: position >= 0 ? position + 1 : undefined,
    top: paths[0],
  };
});

const hitAt = (k: number): number =>
  rows.filter((row) => row.rank !== undefined && row.rank <= k).length;
const mrr =
  rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) /
  rows.length;
const summary = {
  tasks: rows.length,
  hitAt1: hitAt(1),
  hitAt3: hitAt(3),
  hitAt8: hitAt(LIMIT),
  mrr: Number(mrr.toFixed(3)),
};

if (values.json) {
  process.stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
} else {
  for (const row of rows) {
    const rank = row.rank === undefined ? "  -" : `#${row.rank}`.padStart(3);
    const top = row.rank === 1 ? "" : `  (top: ${row.top ?? "none"})`;
    process.stdout.write(`${rank}  ${row.query}${top}\n`);
  }
  process.stdout.write(
    `\nhit@1 ${summary.hitAt1}/${summary.tasks}  hit@3 ${summary.hitAt3}/${summary.tasks}  hit@${LIMIT} ${summary.hitAt8}/${summary.tasks}  MRR ${summary.mrr}\n`,
  );
}
