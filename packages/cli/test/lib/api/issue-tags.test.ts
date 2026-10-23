/**
 * Issue tag API integration tests using the real SDK and intercepted fetch.
 * Fixtures follow Sentry's GroupTagDetailsTest and TagKeySerializer contract.
 */

import type { GetOrganizationIssueTagResponse } from "@sentry/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getIssueTag } from "../../../src/lib/api/issue-tags.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../../helpers.js";

const TAG_DISTRIBUTION: GetOrganizationIssueTagResponse = {
  key: "release",
  name: "Release",
  uniqueValues: 2,
  totalValues: 3,
  topValues: [
    {
      key: "release",
      name: "1.2.0",
      value: "1.2.0",
      count: 2,
      firstSeen: "2026-10-15T00:00:00Z",
      lastSeen: "2026-10-21T00:00:00Z",
    },
    {
      key: "release",
      name: "",
      value: "",
      count: 1,
      firstSeen: "2026-10-16T00:00:00Z",
      lastSeen: "2026-10-20T00:00:00Z",
    },
  ],
};

describe("getIssueTag", () => {
  useTestConfigDir("api-issue-tags-");
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
    setAuthToken("test-token");
    setOrgRegion("test-org", "https://de.sentry.io");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("retrieves the full distribution from the org's region with an encoded key", async () => {
    let request: Request | undefined;
    globalThis.fetch = mockFetch(async (input, init) => {
      request = new Request(input, init);
      return Response.json(TAG_DISTRIBUTION);
    });

    const result = await getIssueTag("test-org", "12345", "sentry:release");

    expect(result).toEqual(TAG_DISTRIBUTION);
    expect(request?.url).toBe(
      "https://de.sentry.io/api/0/organizations/test-org/issues/12345/tags/sentry%3Arelease/",
    );
    expect(request?.method).toBe("GET");
    expect(request?.headers.get("Authorization")).toBe("Bearer test-token");
  });

  test("sends exactly one literal environment filter", async () => {
    let request: Request | undefined;
    globalThis.fetch = mockFetch(async (input, init) => {
      request = new Request(input, init);
      return Response.json(TAG_DISTRIBUTION);
    });

    await getIssueTag("test-org", "12345", "release", "qa/blue&green");

    expect(new URL(request!.url).searchParams.getAll("environment")).toEqual([
      "qa/blue&green",
    ]);
  });

  test.each<GetOrganizationIssueTagResponse>([
    { key: "release", name: "Release" },
    {
      key: "release",
      name: "Release",
      uniqueValues: null,
      totalValues: null,
      topValues: null,
    },
    {
      key: "user",
      name: "User",
      totalValues: 3,
      topValues: [
        {
          key: "user",
          name: "user-123",
          value: "id:user-123",
          count: null,
          firstSeen: null,
          lastSeen: null,
          query: 'user.id:"user-123"',
        },
      ],
    },
  ])(
    "preserves optional fields, nulls, and backend user queries: %j",
    async (body) => {
      globalThis.fetch = mockFetch(async () => Response.json(body));

      expect(await getIssueTag("test-org", "12345", body.key)).toEqual(body);
    },
  );

  test("preserves a missing issue, tag, or environment response as an API error", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(
        { detail: "The requested resource does not exist" },
        { status: 404 },
      ),
    );

    await expect(
      getIssueTag("test-org", "12345", "missing"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });
});
