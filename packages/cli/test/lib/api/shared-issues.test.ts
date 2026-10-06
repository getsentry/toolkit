/**
 * Public shared-issue response and request-boundary regressions.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getSharedIssue } from "../../../src/lib/api/issues.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { ApiError } from "../../../src/lib/errors.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../../helpers.js";

describe("getSharedIssue", () => {
  useTestConfigDir("shared-issues-");
  useEnvSandbox([
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
    "SENTRY_CUSTOM_HEADERS",
  ]);

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reads the backend id from the public org-scoped endpoint without bearer auth", async () => {
    setAuthToken("test-token");
    let request: Request | undefined;
    globalThis.fetch = mockFetch(async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        id: "12345",
        title: "Example shared issue",
        project: { slug: "example-project" },
      });
    });

    const result = await getSharedIssue(
      "https://sentry.io",
      "example org",
      "share/id"
    );

    expect(result.id).toBe("12345");
    expect(request?.url).toBe(
      "https://sentry.io/api/0/organizations/example%20org/shared/issues/share%2Fid/"
    );
    expect(request?.method).toBe("GET");
    expect(request?.headers.has("Authorization")).toBe(false);
  });

  test.each([
    ["null body", null],
    ["missing id", {}],
    ["obsolete groupID field", { groupID: "12345" }],
    ["null id", { id: null }],
    ["numeric id", { id: 12_345 }],
    ["empty id", { id: "" }],
  ])("rejects a response with %s", async (_description, body) => {
    globalThis.fetch = mockFetch(async () => Response.json(body));

    await expect(
      getSharedIssue("https://sentry.io", "example-org", "share-id")
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("reports malformed JSON as an API response error", async () => {
    globalThis.fetch = mockFetch(async () => new Response("not JSON"));

    await expect(
      getSharedIssue("https://sentry.io", "example-org", "share-id")
    ).rejects.toMatchObject({
      name: "ApiError",
      message: expect.stringContaining("invalid JSON"),
    });
  });

  test("preserves body read errors", async () => {
    const error = new TypeError("Response stream interrupted");
    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          })
        )
    );

    await expect(
      getSharedIssue("https://sentry.io", "example-org", "share-id")
    ).rejects.toBe(error);
  });

  test.each([
    [404, "Share link not found or expired"],
    [503, "Failed to resolve share link"],
  ])("preserves the HTTP %s error", async (status, message) => {
    globalThis.fetch = mockFetch(async () => new Response("", { status }));

    await expect(
      getSharedIssue("https://sentry.io", "example-org", "share-id")
    ).rejects.toMatchObject({ name: "ApiError", status, message });
  });
});
