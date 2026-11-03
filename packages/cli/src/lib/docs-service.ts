import { isSaaSTrustOrigin } from "@sentry/toolkit-core/sentry-origin";
import { formatAuthHeader } from "./auth-header.js";
import { customFetch } from "./custom-ca.js";
import { refreshToken } from "./db/auth.js";
import type { DocsProjectContext } from "./docs-context.js";
import { ApiError, CliError, EXIT, HostScopeError } from "./errors.js";
import { normalizeOrigin } from "./sentry-urls.js";
import { getActiveTokenHost } from "./token-host.js";

/** The hosted docs service, which only accepts sentry.io credentials. */
const DEFAULT_DOCS_SERVICE_URL =
  "https://sentry-init-agent.getsentry.workers.dev";

/** `MASTRA_API_URL` points the docs commands at a local or staging service. */
const DOCS_SERVICE_URL = process.env.MASTRA_API_URL ?? DEFAULT_DOCS_SERVICE_URL;

const DOCS_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Refuse to send a self-hosted token to the hosted docs service, which
 * validates bearers against sentry.io.
 *
 * @throws {HostScopeError} When the active token belongs to a non-SaaS host
 *   and requests would go to the hosted service.
 */
function assertDocsServiceAcceptsTokenHost(): void {
  const tokenHost = getActiveTokenHost();
  const usesHostedService =
    normalizeOrigin(DOCS_SERVICE_URL) ===
    normalizeOrigin(DEFAULT_DOCS_SERVICE_URL);

  if (tokenHost && usesHostedService && !isSaaSTrustOrigin(tokenHost)) {
    throw new HostScopeError(
      "Hosted Sentry docs service",
      "https://sentry.io",
      tokenHost,
    );
  }
}

export type DocsQueryResponse = {
  answer: string;
  sources: string[];
};

export type DocsListResponse = {
  results: { description?: string; title: string; url: string }[];
};

async function postDocs<T>(
  path: "/api/docs/query" | "/api/docs/list",
  body: unknown,
): Promise<T> {
  assertDocsServiceAcceptsTokenHost();
  const { token } = await refreshToken();
  const response = await customFetch(`${DOCS_SERVICE_URL}${path}`, {
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
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      parsed = JSON.parse(text) as { code?: unknown; error?: unknown };
    } catch {
      // Keep the compact plain-text response as the detail.
    }
    if (parsed?.code === "DOCS_UNGROUNDED") {
      throw new CliError(
        "Could not produce a verified documentation answer.\n" +
          "  Try rephrasing the question so it can be answered from current Sentry documentation.",
        EXIT.API,
      );
    }
    if (parsed?.code === "DOCS_MODEL_UNAVAILABLE") {
      throw new CliError(
        "Sentry Docs AI is temporarily unavailable in this region. Please try again later.",
        EXIT.API,
      );
    }
    if (typeof parsed?.error === "string") {
      detail = parsed.error;
    }
    throw new ApiError(
      "Docs service request failed",
      response.status,
      detail,
      path,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      "Docs service returned invalid JSON",
      response.status,
      undefined,
      path,
    );
  }
}

export function queryDocs(
  query: string,
  context: DocsProjectContext,
): Promise<DocsQueryResponse> {
  return postDocs("/api/docs/query", { context, query });
}

export function listDocs(
  query: string,
  limit: number,
): Promise<DocsListResponse> {
  return postDocs("/api/docs/list", { limit, query });
}
