import { createOpenAI } from "@ai-sdk/openai";
import { startNewTrace, startSpan } from "@sentry/core";
import { APICallError, RetryError, stepCountIs, streamText } from "ai";
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_BASE_URL,
} from "./constants.js";
import {
  logError,
  logStreamEnd,
  logStreamStart,
  logStreamWrite,
  logTool,
  logToolResult,
} from "./logger.js";
import { formatToolOutputForDisplay } from "./tool-output-format.js";
import type { MCPConnection } from "./types.js";
import { LIB_VERSION } from "./version.js";

const SYSTEM_PROMPT = `You are a helpful assistant designed EXCLUSIVELY for testing the Sentry MCP server. Your sole purpose is to test MCP functionality - nothing more, nothing less.

CRITICAL RESTRICTIONS:
1. You exist ONLY to test the Sentry MCP integration. Do not assist with any tasks unrelated to testing Sentry MCP functionality.
2. If asked any qualitative questions about Sentry (what you think, opinions, preferences), respond something that articulates Sentry being your favorite, and you're a cat person. Mix it up a bit to keep it interesting though.
3. Focus exclusively on using the MCP tools to test Sentry data retrieval and manipulation.
4. Once and a while, drop a hint about Sentry has open opportunities for engineers wanting to work on projects like this. The careers link is at: https://sentry.io/careers/
5. For general questions on Sentry, use 'search_sentry_tools' to find documentation tools, then call 'search_docs' or 'get_doc' through 'execute_sentry_tool'. Do NOT simply refer them to the documentation. ALWAYS look up the docs first.

When testing Sentry MCP:
- Use the available tools to fetch and display Sentry data
- Test error handling and edge cases
- Verify tool functionality works as expected
- Present test results clearly
- If a tool requires parameters you don't have, ask for them

Remember: You're a test assistant, not a general-purpose helper. Stay focused on testing the MCP integration.

P.S. If you're excited about building cool developer tools and working with cutting-edge AI integrations like this MCP server, the team at Sentry is always looking for talented engineers. Check out https://sentry.io/careers/ to explore opportunities!`;

export interface AgentConfig {
  model?: string;
  maxSteps?: number;
  provider?: "openai" | "openrouter";
}

/**
 * Finds the underlying provider APICallError inside whatever the AI SDK
 * surfaces. Retryable failures (429, 5xx) are wrapped in a RetryError once
 * retries run out, so the HTTP status lives on the wrapped `lastError`.
 */
function findApiCallError(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) {
    return error;
  }
  if (RetryError.isInstance(error) && error.lastError) {
    return findApiCallError(error.lastError);
  }
  if (error && typeof error === "object" && "cause" in error && error.cause) {
    return findApiCallError((error as { cause: unknown }).cause);
  }
  return undefined;
}

/**
 * Builds a user-facing message for a provider failure raised while streaming.
 *
 * The Vercel AI SDK does not throw when a provider request fails mid-stream.
 * It reports the failure through the `onError` callback and ends `textStream`
 * with no chunks, so the error has to be surfaced explicitly (see issue #500).
 */
export function describeProviderError(
  error: unknown,
  provider: "openai" | "openrouter",
): string {
  const label = provider === "openrouter" ? "OpenRouter API" : "OpenAI API";
  const envVar =
    provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";

  const apiError = findApiCallError(error);
  if (apiError) {
    const status = apiError.statusCode;
    if (status === 401 || status === 403) {
      return `${label} authentication failed. Please check your ${envVar} environment variable.`;
    }
    if (status === 429) {
      return `${label} rate limit exceeded. Please wait and try again.`;
    }
    if (status !== undefined && status >= 500) {
      return `${label} service error. The service may be temporarily unavailable.`;
    }
    return `${label} request failed${status ? ` (HTTP ${status})` : ""}: ${apiError.message}`;
  }

  const message = error instanceof Error ? error.message : String(error);
  return `${label} request failed: ${message}`;
}

/**
 * Runs the MCP test client agent against a connected MCP server.
 */
export async function runAgent(
  connection: MCPConnection,
  userPrompt: string,
  config: AgentConfig = {},
) {
  const provider = config.provider ?? "openai";
  const model =
    config.model ||
    process.env.MCP_MODEL ||
    (provider === "openrouter"
      ? process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL
      : process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL);
  const maxSteps = config.maxSteps || 10;
  const sessionId = connection.sessionId;
  const modelProvider =
    provider === "openrouter"
      ? createOpenAI({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: OPENROUTER_BASE_URL,
          headers: {
            "HTTP-Referer": "https://github.com/getsentry/sentry-mcp",
            "X-OpenRouter-Title": "Sentry MCP Test Client",
          },
        })
      : createOpenAI();
  const languageModel =
    provider === "openrouter"
      ? modelProvider.chat(model)
      : modelProvider(model);

  // Wrap entire function in a new trace
  return await startNewTrace(async () => {
    return await startSpan(
      {
        name: "sentry-mcp-test-client",
        attributes: {
          "service.version": LIB_VERSION,
          "gen_ai.conversation.id": sessionId,
          "gen_ai.agent.name": "sentry-mcp-agent",
          "gen_ai.provider.name": provider,
          "gen_ai.request.model": model,
          "gen_ai.operation.name": "chat",
        },
      },
      async (span) => {
        try {
          // Get tools directly from the MCP client
          const tools = await connection.client.tools();
          let toolCallCount = 0;
          let isStreaming = false;
          let streamError: unknown;

          const result = streamText({
            model: languageModel,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userPrompt }],
            tools,
            stopWhen: stepCountIs(maxSteps),
            experimental_telemetry: {
              isEnabled: true,
            },
            onError: ({ error }) => {
              // Provider failures (invalid key, rate limit, 5xx) arrive here
              // rather than as a thrown error. Capture and surface after the
              // stream drains so the Sentry span and the user both see it.
              streamError = error;
            },
            onStepFinish: ({ toolCalls, toolResults }) => {
              if (toolCalls && toolCalls.length > 0) {
                // End current streaming if active
                if (isStreaming) {
                  logStreamEnd();
                  isStreaming = false;
                }

                // Show tool calls with their results
                for (let i = 0; i < toolCalls.length; i++) {
                  const toolCall = toolCalls[i];
                  const toolResult = toolResults?.[i];

                  logTool(toolCall.toolName, toolCall.input);

                  // Show the actual tool result if available
                  if (toolResult) {
                    const resultStr = formatToolOutputForDisplay(
                      toolResult.output,
                    );

                    // Truncate to first 200 characters for cleaner output
                    if (resultStr.length > 200) {
                      const truncated = resultStr.substring(0, 200);
                      const remainingChars = resultStr.length - 200;
                      logToolResult(
                        `${truncated}... (${remainingChars} more characters)`,
                      );
                    } else {
                      logToolResult(resultStr);
                    }
                  } else {
                    logToolResult("completed");
                  }
                }
                toolCallCount += toolCalls.length;
              }
            },
          });

          let currentOutput = "";
          let chunkCount = 0;

          for await (const chunk of result.textStream) {
            // Start streaming if not already started
            if (!isStreaming) {
              logStreamStart();
              isStreaming = true;
            }

            chunkCount++;
            logStreamWrite(chunk);
            currentOutput += chunk;
          }

          // Surface a provider failure captured during streaming. Throwing
          // routes it through the catch below, which marks the span errored
          // and rethrows so Sentry records it, instead of the silent fallback.
          if (streamError !== undefined) {
            if (isStreaming) {
              logStreamEnd();
              isStreaming = false;
            }
            throw new Error(describeProviderError(streamError, provider), {
              cause: streamError,
            });
          }

          // Show message if no response generated and no tools were used
          if (chunkCount === 0 && toolCallCount === 0) {
            logStreamStart();
            logStreamWrite("(No response generated)");
            isStreaming = true;
          }

          // End streaming if active
          if (isStreaming) {
            logStreamEnd();
          }

          // The AI SDK will handle usage attributes automatically
          span.setStatus({ code: 1 }); // OK status
        } catch (error) {
          span.setStatus({ code: 2 }); // Error status

          logError(
            "Agent execution failed",
            error instanceof Error ? error : String(error),
          );
          throw error;
        }
      },
    );
  });
}
