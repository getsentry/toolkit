import { getActiveSpan } from "@sentry/core";
import { z } from "zod";
import { defineTool } from "../../internal/tool-helpers/define";
import { formatFeedbackSuggestion } from "../../internal/tool-helpers/feedback-suggestion";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ALL_SKILLS } from "../../skills";
import type { ServerContext } from "../../types";
import type { StructuredToolOutput } from "../types";
import type { ToolRegistry } from "../catalog-runtime/availability";
import { searchToolCatalog } from "../catalog-runtime/search";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

const toolAnnotationsOutputSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

export const searchToolsOutputSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z
        .record(z.string(), z.unknown())
        .describe(
          "JSON Schema for the matching tool's arguments. Session-constrained parameters are omitted.",
        ),
      annotations: toolAnnotationsOutputSchema,
    }),
  ),
  notes: z.array(z.string()),
});

type SearchToolsOutput = z.infer<typeof searchToolsOutputSchema>;

function createSearchToolsResult(
  payload: SearchToolsOutput,
): StructuredToolOutput<SearchToolsOutput> {
  const activeSpan = getActiveSpan();

  if (activeSpan) {
    activeSpan.setAttribute("gen_ai.tool.call.result", JSON.stringify(payload));
    activeSpan.setAttribute(
      "gen_ai.tool.call.result.count",
      payload.results.length,
    );
  }

  return structuredResult(payload);
}

export function createSearchToolsTool(getTools: () => ToolRegistry) {
  return defineTool({
    name: "search_sentry_tools",
    title: "Search Sentry Tools",
    skills: ALL_SKILLS,
    requiredScopes: [],
    description:
      "Search Sentry operations that are not listed as direct tools, such as projects, teams, DSNs, releases, docs, snapshots, and attachments. Returns each match's name, description, and input schema for execute_sentry_tool. Search before you decide a Sentry operation is unavailable.",
    inputSchema: {
      query: z
        .string()
        .trim()
        .min(1)
        .describe("Keywords for the Sentry operation or resource."),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_LIMIT)
        .nullable()
        .default(DEFAULT_LIMIT)
        .describe("Maximum matches to return."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    outputSchema: searchToolsOutputSchema,
    async handler(params, context: ServerContext) {
      const results = searchToolCatalog({
        tools: getTools(),
        context,
        query: params.query,
        limit: params.limit ?? DEFAULT_LIMIT,
      });

      const feedbackSuggestion =
        results.length === 0
          ? formatFeedbackSuggestion(
              "No Sentry tool matched. Try other keywords first. If no Sentry tool can do this task",
              context,
            )
          : null;

      return createSearchToolsResult({
        query: params.query,
        results,
        notes: feedbackSuggestion ? [feedbackSuggestion] : [],
      });
    },
  });
}
