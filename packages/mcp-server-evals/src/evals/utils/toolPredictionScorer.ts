import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { getOpenRouterModel } from "@sentry/mcp-core/internal/agents/openrouter-provider";

// Cache for available tools to avoid reconnecting for each test
let cachedTools: string[] | null = null;

/**
 * Get available tools from the MCP server by connecting to it directly.
 * This ensures the tool list stays in sync with what's actually registered.
 */
async function getAvailableTools(): Promise<string[]> {
  if (cachedTools) {
    return cachedTools;
  }

  // Use pnpm exec to run the binary from the workspace
  const transport = new Experimental_StdioMCPTransport({
    command: "pnpm",
    args: [
      "exec",
      "sentry-mcp",
      "--access-token=mocked-access-token",
      "--all-skills",
    ],
    env: {
      ...process.env,
      SENTRY_ACCESS_TOKEN: "mocked-access-token",
      SENTRY_HOST: "sentry.io",
    },
  });

  const client = await experimental_createMCPClient({
    transport,
  });

  // Discover available tools
  const toolsMap = await client.tools();

  // Convert tools to the format expected by the scorer
  cachedTools = Object.entries(toolsMap).map(([name, tool]) => {
    // Extract the first line of description for a concise summary
    const shortDescription = (tool as any).description?.split("\n")[0] || "";
    return `${name} - ${shortDescription}`;
  });

  // Clean up
  await client.close();

  return cachedTools;
}

export interface ExpectedToolCall {
  name: string;
  arguments: Record<string, any>;
}

interface ToolPredictionScorerOptions {
  input: string;
  output: string;
  expectedTools?: ExpectedToolCall[];
  result?: any;
}

const predictionSchema = z.object({
  score: z.number().min(0).max(1).describe("Score from 0 to 1"),
  rationale: z.string().describe("Explanation of the score"),
  predictedTools: z
    .array(
      z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.any()).optional().default({}),
      }),
    )
    .describe("What tools the AI would likely call"),
});

function generateSystemPrompt(
  availableTools: string[],
  task: string,
  expectedDescription: string,
): string {
  return `You are evaluating whether an AI assistant with access to Sentry MCP tools would make the correct tool calls for a given task.

[AVAILABLE TOOLS]
${availableTools.join("\n")}

[TASK]
${task}

[EXPECTED TOOL CALLS]
${expectedDescription}

Based on the task and available tools, predict what tools the AI would call to complete this task.

IMPORTANT: Look at what information is already provided in the task:
- When only an organization name is given (e.g., "in sentry-mcp-evals"), discovery calls ARE typically needed
- When organization/project are given in "org/project" format, the AI may skip discovery if confident
- The expected tool calls show what is ACTUALLY expected for this specific case - follow them exactly
- Discovery calls (find_organizations, find_projects) are commonly used to get regionUrl and verify access
- Match the expected tool sequence exactly - if expected includes discovery, predict discovery

Consider:
1. Match the expected tool sequence exactly - the expected tools show realistic AI behavior
2. When a value like "sentry-mcp-evals" appears alone, it's typically an organizationSlug, not a projectSlug
3. Arguments should match expected values (organizationSlug, projectSlug, name, etc.)
4. For natural language queries in search tools (search_errors, search_traces, search_logs, etc.), exact phrasing doesn't need to match
5. Extra parameters like regionUrl are acceptable
6. The AI commonly does discovery calls even when slugs appear to be provided, to get region info

Score as follows:
- 1.0: All expected tools would be called with correct arguments in the right order
- 0.8: All expected tools would be called, minor differences (extra params, slight variations)
- 0.6: Most expected tools would be called but missing some or wrong order
- 0.3: Some expected tools would be called but significant issues
- 0.0: Wrong tools or critical tools missing

CRITICAL: The expected tools represent the actual realistic behavior for this specific case. Follow the expected sequence exactly:
- If expected tools include discovery calls, predict discovery calls
- If expected tools do NOT include discovery calls, do NOT predict them
- The test author has determined what's appropriate for each specific scenario`;
}

/**
 * A scorer that uses AI to predict what tools would be called without executing them.
 * This is much faster than actually running the tools and checking what was called.
 *
 * @param model - Optional language model to use for predictions (defaults to OpenRouter)
 * @returns A scorer function that compares predicted vs expected tool calls
 *
 * @example
 * ```typescript
 * import { ToolPredictionScorer } from './utils/toolPredictionScorer';
 * import { NoOpTaskRunner } from './utils/runner';
 * import { describeEval } from 'vitest-evals';
 *
 * describeEval("Sentry issue search", {
 *   data: async () => [
 *     {
 *       input: "Find the newest issues in my-org",
 *       expectedTools: [
 *         { name: "find_organizations", arguments: {} },
 *         { name: "find_issues", arguments: { organizationSlug: "my-org", sortBy: "first_seen" } }
 *       ]
 *     }
 *   ],
 *   task: NoOpTaskRunner(), // Don't execute tools, just predict them
 *   scorers: [ToolPredictionScorer()],
 *   threshold: 0.8
 * });
 * ```
 *
 * The scorer works by:
 * 1. Connecting to the MCP server to get available tools and their descriptions
 * 2. Using AI to predict what tools would be called for the given task
 * 3. Comparing predictions against the expectedTools array
 * 4. Returning a score from 0.0 to 1.0 based on accuracy
 *
 * Scoring criteria:
 * - 1.0: All expected tools predicted with correct arguments in right order
 * - 0.8: All expected tools predicted, minor differences (extra params, slight variations)
 * - 0.6: Most expected tools predicted but missing some or wrong order
 * - 0.3: Some expected tools predicted but significant issues
 * - 0.0: Wrong tools or critical tools missing
 *
 * If `expectedTools` is not provided in test data, the scorer is automatically skipped
 * and returns `{ score: null }` to allow other scorers to run without interference.
 */
export function ToolPredictionScorer(
  model: LanguageModel = getOpenRouterModel(),
) {
  return async function ToolPredictionScorer(
    opts: ToolPredictionScorerOptions,
  ) {
    // If expectedTools is not defined, skip this scorer
    if (!opts.expectedTools) {
      return {
        score: null,
        metadata: {
          rationale: "Skipped: No expectedTools defined for this test case",
        },
      };
    }

    const expectedTools = opts.expectedTools;

    // Get available tools from the MCP server
    const AVAILABLE_TOOLS = await getAvailableTools();

    // Generate a description of the expected tools for the prompt
    const expectedDescription = expectedTools
      .map(
        (tool) =>
          `- ${tool.name} with arguments: ${JSON.stringify(tool.arguments)}`,
      )
      .join("\n");

    const { object } = await generateObject({
      model,
      prompt: generateSystemPrompt(
        AVAILABLE_TOOLS,
        opts.input,
        expectedDescription,
      ),
      schema: predictionSchema,
      providerOptions: {
        openai: {
          structuredOutputs: false,
          strictJsonSchema: false,
        },
      },
      experimental_telemetry: {
        isEnabled: true,
        functionId: "tool_prediction_scorer",
      },
    });

    return {
      score: object.score,
      metadata: {
        rationale: object.rationale,
        predictedTools: object.predictedTools,
        expectedTools: expectedTools,
      },
    };
  };
}
