/**
 * Organization API response validation and fresh-list cache behavior.
 *
 * CLI-1CQ: self-hosted instances can return non-array data from
 * GET /api/0/organizations/ when a reverse proxy or WAF interferes.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  listOrganizations,
  listOrganizationsPage,
  listOrganizationsUncached,
} from "../../../src/lib/api/organizations.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { ApiError } from "../../../src/lib/errors.js";
import {
  getCachedResponse,
  storeCachedResponse,
} from "../../../src/lib/response-cache.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("org-api-test-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_NO_CACHE",
]);

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("fake-token-for-test", 3600, undefined, {
    host: "https://sentry.example.com",
  });
});

test("uncached organization refresh replaces an incomplete HTTP response cache", async () => {
  const baseUrl = "https://sentry.example.com";
  process.env.SENTRY_URL = baseUrl;
  const url = `${baseUrl}/api/0/organizations/?per_page=100`;
  const headers = { authorization: "Bearer fake-token-for-test" };
  const cachedOrgs = [{ id: "1", slug: "first-org", name: "First Org" }];
  const currentOrgs = [
    ...cachedOrgs,
    { id: "2", slug: "new-org", name: "New Org" },
  ];
  await storeCachedResponse(
    "GET",
    url,
    headers,
    Response.json(cachedOrgs, {
      headers: { "Cache-Control": "private, max-age=300" },
    })
  );

  const requests: Request[] = [];
  globalThis.fetch = mockFetch(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(currentOrgs);
  });

  const cachedPage = await listOrganizationsPage(baseUrl, { perPage: 100 });
  expect(cachedPage.data).toEqual(cachedOrgs);
  expect(requests).toHaveLength(0);

  expect(await listOrganizationsUncached()).toEqual(currentOrgs);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(url);
  expect(requests[0]?.headers.get("Authorization")).toBe(headers.authorization);
  expect(await listOrganizations()).toEqual(currentOrgs);
  await expect
    .poll(async () => (await getCachedResponse("GET", url, headers))?.json())
    .toEqual(currentOrgs);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("listOrganizationsPage", () => {
  test("returns organizations when API returns a valid array", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify([{ id: "1", slug: "test-org", name: "Test Org" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
    );

    const { data: orgs } = await listOrganizationsPage(
      "https://sentry.example.com"
    );
    expect(orgs).toHaveLength(1);
    expect(orgs[0].slug).toBe("test-org");
  });

  test("throws ApiError when API returns an empty object instead of array", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(
      listOrganizationsPage("https://sentry.example.com")
    ).rejects.toThrow(ApiError);

    try {
      await listOrganizationsPage("https://sentry.example.com");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.message).toContain("unexpected response format");
      expect(apiError.detail).toContain("sentry.example.com");
    }
  });

  test("throws ApiError when API returns empty body", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(
      listOrganizationsPage("https://sentry.example.com")
    ).rejects.toThrow(ApiError);
  });
});
