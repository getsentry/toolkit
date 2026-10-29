/**
 * The request core that endpoint wrappers build on. It sends a request
 * through the host's transport, turns network failures and error responses
 * into the shared errors, and reads JSON bodies.
 *
 * The host supplies the transport (retries, caching), the per-request
 * headers (credentials, user agent, attribution), and logging.
 */

import { buildSentryApiUrl } from "../api-request.js";
import { type ApiError, ConfigurationError, createApiError } from "./errors.js";
import {
  type ErrorResponseBody,
  readErrorResponse,
  readJsonResponse,
} from "./response.js";

/** What the core needs from the host's transport. */
export type ApiRequestTransport = {
  request(url: string, init: RequestInit): Promise<Response>;
};

export type ApiClientLogger = {
  warn(message: string, extra: Record<string, unknown>): void;
};

export type ApiClientCoreOptions = {
  transport: ApiRequestTransport;
  /**
   * Headers for every request after `Content-Type`, such as Authorization
   * and User-Agent. Called once per request; may throw for a bad credential.
   * They replace any headers the caller passes.
   */
  headers: () => Record<string, string>;
  logger: ApiClientLogger;
};

export type ApiRequestOptions = {
  /** Error statuses returned as the response instead of thrown. */
  allowStatuses?: number[];
};

export type ApiClientCore = {
  /**
   * Send a request to `origin` + `/api/0` + `path`.
   *
   * @throws {ApiError} For an error status not in `allowStatuses`
   * @throws {ConfigurationError} When the host is unreachable or misconfigured
   * @throws {Error} For other network failures, with a readable message
   */
  request(
    origin: string,
    path: string,
    init?: RequestInit,
    options?: ApiRequestOptions,
  ): Promise<Response>;
  /** {@link ApiClientCore.request}, then the parsed JSON body. */
  requestJson(
    origin: string,
    path: string,
    init?: RequestInit,
  ): Promise<unknown>;
};

/** Readable messages for common network error codes. */
const NETWORK_ERROR_MESSAGES: Record<string, string> = {
  EAI_AGAIN: "DNS temporarily unavailable. Check your internet connection.",
  ENOTFOUND: "Hostname not found. Verify the URL is correct.",
  ECONNREFUSED: "Connection refused. Ensure the service is accessible.",
  ETIMEDOUT: "Connection timed out. Check network connectivity.",
  ECONNRESET: "Connection reset. Try again in a moment.",
};

/** Network failures that mean the host is wrong or unreachable. */
const CONFIGURATION_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

/** A failed fetch as a readable error naming the URL. */
function networkError(url: string, error: unknown): Error {
  let rootCause = error;
  while (rootCause instanceof Error && rootCause.cause) {
    rootCause = rootCause.cause;
  }
  const errorMessage =
    rootCause instanceof Error ? rootCause.message : String(rootCause);
  const errorCode = Object.keys(NETWORK_ERROR_MESSAGES).find((code) =>
    errorMessage.includes(code),
  );
  const friendlyMessage = `Unable to connect to ${url} - ${
    errorCode ? NETWORK_ERROR_MESSAGES[errorCode] : errorMessage
  }`;
  if (
    (errorCode && CONFIGURATION_ERROR_CODES.has(errorCode)) ||
    errorMessage.includes("Connect Timeout Error")
  ) {
    return new ConfigurationError(friendlyMessage, { cause: error });
  }
  return new Error(friendlyMessage, { cause: error });
}

/** A failed response's body as the matching `ApiError` subclass. */
function errorFromResponse(
  logger: ApiClientLogger,
  response: Response,
  body: ErrorResponseBody,
  logExtra: Record<string, unknown>,
): ApiError {
  const { retryAfterMs } = body;
  const errorText = body.text ?? "";
  const bodyPreview =
    errorText.length > 256 ? `${errorText.slice(0, 253)}…` : errorText;

  if (body.parseError !== undefined) {
    if (body.isHtml) {
      logger.warn("Received HTML error page instead of JSON", {
        ...logExtra,
        parseErrorMessage: body.parseError,
      });
      // An HTML page instead of JSON usually means a wrong URL or a proxy.
      return createApiError(
        `Server error: Received HTML instead of JSON (${response.status} ${response.statusText}). This may indicate an invalid URL or server issue.`,
        response.status,
        errorText,
        undefined,
        retryAfterMs,
      );
    }
    logger.warn("Failed to parse JSON error response", {
      ...logExtra,
      bodyPreview,
      parseErrorMessage: body.parseError,
    });
  } else if (body.json) {
    if (body.detail !== undefined) {
      return createApiError(
        body.detail,
        response.status,
        body.detail,
        body.json,
        retryAfterMs,
      );
    }
    logger.warn("Failed to parse validated API error response", {
      ...logExtra,
      bodyPreview,
      validationErrorMessage: "Error response has no string detail",
    });
  }

  return createApiError(
    `API request failed: ${response.statusText}\n${errorText}`,
    response.status,
    errorText,
    undefined,
    retryAfterMs,
  );
}

export function createApiClientCore({
  transport,
  headers,
  logger,
}: ApiClientCoreOptions): ApiClientCore {
  async function request(
    origin: string,
    path: string,
    init: RequestInit = {},
    { allowStatuses }: ApiRequestOptions = {},
  ): Promise<Response> {
    const url = buildSentryApiUrl(origin, path);
    const requestHeaders = {
      "Content-Type": "application/json",
      ...headers(),
    };

    if (typeof globalThis.fetch === "undefined") {
      throw new ConfigurationError(
        "fetch is not available. Please use Node.js >= 18 or ensure fetch is available in your environment.",
      );
    }

    let response: Response;
    try {
      response = await transport.request(url, {
        ...init,
        headers: requestHeaders,
      });
    } catch (error) {
      // An abort, including one during a retry wait, keeps the caller's reason.
      if (init.signal?.aborted) {
        throw error;
      }
      throw networkError(url, error);
    }

    if (response.ok || allowStatuses?.includes(response.status)) {
      return response;
    }
    throw errorFromResponse(
      logger,
      response,
      await readErrorResponse(response),
      {
        status: response.status,
        statusText: response.statusText,
        host: new URL(origin).host,
        path,
      },
    );
  }

  return {
    request,

    async requestJson(origin, path, init) {
      return await readJsonResponse(await request(origin, path, init));
    },
  };
}
