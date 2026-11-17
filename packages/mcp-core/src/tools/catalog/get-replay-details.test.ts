import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  mswServer,
  organizationFixture,
  replayDetailsFixture,
} from "@sentry/mcp-server-mocks";
import getReplayDetails, {
  getReplayDetailsOutputSchema,
  resolveReplayParams,
} from "./get-replay-details.js";
import { getServerContext } from "../../test-setup.js";
import { assertStructuredOnlyResult } from "../../test-utils/structured-content.js";

type ReplayDetailsParams = Parameters<typeof getReplayDetails.handler>[0];

async function getPayload(
  params: ReplayDetailsParams,
  context = getServerContext(),
) {
  const result = await getReplayDetails.handler(params, context);
  assertStructuredOnlyResult(result);
  return getReplayDetailsOutputSchema.parse(result.structuredContent);
}

function loadedTimeline(
  payload: Pick<
    ReturnType<typeof getReplayDetailsOutputSchema.parse>,
    "timeline"
  >,
) {
  if (payload.timeline.status !== "loaded") {
    throw new Error(`Expected a loaded timeline: ${payload.timeline.reason}`);
  }
  return payload.timeline;
}

describe("get_replay_details", () => {
  const replayEndpoint = `https://us.sentry.io/api/0/organizations/sentry-mcp-evals/replays/${replayDetailsFixture.id}/`;
  const recordingEndpoint = `https://us.sentry.io/api/0/projects/sentry-mcp-evals/${replayDetailsFixture.project_id}/replays/${replayDetailsFixture.id}/recording-segments/`;
  const directParams = {
    organizationSlug: "sentry-mcp-evals",
    replayId: replayDetailsFixture.id,
    regionUrl: "https://us.sentry.io",
  };

  it("loads replay details from replayUrl", async () => {
    const payload = await getPayload({
      replayUrl: `https://sentry-mcp-evals.sentry.io/explore/replays/${replayDetailsFixture.id}/`,
    });

    expect(payload).toMatchInlineSnapshot(`
      {
        "related": {
          "issues": [
            {
              "eventId": "7ca573c0f4814912aaa9bdc77d1a7d51",
              "shortId": "CLOUDFLARE-MCP-41",
              "title": "Error: Tool list_organizations is already registered",
            },
          ],
          "traces": [
            {
              "spanCount": 112,
              "traceId": "a4d1aae7216b47ff8117cf4e09ce9d0a",
            },
          ],
        },
        "replay": {
          "archived": false,
          "browser": "Chrome 123.0",
          "counts": {
            "deadClicks": 1,
            "errors": 1,
            "infos": 3,
            "rageClicks": 0,
            "segments": 2,
            "warnings": 2,
          },
          "device": "MacBook Pro",
          "durationSeconds": 300,
          "environment": "production",
          "id": "7e07485f-12f9-416b-8b14-26260799b51f",
          "organizationSlug": "sentry-mcp-evals",
          "os": "macOS 14.4",
          "release": "frontend@1.2.3",
          "replayType": null,
          "startedAt": "2025-04-07T12:00:00.000Z",
          "url": "https://sentry-mcp-evals.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/",
          "urls": [
            "/login",
            "/checkout",
          ],
          "user": {
            "email": "taylor@example.com",
            "geo": {
              "city": "Vienna",
              "countryCode": "AT",
              "region": "Austria",
              "subdivision": "Vienna",
            },
            "id": "user-1",
            "ip": "203.0.113.42",
            "username": "taylor",
          },
          "viewed": null,
        },
        "suggestedActions": [
          {
            "arguments": {
              "issueId": "CLOUDFLARE-MCP-41",
              "organizationSlug": "sentry-mcp-evals",
            },
            "reason": "Inspect the issue for an error seen in this replay.",
            "toolName": "get_issue_details",
            "type": "tool_call",
          },
          {
            "arguments": {
              "organizationSlug": "sentry-mcp-evals",
              "traceId": "a4d1aae7216b47ff8117cf4e09ce9d0a",
            },
            "reason": "Inspect a trace recorded during this replay.",
            "toolName": "get_trace_details",
            "type": "tool_call",
          },
        ],
        "timeline": {
          "categories": null,
          "endOffsetSeconds": null,
          "events": [
            {
              "details": {},
              "label": "page load",
              "offsetSeconds": 0.1,
              "target": "https://example.com/login",
            },
            {
              "details": {
                "text": "Sign in",
              },
              "label": "click",
              "offsetSeconds": 10,
              "target": "form.login > button#sign-in",
            },
            {
              "details": {},
              "label": "navigation",
              "offsetSeconds": 12,
              "target": "https://example.com/checkout",
            },
            {
              "details": {
                "duration": "812ms",
                "status": "500",
              },
              "label": "request",
              "offsetSeconds": 290,
              "target": "POST https://example.com/api/orders",
            },
            {
              "details": {},
              "label": "console.error",
              "offsetSeconds": 290.9,
              "target": "Payment request failed",
            },
            {
              "details": {
                "no response after": "7.0s",
                "text": "Place order",
              },
              "label": "dead click",
              "offsetSeconds": 292,
              "target": "div.modal > button.place-order",
            },
            {
              "details": {
                "key": "Escape",
              },
              "label": "key",
              "offsetSeconds": 298.5,
              "target": "div.modal",
            },
            {
              "details": {},
              "label": "dialog",
              "offsetSeconds": 298.6,
              "target": "Checkout dialog closed",
            },
          ],
          "failedRequests": 1,
          "matchingCount": 8,
          "nextSkip": null,
          "recorded": {
            "click": {
              "click": 1,
              "dead click": 1,
            },
            "console": {
              "console.error": 1,
              "console.log": 1,
            },
            "input": {
              "key": 1,
            },
            "navigation": {
              "navigation": 1,
              "page load": 1,
            },
            "network": {
              "request": 2,
            },
            "other": {
              "dialog": 1,
            },
          },
          "segmentsRead": 2,
          "skip": 0,
          "startOffsetSeconds": null,
          "status": "loaded",
          "truncated": false,
        },
      }
    `);
  });

  it("shows unresolved error events by event ID", async () => {
    mswServer.use(
      http.get(
        replayEndpoint,
        () =>
          HttpResponse.json({
            data: {
              ...replayDetailsFixture,
              error_ids: ["replay-only-event-id"],
            },
          }),
        { once: true },
      ),
    );

    const payload = await getPayload(directParams);

    expect(payload.related.issues).toEqual([
      { eventId: "replay-only-event-id", shortId: null, title: null },
    ]);
    // Event lookups go through the same issue search, so none is suggested.
    expect(payload.suggestedActions.map((action) => action.toolName)).toEqual([
      "get_trace_details",
    ]);
  });

  it("handles archived replays", async () => {
    mswServer.use(
      http.get(
        replayEndpoint,
        () =>
          HttpResponse.json({
            data: { ...replayDetailsFixture, is_archived: true },
          }),
        { once: true },
      ),
    );

    const payload = await getPayload(directParams);

    expect(payload.replay.archived).toBe(true);
    expect(payload.timeline).toEqual({
      status: "unavailable",
      reason: "Recording is archived and not available for playback.",
    });
    expect(payload.related.issues).toHaveLength(1);
  });

  it("reports when the recording cannot be loaded", async () => {
    mswServer.use(
      http.get(
        recordingEndpoint,
        () =>
          HttpResponse.json(
            { detail: "Replay recording segment not found." },
            { status: 404 },
          ),
        { once: true },
      ),
    );

    const payload = await getPayload(directParams);

    expect(payload.timeline).toEqual({
      status: "unavailable",
      reason:
        "The recording could not be loaded: Replay recording segment not found.",
    });
    expect(payload.replay.archived).toBe(false);
  });

  it("maps stored user fields and leaves out tags, SDK, and recording internals", async () => {
    mswServer.use(
      http.get(
        replayEndpoint,
        () =>
          HttpResponse.json({
            data: {
              ...replayDetailsFixture,
              dist: "dist-leak-42",
              info_ids: ["info-leak-event-id"],
              warning_ids: ["warning-leak-event-id"],
              tags: { "leak.tag": ["tag-leak-value"] },
              user: {
                display_name: "display-name-mix",
                email: "taylor@example.com",
                id: "user-1",
                ip: "203.0.113.77",
                username: "taylor-username",
                geo: { city: "Graz", country_code: "AT" },
              },
            },
          }),
        { once: true },
      ),
      http.get(
        recordingEndpoint,
        () =>
          HttpResponse.json([
            [
              {
                type: 5,
                timestamp: 1744027290000,
                data: {
                  tag: "performanceSpan",
                  payload: {
                    op: "resource.fetch",
                    description: "https://example.com/api/orders",
                    startTimestamp: 1744027290,
                    endTimestamp: 1744027290.5,
                    data: {
                      method: "POST",
                      statusCode: 500,
                      request: {
                        headers: { authorization: "Bearer leak-token-123" },
                        body: { cardNumber: "4111111111111111" },
                      },
                      response: { body: "leak-response-body" },
                    },
                  },
                },
              },
              {
                type: 5,
                timestamp: 1744027291000,
                data: {
                  tag: "breadcrumb",
                  payload: {
                    timestamp: 1744027291,
                    category: "console",
                    level: "error",
                    message: "Payment failed",
                    data: { arguments: ["leak-console-argument"] },
                  },
                },
              },
            ],
          ]),
        { once: true },
      ),
    );

    const result = await getReplayDetails.handler(
      directParams,
      getServerContext(),
    );
    const serialized = JSON.stringify(result);
    // suggestedActions has its own `arguments` key, so check product keys
    // without it.
    const { suggestedActions: _actions, ...product } =
      getReplayDetailsOutputSchema.parse(result.structuredContent);
    const serializedProduct = JSON.stringify(product);

    expect(product.replay.user).toEqual({
      id: "user-1",
      username: "taylor-username",
      email: "taylor@example.com",
      ip: "203.0.113.77",
      geo: {
        city: "Graz",
        countryCode: "AT",
        region: null,
        subdivision: null,
      },
    });
    for (const leaked of [
      "display-name-mix",
      "dist-leak-42",
      "info-leak-event-id",
      "warning-leak-event-id",
      "tag-leak-value",
      "@sentry/browser",
      "leak-token-123",
      "4111111111111111",
      "leak-response-body",
      "leak-console-argument",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    for (const key of [
      "display_name",
      "name",
      "country_code",
      "tags",
      "sdk",
      "platform",
      "project_id",
      "error_ids",
      "trace_ids",
      "response",
      "headers",
      "body",
      "arguments",
      "nodeId",
      "notable",
      "problem",
      "timestampMs",
    ]) {
      expect(serializedProduct).not.toContain(`"${key}":`);
    }
    expect(loadedTimeline(product).events).toEqual([
      {
        offsetSeconds: 90,
        label: "request",
        target: "POST https://example.com/api/orders",
        details: { status: "500", duration: "500ms" },
      },
      {
        offsetSeconds: 91,
        label: "console.error",
        target: "Payment failed",
        details: {},
      },
    ]);
  });

  it("returns a null user for archived replays", async () => {
    mswServer.use(
      http.get(
        replayEndpoint,
        () =>
          HttpResponse.json({
            data: {
              ...replayDetailsFixture,
              is_archived: true,
              user: { id: "Archived Replay", display_name: "Archived Replay" },
            },
          }),
        { once: true },
      ),
    );

    const payload = await getPayload(directParams);

    expect(payload.replay.user).toBeNull();
  });

  it.each([
    {
      name: "null columns",
      user: {
        id: null,
        username: null,
        email: null,
        ip: null,
        display_name: null,
        geo: {
          city: null,
          country_code: null,
          region: null,
          subdivision: null,
        },
      },
    },
    {
      name: "empty Snuba columns",
      user: {
        id: "",
        username: "",
        email: "",
        ip: "",
        display_name: "",
        geo: { city: "", country_code: "", region: "", subdivision: "" },
      },
    },
  ])(
    "returns a null user for anonymous replays with $name",
    async ({ user }) => {
      mswServer.use(
        http.get(
          replayEndpoint,
          () => HttpResponse.json({ data: { ...replayDetailsFixture, user } }),
          { once: true },
        ),
      );

      const payload = await getPayload(directParams);

      expect(payload.replay.user).toBeNull();
    },
  );

  it("returns a null geo when every geo column is empty", async () => {
    mswServer.use(
      http.get(
        replayEndpoint,
        () =>
          HttpResponse.json({
            data: {
              ...replayDetailsFixture,
              user: {
                id: "user-1",
                username: "",
                email: "taylor@example.com",
                ip: "",
                display_name: "taylor@example.com",
                geo: {
                  city: "",
                  country_code: "",
                  region: "",
                  subdivision: "",
                },
              },
            },
          }),
        { once: true },
      ),
    );

    const payload = await getPayload(directParams);

    expect(payload.replay.user).toEqual({
      id: "user-1",
      username: null,
      email: "taylor@example.com",
      ip: null,
      geo: null,
    });
  });

  it("throws for invalid direct input", async () => {
    await expect(
      getReplayDetails.handler({}, getServerContext()),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[UserInputError: Provide either \`replayUrl\` or both \`organizationSlug\` and \`replayId\`.]`,
    );
  });

  it("rejects replay URLs outside the active organization constraint", () => {
    expect(() =>
      resolveReplayParams({
        replayUrl: `https://url-org.sentry.io/replays/${replayDetailsFixture.id}/`,
        organizationSlug: "constrained-org",
      }),
    ).toThrow(
      'Replay URL is outside the active organization constraint. Expected organization "constrained-org" but got "url-org".',
    );
  });

  it("rejects replays outside the active project constraint", async () => {
    mswServer.use(
      http.get(
        "https://us.sentry.io/api/0/projects/sentry-mcp-evals/frontend/",
        () =>
          HttpResponse.json({
            id: "9999999999999999",
            slug: "frontend",
            name: "frontend",
          }),
        { once: true },
      ),
    );

    await expect(
      getReplayDetails.handler(
        directParams,
        getServerContext({
          constraints: {
            projectSlug: "frontend",
          },
        }),
      ),
    ).rejects.toThrow(
      'Replay is outside the active project constraint. Expected project "frontend".',
    );
  });

  it("uses the constrained regionUrl for replay endpoints", async () => {
    mswServer.use(
      http.get(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/replays/${replayDetailsFixture.id}/`,
        () => HttpResponse.json({ detail: "wrong host" }, { status: 404 }),
        { once: true },
      ),
      http.get(recordingEndpoint, () => HttpResponse.json([]), { once: true }),
    );

    const payload = await getPayload(
      {
        organizationSlug: "sentry-mcp-evals",
        replayId: replayDetailsFixture.id,
      },
      getServerContext({
        constraints: { regionUrl: "https://us.sentry.io" },
      }),
    );

    expect(payload.replay.id).toBe(replayDetailsFixture.id);
  });

  it("resolves the organization region when none is provided", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/",
        () =>
          HttpResponse.json({
            ...organizationFixture,
            links: {
              ...organizationFixture.links,
              regionUrl: "https://us.sentry.io",
            },
          }),
        { once: true },
      ),
      http.get(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/replays/${replayDetailsFixture.id}/`,
        () => HttpResponse.json({ detail: "wrong host" }, { status: 404 }),
        { once: true },
      ),
      http.get(recordingEndpoint, () => HttpResponse.json([]), { once: true }),
    );

    const payload = await getPayload({
      organizationSlug: "sentry-mcp-evals",
      replayId: replayDetailsFixture.id,
    });

    expect(payload.replay.id).toBe(replayDetailsFixture.id);
    expect(loadedTimeline(payload).recorded).toEqual({});
  });

  it("shows the last seconds of a replay with negative offsets", async () => {
    const payload = await getPayload({
      ...directParams,
      startOffsetSeconds: -10,
    });

    expect(loadedTimeline(payload)).toMatchInlineSnapshot(`
      {
        "categories": null,
        "endOffsetSeconds": null,
        "events": [
          {
            "details": {
              "duration": "812ms",
              "status": "500",
            },
            "label": "request",
            "offsetSeconds": 290,
            "target": "POST https://example.com/api/orders",
          },
          {
            "details": {},
            "label": "console.error",
            "offsetSeconds": 290.9,
            "target": "Payment request failed",
          },
          {
            "details": {
              "no response after": "7.0s",
              "text": "Place order",
            },
            "label": "dead click",
            "offsetSeconds": 292,
            "target": "div.modal > button.place-order",
          },
          {
            "details": {
              "key": "Escape",
            },
            "label": "key",
            "offsetSeconds": 298.5,
            "target": "div.modal",
          },
          {
            "details": {},
            "label": "dialog",
            "offsetSeconds": 298.6,
            "target": "Checkout dialog closed",
          },
        ],
        "failedRequests": 1,
        "matchingCount": 5,
        "nextSkip": null,
        "recorded": {
          "click": {
            "click": 1,
            "dead click": 1,
          },
          "console": {
            "console.error": 1,
            "console.log": 1,
          },
          "input": {
            "key": 1,
          },
          "navigation": {
            "navigation": 1,
            "page load": 1,
          },
          "network": {
            "request": 2,
          },
          "other": {
            "dialog": 1,
          },
        },
        "segmentsRead": 2,
        "skip": 0,
        "startOffsetSeconds": 290,
        "status": "loaded",
        "truncated": false,
      }
    `);
  });

  it("shows every event in a requested category", async () => {
    const timeline = loadedTimeline(
      await getPayload({ ...directParams, categories: ["network", "console"] }),
    );

    expect(timeline.categories).toEqual(["network", "console"]);
    expect(timeline.events).toContainEqual(
      expect.objectContaining({
        label: "request",
        target: "GET https://example.com/api/cart",
      }),
    );
    expect(timeline.events).toContainEqual(
      expect.objectContaining({
        label: "console.log",
        target: "cart refreshed",
      }),
    );
    expect(timeline.events.map((event) => event.label)).not.toContain("click");
  });

  it("suggests how to continue when more events match than the limit", async () => {
    const payload = await getPayload({
      ...directParams,
      categories: ["click", "network"],
      startOffsetSeconds: 0,
      limit: 2,
    });
    const timeline = loadedTimeline(payload);

    expect(timeline.events).toHaveLength(2);
    expect(timeline.matchingCount).toBe(4);
    expect(timeline.nextSkip).toBe(2);
    expect(payload.suggestedActions[0]).toEqual({
      type: "tool_call",
      toolName: "get_replay_details",
      arguments: {
        organizationSlug: "sentry-mcp-evals",
        replayId: replayDetailsFixture.id,
        regionUrl: "https://us.sentry.io",
        categories: ["click", "network"],
        startOffsetSeconds: 0,
        limit: 2,
        skip: 2,
      },
      reason: "Show the next matching timeline events; 2 remain.",
    });
  });

  it("leaves regionUrl out of the continuation when the caller did not pass it", async () => {
    const payload = await getPayload(
      {
        organizationSlug: "sentry-mcp-evals",
        replayId: replayDetailsFixture.id,
        limit: 2,
      },
      getServerContext({
        constraints: { regionUrl: "https://us.sentry.io" },
      }),
    );

    expect(payload.suggestedActions[0]).toMatchObject({
      toolName: "get_replay_details",
      arguments: { skip: 2 },
    });
    expect(payload.suggestedActions[0]?.arguments).not.toHaveProperty(
      "regionUrl",
    );
  });

  it("continues from the skip value without repeating events", async () => {
    const firstPage = loadedTimeline(
      await getPayload({ ...directParams, limit: 2 }),
    );
    const secondPage = loadedTimeline(
      await getPayload({ ...directParams, limit: 2, skip: 2 }),
    );

    expect(firstPage.matchingCount).toBe(8);
    expect(secondPage.skip).toBe(2);
    expect(secondPage.nextSkip).toBe(4);
    expect(secondPage.events).toHaveLength(2);
    for (const event of secondPage.events) {
      expect(firstPage.events).not.toContainEqual(event);
    }
  });

  it("only suggests tools that are available in the session", async () => {
    const payload = await getPayload(
      { ...directParams, limit: 2 },
      getServerContext({
        availableToolNames: new Set(["get_sentry_resource"]),
        directToolNames: new Set(["get_sentry_resource"]),
      }),
    );

    expect(loadedTimeline(payload).nextSkip).toBe(2);
    expect(payload.suggestedActions).toEqual([]);
  });

  it("rejects windows that end before they start", async () => {
    await expect(
      getReplayDetails.handler(
        { ...directParams, startOffsetSeconds: 60, endOffsetSeconds: 30 },
        getServerContext(),
      ),
    ).rejects.toThrow(
      "`startOffsetSeconds` must resolve to a time before `endOffsetSeconds`.",
    );
  });

  it("ignores malformed recording events", async () => {
    mswServer.use(
      http.get(
        recordingEndpoint,
        () =>
          HttpResponse.json([
            [
              { type: 5, data: { tag: "breadcrumb", payload: ["alpha"] } },
              {
                type: 5,
                timestamp: "invalid",
                data: {
                  tag: "breadcrumb",
                  payload: { category: "ui.click", message: "button" },
                },
              },
              "not an event",
              {
                type: 5,
                timestamp: 1744027205000,
                data: {
                  tag: "breadcrumb",
                  payload: {
                    category: "ui.click",
                    message: "button.ok",
                    data: { node: { textContent: 42 } },
                  },
                },
              },
            ],
          ]),
        { once: true },
      ),
    );

    const timeline = loadedTimeline(await getPayload(directParams));

    expect(timeline.recorded).toEqual({ click: { click: 1 } });
    expect(timeline.events).toEqual([
      { offsetSeconds: 5, label: "click", target: "button.ok", details: {} },
    ]);
  });

  describe("tool definition", () => {
    it("requires the replay read scopes used by the backend endpoints", () => {
      expect(getReplayDetails.requiredScopes).toEqual([
        "org:read",
        "project:read",
        "event:read",
      ]);
    });

    it("accepts regionUrl so constrained sessions can inject it", () => {
      expect(Object.keys(getReplayDetails.inputSchema)).toEqual([
        "replayUrl",
        "organizationSlug",
        "replayId",
        "regionUrl",
        "categories",
        "startOffsetSeconds",
        "endOffsetSeconds",
        "limit",
        "skip",
      ]);
    });
  });
});
