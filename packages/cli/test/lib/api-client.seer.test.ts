/**
 * Seer API Client Tests
 *
 * Tests for the seer-related API functions by mocking fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { normalizeAgentStatus } from "../../src/lib/api/seer.js";
import {
  getAutofixState,
  triggerRootCauseAnalysis,
  triggerSolutionPlanning,
} from "../../src/lib/api-client.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setOrgRegion } from "../../src/lib/db/regions.js";
import { ApiError } from "../../src/lib/errors.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-seer-api-");
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  // Save original fetch
  originalFetch = globalThis.fetch;

  // Set up auth token (manual token, no refresh)
  await setAuthToken("test-token");
  // Pre-populate region cache to avoid region resolution API calls
  setOrgRegion("test-org", "https://sentry.io");
});

afterEach(() => {
  // Restore original fetch
  globalThis.fetch = originalFetch;
});

describe("triggerRootCauseAnalysis", () => {
  test("sends POST request to autofix endpoint with explorer mode", async () => {
    let capturedRequest: Request | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest = new Request(input, init);

      return new Response(JSON.stringify({ run_id: 12_345 }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    };

    await triggerRootCauseAnalysis("test-org", "123456789");

    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.url).toContain(
      "/organizations/test-org/issues/123456789/autofix/",
    );
    expect(capturedRequest?.url).toContain("mode=explorer");
  });

  test("includes step and stopping_point in request body", async () => {
    let capturedBody: unknown;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      capturedBody = await req.json();

      return new Response(JSON.stringify({ run_id: 12_345 }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    };

    await triggerRootCauseAnalysis("test-org", "123456789");

    expect(capturedBody).toEqual({
      step: "root_cause",
      referrer: "api.cli",
    });
  });

  test("throws ApiError on 402 response", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "No budget for Seer Autofix" }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });

    await expect(
      triggerRootCauseAnalysis("test-org", "123456789"),
    ).rejects.toThrow();
  });

  test("throws ApiError on 403 response", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "AI Autofix is not enabled" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });

    await expect(
      triggerRootCauseAnalysis("test-org", "123456789"),
    ).rejects.toThrow();
  });
});

describe("getAutofixState", () => {
  test("sends GET request to autofix endpoint with explorer mode", async () => {
    let capturedRequest: Request | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest = new Request(input, init);

      return new Response(
        JSON.stringify({
          autofix: {
            sentry_run_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            status: "processing",
            blocks: [],
            updated_at: "2025-01-01T00:00:00Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const result = await getAutofixState("test-org", "123456789");

    expect(result?.sentry_run_id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(result?.status).toBe("PROCESSING");
    expect(capturedRequest?.method).toBe("GET");
    expect(capturedRequest?.url).toContain(
      "/organizations/test-org/issues/123456789/autofix/",
    );
    expect(capturedRequest?.url).toContain("mode=explorer");
  });

  test("still parses legacy run_id when sentry_run_id is absent", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "processing",
            blocks: [],
            updated_at: "2025-01-01T00:00:00Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await getAutofixState("test-org", "123456789");

    expect(result?.run_id).toBe(12_345);
    expect(result?.sentry_run_id).toBeUndefined();
  });

  test("normalizes agent status values to uppercase", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          autofix: {
            run_id: 1,
            status: "awaiting_user_input",
            blocks: [],
            updated_at: "2025-01-01T00:00:00Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await getAutofixState("test-org", "123456789");
    expect(result?.status).toBe("WAITING_FOR_USER_RESPONSE");
  });

  test("normalizes US spelling 'canceled' to CANCELLED for terminal status match", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          autofix: {
            run_id: 1,
            status: "canceled",
            blocks: [],
            updated_at: "2025-01-01T00:00:00Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await getAutofixState("test-org", "123456789");
    expect(result?.status).toBe("CANCELLED");
  });

  test("normalizes need_more_information to NEED_MORE_INFORMATION", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          autofix: {
            run_id: 1,
            status: "need_more_information",
            blocks: [],
            updated_at: "2025-01-01T00:00:00Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await getAutofixState("test-org", "123456789");
    expect(result?.status).toBe("NEED_MORE_INFORMATION");
  });

  test("returns null when autofix is null", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ autofix: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await getAutofixState("test-org", "123456789");
    expect(result).toBeNull();
  });

  test.each([
    { name: "a null response", payload: null },
    { name: "a missing status", payload: { autofix: { run_id: 1 } } },
    {
      name: "a non-string status",
      payload: { autofix: { run_id: 1, status: 123 } },
    },
  ])("throws a validation ApiError for $name", async ({ payload }) => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const request = getAutofixState("test-org", "123456789");

    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      message:
        "Unexpected response format from /organizations/test-org/issues/123456789/autofix/",
      status: 200,
      detail: expect.any(String),
    });
  });

  test("returns completed state with blocks", async () => {
    const blocks = [
      {
        id: "block-1",
        message: { role: "assistant", content: "Found the root cause" },
        timestamp: "2025-01-01T00:00:00Z",
        artifacts: [
          {
            key: "root_cause",
            data: {
              one_line_description: "Test cause",
              five_whys: ["Why 1"],
            },
            reason: "",
          },
        ],
      },
    ];

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "completed",
            updated_at: "2025-01-01T00:00:00Z",
            blocks,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await getAutofixState("test-org", "123456789");
    expect(result?.status).toBe("COMPLETED");
    expect(result?.blocks).toEqual(blocks);
  });
});

describe("triggerSolutionPlanning", () => {
  test("sends POST request to autofix endpoint with explorer mode", async () => {
    let capturedRequest: Request | undefined;
    let capturedBody: unknown;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest = new Request(input, init);
      capturedBody = await new Request(input, init).json();

      return new Response(JSON.stringify({ run_id: 12_345 }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    };

    await triggerSolutionPlanning("test-org", "123456789", 12_345);

    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.url).toContain(
      "/organizations/test-org/issues/123456789/autofix/",
    );
    expect(capturedRequest?.url).toContain("mode=explorer");
    expect(capturedBody).toEqual({
      step: "solution",
      run_id: 12_345,
      referrer: "api.cli",
    });
  });

  test("sends a UUID run ID under the sentry_run_id body field, not run_id", async () => {
    let capturedBody: unknown;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = await new Request(input, init).json();

      return new Response(
        JSON.stringify({
          run_id: 12_345,
          sentry_run_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await triggerSolutionPlanning(
      "test-org",
      "123456789",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );

    // sentry_run_id is a UUIDField server-side; run_id is an IntegerField.
    // Sending the UUID under run_id would fail server-side validation.
    expect(capturedBody).toEqual({
      step: "solution",
      sentry_run_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      referrer: "api.cli",
    });
  });
});

describe("normalizeAgentStatus", () => {
  test.each([
    ["processing", "PROCESSING"],
    ["completed", "COMPLETED"],
    ["error", "ERROR"],
    ["canceled", "CANCELLED"],
    ["cancelled", "CANCELLED"],
    ["awaiting_user_input", "WAITING_FOR_USER_RESPONSE"],
    ["need_more_information", "NEED_MORE_INFORMATION"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeAgentStatus(input)).toBe(expected);
  });

  test.each([[null], [undefined], [""]])(
    "defaults %s status to PROCESSING",
    (input) => {
      expect(normalizeAgentStatus(input)).toBe("PROCESSING");
    },
  );

  test("uppercases unknown statuses", () => {
    expect(normalizeAgentStatus("some_new_status")).toBe("SOME_NEW_STATUS");
  });
});
