/**
 * Product Trial API Client Tests
 *
 * Tests for getProductTrials and startProductTrial by mocking fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getProductTrials,
  startProductTrial,
} from "../../src/lib/api-client.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setOrgRegion } from "../../src/lib/db/regions.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-product-trial-api-");
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;

  await setAuthToken("test-token");
  setOrgRegion("test-org", "https://sentry.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getProductTrials", () => {
  test("returns all trials from the API", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            productTrials: [
              {
                category: "seerUsers",
                startDate: null,
                endDate: null,
                reasonCode: 0,
                isStarted: false,
                lengthDays: 14,
              },
              {
                category: "replays",
                startDate: "2025-01-01",
                endDate: "2025-01-15",
                reasonCode: 0,
                isStarted: true,
                lengthDays: 14,
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
    );

    const trials = await getProductTrials("test-org");

    expect(trials).toHaveLength(2);
    expect(trials[0]?.category).toBe("seerUsers");
    expect(trials[0]?.isStarted).toBe(false);
    expect(trials[1]?.category).toBe("replays");
    expect(trials[1]?.isStarted).toBe(true);
  });

  test("returns empty array when no productTrials field", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const trials = await getProductTrials("test-org");

    expect(trials).toEqual([]);
  });

  test("returns empty array when productTrials is empty", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ productTrials: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const trials = await getProductTrials("test-org");

    expect(trials).toEqual([]);
  });

  test("sends GET request to customer endpoint", async () => {
    let capturedRequest: Request | undefined;

    globalThis.fetch = mockFetch(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedRequest = new Request(input, init);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    await getProductTrials("test-org");

    expect(capturedRequest?.method).toBe("GET");
    expect(capturedRequest?.url).toContain("/customers/test-org/");
  });

  test("throws ApiError on non-200 response", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(getProductTrials("test-org")).rejects.toThrow();
  });
});

describe("startProductTrial", () => {
  test("sends PUT request with correct body for seerUsers", async () => {
    let capturedBody: unknown;

    globalThis.fetch = mockFetch(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    await startProductTrial("test-org", "seerUsers");

    expect(capturedBody).toEqual({
      referrer: "sentry-cli",
      productTrial: { category: "seerUsers", reasonCode: 0 },
    });
  });

  test("sends PUT request with seerAutofix category", async () => {
    let capturedBody: unknown;

    globalThis.fetch = mockFetch(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    await startProductTrial("test-org", "seerAutofix");

    expect(capturedBody).toEqual({
      referrer: "sentry-cli",
      productTrial: { category: "seerAutofix", reasonCode: 0 },
    });
  });

  test("sends PUT request with any category", async () => {
    let capturedBody: unknown;

    globalThis.fetch = mockFetch(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    await startProductTrial("test-org", "replays");

    expect(capturedBody).toEqual({
      referrer: "sentry-cli",
      productTrial: { category: "replays", reasonCode: 0 },
    });
  });

  test("sends PUT to product-trial endpoint", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;

    globalThis.fetch = mockFetch(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = input.toString();
        capturedMethod = init?.method ?? "GET";
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    await startProductTrial("test-org", "seerUsers");

    expect(capturedMethod).toBe("PUT");
    expect(capturedUrl).toContain("/customers/test-org/product-trial/");
  });

  test("throws ApiError on non-200 response", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(startProductTrial("test-org", "seerUsers")).rejects.toThrow();
  });
});
