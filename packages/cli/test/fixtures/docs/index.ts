import { readFileSync } from "node:fs";
import { buildPagesFromDoctree } from "../../../src/lib/docs-index.js";
import { buildPostings, type DocsIndex } from "../../../src/lib/docs-search.js";

/** The search index of a pruned copy of docs.sentry.io's doctree.json. */
export function fixtureDocsIndex(): DocsIndex {
  const doctree = JSON.parse(
    readFileSync(new URL("doctree.json", import.meta.url), "utf8"),
  );
  const pages = buildPagesFromDoctree(doctree).map(
    ([path, title, description, parent]) => ({
      path,
      title,
      description,
      parent,
    }),
  );
  return { pages, postings: buildPostings(pages) };
}
