import { getActiveSpan } from "@sentry/core";
import { APICallError, RetryError, tool } from "ai";
import { z } from "zod";
import { ApiClientError, ApiServerError } from "../../../api-client";
import {
  AgentExecutionError,
  LLMProviderError,
  UserInputError,
} from "../../../errors";
import { logIssue, logWarn } from "../../../telem/logging";
import { findInsufficientScopeError } from "../../error-handling";

export type AgentToolResponse<T = unknown> = {
  error?: string;
  result?: T;
};

export function recordAgentToolResultCount(count: number | undefined) {
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return;
  }

  try {
    getActiveSpan()?.setAttribute("gen_ai.tool.call.result.count", count);
  } catch {}
}

function recordExtractedAgentToolResultCount<TResult>(
  result: TResult,
  getResultCount?: (result: TResult) => number | undefined,
) {
  if (!getResultCount) {
    return;
  }

  try {
    recordAgentToolResultCount(getResultCount(result));
  } catch {}
}

/**
 * Handles errors from agent tool execution and returns appropriate error messages.
 *
 * SECURITY: Only returns trusted error messages to prevent prompt injection.
 * We trust: Sentry API errors, our own UserInputError messages, and system templates.
 */
function handleAgentToolError<T>(error: unknown): AgentToolResponse<T> {
  // Before input errors, whose "try again" advice cannot help here.
  const insufficientScopeError = findInsufficientScopeError(error);
  if (insufficientScopeError) {
    return {
      error: `Missing Permission: ${insufficientScopeError.toUserMessage()}`,
    };
  }

  if (error instanceof UserInputError) {
    // Log UserInputError for Sentry logging (as log, not exception)
    logWarn(error, {
      loggerScope: ["agent-tools", "user-input"],
      contexts: {
        agentTool: {
          errorType: "UserInputError",
        },
      },
    });
    return {
      error: `Input Error: ${error.message}. You may be able to resolve this by addressing the concern and trying again.`,
    };
  }

  if (error instanceof LLMProviderError) {
    // Log LLMProviderError for Sentry logging (as log, not exception)
    logWarn(error, {
      loggerScope: ["agent-tools", "llm-provider"],
      contexts: {
        agentTool: {
          errorType: "LLMProviderError",
        },
      },
    });
    return {
      error: `AI Provider Error: ${error.message}. This is a service availability issue that cannot be resolved by retrying.`,
    };
  }

  if (error instanceof AgentExecutionError) {
    // Issue already filed at the embedded-agent boundary. Return a structured
    // error so the parent agent/tool can continue without a second Sentry issue.
    const eventIdPart = error.eventId ? ` Event ID: ${error.eventId}.` : "";
    return {
      error: `AI Processing Error: the embedded agent failed unexpectedly.${eventIdPart} This is a system error that cannot be resolved by retrying the same agent step.`,
    };
  }

  // Handle AI SDK APICallError / RetryError that weren't converted to
  // LLMProviderError. Defensive layer: all provider API failures are
  // availability issues and must not create per-request Sentry issues during
  // an outage. RetryError is what the AI SDK throws after exhausting retries.
  if (APICallError.isInstance(error) || RetryError.isInstance(error)) {
    const statusCode = APICallError.isInstance(error)
      ? error.statusCode
      : undefined;
    logWarn(error, {
      loggerScope: ["agent-tools", "api-call"],
      contexts: {
        agentTool: {
          errorType: APICallError.isInstance(error)
            ? "APICallError"
            : "RetryError",
          statusCode: statusCode ?? null,
        },
      },
    });
    return {
      error: `AI Provider Error: ${error.message}. This is a service availability issue with the upstream AI provider. Other non-AI tools should still work.`,
    };
  }

  if (error instanceof ApiClientError) {
    // Log ApiClientError for Sentry logging (as log, not exception)
    const message = error.toUserMessage();
    logWarn(message, {
      loggerScope: ["agent-tools", "api-client"],
      contexts: {
        agentTool: {
          errorType: error.name,
          status: error.status ?? null,
        },
      },
    });
    return {
      error: `Input Error: ${message}. You may be able to resolve this by addressing the concern and trying again.`,
    };
  }

  if (error instanceof ApiServerError) {
    // Log server errors to Sentry and get Event ID
    const eventId = logIssue(error);
    const statusText = error.status ? ` (${error.status})` : "";
    const eventIdPart = eventId ? ` Event ID: ${eventId}.` : "";
    return {
      error: `Server Error${statusText}: ${error.message}.${eventIdPart} This is a system error that cannot be resolved by retrying.`,
    };
  }

  // Log unexpected errors to Sentry and return safe generic message
  // SECURITY: Don't return untrusted error messages that could enable prompt injection
  const eventId = logIssue(error);
  const eventIdPart = eventId ? ` Event ID: ${eventId}.` : "";
  return {
    error: `System Error: An unexpected error occurred.${eventIdPart} This is a system error that cannot be resolved by retrying.`,
  };
}

/**
 * Creates an embedded agent tool with automatic error handling and schema wrapping.
 *
 * This wrapper:
 * - Maintains the same API as the AI SDK's tool() function
 * - Automatically wraps the result schema with error/result structure
 * - Handles all error types and returns them as structured responses
 * - Preserves type inference from the original tool implementation
 *
 * @example
 * ```typescript
 * export function createMyTool(apiService: SentryApiService) {
 *   return agentTool({
 *     description: "My tool description",
 *     parameters: z.object({ param: z.string() }),
 *     execute: async (params) => {
 *       // Tool implementation that might throw errors
 *       const result = await apiService.someMethod(params);
 *       return result; // Original return type preserved
 *     }
 *   });
 * }
 * ```
 */
export function agentTool<TParameters, TResult>(config: {
  description: string;
  parameters: z.ZodSchema<TParameters>;
  execute: (params: TParameters) => Promise<TResult>;
  getResultCount?: (result: TResult) => number | undefined;
}) {
  // Infer the result type from the execute function's return type
  type InferredResult = Awaited<ReturnType<typeof config.execute>>;

  return tool({
    description: config.description,
    inputSchema: config.parameters,
    execute: async (
      input: TParameters,
    ): Promise<AgentToolResponse<InferredResult>> => {
      try {
        const result = await config.execute(input);
        recordExtractedAgentToolResultCount(result, config.getResultCount);
        return { result };
      } catch (error) {
        return handleAgentToolError<InferredResult>(error);
      }
    },
  });
}
