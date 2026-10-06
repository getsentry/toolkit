import type { SentryContext } from "../../context.js";
import { validateLimit } from "../../lib/arg-parsing.js";
import { buildCommand } from "../../lib/command.js";
import { type DocsListResponse, listDocs } from "../../lib/docs-service.js";
import { ValidationError } from "../../lib/errors.js";
import { muted } from "../../lib/formatters/colors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { formatTable } from "../../lib/formatters/table.js";

type ListFlags = {
  readonly fields?: string[];
  readonly json: boolean;
  readonly limit: number;
};

function parseLimit(value: string): number {
  return validateLimit(value, 1, 20);
}

function formatListHuman(data: DocsListResponse): string {
  if (data.results.length === 0) {
    return muted("No documentation pages match that search.");
  }
  return formatTable(data.results, [
    { header: "TITLE", value: (result) => result.title, truncate: true },
    {
      header: "DESCRIPTION",
      value: (result) => result.description ?? "",
      truncate: true,
    },
    { header: "URL", value: (result) => result.url, truncate: true },
  ]);
}

export const listCommand = buildCommand({
  docs: {
    brief: "Find Sentry documentation pages by keyword",
    fullDescription:
      "Search the Sentry documentation index without synthesizing an answer. Returns ranked page titles, descriptions, and URLs.\n\n" +
      'Examples:\n  sentry docs list "nextjs tracing"\n  sentry docs list "session replay privacy" --limit 5\n  sentry docs list "source maps" --json',
  },
  output: { human: formatListHuman },
  parameters: {
    flags: {
      limit: {
        kind: "parsed",
        parse: parseLimit,
        brief: "Maximum matches to return (1-20)",
        default: "8",
      },
    },
    aliases: { n: "limit" },
    positional: {
      kind: "array",
      parameter: {
        brief: "Documentation keywords",
        parse: String,
        placeholder: "keywords",
      },
    },
  },
  async *func(this: SentryContext, flags: ListFlags, ...parts: string[]) {
    const query = parts.join(" ").trim();
    if (!query) {
      throw new ValidationError(
        "Provide documentation keywords to search for.",
        "keywords"
      );
    }
    yield new CommandOutput(await listDocs(query, flags.limit));
  },
});
