import { z } from "zod";
import type { SentryApiService } from "../../../api-client";
import { callEmbeddedAgent } from "../../../internal/agents/callEmbeddedAgent";
import { createDatasetFieldsTool } from "../../../internal/agents/tools/dataset-fields";
import { createWhoamiTool } from "../../../internal/agents/tools/whoami";
import { systemPrompt } from "./config";

// .default("") on explanation is safe because structuredOutputs: false is set via providerOptions.
// If structuredOutputs is re-enabled, remove .default() calls (OpenAI requires all fields in 'required').
// Tracking: https://github.com/getsentry/sentry-mcp/issues/623
export const searchIssuesAgentOutputSchema = z.object({
  query: z.string().describe("The Sentry issue search query"),
  sort: z
    .enum(["date", "freq", "new", "user", "recommended"])
    .nullable()
    .describe("How to sort the results"),
  explanation: z
    .string()
    .default("")
    .describe("Brief explanation of how you translated this query."),
});

export interface SearchIssuesAgentOptions {
  query: string;
  organizationSlug: string;
  apiService: SentryApiService;
  projectId?: string | undefined;
}

/**
 * Search issues agent - single entry point for translating natural language queries to Sentry issue search syntax
 * This returns both the translated query result AND the tool calls made by the agent
 */
export async function searchIssuesAgent(
  options: SearchIssuesAgentOptions,
): Promise<{
  result: z.output<typeof searchIssuesAgentOutputSchema>;
  toolCalls: any[];
}> {
  // Provider check happens in callEmbeddedAgent via getAgentProvider()
  // Create tools pre-bound with the provided API service and organization
  return await callEmbeddedAgent({
    system: systemPrompt,
    prompt: options.query,
    tools: {
      issueFields: createDatasetFieldsTool({
        apiService: options.apiService,
        organizationSlug: options.organizationSlug,
        dataset: "search_issues",
        projectId: options.projectId,
      }),
      whoami: createWhoamiTool({ apiService: options.apiService }),
    },
    schema: searchIssuesAgentOutputSchema,
  });
}
