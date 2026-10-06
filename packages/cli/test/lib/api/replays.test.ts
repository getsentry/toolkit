/**
 * Tests for the replay API helpers.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_PAGINATION_PAGES } from "../../../src/lib/api/infrastructure.js";
import {
  getReplay,
  getReplayRecordingSegments,
  listReplayIdsForIssue,
  listReplays,
  resolveReplay,
} from "../../../src/lib/api/replays.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ApiError } from "../../../src/lib/errors.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("replays-api-test-");

const REPLAY_ID = "346789a703f6454384f1de473b8b9fcc";

function replayRow(id = REPLAY_ID) {
  return {
    id,
    count_errors: 2,
    count_segments: 4,
    duration: 95,
    started_at: "2025-01-30T14:32:15+00:00",
    user: { display_name: "Test User" },
  };
}

function recordingSegmentsResponse(
  body: unknown,
  nextCursor?: string
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (nextCursor) {
    headers.Link = `<https://sentry.io/api/0/next/>; rel="next"; results="true"; cursor="${nextCursor}"`;
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers,
  });
}

describe("listReplays", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls the organization replay index with repeated field params", async () => {
    let capturedUrl = "";

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      return new Response(JSON.stringify({ data: [replayRow()] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Link: `<https://sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:25:0"`,
        },
      });
    });

    const result = await listReplays("test-org", {
      limit: 25,
      projectSlugs: ["cli"],
      query: "count_errors:>0",
      sort: "-count_errors",
      statsPeriod: "24h",
    });

    const url = new URL(capturedUrl);
    expect(url.pathname).toContain("/api/0/organizations/test-org/replays/");
    expect(url.searchParams.get("projectSlug")).toBe("cli");
    expect(url.searchParams.get("query")).toBe("count_errors:>0");
    expect(url.searchParams.get("sort")).toBe("-count_errors");
    expect(url.searchParams.get("statsPeriod")).toBe("24h");
    expect(url.searchParams.get("per_page")).toBe("25");
    expect(url.searchParams.getAll("field")).toContain("id");
    expect(url.searchParams.getAll("field")).toContain("user");
    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBe("0:25:0");
  });

  test("passes replay environment filters and custom field selection", async () => {
    let capturedUrl = "";

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      return new Response(JSON.stringify({ data: [replayRow()] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await listReplays("test-org", {
      environment: ["production", "canary"],
      fields: ["id", "user", "urls"],
      limit: 10,
      sort: "-count_rage_clicks",
    });

    const url = new URL(capturedUrl);
    expect(url.searchParams.getAll("environment")).toEqual([
      "production",
      "canary",
    ]);
    expect(url.searchParams.getAll("field")).toEqual(["id", "user", "urls"]);
    expect(url.searchParams.get("sort")).toBe("-count_rage_clicks");
  });

  test("auto-paginates when limit exceeds the API cap", async () => {
    const capturedUrls: string[] = [];
    let callIndex = 0;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);

      const body =
        callIndex === 0
          ? {
              data: Array.from({ length: 100 }, (_, index) =>
                replayRow(index.toString(16).padStart(32, "a").slice(-32))
              ),
            }
          : {
              data: Array.from({ length: 50 }, (_, index) =>
                replayRow(index.toString(16).padStart(32, "b").slice(-32))
              ),
            };
      const headers =
        callIndex === 0
          ? {
              Link: `<https://sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:100:0"`,
            }
          : {
              Link: `<https://sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
            };
      callIndex += 1;

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json", ...headers },
      });
    });

    const result = await listReplays("test-org", { limit: 150 });

    expect(result.data).toHaveLength(150);
    expect(result.nextCursor).toBeUndefined();
    expect(capturedUrls).toHaveLength(2);
    expect(capturedUrls[0]).toContain("per_page=100");
    expect(capturedUrls[1]).toContain("per_page=50");
  });
});

describe("getReplay", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls the replay detail endpoint", async () => {
    let capturedUrl = "";

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      return new Response(JSON.stringify({ data: replayRow() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const replay = await getReplay("test-org", REPLAY_ID);

    expect(capturedUrl).toContain(
      `/api/0/organizations/test-org/replays/${REPLAY_ID}/`
    );
    expect(replay.id).toBe(REPLAY_ID);
    expect(replay.count_errors).toBe(2);
  });

  test("normalizes archived replay payload oddities", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              ...replayRow(),
              error_ids: undefined,
              info_ids: undefined,
              project_id: 42,
              releases: null,
              tags: [],
              trace_ids: undefined,
              urls: null,
              warning_ids: undefined,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
    );

    const replay = await getReplay("test-org", REPLAY_ID);

    expect(replay.project_id).toBe("42");
    expect(replay.tags).toEqual({});
    expect(replay.releases).toEqual([]);
    expect(replay.urls).toEqual([]);
    expect(replay.error_ids).toEqual([]);
    expect(replay.info_ids).toEqual([]);
    expect(replay.trace_ids).toEqual([]);
    expect(replay.warning_ids).toEqual([]);
  });
});

describe("resolveReplay", () => {
  let originalFetch: typeof globalThis.fetch;
  const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  test("returns the replay when the detail endpoint hits", async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);
      return jsonResponse({ data: replayRow() });
    });

    const replay = await resolveReplay("test-org", REPLAY_ID);

    expect(replay.id).toBe(REPLAY_ID);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain(
      `/api/0/organizations/test-org/replays/${REPLAY_ID}/`
    );
  });

  test("falls back to a linked trace search after a 404", async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);
      const url = new URL(req.url);

      if (url.pathname.endsWith(`/replays/${TRACE_ID}/`)) {
        return jsonResponse({ detail: "Not Found" }, 404);
      }
      if (url.pathname.endsWith(`/replays/${REPLAY_ID}/`)) {
        return jsonResponse({ data: replayRow() });
      }
      if (url.pathname.endsWith("/replays/")) {
        return jsonResponse({ data: [replayRow()] });
      }
      throw new Error(`unexpected request ${req.url}`);
    });

    const replay = await resolveReplay("test-org", TRACE_ID, {
      projectSlugs: ["javascript"],
    });

    expect(replay.id).toBe(REPLAY_ID);
    expect(capturedUrls).toHaveLength(3);

    const listUrl = new URL(capturedUrls[1]!);
    expect(listUrl.pathname).toContain(
      "/api/0/organizations/test-org/replays/"
    );
    expect(listUrl.searchParams.get("query")).toBe(`trace:${TRACE_ID}`);
    expect(listUrl.searchParams.get("statsPeriod")).toBe("90d");
    expect(listUrl.searchParams.get("per_page")).toBe("1");
    expect(listUrl.searchParams.get("sort")).toBe("-started_at");
    expect(listUrl.searchParams.get("projectSlug")).toBe("javascript");
    expect(listUrl.searchParams.get("project")).toBeNull();
  });

  test("rethrows the original 404 when no replay is linked to the id", async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);
      const url = new URL(req.url);

      if (url.pathname.endsWith(`/replays/${TRACE_ID}/`)) {
        return jsonResponse({ detail: "Replay not found" }, 404);
      }
      if (url.pathname.endsWith("/replays/")) {
        return jsonResponse({ data: [] });
      }
      throw new Error(`unexpected request ${req.url}`);
    });

    await expect(resolveReplay("test-org", TRACE_ID)).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      detail: "Replay not found",
    });

    const listUrl = new URL(capturedUrls[1]!);
    expect(listUrl.searchParams.get("query")).toBe(`trace:${TRACE_ID}`);
    expect(listUrl.searchParams.get("project")).toBe("-1");
    expect(listUrl.searchParams.get("projectSlug")).toBeNull();
  });

  test("does not search by trace when the detail endpoint fails with a non-404", async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);
      return jsonResponse({ detail: "Bad Request" }, 400);
    });

    await expect(resolveReplay("test-org", TRACE_ID)).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
    });
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain(`/replays/${TRACE_ID}/`);
  });
});

describe("getReplayRecordingSegments", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls the project replay recording-segments endpoint", async () => {
    let capturedUrl = "";

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      return recordingSegmentsResponse([[{ timestamp: 1 }]]);
    });

    const segments = await getReplayRecordingSegments(
      "test-org",
      "42",
      REPLAY_ID
    );

    const url = new URL(capturedUrl);
    expect(url.pathname).toContain(
      `/api/0/projects/test-org/42/replays/${REPLAY_ID}/recording-segments/`
    );
    expect(url.searchParams.get("download")).toBeNull();
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(segments).toEqual([[{ timestamp: 1 }]]);
  });

  test("rejects non-object recording events at the API boundary", async () => {
    globalThis.fetch = mockFetch(async () =>
      recordingSegmentsResponse([[null]])
    );

    await expect(
      getReplayRecordingSegments("test-org", "42", REPLAY_ID)
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("auto-paginates recording segments using the link cursor", async () => {
    const capturedUrls: string[] = [];
    let callIndex = 0;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);

      const body =
        callIndex === 0
          ? Array.from({ length: 100 }, (_, index) => [{ segment: index }])
          : [[{ segment: 100 }]];
      const nextCursor = callIndex === 0 ? "0:100:0" : undefined;
      callIndex += 1;

      return recordingSegmentsResponse(body, nextCursor);
    });

    const segments = await getReplayRecordingSegments(
      "test-org",
      "42",
      REPLAY_ID,
      { expectedSegments: 101 }
    );

    expect(segments).toHaveLength(101);
    expect(capturedUrls).toHaveLength(2);

    const firstUrl = new URL(capturedUrls[0]!);
    expect(firstUrl.searchParams.get("per_page")).toBe("100");
    expect(firstUrl.searchParams.get("cursor")).toBeNull();

    const secondUrl = new URL(capturedUrls[1]!);
    expect(secondUrl.searchParams.get("cursor")).toBe("0:100:0");
    expect(secondUrl.searchParams.get("per_page")).toBe("100");
  });

  test("stops recording segment pagination at the safety cap and warns", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const capturedUrls: string[] = [];
    let callIndex = 0;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);

      const nextCursor = `0:${(callIndex + 1) * 100}:0`;
      const body = [[{ segment: callIndex }]];
      callIndex += 1;

      return recordingSegmentsResponse(body, nextCursor);
    });

    const segments = await getReplayRecordingSegments(
      "test-org",
      "42",
      REPLAY_ID
    );

    expect(segments).toHaveLength(MAX_PAGINATION_PAGES);
    expect(capturedUrls).toHaveLength(MAX_PAGINATION_PAGES);

    const finalUrl = new URL(capturedUrls.at(-1)!);
    expect(finalUrl.searchParams.get("cursor")).toBe(
      `0:${(MAX_PAGINATION_PAGES - 1) * 100}:0`
    );

    const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();
    expect(stderr).toContain("Pagination limit reached");
  });
});

describe("listReplayIdsForIssue", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls the replay-count endpoint with the issue query", async () => {
    let capturedUrl = "";

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      return new Response(
        JSON.stringify({
          "12345": [
            "346789a703f6454384f1de473b8b9fcc",
            "aaaaaaaa03f6454384f1de473b8b9fcc",
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    const replayIds = await listReplayIdsForIssue("test-org", "12345");
    const url = new URL(capturedUrl);

    expect(url.pathname).toContain(
      "/api/0/organizations/test-org/replay-count/"
    );
    expect(url.searchParams.get("returnIds")).toBe("true");
    expect(url.searchParams.get("query")).toBe("issue.id:[12345]");
    expect(url.searchParams.get("data_source")).toBe("events");
    expect(url.searchParams.get("statsPeriod")).toBe("90d");
    expect(url.searchParams.getAll("project")).toEqual(["-1"]);
    expect(replayIds).toEqual([
      "346789a703f6454384f1de473b8b9fcc",
      "aaaaaaaa03f6454384f1de473b8b9fcc",
    ]);
  });
});
