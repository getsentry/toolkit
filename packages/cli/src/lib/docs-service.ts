import { formatAuthHeader } from "./auth-header.js";
import { customFetch } from "./custom-ca.js";
import { refreshToken } from "./db/auth.js";
import type { DocsProjectContext } from "./docs-context.js";
import { ApiError, CliError, EXIT } from "./errors.js";
import { MASTRA_API_URL } from "./init/constants.js";
import { assertHostedInitServiceAcceptsTokenHost } from "./init/init-service-auth.js";

const DOCS_REQUEST_TIMEOUT_MS = 120_000;

export type DocsQueryResponse = {
  answer: string;
  sources: string[];
};

export type DocsListResponse = {
  results: { description?: string; title: string; url: string }[];
};

async function postDocs<T>(
  path: "/api/docs/query" | "/api/docs/list",
  body: unknown
): Promise<T> {
  assertHostedInitServiceAcceptsTokenHost();
  const { token } = await refreshToken();
  const response = await customFetch(`${MASTRA_API_URL}${path}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: formatAuthHeader(token),
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(DOCS_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    let parsed: { code?: unknown; error?: unknown } | undefined;
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      parsed = JSON.parse(text) as { code?: unknown; error?: unknown };
    } catch {
      // Keep the compact plain-text response as the detail.
    }
    if (parsed?.code === "DOCS_UNGROUNDED") {
      throw new CliError(
        "Could not produce a verified documentation answer.\n" +
          "  Try rephrasing the question so it can be answered from current Sentry documentation.",
        EXIT.API
      );
    }
    if (parsed?.code === "DOCS_MODEL_UNAVAILABLE") {
      throw new CliError(
        "Sentry Docs AI is temporarily unavailable in this region. Please try again later.",
        EXIT.API
      );
    }
    if (typeof parsed?.error === "string") {
      detail = parsed.error;
    }
    throw new ApiError(
      "Docs service request failed",
      response.status,
      detail,
      path
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      "Docs service returned invalid JSON",
      response.status,
      undefined,
      path
    );
  }
}

export function queryDocs(
  query: string,
  context: DocsProjectContext
): Promise<DocsQueryResponse> {
  return postDocs("/api/docs/query", { context, query });
}

export function listDocs(
  query: string,
  limit: number
): Promise<DocsListResponse> {
  return postDocs("/api/docs/list", { limit, query });
}
