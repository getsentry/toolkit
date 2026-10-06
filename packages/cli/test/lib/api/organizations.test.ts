/**
 * Tests for listOrganizationsPage — guards against non-array SDK responses.
 *
 * CLI-1CQ: self-hosted instances can return non-array data from
 * GET /api/0/organizations/ when a reverse proxy or WAF interferes.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listOrganizationsPage } from "../../../src/lib/api/organizations.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { ApiError } from "../../../src/lib/errors.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("org-api-test-");

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("fake-token-for-test", 3600, undefined, {
    host: "https://sentry.example.com",
  });
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
