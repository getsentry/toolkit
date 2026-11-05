/**
 * sentry docs
 *
 * Search the Sentry documentation and print matching pages with their
 * Markdown URLs. The search runs locally against a cached copy of the
 * docs.sentry.io page index (see `lib/docs-index.ts`), with no model and no
 * login, so it is fast and works with self-hosted Sentry too.
 */

import type { SentryContext } from "../context.js";
import { DocsSearchOutputSchema } from "../generated/output-schemas/docs.js";
import { validateLimit } from "../lib/arg-parsing.js";
import { buildCommand } from "../lib/command.js";
import { parseText, textParser } from "../lib/completion-target.js";
import { loadDocsIndex } from "../lib/docs-index.js";
import { searchDocs } from "../lib/docs-search.js";
import { ValidationError } from "../lib/errors.js";
import { muted } from "../lib/formatters/colors.js";
import { CommandOutput } from "../lib/formatters/output.js";
import type { DocsSearchOutput } from "../output-schemas/docs.js";
import { topLevelBrief } from "../top-level-briefs.js";

type DocsFlags = {
  readonly fields?: string[];
  readonly fresh: boolean;
  readonly ignoreCase: boolean;
  readonly json: boolean;
  readonly limit: number;
  readonly regex?: readonly string[];
  readonly regexp?: readonly string[];
};

const MAX_LIMIT = 50;

function parseLimit(value: string): number {
  return validateLimit(value, 1, MAX_LIMIT);
}

/**
 * One page per entry: the title, then its URL on its own line, so long URLs
 * never wrap into the title and stay easy to copy.
 */
function formatDocsHuman(data: DocsSearchOutput): string {
  const lines = data.results.map(
    (result) => `${result.title}\n  ${result.url}`,
  );
  if (lines.length === 0) {
    lines.push(
      muted(
        "No documentation pages match. Try fewer or different words, or a broader -e pattern.",
      ),
    );
  }
  for (const warning of data.warnings) {
    lines.push(muted(warning));
  }
  return lines.join("\n");
}

export const docsCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: topLevelBrief("docs"),
    fullDescription:
      "Search the Sentry documentation and list matching pages with their " +
      "Markdown URLs. Fetch a URL to read the page.\n\n" +
      "Words are ranked: pages that match more of them come first, and a " +
      "page does not have to match all of them. Quotes, case, and " +
      "punctuation do not matter, so `next.js`, `next js`, and `nextjs` " +
      "find the same pages. Paste a docs URL to get that page.\n\n" +
      "`-e` filters by a regular expression on the page title or URL path, " +
      "like `grep -e`. It is case-insensitive; repeat it to match any of " +
      "several patterns. Docs paths look like " +
      "`/platforms/<language>/guides/<framework>/<feature>`.\n\n" +
      "The search runs locally against a cached copy of the docs index, so " +
      "it needs no login. The copy refreshes every few hours; `--fresh` " +
      "refreshes it now.",
    examples: [
      {
        description: "Find pages by keywords",
        command: "sentry docs nextjs tracing",
      },
      {
        description: "Combine several topics",
        command: "sentry docs tracing cloudflare tanstack start",
      },
      {
        description: "Match URL paths with a regular expression",
        command:
          "sentry docs -e 'guides/(nextjs|remix|sveltekit)/manual-setup$'",
      },
      {
        description: "Combine a pattern and words",
        command: "sentry docs -e '/python/integrations/' celery",
      },
      {
        description: "Output as JSON",
        command: "sentry docs source maps vite --json",
      },
    ],
  },
  output: { human: formatDocsHuman, schema: DocsSearchOutputSchema },
  parameters: {
    flags: {
      regexp: {
        kind: "parsed",
        parse: parseText,
        variadic: true,
        optional: true,
        brief:
          "Only pages whose title or URL path matches this regular expression (repeatable)",
        placeholder: "pattern",
      },
      // `--regex` is a common spelling of `--regexp`.
      regex: {
        kind: "parsed",
        parse: parseText,
        variadic: true,
        optional: true,
        brief: "Alias of --regexp",
        hidden: true,
      },
      // grep's `-i`; matching is always case-insensitive.
      ignoreCase: {
        kind: "boolean",
        brief: "Accepted for grep compatibility; matching ignores case",
        default: false,
        hidden: true,
      },
      limit: {
        kind: "parsed",
        parse: textParser(parseLimit),
        brief: `Maximum pages to return (1-${MAX_LIMIT})`,
        default: "8",
      },
      fresh: {
        kind: "boolean",
        brief: "Refresh the cached docs index before searching",
        default: false,
      },
    },
    aliases: {
      e: "regexp",
      E: "regexp",
      i: "ignoreCase",
      n: "limit",
      f: "fresh",
    },
    positional: {
      kind: "array",
      parameter: {
        brief: "Words to search for",
        parse: parseText,
        placeholder: "words",
      },
    },
  },
  async *func(this: SentryContext, flags: DocsFlags, ...words: string[]) {
    const query = words.join(" ").trim();
    const patterns = [...(flags.regexp ?? []), ...(flags.regex ?? [])];
    if (!query && patterns.length === 0) {
      throw new ValidationError(
        "Provide words to search for, or a pattern with -e.",
        "words",
      );
    }
    const loaded = await loadDocsIndex({ fresh: flags.fresh });
    const outcome = searchDocs(loaded.index, {
      query,
      patterns,
      limit: flags.limit,
    });
    const warnings = loaded.warning
      ? [loaded.warning, ...outcome.warnings]
      : outcome.warnings;
    yield new CommandOutput<DocsSearchOutput>({
      results: outcome.results,
      warnings,
    });
  },
});
