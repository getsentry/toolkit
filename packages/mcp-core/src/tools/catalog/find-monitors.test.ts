import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import findMonitors, { findMonitorsOutputSchema } from "./find-monitors.js";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

describe("find_monitors", () => {
  it("serializes cron monitors", async () => {
    const result = await findMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: null,
        environment: null,
        owner: null,
        query: null,
        limit: 10,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findMonitorsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "monitors": [
          {
            "environments": [
              {
                "lastCheckIn": "2025-04-14T02:00:13.000Z",
                "name": "production",
                "status": "ok",
              },
              {
                "lastCheckIn": "2025-04-13T02:00:18.000Z",
                "name": "staging",
                "status": "missed_checkin",
              },
            ],
            "hasMoreEnvironments": false,
            "id": "4509100000000001",
            "lastCheckIn": "2025-04-14T02:00:13.000Z",
            "name": "Nightly Import",
            "nextCheckIn": "2025-04-15T02:00:00.000Z",
            "owner": "the-goats",
            "projectSlug": "cloudflare-mcp",
            "schedule": {
              "checkInMargin": 5,
              "maxRuntime": 30,
              "type": "crontab",
              "value": "0 2 * * *",
            },
            "slug": "nightly-import",
            "status": "ok",
            "webUrl": "https://sentry-mcp-evals.sentry.io/crons/cloudflare-mcp/nightly-import/",
          },
        ],
      }
    `);
  });

  it("filters by projectSlug instead of numeric project for project slugs", async () => {
    let requestUrl: string | undefined;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
    );

    await findMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "backend",
        environment: null,
        owner: null,
        query: null,
        limit: 10,
      },
      context,
    );

    expect(requestUrl).toBeDefined();
    const params = new URL(requestUrl ?? "").searchParams;
    expect(params.get("projectSlug")).toBe("backend");
    expect(params.get("project")).toBeNull();
  });

  it("sends monitor list filters to Sentry", async () => {
    let requestUrl: string | undefined;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
    );

    await findMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "backend",
        environment: "production",
        owner: "team:123",
        query: "billing",
        limit: 25,
      },
      context,
    );

    expect(requestUrl).toBeDefined();
    const params = new URL(requestUrl ?? "").searchParams;
    expect(params.get("projectSlug")).toBe("backend");
    expect(params.get("environment")).toBe("production");
    expect(params.get("owner")).toBe("team:123");
    expect(params.get("query")).toBe("billing");
    expect(params.get("per_page")).toBe("26");
  });

  it("uses the active project constraint as the monitor list project", async () => {
    let requestUrl: string | undefined;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
    );

    await findMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "all",
        environment: null,
        owner: null,
        query: null,
        limit: 10,
      },
      {
        ...context,
        constraints: {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "backend",
        },
      },
    );

    expect(requestUrl).toBeDefined();
    const params = new URL(requestUrl ?? "").searchParams;
    expect(params.get("projectSlug")).toBe("backend");
  });

  it("rejects monitor list projects outside the active project constraint", async () => {
    await expect(
      findMonitors.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          projectSlug: "backend",
          environment: null,
          owner: null,
          query: null,
          limit: 10,
        },
        {
          ...context,
          constraints: {
            organizationSlug: "sentry-mcp-evals",
            projectSlug: "frontend",
          },
        },
      ),
    ).rejects.toThrow(
      'Monitor list is outside the active project constraint. Expected project "frontend".',
    );
  });

  it("encodes monitor slugs in web links", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/",
        () =>
          HttpResponse.json([
            {
              id: "4509100000000002",
              slug: "nightly/import 1",
              name: "Nightly Import 1",
              status: "ok",
              project: {
                id: "4509109104082945",
                name: "cloudflare-mcp",
              },
              config: {
                schedule_type: "crontab",
                schedule: ["crontab", "0 2 * * *"],
              },
              environments: [],
            },
          ]),
      ),
    );

    const result = await findMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: null,
        environment: null,
        owner: null,
        query: null,
        limit: 10,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchObject({
      monitors: [
        {
          projectSlug: "cloudflare-mcp",
          webUrl:
            "https://sentry-mcp-evals.sentry.io/crons/cloudflare-mcp/nightly%2Fimport%201/",
        },
      ],
    });
  });

  it("preserves object and legacy interval schedules without inventing ids", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/",
        () =>
          HttpResponse.json([
            {
              slug: "object-interval",
              name: "Object Interval",
              config: {
                schedule: { type: "interval", value: 5, unit: "day" },
              },
              environments: [],
            },
            {
              id: "2",
              slug: "legacy-interval",
              name: "Legacy Interval",
              config: {
                schedule: ["interval", 3, "hour"],
              },
              environments: [],
            },
          ]),
      ),
    );

    const result = await findMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: null,
        environment: null,
        owner: null,
        query: null,
        limit: 10,
      },
      context,
    );

    expect(getStructuredContent(result)).toMatchObject({
      monitors: [
        {
          id: null,
          schedule: { type: "interval", value: "5 day" },
        },
        {
          id: "2",
          schedule: { type: "interval", value: "3 hour" },
        },
      ],
    });
  });

  it("reports more results and returns only the requested monitor limit", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("per_page")).toBe("11");
          return HttpResponse.json(
            Array.from({ length: 11 }, (_, index) => ({
              id: String(index + 1),
              slug: `monitor-${index + 1}`,
              name: `Monitor ${index + 1}`,
              status: "ok",
              project: {
                id: "1",
                slug: "cloudflare-mcp",
                name: "cloudflare-mcp",
              },
              config: null,
              environments: [],
            })),
          );
        },
      ),
    );

    const result = await findMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: null,
        environment: null,
        owner: null,
        query: null,
        limit: 10,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(structuredContent["hasMore"]).toBe(true);
    expect(structuredContent["monitors"]).toHaveLength(10);
  });
});
