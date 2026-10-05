/**
 * API Client Tests
 *
 * Tests for the Sentry API client 401 retry behavior and utility functions.
 * Uses manual fetch mocking to avoid polluting the module cache.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  API_MAX_PER_PAGE,
  buildSearchParams,
  getLogs,
  listIssuesPaginated,
  listRepositoriesPaginated,
  listTeamsPaginated,
  listTraceLogs,
  listTransactions,
  rawApiRequest,
} from "../../src/lib/api-client.js";
import { DEFAULT_SENTRY_URL } from "../../src/lib/constants.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setOrgRegion, setOrgRegions } from "../../src/lib/db/regions.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-api-");

let originalFetch: typeof globalThis.fetch;

/**
 * Tracks requests made during a test
 */
type RequestLog = {
  url: string;
  method: string;
  authorization: string | null;
  isRetry: boolean;
};

beforeEach(async () => {
  // Set required env var for OAuth refresh
  process.env.SENTRY_CLIENT_ID = "test-client-id";

  // Save original fetch
  originalFetch = globalThis.fetch;

  // Set up initial auth token with a refresh token so 401 retry can get a new token
  await setAuthToken("initial-token", 3600, "test-refresh-token");
});

afterEach(() => {
  // Restore original fetch
  globalThis.fetch = originalFetch;
});

/**
 * Creates a mock fetch that handles API requests.
 * Uses rawApiRequest which goes to control silo (no region resolution needed).
 *
 * The `apiRequestHandler` is called for each API request.
 */
function createMockFetch(
  requests: RequestLog[],
  apiRequestHandler: (
    req: Request,
    requestCount: number
  ) => Response | Promise<Response>,
  options: {
    oauthHandler?: (req: Request) => Response | Promise<Response>;
  } = {}
): typeof globalThis.fetch {
  let apiRequestCount = 0;

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.get("Authorization"),
      isRetry: req.headers.get("x-sentry-cli-retry") === "1",
    });

    // OAuth token refresh endpoint
    if (req.url.includes("/oauth/token/")) {
      if (options.oauthHandler) {
        return options.oauthHandler(req);
      }
      return new Response(
        JSON.stringify({
          access_token: "refreshed-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "new-refresh-token",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // API requests - delegate to handler
    apiRequestCount += 1;
    return apiRequestHandler(req, apiRequestCount);
  };
}

describe("401 retry behavior", () => {
  // Note: These tests use rawApiRequest which goes to control silo (sentry.io)
  // and supports 401 retry with token refresh.

  let savedAuthToken: string | undefined;
  beforeEach(() => {
    savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
  });
  afterEach(() => {
    if (savedAuthToken !== undefined) {
      process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
    }
  });

  test("retries request with new token on 401 response", async () => {
    const requests: RequestLog[] = [];

    globalThis.fetch = createMockFetch(requests, (_req, requestCount) => {
      // First request: return 401
      if (requestCount === 1) {
        return new Response(JSON.stringify({ detail: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Retry request: return success
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await rawApiRequest("/test-endpoint/");

    // Verify successful result from retry
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });

    // Verify request sequence:
    // 1. Initial API request with initial-token -> 401
    // 2. OAuth refresh request
    // 3. Retry API request with refreshed-token -> 200
    const apiRequests = requests.filter((r) =>
      r.url.includes("/test-endpoint")
    );
    const oauthRequests = requests.filter((r) =>
      r.url.includes("/oauth/token/")
    );

    expect(apiRequests).toHaveLength(2);
    expect(oauthRequests).toHaveLength(1);

    // First request with initial token
    expect(apiRequests[0].authorization).toBe("Bearer initial-token");
    expect(apiRequests[0].isRetry).toBe(false);

    // Retry request with new token
    expect(apiRequests[1].authorization).toBe("Bearer refreshed-token");
    expect(apiRequests[1].isRetry).toBe(true);
  });

  test("does not retry on non-401 errors", async () => {
    const requests: RequestLog[] = [];

    globalThis.fetch = createMockFetch(requests, () => {
      // Return 403 (not 401) - this should not trigger retry
      return new Response(JSON.stringify({ detail: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    });

    // rawApiRequest doesn't throw on error responses, it returns the status
    const result = await rawApiRequest("/test-endpoint/");
    expect(result.status).toBe(403);

    // Should only have initial API request, no retry
    const apiRequests = requests.filter((r) =>
      r.url.includes("/test-endpoint")
    );
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0].isRetry).toBe(false);

    // No OAuth refresh should have been attempted
    const oauthRequests = requests.filter((r) =>
      r.url.includes("/oauth/token/")
    );
    expect(oauthRequests).toHaveLength(0);
  });

  test("does not retry infinitely on repeated 401s", async () => {
    const requests: RequestLog[] = [];

    globalThis.fetch = createMockFetch(requests, () => {
      // Always return 401 for API requests
      return new Response(JSON.stringify({ detail: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    // rawApiRequest doesn't throw, returns status
    const result = await rawApiRequest("/test-endpoint/");
    expect(result.status).toBe(401);

    // Should have exactly 2 API requests (initial + one retry, no infinite loop)
    const apiRequests = requests.filter((r) =>
      r.url.includes("/test-endpoint")
    );
    expect(apiRequests).toHaveLength(2);
    expect(apiRequests[0].isRetry).toBe(false);
    expect(apiRequests[1].isRetry).toBe(true);

    // OAuth refresh should have been called once (after first 401)
    const oauthRequests = requests.filter((r) =>
      r.url.includes("/oauth/token/")
    );
    expect(oauthRequests).toHaveLength(1);
  });

  test("preserves a final-attempt 401 without refreshing the token", async () => {
    const requests: RequestLog[] = [];
    const body = { detail: "Unauthorized" };
    globalThis.fetch = createMockFetch(requests, (_req, requestCount) =>
      Response.json(body, { status: requestCount < 3 ? 503 : 401 })
    );

    const result = await rawApiRequest("/test-endpoint/");

    expect(result.status).toBe(401);
    expect(result.body).toEqual(body);
    expect(requests).toHaveLength(3);
    expect(requests.filter((r) => r.url.includes("/oauth/token/"))).toEqual([]);
  });

  test("does not retry for manual API tokens (no refresh token)", async () => {
    // Manual API tokens have no expiry and no refresh token
    await setAuthToken("manual-api-token"); // No expiry, no refresh token

    const requests: RequestLog[] = [];

    globalThis.fetch = createMockFetch(requests, () => {
      // Always return 401
      return new Response(JSON.stringify({ detail: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    // rawApiRequest doesn't throw, returns status
    const result = await rawApiRequest("/test-endpoint/");
    expect(result.status).toBe(401);

    // Should have exactly 1 API request - no retry since token can't be refreshed
    const apiRequests = requests.filter((r) =>
      r.url.includes("/test-endpoint")
    );
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0].isRetry).toBe(false);

    // No OAuth refresh should have been attempted (no refresh token available)
    const oauthRequests = requests.filter((r) =>
      r.url.includes("/oauth/token/")
    );
    expect(oauthRequests).toHaveLength(0);
  });
});

describe("buildSearchParams", () => {
  test("returns undefined for undefined input", () => {
    expect(buildSearchParams(undefined)).toBeUndefined();
  });

  test("returns undefined for empty object", () => {
    expect(buildSearchParams({})).toBeUndefined();
  });

  test("returns undefined when all values are undefined", () => {
    expect(buildSearchParams({ a: undefined, b: undefined })).toBeUndefined();
  });

  test("builds params from simple key-value pairs", () => {
    const result = buildSearchParams({ status: "resolved", limit: 10 });
    expect(result).toBeDefined();
    expect(result?.get("status")).toBe("resolved");
    expect(result?.get("limit")).toBe("10");
  });

  test("skips undefined values", () => {
    const result = buildSearchParams({
      status: "resolved",
      query: undefined,
      limit: 10,
    });
    expect(result).toBeDefined();
    expect(result?.get("status")).toBe("resolved");
    expect(result?.get("limit")).toBe("10");
    expect(result?.has("query")).toBe(false);
  });

  test("handles boolean values", () => {
    const result = buildSearchParams({ active: true, archived: false });
    expect(result).toBeDefined();
    expect(result?.get("active")).toBe("true");
    expect(result?.get("archived")).toBe("false");
  });

  test("handles string arrays as repeated keys", () => {
    const result = buildSearchParams({ tags: ["error", "warning", "info"] });
    expect(result).toBeDefined();
    // URLSearchParams.getAll returns all values for repeated keys
    expect(result?.getAll("tags")).toEqual(["error", "warning", "info"]);
    // toString shows repeated keys
    expect(result?.toString()).toBe("tags=error&tags=warning&tags=info");
  });

  test("handles mixed simple values and arrays", () => {
    const result = buildSearchParams({
      status: "unresolved",
      tags: ["critical", "backend"],
      limit: 25,
    });
    expect(result).toBeDefined();
    expect(result?.get("status")).toBe("unresolved");
    expect(result?.getAll("tags")).toEqual(["critical", "backend"]);
    expect(result?.get("limit")).toBe("25");
  });

  test("handles empty array", () => {
    const result = buildSearchParams({ tags: [] });
    // Empty array produces no entries, so result should be undefined
    expect(result).toBeUndefined();
  });
});

describe("rawApiRequest", () => {
  test("sends GET request without body", async () => {
    const requests: Request[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);

      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await rawApiRequest("organizations/");

    expect(result.status).toBe(200);
    expect(result.body).toEqual([{ id: 1 }]);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
  });

  test("sends POST request with JSON object body", async () => {
    const requests: Request[] = [];
    let capturedBody: string | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);
      capturedBody = await req.text();

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await rawApiRequest("issues/123/", {
      method: "POST",
      body: { status: "resolved" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true });
    expect(requests[0].method).toBe("POST");
    expect(capturedBody).toBe('{"status":"resolved"}');
  });

  test("sends PUT request with string body", async () => {
    const requests: Request[] = [];
    let capturedBody: string | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);
      capturedBody = await req.text();

      return new Response(JSON.stringify({ updated: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await rawApiRequest("issues/123/", {
      method: "PUT",
      body: '{"status":"resolved"}',
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ updated: true });
    expect(requests[0].method).toBe("PUT");
    // String body should be sent as-is
    expect(capturedBody).toBe('{"status":"resolved"}');
    // No explicit Content-Type header set by rawApiRequest for string bodies.
    // Node.js Request constructor auto-sets "text/plain;charset=UTF-8" for
    // string bodies; Bun leaves it null. Accept either.
    const ct = requests[0].headers.get("Content-Type");
    expect(ct === null || ct === "text/plain;charset=UTF-8").toBe(true);
  });

  test("string body with explicit Content-Type header", async () => {
    const requests: Request[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await rawApiRequest("issues/123/", {
      method: "PUT",
      body: "plain text content",
      headers: { "Content-Type": "text/plain" },
    });

    // User-provided Content-Type should be used
    expect(requests[0].headers.get("Content-Type")).toBe("text/plain");
  });

  test("string body with lowercase content-type header (case-insensitive)", async () => {
    const requests: Request[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await rawApiRequest("issues/123/", {
      method: "PUT",
      body: "<xml>content</xml>",
      headers: { "content-type": "text/xml" },
    });

    // Lowercase content-type should be detected and preserved (case-insensitive check)
    expect(requests[0].headers.get("Content-Type")).toBe("text/xml");
  });

  test("string body with mixed case Content-TYPE header", async () => {
    const requests: Request[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await rawApiRequest("issues/123/", {
      method: "PUT",
      body: "some data",
      headers: { "CONTENT-TYPE": "application/octet-stream" },
    });

    // Mixed case Content-TYPE should be detected and preserved
    expect(requests[0].headers.get("Content-Type")).toBe(
      "application/octet-stream"
    );
  });

  test("sends request with query params", async () => {
    const requests: Request[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await rawApiRequest("issues/", {
      params: { status: "resolved", limit: "10" },
    });

    const url = new URL(requests[0].url);
    expect(url.searchParams.get("status")).toBe("resolved");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  test("sends request with custom headers", async () => {
    const requests: Request[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await rawApiRequest("issues/", {
      headers: { "X-Custom-Header": "test-value" },
    });

    expect(requests[0].headers.get("X-Custom-Header")).toBe("test-value");
  });

  test("custom headers merged with string body (no default Content-Type)", async () => {
    const requests: Request[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await rawApiRequest("issues/123/", {
      method: "PUT",
      body: '{"status":"resolved"}',
      headers: { "X-Custom": "value" },
    });

    // Custom headers should be present, but no explicit Content-Type for string bodies.
    // Node.js Request constructor auto-sets "text/plain;charset=UTF-8" for
    // string bodies; Bun leaves it null. Accept either.
    expect(requests[0].headers.get("X-Custom")).toBe("value");
    const ct = requests[0].headers.get("Content-Type");
    expect(ct === null || ct === "text/plain;charset=UTF-8").toBe(true);
  });

  test("returns non-JSON response body as string", async () => {
    globalThis.fetch = async () =>
      new Response("Plain text response", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

    const result = await rawApiRequest("some-endpoint/");

    expect(result.status).toBe(200);
    expect(result.body).toBe("Plain text response");
  });

  test("returns error status without throwing", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });

    const result = await rawApiRequest("nonexistent/");

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ detail: "Not found" });
  });

  test("includes response headers", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "abc123",
        },
      });

    const result = await rawApiRequest("test/");

    expect(result.headers.get("X-Request-Id")).toBe("abc123");
  });
});

describe("findProjectsBySlug", () => {
  test("returns matching projects from multiple orgs", async () => {
    // Import dynamically inside test to allow mocking
    const { findProjectsBySlug } = await import("../../src/lib/api-client.js");
    const requests: Request[] = [];

    // Mock the regions endpoint first, then org/project requests
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);
      const url = req.url;

      // Regions endpoint - return single region to simplify test
      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Organizations list
      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "acme", name: "Acme Corp" },
            { id: "2", slug: "beta", name: "Beta Inc" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // getProject for acme/frontend - found
      if (url.includes("/projects/acme/frontend/")) {
        return new Response(
          JSON.stringify({ id: "101", slug: "frontend", name: "Frontend" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // getProject for beta/frontend - found
      if (url.includes("/projects/beta/frontend/")) {
        return new Response(
          JSON.stringify({
            id: "201",
            slug: "frontend",
            name: "Beta Frontend",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Default - not found
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { projects, orgs } = await findProjectsBySlug("frontend");

    expect(projects).toHaveLength(2);
    expect(projects[0].slug).toBe("frontend");
    expect(projects[0].orgSlug).toBe("acme");
    expect(projects[1].slug).toBe("frontend");
    expect(projects[1].orgSlug).toBe("beta");
    expect(orgs).toHaveLength(2);
  });

  test("returns empty array when no projects match", async () => {
    const { findProjectsBySlug } = await import("../../src/lib/api-client.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // Regions endpoint
      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Organizations list
      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "acme", name: "Acme Corp" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // getProject - not found (404)
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { projects } = await findProjectsBySlug("nonexistent");

    expect(projects).toHaveLength(0);
  });

  test("skips orgs where user lacks access (403)", async () => {
    const { findProjectsBySlug } = await import("../../src/lib/api-client.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // Regions endpoint
      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Organizations list
      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "acme", name: "Acme Corp" },
            { id: "2", slug: "restricted", name: "Restricted Org" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // getProject for acme/frontend - success
      if (url.includes("/projects/acme/frontend/")) {
        return new Response(
          JSON.stringify({ id: "101", slug: "frontend", name: "Frontend" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // getProject for restricted/frontend - 403 forbidden
      if (url.includes("/projects/restricted/frontend/")) {
        return new Response(JSON.stringify({ detail: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    // Should not throw, should just skip the restricted org
    const { projects } = await findProjectsBySlug("frontend");

    expect(projects).toHaveLength(1);
    expect(projects[0].orgSlug).toBe("acme");
  });

  test("resolves numeric project ID when slug differs", async () => {
    const { findProjectsBySlug } = await import("../../src/lib/api-client.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // Regions endpoint
      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Organizations list
      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "acme", name: "Acme Corp" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // getProject for acme/7275560680 - API resolves by numeric ID,
      // returns project with a different slug
      if (url.includes("/projects/acme/7275560680/")) {
        return new Response(
          JSON.stringify({
            id: "7275560680",
            slug: "frontend",
            name: "Frontend",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    // Numeric ID should resolve even though returned slug differs
    const { projects } = await findProjectsBySlug("7275560680");
    expect(projects).toHaveLength(1);
    expect(projects[0].slug).toBe("frontend");
    expect(projects[0].orgSlug).toBe("acme");
  });

  test("rejects non-numeric input when returned slug differs", async () => {
    const { findProjectsBySlug } = await import("../../src/lib/api-client.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/organizations/") && !url.includes("/projects/")) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "acme", name: "Acme Corp" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // API returns project with different slug (coincidental ID match)
      if (url.includes("/projects/acme/wrong-slug/")) {
        return new Response(
          JSON.stringify({ id: "999", slug: "actual-slug", name: "Actual" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    // Non-numeric input with slug mismatch should be rejected
    const { projects } = await findProjectsBySlug("wrong-slug");
    expect(projects).toHaveLength(0);
  });

  test("uses cached orgs to skip listOrganizations API calls", async () => {
    const { findProjectsBySlug } = await import("../../src/lib/api-client.js");

    // Seed org_regions cache with full org data (slug, id, name, region)
    // so listOrganizations() returns from cache without HTTP calls.
    setOrgRegions([
      {
        slug: "acme",
        regionUrl: DEFAULT_SENTRY_URL,
        orgId: "42",
        orgName: "Acme Corp",
      },
    ]);

    const requests: string[] = [];

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;
      requests.push(url);

      // getProject for acme/frontend — success
      if (url.includes("/projects/acme/frontend/")) {
        return new Response(
          JSON.stringify({ id: "101", slug: "frontend", name: "Frontend" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { projects } = await findProjectsBySlug("frontend");

    // Found via cached orgs
    expect(projects).toHaveLength(1);
    expect(projects[0].slug).toBe("frontend");
    expect(projects[0].orgSlug).toBe("acme");

    // The expensive listOrganizations API calls were skipped
    expect(requests.some((r) => r.includes("/users/me/regions/"))).toBe(false);
    expect(
      requests.some(
        (r) => r.includes("/organizations/") && !r.includes("/projects/")
      )
    ).toBe(false);
  });
});

describe("resolveEventInOrg", () => {
  const sampleEvent = {
    id: "abc123",
    eventID: "abc123def456",
    groupID: "12345",
    projectID: "67890",
    message: "Something went wrong",
    title: "Error",
    location: null,
    user: null,
    tags: [],
    platform: "node",
    dateReceived: "2026-01-01T00:00:00Z",
    contexts: null,
    size: 100,
    entries: [],
    dist: null,
    sdk: {},
    context: null,
    packages: {},
    type: "error",
    metadata: null,
    errors: [],
    occurrence: null,
    _meta: {},
  };

  test("returns resolved event when found in org", async () => {
    const { resolveEventInOrg } = await import("../../src/lib/api-client.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/eventids/abc123def456/")) {
        return new Response(
          JSON.stringify({
            organizationSlug: "acme",
            projectSlug: "frontend",
            groupId: "12345",
            eventId: "abc123def456",
            event: sampleEvent,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await resolveEventInOrg("acme", "abc123def456");
    expect(result).not.toBeNull();
    expect(result?.org).toBe("acme");
    expect(result?.project).toBe("frontend");
    expect(result?.event.eventID).toBe("abc123def456");
  });

  test("returns null when event not found in org", async () => {
    const { resolveEventInOrg } = await import("../../src/lib/api-client.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await resolveEventInOrg("acme", "notfound000000");
    expect(result).toBeNull();
  });
});

describe("findEventAcrossOrgs", () => {
  const sampleEvent = {
    id: "abc123",
    eventID: "abc123def456",
    groupID: "12345",
    projectID: "67890",
    message: "Something went wrong",
    title: "Error",
    location: null,
    user: null,
    tags: [],
    platform: "node",
    dateReceived: "2026-01-01T00:00:00Z",
    contexts: null,
    size: 100,
    entries: [],
    dist: null,
    sdk: {},
    context: null,
    packages: {},
    type: "error",
    metadata: null,
    errors: [],
    occurrence: null,
    _meta: {},
  };

  test("returns match from the org that has the event", async () => {
    const { findEventAcrossOrgs } = await import("../../src/lib/api-client.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/organizations/") && !url.includes("/eventids/")) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "no-event-org", name: "No Event Org" },
            { id: "2", slug: "has-event-org", name: "Has Event Org" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/has-event-org/eventids/abc123def456/")) {
        return new Response(
          JSON.stringify({
            organizationSlug: "has-event-org",
            projectSlug: "backend",
            groupId: "12345",
            eventId: "abc123def456",
            event: sampleEvent,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await findEventAcrossOrgs("abc123def456");
    expect(result).not.toBeNull();
    expect(result?.org).toBe("has-event-org");
    expect(result?.project).toBe("backend");
  });

  test("returns null when event not found in any org", async () => {
    const { findEventAcrossOrgs } = await import("../../src/lib/api-client.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/users/me/regions/")) {
        return new Response(
          JSON.stringify({
            regions: [{ name: "us", url: "https://us.sentry.io" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/organizations/") && !url.includes("/eventids/")) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "acme", name: "Acme" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await findEventAcrossOrgs("notfound000000");
    expect(result).toBeNull();
  });
});

describe("listTeamsPaginated", () => {
  beforeEach(async () => {
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  test("returns teams and nextCursor from Link header", async () => {
    const teamData = [
      { id: "1", slug: "backend", name: "Backend", memberCount: 5 },
      { id: "2", slug: "frontend", name: "Frontend", memberCount: 3 },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/teams/")) {
        return new Response(JSON.stringify(teamData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://sentry.io/api/0/teams/>; rel="next"; results="true"; cursor="100:1:0"',
          },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    const result = await listTeamsPaginated("my-org");
    expect(result.data).toHaveLength(2);
    expect(result.nextCursor).toBe("100:1:0");
  });

  test("returns no nextCursor when Link header has results=false", async () => {
    const teamData = [
      { id: "1", slug: "backend", name: "Backend", memberCount: 5 },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/teams/")) {
        return new Response(JSON.stringify(teamData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://sentry.io/api/0/teams/>; rel="previous"; results="false"; cursor="100:0:1", <https://sentry.io/api/0/teams/>; rel="next"; results="false"; cursor="100:1:0"',
          },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    const result = await listTeamsPaginated("my-org");
    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBeUndefined();
  });

  test("passes cursor and perPage as query params", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/teams/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listTeamsPaginated("my-org", { cursor: "100:2:0", perPage: 10 });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("cursor")).toBe("100:2:0");
    expect(url.searchParams.get("per_page")).toBe("10");
  });
});

describe("listRepositoriesPaginated", () => {
  beforeEach(async () => {
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  test("returns repos and nextCursor from Link header", async () => {
    const repoData = [
      {
        id: "1",
        name: "getsentry/sentry",
        provider: { name: "GitHub" },
        status: "active",
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/repos/")) {
        return new Response(JSON.stringify(repoData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://sentry.io/api/0/repos/>; rel="next"; results="true"; cursor="0:1:0"',
          },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    const result = await listRepositoriesPaginated("my-org");
    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBe("0:1:0");
  });

  test("passes cursor and perPage as query params", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/repos/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listRepositoriesPaginated("my-org", { cursor: "0:2:0", perPage: 5 });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("cursor")).toBe("0:2:0");
    expect(url.searchParams.get("per_page")).toBe("5");
  });
});

describe("listIssuesPaginated", () => {
  beforeEach(async () => {
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  test("returns issues and nextCursor from Link header", async () => {
    const issueData = [
      { id: "1", shortId: "PROJ-1", title: "Test Error", status: "unresolved" },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/issues/")) {
        return new Response(JSON.stringify(issueData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://sentry.io/api/0/issues/>; rel="next"; results="true"; cursor="0:1:0"',
          },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    const result = await listIssuesPaginated("my-org", "my-proj");
    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBe("0:1:0");
  });

  test("includes project filter in query param", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/issues/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listIssuesPaginated("my-org", "my-proj");

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("query")).toContain("project:my-proj");
  });

  test("combines project filter with custom query", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/issues/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listIssuesPaginated("my-org", "my-proj", { query: "is:unresolved" });

    const url = new URL(capturedUrl);
    const query = url.searchParams.get("query") ?? "";
    expect(query).toContain("project:my-proj");
    expect(query).toContain("is:unresolved");
  });

  test("passes cursor, perPage, and sort as query params", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/issues/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listIssuesPaginated("my-org", "my-proj", {
      cursor: "0:3:0",
      perPage: 20,
      sort: "freq",
    });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("cursor")).toBe("0:3:0");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("sort")).toBe("freq");
  });

  test("uses project query param instead of project:slug when projectId is provided", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/issues/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listIssuesPaginated("my-org", "my-proj", { projectId: 12_345 });

    const url = new URL(capturedUrl);
    // Should use project=12345 query param
    expect(url.searchParams.get("project")).toBe("12345");
    // Should NOT include project:my-proj in the search query
    const query = url.searchParams.get("query") ?? "";
    expect(query).not.toContain("project:my-proj");
  });

  test("uses project:slug in query when projectId is not provided", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/issues/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listIssuesPaginated("my-org", "my-proj");

    const url = new URL(capturedUrl);
    // Should NOT have project query param
    expect(url.searchParams.has("project")).toBe(false);
    // Should include project:my-proj in the search query
    expect(url.searchParams.get("query")).toContain("project:my-proj");
  });

  test("combines projectId with custom query without project:slug", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/issues/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listIssuesPaginated("my-org", "my-proj", {
      projectId: 12_345,
      query: "is:unresolved",
    });

    const url = new URL(capturedUrl);
    // Should use project=12345 query param
    expect(url.searchParams.get("project")).toBe("12345");
    // Search query should contain custom query but not project:slug
    const query = url.searchParams.get("query") ?? "";
    expect(query).toContain("is:unresolved");
    expect(query).not.toContain("project:my-proj");
  });
});

describe("listTransactions", () => {
  const transactionData = {
    data: [
      {
        trace: "aaaa1111bbbb2222cccc3333dddd4444",
        id: "evt001",
        transaction: "GET /api/users",
        timestamp: "2025-01-30T14:32:15+00:00",
        "span.duration": 245,
        project: "my-project",
      },
    ],
    meta: { fields: { trace: "string" } },
  };

  beforeEach(async () => {
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  test("returns data and nextCursor from Link header", async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        return new Response(JSON.stringify(transactionData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://sentry.io/api/0/events/>; rel="next"; results="true"; cursor="1735689600:0:0"',
          },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await listTransactions("my-org", "my-project");
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBe("1735689600:0:0");
  });

  test("returns no nextCursor when link header has results=false", async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        return new Response(JSON.stringify(transactionData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: '<https://sentry.io/api/0/events/>; rel="next"; results="false"; cursor="1735689600:1:0"',
          },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await listTransactions("my-org", "my-project");
    expect(result.nextCursor).toBeUndefined();
  });

  test("passes cursor, sort, limit, and query as params", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify(transactionData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await listTransactions("my-org", "my-project", {
      cursor: "1735689600:0:0",
      sort: "duration",
      limit: 50,
      query: "transaction:GET",
    });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("cursor")).toBe("1735689600:0:0");
    expect(url.searchParams.get("sort")).toBe("-span.duration");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("query")).toContain("transaction:GET");
    expect(url.searchParams.get("query")).toContain("is_transaction:true");
  });

  test("uses project query param for numeric project IDs", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify(transactionData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await listTransactions("my-org", "12345");

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("project")).toBe("12345");
    // Query should only carry the transaction filter, not project scoping
    const query = url.searchParams.get("query");
    expect(query).toBe("is_transaction:true");
  });

  test("uses project:slug in query for non-numeric project slugs", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify(transactionData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await listTransactions("my-org", "my-project");

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("project")).toBeNull();
    expect(url.searchParams.get("query")).toContain("project:my-project");
  });
});

describe("listTraceLogs", () => {
  const traceLogsData = {
    data: [
      {
        id: "log001",
        "project.id": 123,
        trace: "aaaa1111bbbb2222cccc3333dddd4444",
        severity_number: 9,
        severity: "info",
        timestamp: "2025-01-30T14:32:15+00:00",
        timestamp_precise: 1_738_247_535_000_000_000,
        message: "Request received",
      },
    ],
    meta: { fields: { id: "string" } },
  };

  beforeEach(async () => {
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  test("returns trace log entries", async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/trace-logs/")) {
        return new Response(JSON.stringify(traceLogsData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await listTraceLogs(
      "my-org",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("info");
  });

  test("passes traceId, statsPeriod, limit, and query as params", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/trace-logs/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify(traceLogsData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await listTraceLogs("my-org", "aaaa1111bbbb2222cccc3333dddd4444", {
      statsPeriod: "7d",
      limit: 100,
      query: "severity:error",
    });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("traceId")).toBe(
      "aaaa1111bbbb2222cccc3333dddd4444"
    );
    expect(url.searchParams.get("statsPeriod")).toBe("7d");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("query")).toBe("severity:error");
  });

  test("defaults statsPeriod to 14d when not specified", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/trace-logs/")) {
        capturedUrl = req.url;
        return new Response(JSON.stringify(traceLogsData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await listTraceLogs("my-org", "aaaa1111bbbb2222cccc3333dddd4444");

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("statsPeriod")).toBe("14d");
  });

  test("coerces string numeric fields to numbers (API resilience)", async () => {
    const stringFieldsData = {
      data: [
        {
          id: "log001",
          "project.id": "123",
          trace: "aaaa1111bbbb2222cccc3333dddd4444",
          severity_number: "9",
          severity: "info",
          timestamp: "2025-01-30T14:32:15+00:00",
          timestamp_precise: "1738247535000000000",
          message: "Request received",
        },
      ],
      meta: { fields: { id: "string" } },
    };

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/trace-logs/")) {
        return new Response(JSON.stringify(stringFieldsData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await listTraceLogs(
      "my-org",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );
    expect(result).toHaveLength(1);
    expect(typeof result[0]["project.id"]).toBe("number");
    expect(result[0]["project.id"]).toBe(123);
    expect(typeof result[0].severity_number).toBe("number");
    expect(result[0].severity_number).toBe(9);
    expect(typeof result[0].timestamp_precise).toBe("number");
  });

  test("accepts responses with missing optional fields", async () => {
    const minimalData = {
      data: [
        {
          id: "log001",
          "project.id": 123,
          trace: "aaaa1111bbbb2222cccc3333dddd4444",
          severity: "info",
          timestamp: "2025-01-30T14:32:15+00:00",
          message: "Test",
        },
      ],
    };

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/trace-logs/")) {
        return new Response(JSON.stringify(minimalData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await listTraceLogs(
      "my-org",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );
    expect(result).toHaveLength(1);
    expect(result[0].severity_number).toBeUndefined();
    expect(result[0].timestamp_precise).toBeUndefined();
    expect(result[0].severity).toBe("info");
  });
});

describe("getLogs", () => {
  const LOG_ID_1 = "a0a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5";
  const LOG_ID_2 = "1111222233334444555566667777aaaa";

  function makeLogEntry(id: string) {
    return {
      "sentry.item_id": id,
      timestamp: "2025-01-30T14:32:15+00:00",
      timestamp_precise: 1_770_060_419_044_800_300,
      message: `Log ${id}`,
      severity: "info",
      trace: "abc123def456abc123def456abc12345",
      project: "test-project",
      environment: "production",
      release: "1.0.0",
      "sdk.name": "sentry.javascript.node",
      "sdk.version": "8.0.0",
      span_id: "span123abc",
      "code.function": "handleRequest",
      "code.file.path": "src/handlers/api.ts",
      "code.line.number": "42",
      "sentry.otel.kind": null,
      "sentry.otel.status_code": null,
      "sentry.otel.instrumentation_scope.name": null,
    };
  }

  beforeEach(async () => {
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  test("returns matching log entries", async () => {
    const responseData = {
      data: [makeLogEntry(LOG_ID_1)],
      meta: { fields: { "sentry.item_id": "string" } },
    };

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        return new Response(JSON.stringify(responseData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await getLogs("my-org", "my-project", [LOG_ID_1]);
    expect(result).toHaveLength(1);
    expect(result[0]["sentry.item_id"]).toBe(LOG_ID_1);
  });

  test("passes bracket syntax and per_page in query", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        capturedUrl = req.url;
        return new Response(
          JSON.stringify({ data: [], meta: { fields: {} } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await getLogs("my-org", "my-project", [LOG_ID_1, LOG_ID_2]);
    const url = new URL(capturedUrl);
    const query = url.searchParams.get("query");
    expect(query).toContain(`sentry.item_id:[${LOG_ID_1},${LOG_ID_2}]`);
    expect(url.searchParams.get("per_page")).toBe("2");
  });

  test("returns empty array when no logs found", async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        return new Response(
          JSON.stringify({ data: [], meta: { fields: {} } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await getLogs("my-org", "my-project", [
      "deadbeefdeadbeefdeadbeefdeadbeef",
    ]);
    expect(result).toHaveLength(0);
  });

  test("batches requests when IDs exceed API_MAX_PER_PAGE", async () => {
    // Create 150 IDs (should split into 2 batches: 100 + 50)
    const ids = Array.from({ length: 150 }, (_, i) =>
      i.toString(16).padStart(32, "0")
    );
    const capturedUrls: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/events/")) {
        capturedUrls.push(req.url);
        // Return one log per batch so we can verify results are merged
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? "";
        const bracketMatch = query.match(/sentry\.item_id:\[([^\]]+)\]/);
        const batchIds = bracketMatch ? bracketMatch[1].split(",") : [];
        return new Response(
          JSON.stringify({
            data: [makeLogEntry(batchIds[0])],
            meta: { fields: {} },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await getLogs("my-org", "my-project", ids);

    // Should have made 2 separate requests
    expect(capturedUrls).toHaveLength(2);

    // First batch: 100 IDs
    const url1 = new URL(capturedUrls[0]);
    expect(url1.searchParams.get("per_page")).toBe(String(API_MAX_PER_PAGE));

    // Second batch: 50 IDs
    const url2 = new URL(capturedUrls[1]);
    expect(url2.searchParams.get("per_page")).toBe("50");

    // Results from both batches should be flattened
    expect(result).toHaveLength(2);
  });
});

describe("getProject", () => {
  test("sends ?collapse=organization query parameter", async () => {
    const { getProject } = await import("../../src/lib/api-client.js");

    // Seed region cache so the SDK targets us.sentry.io without /users/me/regions/
    setOrgRegions([
      {
        slug: "acme",
        regionUrl: DEFAULT_SENTRY_URL,
        orgId: "42",
        orgName: "Acme Corp",
      },
    ]);

    const capturedUrls: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      capturedUrls.push(req.url);

      if (req.url.includes("/projects/acme/frontend/")) {
        return new Response(
          JSON.stringify({
            id: "101",
            slug: "frontend",
            name: "Frontend",
            // Collapsed response: no `name` on organization
            organization: { id: "42", slug: "acme" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const project = await getProject("acme", "frontend");

    expect(project.slug).toBe("frontend");
    expect(project.organization?.slug).toBe("acme");

    // Verify the outgoing URL carries ?collapse=organization
    const projectRequest = capturedUrls.find((u) =>
      u.includes("/projects/acme/frontend/")
    );
    expect(projectRequest).toBeDefined();
    const parsed = new URL(projectRequest as string);
    expect(parsed.searchParams.get("collapse")).toBe("organization");
  });

  test("tolerates collapsed response missing organization.name", async () => {
    const { getProject } = await import("../../src/lib/api-client.js");

    setOrgRegions([
      {
        slug: "acme",
        regionUrl: DEFAULT_SENTRY_URL,
        orgId: "42",
        orgName: "Acme Corp",
      },
    ]);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);

      if (req.url.includes("/projects/acme/frontend/")) {
        return new Response(
          JSON.stringify({
            id: "101",
            slug: "frontend",
            name: "Frontend",
            organization: { id: "42", slug: "acme" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const project = await getProject("acme", "frontend");

    // `name` is optional on collapsed responses
    expect(project.organization?.name).toBeUndefined();
    expect(project.organization?.slug).toBe("acme");
  });
});

describe("resolveOrgDisplayName", () => {
  test("prefers explicit name when provided", async () => {
    const { resolveOrgDisplayName } = await import(
      "../../src/lib/api-client.js"
    );

    expect(resolveOrgDisplayName("acme", "Acme Corp")).toBe("Acme Corp");
  });

  test("falls back to cached org name when explicit name is absent", async () => {
    const { resolveOrgDisplayName } = await import(
      "../../src/lib/api-client.js"
    );

    setOrgRegions([
      {
        slug: "acme",
        regionUrl: DEFAULT_SENTRY_URL,
        orgId: "42",
        orgName: "Acme Corp",
      },
    ]);

    expect(resolveOrgDisplayName("acme")).toBe("Acme Corp");
  });

  test("falls back to slug when no cache entry exists", async () => {
    const { resolveOrgDisplayName } = await import(
      "../../src/lib/api-client.js"
    );

    // Empty cache — no entry for this slug
    expect(resolveOrgDisplayName("unknown-org")).toBe("unknown-org");
  });

  test("falls back to slug when explicit name is empty string", async () => {
    const { resolveOrgDisplayName } = await import(
      "../../src/lib/api-client.js"
    );

    // Empty string is falsy, so the cache/slug fallback kicks in
    expect(resolveOrgDisplayName("unknown-org", "")).toBe("unknown-org");
  });
});
