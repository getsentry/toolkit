import { z } from "zod";
import { runQueryAgent } from "./agent/query-agent";
import { getDoctree, searchPages } from "./sentry-docs/doctree";

const UNGROUNDED_DOCS_ERROR_RE =
  /Citation URL is not an allowed Sentry docs URL|Docs citation .*not fetched|Docs query returned no fetched sources|Docs query answer must include an inline citation/;
const MODEL_UNAVAILABLE_ERROR_RE = /model is not available in your region/i;

const projectContextSchema = z.object({
  frameworks: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  languages: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  sentryConfigured: z.boolean().optional(),
});

export const queryDocsInputSchema = z.object({
  context: projectContextSchema
    .optional()
    .describe("Optional safe project metadata used only to tailor the answer"),
  query: z.string().min(1).max(2000).describe("Natural-language docs question"),
});

export const searchDocsInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum number of matching pages to return (default 8)"),
  query: z.string().min(1).describe("Keywords to search for"),
});

export type QueryDocsInput = z.infer<typeof queryDocsInputSchema>;
export type SearchDocsInput = z.infer<typeof searchDocsInputSchema>;
export type InternalDocsRequest =
  | (QueryDocsInput & { operation: "query-docs" })
  | (SearchDocsInput & { operation: "search-docs" });

export const internalDocsRequestSchema: z.ZodType<InternalDocsRequest> =
  z.discriminatedUnion("operation", [
    queryDocsInputSchema.extend({ operation: z.literal("query-docs") }),
    searchDocsInputSchema.extend({ operation: z.literal("search-docs") }),
  ]);

export function isUngroundedDocsError(error: unknown): boolean {
  return error instanceof Error && UNGROUNDED_DOCS_ERROR_RE.test(error.message);
}

/** Identify upstream model failures that can be safely explained to callers. */
export function isModelUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error && MODEL_UNAVAILABLE_ERROR_RE.test(error.message)
  );
}

export function executeDocsQuery(
  apiKey: string | undefined,
  input: QueryDocsInput,
  docsVersion?: string,
) {
  if (!apiKey) {
    throw new Error("Set OPENROUTER_API_KEY on the docs-mcp worker");
  }

  // Start loading the index before the agent needs its search tool. Failures
  // are retried by the agent, so they should not block the request here.
  getDoctree().catch(() => {
    // swallow
  });

  return runQueryAgent(apiKey, input.query, input.context, docsVersion);
}

export async function executeDocsSearch(input: SearchDocsInput) {
  return { results: await searchPages(input.query, input.limit ?? 8) };
}

export function executeInternalDocsRequest(
  apiKey: string | undefined,
  request: InternalDocsRequest,
  docsVersion?: string,
) {
  switch (request.operation) {
    case "query-docs":
      return executeDocsQuery(apiKey, request, docsVersion);
    case "search-docs":
      return executeDocsSearch(request);
    default:
      throw new Error("Unsupported docs operation");
  }
}
