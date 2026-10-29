import {
  SentryApiService,
  ApiAuthenticationError,
  ApiClientError,
  ApiNotFoundError,
} from "../../api-client/index";
import { UserInputError } from "../../errors";
import { formatNotFoundParams } from "./enhance-error";
import type { ServerContext } from "../../types";
import { validateRegionUrl } from "./validate-region-url";

/**
 * Create a Sentry API service from server context with optional region override
 * @param context - Server context containing host and access token
 * @param opts - Options object containing optional regionUrl override
 * @returns Configured SentryApiService instance using the context's configured protocol
 * @throws {UserInputError} When regionUrl is provided but invalid
 */
export function apiServiceFromContext(
  context: ServerContext,
  opts: { regionUrl?: string } = {},
) {
  let host = context.sentryHost;

  if (opts.regionUrl?.trim()) {
    // Validate the regionUrl against the base host to prevent SSRF
    // Use default host if context.sentryHost is not set
    const baseHost = context.sentryHost || "sentry.io";
    host = validateRegionUrl(opts.regionUrl.trim(), baseHost);
  }

  return new SentryApiService({
    host,
    protocol: context.sentryProtocol,
    accessToken: context.accessToken,
    clientId: context.clientId,
    clientName: context.clientName,
    clientFamily: context.clientFamily,
    utmSource: context.utmSource,
  });
}

/**
 * Maps API errors to user-friendly errors based on context
 * @param error - The error to handle
 * @param params - The parameters that were used in the API call
 * @returns Never - always throws an error
 * @throws {UserInputError} For 4xx errors that are likely user input issues
 * @throws {Error} For other errors
 */
export function handleApiError(
  error: unknown,
  params?: Record<string, unknown>,
): never {
  // 401 isn't a user-input problem — propagate unwrapped so the server-level
  // catch can route it through ServerContext.onUpstreamUnauthorized.
  if (error instanceof ApiAuthenticationError) {
    throw error;
  }

  // Use the new error hierarchy - all 4xx errors extend ApiClientError
  if (error instanceof ApiClientError) {
    let message = `API error (${error.status}): ${error.message}`;

    // Special handling for 404s with parameter context
    if (error instanceof ApiNotFoundError && params) {
      const paramsList = formatNotFoundParams(params);

      if (paramsList.length > 0) {
        message = `Resource not found (404): ${error.message}\nPlease verify these parameters are correct:\n${paramsList.map((p) => `  - ${p}`).join("\n")}`;
      }
    }

    throw new UserInputError(message, { cause: error });
  }

  // All other errors bubble up (including ApiServerError for 5xx)
  throw error;
}

/**
 * Wraps an async API call with automatic error handling
 * @param fn - The async function to execute
 * @param params - The parameters that were used in the API call
 * @returns The result of the function
 * @throws {UserInputError} For user input errors
 * @throws {Error} For other errors
 */
export async function withApiErrorHandling<T>(
  fn: () => Promise<T>,
  params?: Record<string, unknown>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    handleApiError(error, params);
  }
}
