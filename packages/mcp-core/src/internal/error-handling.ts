import {
  AgentExecutionError,
  UserInputError,
  ConfigurationError,
  LLMProviderError,
} from "../errors";
import {
  ApiError,
  ApiClientError,
  ApiRateLimitError,
  ApiServerError,
  isApiAuthenticationErrorDeep,
} from "../api-client";
import { logIssue, logWarn } from "../telem/logging";
import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import type { ToolConfig } from "../tools/types";
import type { ServerContext, TransportType } from "../types";

/**
 * Type guard to identify user input validation errors.
 */
export function isUserInputError(error: unknown): error is UserInputError {
  return error instanceof UserInputError;
}

/**
 * Type guard to identify configuration errors.
 */
export function isConfigurationError(
  error: unknown,
): error is ConfigurationError {
  return error instanceof ConfigurationError;
}

/**
 * Type guard to identify LLM provider errors.
 */
export function isLLMProviderError(error: unknown): error is LLMProviderError {
  return error instanceof LLMProviderError;
}

/**
 * Type guard for unexpected embedded-agent failures that already created a
 * Sentry issue at the agent boundary.
 */
export function isAgentExecutionError(
  error: unknown,
): error is AgentExecutionError {
  return error instanceof AgentExecutionError;
}

/**
 * Type guard to identify API errors.
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Type guard to identify API client errors (4xx).
 */
export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}

/**
 * Type guard to identify API server errors (5xx).
 */
export function isApiServerError(error: unknown): error is ApiServerError {
  return error instanceof ApiServerError;
}

/**
 * Type guard to identify AI SDK API call errors.
 */
export function isAPICallError(error: unknown): error is APICallError {
  return APICallError.isInstance(error);
}

const GENERIC_CONFIG_ERROR_MESSAGE = [
  "**Feature Unavailable**",
  "This feature is temporarily unavailable due to a server configuration issue.",
  "The service operator has been notified. Please try again later.",
].join("\n\n");

const GENERIC_AI_PROVIDER_ERROR_MESSAGE = [
  "**Feature Unavailable**",
  "AI-powered features are temporarily unavailable because the upstream AI provider rejected or could not complete this request.",
  "Other Sentry MCP tools that do not require AI should still work. Please try again later.",
].join("\n\n");

/**
 * Expected/user-facing tool failures that should return a formatted MCP error
 * response without creating a Sentry issue or recording a span exception.
 *
 * Includes AI provider outages (budget exhaustion, rate limits, region blocks,
 * 5xx/network failures from the upstream LLM) so tool calls degrade cleanly.
 */
export function isExpectedToolError(error: unknown): boolean {
  if (
    isUserInputError(error) ||
    isConfigurationError(error) ||
    isLLMProviderError(error) ||
    // Already reported once in callEmbeddedAgent; do not record again on the span.
    isAgentExecutionError(error) ||
    isApiClientError(error) ||
    isApiAuthenticationErrorDeep(error)
  ) {
    return true;
  }

  // AI SDK provider failures are expected at the tool boundary once converted
  // or handled as availability issues. Includes 4xx, 5xx, transport errors, and
  // RetryError wrappers emitted after the SDK exhausts retries.
  if (isAPICallError(error) || RetryError.isInstance(error)) {
    return true;
  }

  return NoObjectGeneratedError.isInstance(error);
}

/**
 * Format a server-side configuration error for user display.
 *
 * For HTTP transport, the detailed message is hidden (the user cannot fix
 * server-side configuration) — the error is logged to Sentry and a generic
 * message is returned instead.
 * For stdio/unset transport, the detailed parts are returned as-is.
 */
function formatServerConfigError(
  error: Error,
  detailedParts: string[],
  options?: { transport?: TransportType },
): string {
  if (options?.transport === "http") {
    logIssue(error);
    return GENERIC_CONFIG_ERROR_MESSAGE;
  }
  return detailedParts.join("\n\n");
}

/**
 * Format an AI provider availability failure for user display.
 *
 * These are expected operational failures (budget limits, rate limits, region
 * restrictions, provider outages). Always log as a warning — never create a
 * Sentry issue per request — and hide provider internals on HTTP transport.
 */
function formatAiProviderError(
  error: Error,
  detailedParts: string[],
  options?: { transport?: TransportType },
): string {
  logWarn(error, {
    loggerScope: ["error-handling", "llm-provider"],
    contexts: {
      aiProvider: {
        errorType: error.name,
        transport: options?.transport ?? null,
      },
    },
  });

  if (options?.transport === "http") {
    return GENERIC_AI_PROVIDER_ERROR_MESSAGE;
  }
  return detailedParts.join("\n\n");
}

/**
 * Format an error for user display with markdown formatting.
 * This is used by tool handlers to format errors for MCP responses.
 *
 * When transport is "http", server configuration errors create a Sentry issue
 * and return a generic message (users can't fix server-side config).
 * AI provider outages are different: they always log as warnings and return a
 * graceful availability message so a provider budget/outage does not flood issues.
 * When transport is "stdio" or undefined, detailed messages are returned
 * (operators/users can fix their own config).
 *
 * SECURITY: Only return trusted error messages to prevent prompt injection vulnerabilities.
 * We trust: Sentry API errors, our own UserInputError/ConfigurationError messages, and system templates.
 */
export async function formatErrorForUser(
  error: unknown,
  options?: { transport?: TransportType },
): Promise<string> {
  if (isUserInputError(error)) {
    return [
      "**Input Error**",
      "It looks like there was a problem with the input you provided.",
      error.message,
      "You may be able to resolve the issue by addressing the concern and trying again.",
    ].join("\n\n");
  }

  if (isConfigurationError(error)) {
    return formatServerConfigError(
      error,
      [
        "**Configuration Error**",
        "There appears to be a configuration issue with your setup.",
        error.message,
        "Please check your environment configuration and try again.",
      ],
      options,
    );
  }

  if (isLLMProviderError(error)) {
    return formatAiProviderError(
      error,
      [
        "**AI Provider Error**",
        "The AI provider service is not available for this request.",
        error.message,
        "This is a service availability issue. Other non-AI tools should still work.",
      ],
      options,
    );
  }

  // Unexpected agent failure already filed a Sentry issue in callEmbeddedAgent.
  // Return a graceful tool error without creating a second issue.
  if (isAgentExecutionError(error)) {
    const parts = [
      "**AI Processing Error**",
      "The AI agent failed to complete this request.",
      "The service operator has been notified. Please try again, or rephrase your request.",
    ];
    if (error.eventId) {
      parts.push(`**Event ID**: ${error.eventId}`);
    }
    return parts.join("\n\n");
  }

  // Handle AI SDK APICallError / RetryError that weren't converted to
  // LLMProviderError. This is a defensive layer - ideally callEmbeddedAgent
  // converts these. Treat all provider API failures as availability issues so
  // tool calls degrade gracefully instead of creating per-request Sentry issues.
  if (isAPICallError(error) || RetryError.isInstance(error)) {
    const statusCode = isAPICallError(error) ? error.statusCode : undefined;
    const detail =
      statusCode && statusCode >= 500
        ? "The AI provider is currently unavailable."
        : statusCode && statusCode >= 400
          ? "The AI provider rejected this request."
          : "The AI provider could not complete this request.";

    return formatAiProviderError(
      error,
      [
        "**AI Provider Error**",
        detail,
        error.message,
        "This is a service availability issue. Other non-AI tools should still work.",
      ],
      options,
    );
  }

  // Defensive: NoObjectGeneratedError is normally handled in callEmbeddedAgent,
  // but catch any that escape (e.g., from future code paths).
  if (NoObjectGeneratedError.isInstance(error)) {
    return [
      "**AI Processing Error**",
      "The AI was unable to process your query. Please try rephrasing your request.",
    ].join("\n\n");
  }

  // Upstream 401 isn't a user-input problem — prompt re-authorization instead
  // of routing through the generic Input Error template below. Deep check
  // handles tools that rewrap the original with `{ cause: apiError }`.
  if (isApiAuthenticationErrorDeep(error)) {
    return [
      "**Authorization Expired**",
      "Sentry rejected the stored access token for this session. Please re-authorize to continue.",
    ].join("\n\n");
  }

  // A 429 isn't an input problem either. Tell the agent when to come back and
  // that parallel tool calls are what usually trips the per-second limit.
  if (error instanceof ApiRateLimitError) {
    return [
      "**Rate Limited**",
      "The Sentry API is rate limiting these requests. Short waits are already retried automatically.",
      error.toUserMessage(),
      "Call Sentry tools one at a time instead of in parallel, and don't repeat this call before then.",
    ].join("\n\n");
  }

  // Handle ApiClientError (4xx) - user input errors, should NOT be logged to Sentry
  if (isApiClientError(error)) {
    const statusText = error.status
      ? `There was an HTTP ${error.status} error with your request to the Sentry API.`
      : "There was an error with your request.";

    return [
      "**Input Error**",
      statusText,
      error.toUserMessage(),
      "You may be able to resolve the issue by addressing the concern and trying again.",
    ].join("\n\n");
  }

  // Handle ApiServerError (5xx) - system errors, SHOULD be logged to Sentry
  if (isApiServerError(error)) {
    const eventId = logIssue(error);
    const statusText = error.status
      ? `There was an HTTP ${error.status} server error with the Sentry API.`
      : "There was a server error.";

    const parts = ["**Error**", statusText, error.message];
    if (eventId) {
      parts.push(`**Event ID**: ${eventId}`);
    }
    parts.push("Please contact support if the problem persists.");
    return parts.join("\n\n");
  }

  // Handle generic ApiError (shouldn't happen with new hierarchy, but just in case)
  if (isApiError(error)) {
    const statusText = error.status
      ? `There was an HTTP ${error.status} error with your request to the Sentry API.`
      : "There was an error with your request.";

    return [
      "**Error**",
      statusText,
      error.message,
      "You may be able to resolve the issue by addressing the concern and trying again.",
    ].join("\n\n");
  }

  const eventId = logIssue(error);

  const parts = [
    "**Error**",
    "It looks like there was a problem communicating with the Sentry API.",
    "Please report the following to the user for the Sentry team:",
  ];
  if (eventId) {
    parts.push(`**Event ID**: ${eventId}`);
  }
  if (process.env.NODE_ENV !== "production") {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg) {
      parts.push(errorMsg);
    }
  }
  return parts.join("\n\n");
}

/**
 * Invoke a tool's onError hook for failure telemetry, isolated so a misbehaving
 * hook can't disrupt the surrounding error handling. Call this at every point
 * where a tool handler is run and may throw.
 */
export function recordToolFailure(
  tool: Pick<ToolConfig, "onError">,
  error: unknown,
  params: Record<string, unknown>,
  context: ServerContext,
): void {
  try {
    tool.onError?.(error, params, context);
  } catch {}
}
