import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  type StepResult,
  type Tool,
} from "ai";
import type { z } from "zod";
import {
  AgentExecutionError,
  ConfigurationError,
  LLMProviderError,
  UserInputError,
} from "../../errors";
import { logIssue, logWarn } from "../../telem/logging";
import { getAgentProvider } from "./provider-factory";

// Tool work gets this many model steps; a validated final response may get one more.
const MAX_WORK_STEPS = 5;

/**
 * Resolve the underlying provider failure from an AI SDK error.
 *
 * After retries, the SDK wraps retryable 5xx/network failures in RetryError.
 * Prefer the last error, then walk earlier errors for the first APICallError.
 */
function resolveProviderApiCallError(error: unknown): APICallError | null {
  if (APICallError.isInstance(error)) {
    return error;
  }

  if (!RetryError.isInstance(error)) {
    return null;
  }

  if (APICallError.isInstance(error.lastError)) {
    return error.lastError;
  }

  for (let i = error.errors.length - 1; i >= 0; i--) {
    const candidate = error.errors[i];
    if (APICallError.isInstance(candidate)) {
      return candidate;
    }
  }

  return null;
}

function toLLMProviderError(
  error: APICallError,
  originalError: unknown = error,
): LLMProviderError {
  // OpenAI region restriction error - provide specific helpful message
  if (error.message.includes("Country, region, or territory not supported")) {
    return new LLMProviderError(
      "The AI provider (OpenAI) does not support requests from your region. " +
        "This is a restriction imposed by OpenAI on certain countries and territories. " +
        "Please contact support if you believe this is an error.",
      { cause: originalError },
    );
  }

  const statusCode = error.statusCode;

  // 4xx: account/config/budget/rate-limit style failures
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return new LLMProviderError(
      `The AI provider returned an error: ${error.message}. This may be a configuration, quota, or account issue with the upstream AI provider.`,
      { cause: originalError },
    );
  }

  // 5xx / missing status (network, timeouts): treat as provider outage so
  // tool handlers can fall back instead of failing the parent MCP tool.
  if (!statusCode || statusCode >= 500) {
    return new LLMProviderError(
      `The AI provider is currently unavailable${statusCode ? ` (HTTP ${statusCode})` : ""}: ${error.message}. Please try again later.`,
      { cause: originalError },
    );
  }

  return new LLMProviderError(
    `The AI provider returned an error: ${error.message}. This may be a configuration, quota, or account issue with the upstream AI provider.`,
    { cause: originalError },
  );
}

export type ToolCall = {
  toolName: string;
  args: unknown;
};

interface EmbeddedAgentResult<T> {
  result: T;
  toolCalls: ToolCall[];
}

/**
 * Call an embedded agent with tool call capture
 * This is the standard way to call embedded AI agents within MCP tools
 *
 * Error handling:
 * - Errors are re-thrown for the calling agent to handle
 * - Each agent can implement its own error handling strategy
 */
export async function callEmbeddedAgent<
  TOutput,
  TSchema extends z.ZodType<TOutput, unknown>,
>({
  system,
  prompt,
  tools,
  schema,
  isReadyToFinalize,
}: {
  system: string;
  prompt: string;
  tools: Record<string, Tool>;
  schema: TSchema;
  /** Whether this step produced a result that permits a final response. */
  isReadyToFinalize?: (step: StepResult<Record<string, Tool>>) => boolean;
}): Promise<EmbeddedAgentResult<TOutput>> {
  const capturedToolCalls: ToolCall[] = [];

  function shouldAllowFinalResponseStep(
    steps: StepResult<Record<string, Tool>>[],
  ): boolean {
    if (steps.length !== MAX_WORK_STEPS) return false;
    const lastStep = steps.at(-1);
    return lastStep !== undefined && (isReadyToFinalize?.(lastStep) ?? false);
  }

  // Get the configured provider (OpenAI, Azure OpenAI, or Anthropic)
  const provider = getAgentProvider();

  try {
    const result = await generateText({
      model: provider.getModel(),
      system,
      prompt,
      tools,
      stopWhen: ({ steps }) =>
        steps.length >= MAX_WORK_STEPS && !shouldAllowFinalResponseStep(steps),
      prepareStep: ({ steps }) => {
        if (shouldAllowFinalResponseStep(steps)) return { toolChoice: "none" };
        return undefined;
      },
      experimental_output: Output.object({ schema }),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "callEmbeddedAgent",
      },
      // Provider-specific options (e.g., OpenAI needs structuredOutputs: false)
      // See: https://github.com/getsentry/sentry-mcp/issues/623
      providerOptions: provider.getProviderOptions(),
      onStepFinish: (event) => {
        if (event.toolCalls && event.toolCalls.length > 0) {
          for (const toolCall of event.toolCalls) {
            capturedToolCalls.push({
              toolName: toolCall.toolName,
              args: toolCall.input,
            });
          }
        }
      },
    });

    if (!result.experimental_output) {
      // Same user-visible failure mode as AI SDK NoOutputGeneratedError.
      throw new NoOutputGeneratedError({
        message: "No output generated.",
      });
    }

    const rawOutput = result.experimental_output;

    if (
      typeof rawOutput === "object" &&
      rawOutput !== null &&
      "error" in rawOutput &&
      typeof (rawOutput as { error?: unknown }).error === "string"
    ) {
      throw new UserInputError((rawOutput as { error: string }).error);
    }

    const parsedResult = schema.safeParse(rawOutput);

    if (!parsedResult.success) {
      throw new UserInputError(
        `Invalid agent response: ${parsedResult.error.message}`,
      );
    }

    return {
      result: parsedResult.data,
      toolCalls: capturedToolCalls,
    };
  } catch (error: unknown) {
    // Rescue NoObjectGeneratedError: try to parse the raw LLM text through the schema
    // (schema defaults like .default("") fill missing fields)
    if (NoObjectGeneratedError.isInstance(error)) {
      if (error.text) {
        const rescued = rescueFromText(error.text, schema);
        if (rescued) {
          logWarn("NoObjectGeneratedError rescued via schema defaults", {
            loggerScope: ["agents", "embedded"],
            extra: {
              errorMessage: error.message,
              finishReason: error.finishReason,
            },
          });
          return { result: rescued, toolCalls: capturedToolCalls };
        }
      }
      logWarn("NoObjectGeneratedError could not be rescued", {
        loggerScope: ["agents", "embedded"],
        extra: {
          errorMessage: error.message,
          hasText: !!error.text,
          finishReason: error.finishReason,
        },
      });
      throw new UserInputError(
        "The AI was unable to process your query. Please try rephrasing.",
      );
    }

    // NoOutputGeneratedError: the model exhausted its steps without emitting the
    // structured output (typically after repeated tool/validation failures). This
    // is a recoverable model limitation, not a system fault — surface it as user
    // input like its NoObjectGeneratedError sibling and log a warning, instead of
    // filing a Sentry issue for every occurrence.
    if (NoOutputGeneratedError.isInstance(error)) {
      logWarn("Embedded agent produced no output", {
        loggerScope: ["agents", "embedded"],
        extra: { errorMessage: error.message },
      });
      throw new UserInputError(
        "The AI could not construct a valid query for this request. Please rephrase or narrow it — for example, specify the fields, a real environment name, or a time range.",
      );
    }

    // Handle LLM provider errors with user-friendly messages.
    // These are operational availability failures that should NOT create Sentry
    // issues per request (budget exhaustion, rate limits, provider outages).
    // Also unwrap RetryError: after maxRetries the AI SDK wraps retryable
    // 5xx/network failures so bare APICallError checks alone would miss them.
    const providerError = resolveProviderApiCallError(error);
    if (providerError) {
      throw toLLMProviderError(providerError, error);
    }

    // RetryError without an underlying APICallError is still a provider outage
    // (timeouts/network after retries) and should degrade the same way.
    if (RetryError.isInstance(error)) {
      throw new LLMProviderError(
        `The AI provider is currently unavailable: ${error.message}. Please try again later.`,
        { cause: error },
      );
    }

    // Expected application errors thrown above (schema/user-input/config paths)
    // must keep their original type so callers do not treat them as unexpected.
    // ConfigurationError can come from provider.getProviderOptions() (e.g. bad
    // OPENROUTER_REASONING_EFFORT) and must surface, not silently fall back.
    if (
      error instanceof UserInputError ||
      error instanceof ConfigurationError ||
      error instanceof LLMProviderError ||
      error instanceof AgentExecutionError
    ) {
      throw error;
    }

    // Genuinely unexpected agent failures: file one Sentry issue, then throw a
    // typed error so AI-powered tools can fall back or return a graceful response
    // instead of hard-failing the MCP tool.
    throw toAgentExecutionError(error);
  }
}

function toAgentExecutionError(error: unknown): AgentExecutionError {
  const eventId = logIssue(error, {
    loggerScope: ["agents", "embedded"],
    contexts: {
      embeddedAgent: {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        isNoOutputGenerated: NoOutputGeneratedError.isInstance(error),
      },
    },
  });

  const detail =
    error instanceof Error && error.message
      ? error.message
      : "An unexpected error occurred while running the AI agent.";

  return new AgentExecutionError(
    `The AI agent failed to complete this request: ${detail}`,
    { cause: error, eventId },
  );
}

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (depth === 0) {
      if (ch === "{") {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
        inString = false;
        escaped = false;
      }
    }
  }

  return objects;
}

/**
 * Extract candidate JSON strings from text using multiple strategies.
 * Handles plain JSON, markdown code blocks, and embedded JSON objects.
 */
function extractJsonCandidates(text: string): string[] {
  const candidates = new Set<string>([text]);

  // Strategy 1: Extract from markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  const allMatches = Array.from(text.matchAll(codeBlockRegex));
  for (const match of allMatches) {
    candidates.add(match[1].trim());
  }

  // Strategy 2: Find balanced JSON objects anywhere in the text.
  for (const jsonObject of extractBalancedJsonObjects(text)) {
    candidates.add(jsonObject);
  }

  return Array.from(candidates);
}

/**
 * Attempt to rescue a failed structured output by parsing raw LLM text through the schema.
 * Schema defaults (e.g., `.default("")`) fill missing optional fields.
 * Handles plain JSON, markdown code blocks, and JSON embedded in prose (e.g., Anthropic responses).
 * Returns null if no candidate can be parsed or matched against the schema.
 */
function rescueFromText<TOutput>(
  text: string,
  schema: z.ZodType<TOutput, unknown>,
): TOutput | null {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}
