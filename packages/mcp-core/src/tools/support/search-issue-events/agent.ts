import { z } from "zod";
import {
  callEmbeddedAgent,
  type ToolCall,
} from "../../../internal/agents/callEmbeddedAgent";
import type { SentryApiService } from "../../../api-client";
import { createWhoamiTool } from "../../../internal/agents/tools/whoami";
import { createIssueEventFieldsTool } from "./utils";
import { systemPrompt } from "./config";

// .default("") on explanation is safe because structuredOutputs: false is set via providerOptions.
// If structuredOutputs is re-enabled, remove .default() calls (OpenAI requires all fields in 'required').
// Tracking: https://github.com/getsentry/sentry-mcp/issues/623
export const searchIssueEventsAgentOutputSchema = z
  .object({
    query: z
      .string()
      .describe(
        "Sentry query filters for tags/fields (NOT including issue: prefix - handler adds that)",
      ),
    fields: z
      .array(z.string())
      .describe("Array of field names to return in results"),
    sort: z.string().describe("Sort parameter for results (e.g., -timestamp)"),
    timeRange: z
      .union([
        z.object({
          statsPeriod: z
            .string()
            .describe("Relative time period like '1h', '24h', '7d', '14d'"),
        }),
        z.object({
          start: z.string().describe("ISO 8601 start time"),
          end: z
            .string()
            .optional()
            .describe(
              "ISO 8601 end time. Omit for open-ended ranges like 'since X'; the search then runs until now.",
            ),
        }),
        z.null(),
      ])
      .default(null)
      .describe(
        "Time range for filtering events. Use either statsPeriod for relative time or start (and optional end) for absolute time. Use null for default 14-day window.",
      ),
    explanation: z
      .string()
      .default("")
      .describe("Brief explanation of how you translated this query"),
  })
  .refine(
    (data) => {
      // Only validate if both sort and fields are present
      if (!data.sort || data.fields.length === 0) {
        return true;
      }

      // Extract the field name from sort parameter (e.g., "-timestamp" -> "timestamp")
      const sortField = data.sort.startsWith("-")
        ? data.sort.substring(1)
        : data.sort;

      // Check if sort field is in fields array
      return data.fields.includes(sortField);
    },
    {
      message:
        "Sort field must be included in the fields array. Sentry requires that any field used for sorting must also be explicitly selected. Add the sort field to the fields array or choose a different sort field that's already included.",
    },
  );

export interface SearchIssueEventsAgentOptions {
  query: string;
  organizationSlug: string;
  apiService: SentryApiService;
  projectId?: string | undefined;
}

/**
 * Search issue events agent - translates natural language queries to Sentry tag filters for events within a specific issue
 * Returns both the translated query result AND the tool calls made by the agent
 */
export async function searchIssueEventsAgent(
  options: SearchIssueEventsAgentOptions,
): Promise<{
  result: z.output<typeof searchIssueEventsAgentOutputSchema>;
  toolCalls: ToolCall[];
}> {
  // Provider check happens in callEmbeddedAgent via getAgentProvider()
  // Create tools pre-bound with the provided API service and organization
  const issueEventFieldsTool = createIssueEventFieldsTool({
    apiService: options.apiService,
    organizationSlug: options.organizationSlug,
    projectId: options.projectId,
  });

  const whoamiTool = createWhoamiTool({
    apiService: options.apiService,
  });

  // Use callEmbeddedAgent to translate the query with tool call capture
  return await callEmbeddedAgent({
    system: systemPrompt,
    prompt: options.query,
    tools: {
      issueEventFields: issueEventFieldsTool,
      whoami: whoamiTool,
    },
    schema: searchIssueEventsAgentOutputSchema,
  });
}
