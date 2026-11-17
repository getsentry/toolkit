import {
  asSchema,
  type JSONSchema7,
  type JSONValue,
  jsonSchema,
  tool,
} from "ai";
import { z } from "zod";
import { searchPages } from "../sentry-docs/doctree";
import {
  buildDocsUrl,
  fetchDocPage,
  normalizeDocPath,
} from "../sentry-docs/fetcher";

/**
 * Truncate a fetched doc page to keep the agent's context window bounded.
 *
 * The head of the doc always contains the canonical setup steps; the
 * tail is usually changelog/reference and not needed for synthesis.
 */
const MAX_PAGE_CHARS = 25_000;

/** Sort object keys, recursively, the way Mastra serialized tool results. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/**
 * The JSON schema Mastra sent for a tool: `minLength` moves into the
 * property's description as a "constraints" line.
 */
function mastraToolSchema(schema: z.ZodObject): JSONSchema7 {
  const json = structuredClone(asSchema(schema).jsonSchema);
  for (const property of Object.values(json.properties ?? {})) {
    if (typeof property === "object" && property.minLength !== undefined) {
      property.description = `${property.description}\nconstraints: minimum length ${property.minLength}`;
      delete property.minLength;
    }
  }
  return json;
}

/**
 * A docs tool that behaves the way it did as a Mastra tool: invalid input
 * comes back to the model as Mastra's validation error result, in call order
 * with the other results, instead of an AI SDK tool error.
 */
function docsTool<Schema extends z.ZodObject, Output>({
  description,
  execute,
  name,
  schema,
}: {
  description: string;
  execute: (input: z.infer<Schema>) => Promise<Output>;
  name: string;
  schema: Schema;
}) {
  return tool<unknown, unknown>({
    description,
    execute: (input): Promise<unknown> => {
      const parsed = schema.safeParse(input);
      if (parsed.success) {
        return execute(parsed.data);
      }
      return Promise.resolve({
        error: true,
        message: `Tool input validation failed for ${name}. Please fix the following errors and try again:\n${parsed.error.issues.map((issue) => `- ${issue.path.join(".") || "root"}: ${issue.message}`).join("\n")}\n\nProvided arguments: ${truncateArguments(input)}`,
        validationErrors: fieldErrors(parsed.error.issues),
      });
    },
    inputSchema: jsonSchema(mastraToolSchema(schema)),
    toModelOutput: (output) => ({
      type: "json",
      value: sortKeys(output) as JSONValue,
    }),
  });
}

interface FieldErrors {
  errors: string[];
  fields: Record<string, FieldErrors>;
}

function fieldErrors(issues: z.core.$ZodIssue[]): FieldErrors {
  const root: FieldErrors = { errors: [], fields: {} };
  for (const issue of issues) {
    let node = root;
    for (const key of issue.path.map(String)) {
      node.fields[key] ??= { errors: [], fields: {} };
      node = node.fields[key];
    }
    node.errors.push(issue.message);
  }
  return root;
}

function truncateArguments(input: unknown): string {
  const text = JSON.stringify(input, null, 2) ?? "undefined";
  return text.length <= 200 ? text : `${text.slice(0, 200)}... (truncated)`;
}

/**
 * `search_docs` — discovery tool the agents use to find relevant docs.sentry.io pages.
 * Returns up to 8 hits with `url`, `title`, `description`.
 */
export function createSearchDocsTool() {
  return docsTool({
    name: "search_docs",
    description:
      "Search docs.sentry.io for pages relevant to a query. Returns up to 8 matching pages with their URL, title, and description. Use this to discover the right doc page when you don't already have its path.",
    execute: async ({ query }) => {
      const hits = await searchPages(query, 8);
      return { hits };
    },
    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Free-text search, e.g. 'celery integration', 'session replay privacy', 'sourcemaps webpack'",
        ),
    }),
  });
}

/**
 * `fetch_doc_page` — page reader. Returns the pre-rendered Markdown for a path.
 * The body is truncated to MAX_PAGE_CHARS to keep the agent's context bounded.
 */
export function createFetchDocPageTool(fetchedUrls?: string[]) {
  return docsTool({
    name: "fetch_doc_page",
    description:
      "Fetch the full pre-rendered Markdown of a docs.sentry.io page. Pass the path you got from search_docs (or a known path like '/platforms/javascript/guides/nextjs/'). A successful response includes its canonical url; only cite urls returned by successful fetches.",
    execute: async ({ path }) => {
      const normalizedPath = normalizeDocPath(path);
      const url = buildDocsUrl(normalizedPath);
      try {
        const content = await fetchDocPage(normalizedPath);
        fetchedUrls?.push(url);
        const truncated =
          content.length > MAX_PAGE_CHARS
            ? `${content.slice(0, MAX_PAGE_CHARS)}\n\n[... truncated, ${content.length - MAX_PAGE_CHARS} more chars ...]`
            : content;
        return { content: truncated, path: normalizedPath, url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message, path };
      }
    },
    schema: z.object({
      path: z
        .string()
        .min(1)
        .describe(
          "Docs path or full docs.sentry.io URL. The .md suffix is added automatically.",
        ),
    }),
  });
}
