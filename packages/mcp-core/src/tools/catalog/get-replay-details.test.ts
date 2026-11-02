import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  mswServer,
  organizationFixture,
  replayDetailsFixture,
} from "@sentry/mcp-server-mocks";
import getReplayDetails, { resolveReplayParams } from "./get-replay-details.js";
import { getServerContext } from "../../test-setup.js";

describe("get_replay_details", () => {
  it("loads replay details from replayUrl", async () => {
    const result = await getReplayDetails.handler(
      {
        replayUrl: `https://sentry-mcp-evals.sentry.io/explore/replays/${replayDetailsFixture.id}/`,
      },
      getServerContext(),
    );

    expect(result).toMatchInlineSnapshot(`
      "# Replay 7e07485f-12f9-416b-8b14-26260799b51f in **sentry-mcp-evals**

      ## Summary

      - **Replay URL**: https://sentry-mcp-evals.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/
      - **Started**: 2025-04-07 12:00:00 UTC
      - **Duration**: 5m
      - **Environment**: production
      - **Browser**: Chrome 123.0
      - **OS**: macOS 14.4
      - **User**: Taylor Example (id \`user-1\`)
      - **URLs**: /login, /checkout
      - **Device**: MacBook Pro
      - **Release**: frontend@1.2.3
      - **Errors**: 1
      - **Rage Clicks**: 0
      - **Dead Clicks**: 1
      - **Warnings**: 2
      - **Infos**: 3
      - **Recording Segments**: 2
      - **Archived**: No

      ## Timeline

      **Recorded**: 1 × page load · 1 × click · 1 × navigation · 2 × request (1 failed) · 1 × console.error · 1 × console.log · 1 × dead click · 1 × key · 1 × dialog
      **Showing**: notable events · 8 of 8 events

      - 00:00.1 · **page load** · \`https://example.com/login\`
      - 00:10.0 · **click** · \`form.login > button#sign-in\` · text: \`Sign in\`
      - 00:12.0 · **navigation** · \`https://example.com/checkout\`
      - 04:50.0 · **request** · \`POST https://example.com/api/orders\` · status: \`500\` · duration: \`812ms\`
      - 04:50.9 · **console.error** · \`Payment request failed\`
      - 04:52.0 · **dead click** · \`div.modal > button.place-order\` · text: \`Place order\` · no response after: \`7.0s\`
      - 04:58.5 · **key** · \`div.modal\` · key: \`Escape\`
      - 04:58.6 · **dialog** · \`Checkout dialog closed\`

      ## Related

      - **CLOUDFLARE-MCP-41**: Error: Tool list_organizations is already registered
      - Trace \`a4d1aae7216b47ff8117cf4e09ce9d0a\` (112 spans)

      Use \`get_sentry_resource\` to inspect any issue or trace listed above."
    `);
  });

  it("shows unresolved error events by event ID", async () => {
    const replayWithUnresolvedError = {
      ...replayDetailsFixture,
      error_ids: ["replay-only-event-id"],
    };

    mswServer.use(
      http.get(
        `https://us.sentry.io/api/0/organizations/sentry-mcp-evals/replays/${replayDetailsFixture.id}/`,
        () => HttpResponse.json({ data: replayWithUnresolvedError }),
        { once: true },
      ),
    );

    const result = await getReplayDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        replayId: replayDetailsFixture.id,
        regionUrl: "https://us.sentry.io",
      },
      getServerContext(),
    );

    expect(result).toContain("- Event `replay-only-event-id`");
    expect(result).toContain("Use `get_sentry_resource`");
  });

  it("handles archived replays", async () => {
    const archivedReplay = {
      ...replayDetailsFixture,
      is_archived: true,
    };

    mswServer.use(
      http.get(
        `https://us.sentry.io/api/0/organizations/sentry-mcp-evals/replays/${archivedReplay.id}/`,
        () => HttpResponse.json({ data: archivedReplay }),
        { once: true },
      ),
    );

    const result = await getReplayDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        replayId: archivedReplay.id,
        regionUrl: "https://us.sentry.io",
      },
      getServerContext(),
    );

    expect(result).toMatchInlineSnapshot(`
      "# Replay 7e07485f-12f9-416b-8b14-26260799b51f in **sentry-mcp-evals**

      ## Summary

      - **Replay URL**: https://sentry-mcp-evals.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/
      - **Started**: 2025-04-07 12:00:00 UTC
      - **Duration**: 5m
      - **Environment**: production
      - **Browser**: Chrome 123.0
      - **OS**: macOS 14.4
      - **User**: Taylor Example (id \`user-1\`)
      - **URLs**: /login, /checkout
      - **Device**: MacBook Pro
      - **Release**: frontend@1.2.3
      - **Errors**: 1
      - **Rage Clicks**: 0
      - **Dead Clicks**: 1
      - **Warnings**: 2
      - **Infos**: 3
      - **Recording Segments**: 2
      - **Archived**: Yes

      ## Timeline

      Recording is archived and not available for playback.

      ## Related

      - **CLOUDFLARE-MCP-41**: Error: Tool list_organizations is already registered
      - Trace \`a4d1aae7216b47ff8117cf4e09ce9d0a\` (112 spans)

      Use \`get_sentry_resource\` to inspect any issue or trace listed above."
    `);
  });

  it("reports when the recording cannot be loaded", async () => {
    mswServer.use(
      http.get(
        `https://us.sentry.io/api/0/organizations/sentry-mcp-evals/replays/${replayDetailsFixture.id}/`,
        () => HttpResponse.json({ data: replayDetailsFixture }),
        { once: true },
      ),
      http.get(
        `https://us.sentry.io/api/0/projects/sentry-mcp-evals/${replayDetailsFixture.project_id}/replays/${replayDetailsFixture.id}/recording-segments/`,
        () =>
          HttpResponse.json(
            { detail: "Replay recording segment not found." },
            { status: 404 },
          ),
        { once: true },
      ),
    );

    const result = await getReplayDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        replayId: replayDetailsFixture.id,
        regionUrl: "https://us.sentry.io",
      },
      getServerContext(),
    );

    expect(result).toMatchInlineSnapshot(`
      "# Replay 7e07485f-12f9-416b-8b14-26260799b51f in **sentry-mcp-evals**

      ## Summary

      - **Replay URL**: https://sentry-mcp-evals.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/
      - **Started**: 2025-04-07 12:00:00 UTC
      - **Duration**: 5m
      - **Environment**: production
      - **Browser**: Chrome 123.0
      - **OS**: macOS 14.4
      - **User**: Taylor Example (id \`user-1\`)
      - **URLs**: /login, /checkout
      - **Device**: MacBook Pro
      - **Release**: frontend@1.2.3
      - **Errors**: 1
      - **Rage Clicks**: 0
      - **Dead Clicks**: 1
      - **Warnings**: 2
      - **Infos**: 3
      - **Recording Segments**: 2
      - **Archived**: No

      ## Timeline

      The recording could not be loaded: Replay recording segment not found.

      ## Related

      - **CLOUDFLARE-MCP-41**: Error: Tool list_organizations is already registered
      - Trace \`a4d1aae7216b47ff8117cf4e09ce9d0a\` (112 spans)

      Use \`get_sentry_resource\` to inspect any issue or trace listed above."
    `);
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
        {
          organizationSlug: "sentry-mcp-evals",
          replayId: replayDetailsFixture.id,
          regionUrl: "https://us.sentry.io",
        },
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
      http.get(
        `https://us.sentry.io/api/0/organizations/sentry-mcp-evals/replays/${replayDetailsFixture.id}/`,
        () => HttpResponse.json({ data: replayDetailsFixture }),
        { once: true },
      ),
      http.get(
        `https://us.sentry.io/api/0/projects/sentry-mcp-evals/${replayDetailsFixture.project_id}/replays/${replayDetailsFixture.id}/recording-segments/`,
        () => HttpResponse.json([]),
        { once: true },
      ),
    );

    const result = await getReplayDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        replayId: replayDetailsFixture.id,
      },
      getServerContext({
        constraints: { regionUrl: "https://us.sentry.io" },
      }),
    );

    expect(result).toContain(
      `# Replay ${replayDetailsFixture.id} in **sentry-mcp-evals**`,
    );
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
      http.get(
        `https://us.sentry.io/api/0/organizations/sentry-mcp-evals/replays/${replayDetailsFixture.id}/`,
        () => HttpResponse.json({ data: replayDetailsFixture }),
        { once: true },
      ),
      http.get(
        `https://us.sentry.io/api/0/projects/sentry-mcp-evals/${replayDetailsFixture.project_id}/replays/${replayDetailsFixture.id}/recording-segments/`,
        () => HttpResponse.json([]),
        { once: true },
      ),
    );

    const result = await getReplayDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        replayId: replayDetailsFixture.id,
      },
      getServerContext(),
    );

    expect(result).toContain(
      `# Replay ${replayDetailsFixture.id} in **sentry-mcp-evals**`,
    );
  });

  const directParams = {
    organizationSlug: "sentry-mcp-evals",
    replayId: replayDetailsFixture.id,
    regionUrl: "https://us.sentry.io",
  };

  it("shows the last seconds of a replay with negative offsets", async () => {
    const result = await getReplayDetails.handler(
      { ...directParams, startOffsetSeconds: -10 },
      getServerContext(),
    );

    expect(
      result.slice(result.indexOf("## Timeline"), result.indexOf("## Related")),
    ).toMatchInlineSnapshot(`
      "## Timeline

      **Recorded**: 1 × page load · 1 × click · 1 × navigation · 2 × request (1 failed) · 1 × console.error · 1 × console.log · 1 × dead click · 1 × key · 1 × dialog
      **Showing**: notable events · from 04:50.0 to 05:00.0 · 5 of 5 events

      - 04:50.0 · **request** · \`POST https://example.com/api/orders\` · status: \`500\` · duration: \`812ms\`
      - 04:50.9 · **console.error** · \`Payment request failed\`
      - 04:52.0 · **dead click** · \`div.modal > button.place-order\` · text: \`Place order\` · no response after: \`7.0s\`
      - 04:58.5 · **key** · \`div.modal\` · key: \`Escape\`
      - 04:58.6 · **dialog** · \`Checkout dialog closed\`

      "
    `);
  });

  it("shows every event in a requested category", async () => {
    const result = await getReplayDetails.handler(
      { ...directParams, categories: ["network", "console"] },
      getServerContext(),
    );

    expect(result).toContain(
      "**request** · `GET https://example.com/api/cart`",
    );
    expect(result).toContain("**console.log** · `cart refreshed`");
    expect(result).not.toContain("**click**");
  });

  it("explains how to continue when more events match than the limit", async () => {
    const result = await getReplayDetails.handler(
      { ...directParams, limit: 2 },
      getServerContext(),
    );

    expect(result).toContain("**Showing**: notable events · 2 of 8 events");
    expect(result).toContain(
      "6 more events match. Call `get_replay_details` again with the same arguments and `skip: 2` to continue.",
    );
  });

  it("continues from the skip value without repeating events", async () => {
    const firstPage = await getReplayDetails.handler(
      { ...directParams, limit: 2 },
      getServerContext(),
    );
    const secondPage = await getReplayDetails.handler(
      { ...directParams, limit: 2, skip: 2 },
      getServerContext(),
    );
    const timelineLines = (result: string) =>
      result.split("\n").filter((line) => /^- \d/.test(line));

    expect(secondPage).toContain(
      "**Showing**: notable events · events 3-4 of 8",
    );
    expect(secondPage).toContain(
      "4 more events match. Call `get_replay_details` again with the same arguments and `skip: 4` to continue.",
    );
    expect(timelineLines(secondPage)).toHaveLength(2);
    for (const line of timelineLines(secondPage)) {
      expect(timelineLines(firstPage)).not.toContain(line);
    }
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
        `https://us.sentry.io/api/0/projects/sentry-mcp-evals/${replayDetailsFixture.project_id}/replays/${replayDetailsFixture.id}/recording-segments/`,
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

    const result = await getReplayDetails.handler(
      directParams,
      getServerContext(),
    );

    expect(result).toContain("**Recorded**: 1 × click");
    expect(result).toContain("- 00:05.0 · **click** · `button.ok`");
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
