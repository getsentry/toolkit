import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { detectDocsContext } from "../../lib/docs-context.js";
import { queryDocs } from "../../lib/docs-service.js";
import { ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { withProgress } from "../../lib/polling.js";

type QueryFlags = { readonly fields?: string[]; readonly json: boolean };
type QueryOutput = {
  answer: string;
  detectedContext: Awaited<ReturnType<typeof detectDocsContext>>;
  sources: string[];
};

/** Friendly wait messages for a docs-MCP request without measurable stages. */
const DOCS_QUERY_PROGRESS_MESSAGES = [
  "Finding the relevant bits…",
  "Cross-checking the details…",
  "It’s getting there…",
  "Collecting trusted sources…",
] as const;

function formatQueryHuman(data: QueryOutput): string {
  return data.answer;
}

export const queryCommand = buildCommand({
  docs: {
    brief: "Ask a cited question about Sentry documentation",
    fullDescription:
      "Answer a natural-language Sentry documentation question using current docs.sentry.io pages. " +
      "The command automatically uses safe local project metadata (manifests and config presence only) to tailor the answer.\n\n" +
      'Examples:\n  sentry docs "How do I configure Next.js tracing?"\n  sentry docs query "How do I upload source maps?"\n  sentry docs search "How does session replay mask text?"\n  sentry docs "How do I configure tracing?" --json',
  },
  output: { human: formatQueryHuman },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Natural-language docs question",
        parse: String,
        placeholder: "question",
      },
    },
  },
  async *func(this: SentryContext, _flags: QueryFlags, ...parts: string[]) {
    const query = parts.join(" ").trim();
    if (!query) {
      throw new ValidationError(
        "Provide a documentation question.",
        "question"
      );
    }
    const detectedContext = await detectDocsContext(this.cwd);
    const result = await withProgress(
      {
        interactiveOnly: true,
        json: _flags.json,
        message: "Searching Sentry docs…",
        rotatingMessages: DOCS_QUERY_PROGRESS_MESSAGES,
        rotationIntervalMs: 4000,
      },
      async () => queryDocs(query, detectedContext)
    );
    yield new CommandOutput<QueryOutput>({ ...result, detectedContext });
  },
});
