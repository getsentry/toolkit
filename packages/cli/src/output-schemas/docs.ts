/**
 * Output schema of `sentry docs`.
 */

import {
  array,
  description,
  type InferOutput,
  object,
  pipe,
  string,
} from "valibot";

/** One matching documentation page. */
const DocsSearchResultSchema = object({
  title: pipe(string(), description("Page title")),
  description: pipe(string(), description("Page description")),
  url: pipe(
    string(),
    description(
      "Markdown URL of the page on docs.sentry.io; fetch it to read the page",
    ),
  ),
  breadcrumbs: pipe(
    array(string()),
    description("Titles of the page's parent sections"),
  ),
});

/** `--fields` / SKILL.md documentation schema for a docs search. */
export const DocsSearchOutputSchema = object({
  results: pipe(
    array(DocsSearchResultSchema),
    description("Matching pages, best match first"),
  ),
  warnings: pipe(
    array(string()),
    description(
      "What the search changed about the input, such as a corrected typo",
    ),
  ),
});

/** What `sentry docs` outputs. */
export type DocsSearchOutput = InferOutput<typeof DocsSearchOutputSchema>;
