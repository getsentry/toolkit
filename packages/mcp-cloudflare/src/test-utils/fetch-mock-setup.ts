/**
 * Shared outbound mock registrations for Cloudflare Workers tests.
 *
 * The Cloudflare Vitest plugin configures Miniflare's `outboundService`
 * centrally from vitest.config.ts so test files do not need per-file setup.
 */
import {
  autofixStateFixture,
  clientKeyFixture,
  eventFixture,
  eventsErrorsEmptyFixture,
  eventsErrorsFixture,
  eventsSpansEmptyFixture,
  eventsSpansFixture,
  issueFixture,
  issueFixture2,
  organizationFixture,
  performanceEventFixture,
  projectFixture,
  releaseFixture,
  tagsFixture,
  teamFixture,
  traceFixture,
  traceItemsAttributesLogsNumberFixture,
  traceItemsAttributesLogsStringFixture,
  traceItemsAttributesSpansNumberFixture,
  traceItemsAttributesSpansStringFixture,
  traceMetaFixture,
  userFixture,
} from "@sentry/mcp-server-mocks/payloads";

// Sentry hosts to mock
const SENTRY_HOSTS = [
  "https://sentry.io",
  "https://us.sentry.io",
  "https://direct-token.test",
];

export const DIRECT_AUTH_ASSERTION_TOKEN = "sntryu_assert-direct-token";

// Standard JSON response headers
const JSON_HEADERS = { "Content-Type": "application/json" };

function normalizeQuery(query: string | null): string | null {
  return query ? query.split(" ").sort().join(" ") : query;
}

function getMockRequestHeader(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): string | null {
  if (!headers) {
    return null;
  }
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name);
  }

  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

const VALID_ERROR_EVENT_QUERIES = new Set<string | null>(
  [
    null,
    "",
    "error.handled:false",
    "error.unhandled:true",
    "error.handled:false is:unresolved",
    "error.unhandled:true is:unresolved",
    "is:unresolved project:cloudflare-mcp",
    "project:cloudflare-mcp",
    "user.email:david@sentry.io",
  ].map((query) => normalizeQuery(query)),
);

let fetchMockConfigured = false;

export type FetchMockLike = {
  activate(): void;
  disableNetConnect(): void;
  get(origin: string): {
    intercept(options: Record<string, unknown>): {
      reply(
        statusCode: number,
        body: unknown,
        options?: Record<string, unknown>,
      ): {
        persist(): void;
      };
    };
  };
  assertNoPendingInterceptors?(): void;
};

/**
 * Register outbound interceptors on a MockAgent-like object.
 *
 * IMPORTANT: undici MockAgent matches interceptors in registration order
 * (first match wins). Always register specific path handlers BEFORE
 * general pattern handlers to ensure correct matching.
 */
export function registerFetchMockInterceptors(fetchMock: FetchMockLike) {
  if (fetchMockConfigured) {
    return;
  }

  fetchMockConfigured = true;

  // Public CIMD endpoints blocked by upstream security filtering. Keep the
  // lookalike separate so tests verify that pre-registration matches exactly.
  const codexMetadata = fetchMock.get("https://chatgpt.com");
  for (const path of [
    "/oauth/codex/client.json",
    "/oauth/codex/client.json?other-client=1",
  ]) {
    codexMetadata
      .intercept({ path, method: "GET" })
      .reply(403, "Forbidden", {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
      })
      .persist();
  }

  for (const host of SENTRY_HOSTS) {
    const pool = fetchMock.get(host);

    // ===== Auth Endpoints (control only - sentry.io only) =====
    if (host === "https://sentry.io") {
      pool
        .intercept({ path: "/api/0/auth/" })
        .reply(200, userFixture, { headers: JSON_HEADERS })
        .persist();

      pool
        .intercept({ path: "/api/0/users/me/regions/" })
        .reply(
          200,
          { regions: [{ name: "us", url: "https://us.sentry.io" }] },
          { headers: JSON_HEADERS },
        )
        .persist();
    }

    if (host === "https://direct-token.test") {
      pool
        .intercept({ path: "/api/0/auth/" })
        .reply((req) => {
          const authorization = getMockRequestHeader(
            req.headers,
            "authorization",
          );
          if (authorization !== `Bearer ${DIRECT_AUTH_ASSERTION_TOKEN}`) {
            return {
              statusCode: 401,
              data: { detail: "Unexpected direct-token Authorization header" },
              responseOptions: { headers: JSON_HEADERS },
            };
          }
          if (
            getMockRequestHeader(req.headers, "x-sentry-mcp-utm-source") !==
            "plugin"
          ) {
            return {
              statusCode: 400,
              data: { detail: "Missing MCP UTM source header" },
              responseOptions: { headers: JSON_HEADERS },
            };
          }

          return {
            statusCode: 200,
            data: userFixture,
            responseOptions: { headers: JSON_HEADERS },
          };
        })
        .persist();
    }

    // ===== Organizations =====
    pool
      .intercept({ path: "/api/0/organizations/" })
      .reply(200, [organizationFixture], { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({ path: "/api/0/organizations/sentry-mcp-evals/" })
      .reply(200, organizationFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({ path: "/api/0/organizations/nonexistent-org/" })
      .reply(
        404,
        { detail: "The requested resource does not exist" },
        { headers: JSON_HEADERS },
      )
      .persist();

    // ===== Teams =====
    pool
      .intercept({ path: "/api/0/organizations/sentry-mcp-evals/teams/" })
      .reply(200, [teamFixture], { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/teams/",
        method: "POST",
      })
      .reply(
        201,
        {
          ...teamFixture,
          id: "4509109078196224",
          dateCreated: "2025-04-07T00:05:48.196710Z",
        },
        { headers: JSON_HEADERS },
      )
      .persist();

    // ===== Projects =====
    pool
      .intercept({ path: "/api/0/organizations/sentry-mcp-evals/projects/" })
      .reply(200, [{ ...projectFixture, id: "4509106749636608" }], {
        headers: JSON_HEADERS,
      })
      .persist();

    pool
      .intercept({
        path: "/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        method: "POST",
      })
      .reply(200, projectFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({ path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/" })
      .reply(200, projectFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/?collapse=organization",
        method: "GET",
      })
      .reply(
        200,
        {
          ...projectFixture,
          organization: {
            id: organizationFixture.id,
            slug: organizationFixture.slug,
          },
        },
        { headers: JSON_HEADERS },
      )
      .persist();

    pool
      .intercept({
        path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
        method: "PUT",
      })
      .reply(200, projectFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/projects/sentry-mcp-evals/nonexistent-project/",
      })
      .reply(
        404,
        { detail: "The requested resource does not exist" },
        { headers: JSON_HEADERS },
      )
      .persist();

    pool
      .intercept({
        path: "/api/0/projects/sentry-mcp-evals/nonexistent-project/?collapse=organization",
        method: "GET",
      })
      .reply(
        404,
        { detail: "The requested resource does not exist" },
        { headers: JSON_HEADERS },
      )
      .persist();

    // ===== Client Keys =====
    pool
      .intercept({
        path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        method: "POST",
      })
      .reply(200, clientKeyFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
      })
      .reply(200, [clientKeyFixture], { headers: JSON_HEADERS })
      .persist();

    // ===== Issues =====
    // Project-scoped
    pool
      .intercept({ path: "/api/0/projects/sentry-mcp-evals/foobar/issues/" })
      .reply(200, [], { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: (p: string) =>
          p.startsWith(
            "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/issues/",
          ),
      })
      .reply(200, [issueFixture2, issueFixture], { headers: JSON_HEADERS })
      .persist();

    // Org-scoped (excludes specific issue IDs that have their own handlers)
    pool
      .intercept({
        path: (p: string) =>
          p.startsWith("/api/0/organizations/sentry-mcp-evals/issues/") &&
          !p.includes("CLOUDFLARE-MCP") &&
          !p.includes("6507376") &&
          !p.includes("PERF-N1") &&
          !p.includes("PEATED"),
      })
      .reply(200, [issueFixture2, issueFixture], { headers: JSON_HEADERS })
      .persist();

    // Specific issue details
    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
      })
      .reply(200, issueFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/6507376925/",
      })
      .reply(200, issueFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-42/",
      })
      .reply(200, issueFixture2, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/6507376926/",
      })
      .reply(200, issueFixture2, { headers: JSON_HEADERS })
      .persist();

    // Issue updates (PUT)
    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        method: "PUT",
      })
      .reply(200, issueFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/6507376925/",
        method: "PUT",
      })
      .reply(200, issueFixture, { headers: JSON_HEADERS })
      .persist();

    // ===== Issue Events =====
    // IMPORTANT: Specific handlers must come before general patterns

    // Performance issue events - specific handler
    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/events/latest/",
      })
      .reply(200, performanceEventFixture, { headers: JSON_HEADERS })
      .persist();

    // General events - catch-all for remaining
    pool
      .intercept({
        path: (p: string) =>
          p.includes("/events/7ca573c0f4814912aaa9bdc77d1a7d51") ||
          p.includes("/events/latest"),
      })
      .reply(200, eventFixture, { headers: JSON_HEADERS })
      .persist();

    // ===== Traces =====
    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/trace-meta/a4d1aae7216b47ff8117cf4e09ce9d0a/",
      })
      .reply(200, traceMetaFixture, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/trace/a4d1aae7216b47ff8117cf4e09ce9d0a/",
      })
      .reply(200, traceFixture, { headers: JSON_HEADERS })
      .persist();

    // ===== Releases =====
    pool
      .intercept({ path: "/api/0/organizations/sentry-mcp-evals/releases/" })
      .reply(200, [releaseFixture], { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/releases/",
      })
      .reply(200, [releaseFixture], { headers: JSON_HEADERS })
      .persist();

    // ===== Tags =====
    pool
      .intercept({ path: "/api/0/organizations/sentry-mcp-evals/tags/" })
      .reply(200, tagsFixture, { headers: JSON_HEADERS })
      .persist();

    // ===== Trace Items Attributes =====
    pool
      .intercept({
        path: (p: string) =>
          p.startsWith(
            "/api/0/organizations/sentry-mcp-evals/trace-items/attributes/",
          ),
      })
      .reply((req) => {
        const url = new URL(req.path, "https://sentry.io");
        const itemType = url.searchParams.get("itemType");
        const attributeType = url.searchParams.get("attributeType");

        if (!itemType || !attributeType) {
          if (!itemType) {
            return {
              statusCode: 400,
              data: { detail: "Missing parameters" },
              responseOptions: { headers: JSON_HEADERS },
            };
          }

          const normalizedItemType = itemType === "spans" ? "span" : itemType;

          if (normalizedItemType === "span") {
            return {
              statusCode: 200,
              data: [
                ...traceItemsAttributesSpansStringFixture.map((attribute) => ({
                  ...attribute,
                  attributeType: "string",
                })),
                ...traceItemsAttributesSpansNumberFixture.map((attribute) => ({
                  ...attribute,
                  attributeType: "number",
                })),
              ],
              responseOptions: { headers: JSON_HEADERS },
            };
          }

          if (normalizedItemType === "logs") {
            return {
              statusCode: 200,
              data: [
                ...traceItemsAttributesLogsStringFixture.map((attribute) => ({
                  ...attribute,
                  attributeType: "string",
                })),
                ...traceItemsAttributesLogsNumberFixture.map((attribute) => ({
                  ...attribute,
                  attributeType: "number",
                })),
              ],
              responseOptions: { headers: JSON_HEADERS },
            };
          }

          return {
            statusCode: 400,
            data: { detail: "Invalid itemType" },
            responseOptions: { headers: JSON_HEADERS },
          };
        }

        const normalizedItemType = itemType === "spans" ? "span" : itemType;

        if (normalizedItemType === "span") {
          return {
            statusCode: 200,
            data:
              attributeType === "string"
                ? traceItemsAttributesSpansStringFixture
                : traceItemsAttributesSpansNumberFixture,
            responseOptions: { headers: JSON_HEADERS },
          };
        }

        if (normalizedItemType === "logs") {
          return {
            statusCode: 200,
            data:
              attributeType === "string"
                ? traceItemsAttributesLogsStringFixture
                : traceItemsAttributesLogsNumberFixture,
            responseOptions: { headers: JSON_HEADERS },
          };
        }

        return {
          statusCode: 400,
          data: { detail: "Invalid itemType" },
          responseOptions: { headers: JSON_HEADERS },
        };
      })
      .persist();

    // ===== Events Search (for search_events) =====
    pool
      .intercept({
        path: (p: string) =>
          p.startsWith("/api/0/organizations/sentry-mcp-evals/events/"),
      })
      .reply((req) => {
        const url = new URL(req.path, "https://sentry.io");
        const dataset = url.searchParams.get("dataset");
        const query = url.searchParams.get("query");

        if (dataset === "spans") {
          if (query !== "is_transaction:true") {
            return {
              statusCode: 200,
              data: eventsSpansEmptyFixture,
              responseOptions: { headers: JSON_HEADERS },
            };
          }
          return {
            statusCode: 200,
            data: eventsSpansFixture,
            responseOptions: { headers: JSON_HEADERS },
          };
        }

        if (dataset === "errors") {
          const fields = url.searchParams.getAll("field");
          if (
            !fields.includes("issue") ||
            !fields.includes("title") ||
            !fields.includes("project") ||
            !fields.includes("last_seen()") ||
            !fields.includes("count()")
          ) {
            return {
              statusCode: 400,
              data: "Invalid fields",
              responseOptions: { headers: JSON_HEADERS },
            };
          }

          if (
            !["-count", "-last_seen"].includes(
              url.searchParams.get("sort") ?? "",
            )
          ) {
            return {
              statusCode: 400,
              data: "Invalid sort",
              responseOptions: { headers: JSON_HEADERS },
            };
          }

          if (!VALID_ERROR_EVENT_QUERIES.has(normalizeQuery(query))) {
            return {
              statusCode: 200,
              data: eventsErrorsEmptyFixture,
              responseOptions: { headers: JSON_HEADERS },
            };
          }
          return {
            statusCode: 200,
            data: eventsErrorsFixture,
            responseOptions: { headers: JSON_HEADERS },
          };
        }

        return {
          statusCode: 400,
          data: "Invalid dataset",
          responseOptions: { headers: JSON_HEADERS },
        };
      })
      .persist();

    // ===== Autofix =====
    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/autofix/",
      })
      .reply(200, { autofix: null }, { headers: JSON_HEADERS })
      .persist();

    pool
      .intercept({
        path: "/api/0/organizations/sentry-mcp-evals/issues/PEATED-A8/autofix/",
      })
      .reply(200, autofixStateFixture, { headers: JSON_HEADERS })
      .persist();
  }
}
