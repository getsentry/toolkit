import { getActiveSpan } from "@sentry/core";
import { z } from "zod";
import { createApiError } from "../../api-client/index";
import { fetchWithTimeout } from "../../internal/fetch-utils";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  buildSuggestedToolAction,
  suggestedToolActionSchema,
} from "../../internal/tool-helpers/suggested-actions";
import { formatAvailableToolCallInstruction } from "../../internal/tool-helpers/tool-call-formatting";
import { ParamSentryGuide } from "../../schema";
import type { ServerContext } from "../../types";
import type { SearchResponse } from "../types";

// Snippets are search chunks, so only the top results carry one to keep the
// response small when callers ask for up to 10 results.
const MAX_SNIPPETS = 3;

export const searchDocsOutputSchema = z.object({
  query: z.string(),
  guide: z.string().nullable(),
  results: z.array(
    z.object({
      path: z.string().describe("Pass to get_doc as `path`."),
      url: z.string(),
      relevance: z.number().describe("Match score from 0 to 1."),
      snippet: z
        .string()
        .nullable()
        .describe(
          `Matching excerpt, not the full page. Null after the first ${MAX_SNIPPETS} results.`,
        ),
    }),
  ),
  suggestedActions: z.array(suggestedToolActionSchema),
});

export default defineTool({
  name: "search_docs",
  title: "Search Sentry Docs",
  skills: ["inspect", "docs"], // Docs is retained for legacy docs-only grants.
  requiredScopes: [],
  description: ({ experimentalMode, availableToolNames, directToolNames }) => {
    const getDocInstruction = formatAvailableToolCallInstruction({
      toolName: "get_doc",
      purpose: "to read a full page.",
      experimentalMode,
      availableToolNames,
      directToolNames,
    });
    return [
      "Search Sentry documentation for SDK setup, framework integrations, instrumentation, and configuration such as sampling, data scrubbing, and source maps. Returns matching page paths and snippets only.",
      getDocInstruction,
    ]
      .filter(Boolean)
      .join(" ");
  },
  inputSchema: {
    query: z
      .string()
      .trim()
      .min(
        2,
        "Search query is too short. Please provide at least 2 characters.",
      )
      .max(
        200,
        "Search query is too long. Please keep your query under 200 characters.",
      )
      .describe(
        "Natural-language query. Name the SDK option or feature when you know it, such as `beforeSend` or `tracesSampleRate`.",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("Maximum results to return."),
    guide: ParamSentryGuide.optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: searchDocsOutputSchema,
  async handler(params, context: ServerContext) {
    // Determine the URL - use context.mcpUrl if available, otherwise default to production
    const host = context.mcpUrl || "https://mcp.sentry.dev";
    const searchUrl = new URL("/api/search", host);

    const response = await fetchWithTimeout(
      searchUrl.toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: params.query,
          maxResults: params.maxResults,
          guide: params.guide,
        }),
      },
      15000, // 15 second timeout
    );

    if (!response.ok) {
      // TODO: improve error responses with types
      const errorData = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;

      const errorMessage =
        errorData?.error || `Search failed with status ${response.status}`;
      throw createApiError(errorMessage, response.status, undefined, errorData);
    }

    const data = (await response.json()) as SearchResponse;

    // The search endpoint reports failures with non-2xx statuses. An error in
    // a 2xx body means it misbehaved, so surface it as a server error rather
    // than an empty, success-shaped result.
    if ("error" in data && data.error) {
      throw createApiError(data.error, 502);
    }

    getActiveSpan()?.setAttribute(
      "gen_ai.tool.call.result.count",
      data.results.length,
    );

    const results = data.results.map((result, index) => ({
      path: result.id,
      url: result.url,
      relevance: result.relevance,
      snippet: index < MAX_SNIPPETS ? result.snippet : null,
    }));

    // The search route sends an empty path when a hit has no filename.
    const topPath = results.find((result) => result.path)?.path;
    const getDocAction = topPath
      ? buildSuggestedToolAction({
          toolName: "get_doc",
          arguments: { path: topPath },
          reason:
            "Results are snippets; fetch the full page for the top match.",
          experimentalMode: context.experimentalMode ?? false,
          availableToolNames: context.availableToolNames,
          directToolNames: context.directToolNames,
        })
      : null;

    return structuredResult({
      query: params.query,
      guide: params.guide ?? null,
      results,
      suggestedActions: getDocAction ? [getDocAction] : [],
    });
  },
});
