import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import getMonitorDetails, {
  getMonitorDetailsOutputSchema,
} from "./get-monitor-details.js";
import { prepareToolParams } from "../catalog-runtime/availability";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

const baseParams = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  projectSlugOrId: null,
  monitorSlug: "nightly-import",
  environment: null,
  period: "24h",
  start: null,
  end: null,
  checkInLimit: 10,
  includeStats: true,
  rollupSeconds: null,
};

function getOutput(result: unknown) {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent(result);
  const parsed = getMonitorDetailsOutputSchema.parse(content);
  expect(parsed).toEqual(content);
  return parsed;
}

describe("get_monitor_details", () => {
  it("serializes monitor details", async () => {
    const result = await getMonitorDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlugOrId: null,
        monitorSlug: "nightly-import",
        environment: null,
        period: "24h",
        start: null,
        end: null,
        checkInLimit: 10,
        includeStats: true,
        rollupSeconds: null,
      },
      context,
    );

    expect(getOutput(result)).toMatchInlineSnapshot(`
      {
        "checkIns": [
          {
            "date": "2025-04-14T02:00:13.000Z",
            "durationMs": 13200,
            "environment": "production",
            "status": "ok",
          },
          {
            "date": "2025-04-14T02:05:00.000Z",
            "durationMs": null,
            "environment": "staging",
            "status": "missed",
          },
        ],
        "environments": [
          {
            "lastCheckIn": "2025-04-14T02:00:13.000Z",
            "name": "production",
            "nextCheckIn": "2025-04-15T02:00:00.000Z",
            "status": "ok",
          },
          {
            "lastCheckIn": "2025-04-13T02:00:18.000Z",
            "name": "staging",
            "nextCheckIn": "2025-04-14T02:00:00.000Z",
            "status": "missed_checkin",
          },
        ],
        "monitor": {
          "config": {
            "checkinMarginMinutes": 5,
            "maxRuntimeMinutes": 30,
            "schedule": "0 2 * * *",
            "scheduleType": "crontab",
            "timezone": "UTC",
          },
          "id": "4509100000000001",
          "lastCheckIn": "2025-04-14T02:00:13.000Z",
          "name": "Nightly Import",
          "nextCheckIn": "2025-04-15T02:00:00.000Z",
          "owner": "the-goats",
          "ownerEmail": null,
          "project": "cloudflare-mcp",
          "slug": "nightly-import",
          "status": "ok",
          "type": null,
          "url": "https://sentry-mcp-evals.sentry.io/crons/cloudflare-mcp/nightly-import/",
        },
        "stats": [
          {
            "avgDurationMs": 13200,
            "error": 0,
            "missed": 0,
            "ok": 1,
            "timeout": 0,
            "timestamp": "2025-04-14T02:00:00.000Z",
            "unknown": 0,
          },
          {
            "avgDurationMs": 0,
            "error": 0,
            "missed": 1,
            "ok": 0,
            "timeout": 0,
            "timestamp": "2025-04-15T02:00:00.000Z",
            "unknown": 0,
          },
        ],
      }
    `);
  });

  it("returns a null owner when Sentry has no usable identity", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/",
        () =>
          HttpResponse.json({
            id: "4509100000000001",
            slug: "nightly-import",
            name: "Nightly Import",
            status: "ok",
            project: { id: "4509109104082945", slug: "cloudflare-mcp" },
            environments: [],
            owner: { type: "user" },
            config: { schedule_type: "crontab", schedule: "0 2 * * *" },
          }),
      ),
    );

    const output = getOutput(
      await getMonitorDetails.handler(baseParams, context),
    );

    expect(output.monitor.owner).toBeNull();
    expect(output.monitor.ownerEmail).toBeNull();
  });

  it("does not leak backend-only monitor fields", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/",
        () =>
          HttpResponse.json({
            id: "4509100000000001",
            slug: "nightly-import",
            name: "Nightly Import",
            status: "ok",
            isUpserting: false,
            project: { id: "4509109104082945", slug: "cloudflare-mcp" },
            environments: [],
            owner: {
              type: "user",
              id: "1",
              name: "Jane Developer",
              email: "jane@example.com",
            },
            alertRule: { targets: [{ targetIdentifier: "secret-target" }] },
            config: {
              schedule_type: "crontab",
              schedule: "0 2 * * *",
              failure_issue_threshold: 3,
              alert_rule_id: 987654,
            },
          }),
      ),
    );

    const result = await getMonitorDetails.handler(baseParams, context);

    const output = getOutput(result);
    // The owner's email is user data Sentry stored, so it comes through.
    expect(output.monitor.ownerEmail).toBe("jane@example.com");
    const text = JSON.stringify(output);
    for (const leaked of [
      "secret-target",
      "alertRule",
      "failure_issue_threshold",
      "987654",
      "isUpserting",
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("rejects monitors outside the active project constraint", async () => {
    await expect(
      getMonitorDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          projectSlugOrId: "cloudflare-mcp",
          monitorSlug: "nightly-import",
          environment: null,
          period: "24h",
          start: null,
          end: null,
          checkInLimit: 10,
          includeStats: true,
          rollupSeconds: null,
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
      'Monitor is outside the active project constraint. Expected project "frontend".',
    );
  });

  it("uses the active project constraint for monitor detail endpoints", async () => {
    const paths: string[] = [];
    const monitorResponse = {
      id: "4509100000000001",
      slug: "nightly-import",
      name: "Nightly Import",
      status: "ok",
      owner: null,
      project: {
        id: "4509109104082945",
        slug: "cloudflare-mcp",
        name: "cloudflare-mcp",
      },
      config: {
        schedule_type: "crontab",
        schedule: "0 2 * * *",
      },
      environments: [],
    };
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(monitorResponse);
        },
      ),
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/checkins/",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json([]);
        },
      ),
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/stats/",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await getMonitorDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlugOrId: null,
        monitorSlug: "nightly-import",
        environment: null,
        period: "24h",
        start: null,
        end: null,
        checkInLimit: 10,
        includeStats: true,
        rollupSeconds: null,
      },
      {
        ...context,
        constraints: {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
        },
      },
    );

    expect(getOutput(result).monitor.name).toBe("Nightly Import");
    expect(paths).toEqual([
      "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/",
      "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/checkins/",
      "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/stats/",
    ]);
  });

  it("preserves mixed-case project slug in monitor detail endpoints", async () => {
    const paths: string[] = [];
    const monitorResponse = {
      id: "4509100000000001",
      slug: "nightly-import",
      name: "Nightly Import",
      status: "ok",
      owner: null,
      project: {
        id: "4509109104082945",
        slug: "MyProject",
        name: "My Project",
      },
      config: {
        schedule_type: "crontab",
        schedule: "0 2 * * *",
      },
      environments: [],
    };
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/*/*/monitors/nightly-import/",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(monitorResponse);
        },
      ),
      http.get(
        "https://sentry.io/api/0/projects/*/*/monitors/nightly-import/checkins/",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json([]);
        },
      ),
    );

    const params = prepareToolParams({
      tool: getMonitorDetails,
      params: {
        organizationSlug: " MyOrg ",
        regionUrl: null,
        projectSlugOrId: " MyProject ",
        monitorSlug: "nightly-import",
        environment: null,
        period: "24h",
        start: null,
        end: null,
        checkInLimit: 10,
        includeStats: false,
        rollupSeconds: null,
      },
      context,
    }) as Parameters<typeof getMonitorDetails.handler>[0];

    const result = await getMonitorDetails.handler(params, context);

    expect(getOutput(result).monitor.name).toBe("Nightly Import");
    expect(paths).toEqual([
      "/api/0/projects/MyOrg/MyProject/monitors/nightly-import/",
      "/api/0/projects/MyOrg/MyProject/monitors/nightly-import/checkins/",
    ]);
  });

  it("uses StatsMixin time parameters for monitor stats", async () => {
    let checkInsRequestUrl: string | null = null;
    let statsRequestUrl: string | null = null;
    const monitorResponse = {
      id: "4509100000000001",
      slug: "nightly-import",
      name: "Nightly Import",
      status: "ok",
      owner: null,
      project: {
        id: "4509109104082945",
        slug: "cloudflare-mcp",
        name: "cloudflare-mcp",
      },
      config: {
        schedule_type: "crontab",
        schedule: "0 2 * * *",
      },
      environments: [],
    };
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/",
        () => HttpResponse.json(monitorResponse),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/checkins/",
        ({ request }) => {
          checkInsRequestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/stats/",
        ({ request }) => {
          statsRequestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
    );

    await getMonitorDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlugOrId: null,
        monitorSlug: "nightly-import",
        environment: "production",
        period: null,
        start: "2025-04-14T02:00:00.000Z",
        end: "2025-04-14T03:00:00.000Z",
        checkInLimit: 10,
        includeStats: true,
        rollupSeconds: 3600,
      },
      context,
    );

    expect(checkInsRequestUrl).not.toBeNull();
    const checkInsParams = new URL(checkInsRequestUrl ?? "").searchParams;
    expect(checkInsParams.get("environment")).toBe("production");
    expect(checkInsParams.get("start")).toBe("2025-04-14T02:00:00.000Z");
    expect(checkInsParams.get("end")).toBe("2025-04-14T03:00:00.000Z");
    expect(checkInsParams.get("statsPeriod")).toBeNull();

    expect(statsRequestUrl).not.toBeNull();
    const params = new URL(statsRequestUrl ?? "").searchParams;
    expect(params.get("environment")).toBe("production");
    expect(params.get("since")).toBe("1744596000");
    expect(params.get("until")).toBe("1744599600");
    expect(params.get("resolution")).toBe("3600s");
    expect(params.get("statsPeriod")).toBeNull();
  });

  it("rejects absolute monitor time ranges missing an end", async () => {
    await expect(
      getMonitorDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          projectSlugOrId: null,
          monitorSlug: "nightly-import",
          environment: null,
          period: null,
          start: "2025-04-14T02:00:00.000Z",
          end: null,
          checkInLimit: 10,
          includeStats: true,
          rollupSeconds: null,
        },
        context,
      ),
    ).rejects.toThrow("`start` and `end` must be provided together.");
  });

  it("rejects combining period with an absolute monitor time range", async () => {
    await expect(
      getMonitorDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          projectSlugOrId: null,
          monitorSlug: "nightly-import",
          environment: null,
          period: "24h",
          start: "2025-04-14T02:00:00.000Z",
          end: "2025-04-14T03:00:00.000Z",
          checkInLimit: 10,
          includeStats: true,
          rollupSeconds: null,
        },
        context,
      ),
    ).rejects.toThrow("`period` cannot be combined with `start` and `end`.");
  });

  it("defaults null period to a 24h monitor window", async () => {
    let checkInsRequestUrl: string | null = null;
    let statsRequestUrl: string | null = null;
    const monitorResponse = {
      id: "4509100000000001",
      slug: "nightly-import",
      name: "Nightly Import",
      status: "ok",
      owner: null,
      project: {
        id: "4509109104082945",
        slug: "cloudflare-mcp",
        name: "cloudflare-mcp",
      },
      config: {
        schedule_type: "crontab",
        schedule: "0 2 * * *",
      },
      environments: [],
    };
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/",
        () => HttpResponse.json(monitorResponse),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/checkins/",
        ({ request }) => {
          checkInsRequestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/stats/",
        ({ request }) => {
          statsRequestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
    );

    await getMonitorDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlugOrId: null,
        monitorSlug: "nightly-import",
        environment: null,
        period: null,
        start: null,
        end: null,
        checkInLimit: 10,
        includeStats: true,
        rollupSeconds: null,
      },
      context,
    );

    expect(checkInsRequestUrl).not.toBeNull();
    const checkInsParams = new URL(checkInsRequestUrl ?? "").searchParams;
    expect(checkInsParams.get("statsPeriod")).toBe("24h");

    expect(statsRequestUrl).not.toBeNull();
    const statsParams = new URL(statsRequestUrl ?? "").searchParams;
    expect(statsParams.get("statsPeriod")).toBeNull();
    expect(statsParams.get("since")).not.toBeNull();
    expect(statsParams.get("until")).not.toBeNull();
  });

  it("encodes monitor slugs in web links", async () => {
    const monitorResponse = {
      id: "4509100000000002",
      slug: "nightly/import 1",
      name: "Nightly Import 1",
      status: "ok",
      owner: null,
      project: {
        id: "4509109104082945",
        slug: "cloudflare-mcp",
        name: "cloudflare-mcp",
      },
      config: {
        schedule_type: "crontab",
        schedule: "0 2 * * *",
      },
      environments: [],
    };
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/",
        () => HttpResponse.json(monitorResponse),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/checkins/",
        () => HttpResponse.json([]),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/stats/",
        () =>
          HttpResponse.json(
            { detail: "stats should not be requested" },
            { status: 500 },
          ),
      ),
    );

    const result = await getMonitorDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlugOrId: null,
        monitorSlug: "nightly-import",
        environment: null,
        period: "24h",
        start: null,
        end: null,
        checkInLimit: 10,
        includeStats: false,
        rollupSeconds: null,
      },
      context,
    );

    const output = getOutput(result);
    expect(output.monitor.url).toBe(
      "https://sentry-mcp-evals.sentry.io/crons/cloudflare-mcp/nightly%2Fimport%201/",
    );
    expect(output.stats).toBeNull();
  });

  describe("tool definition", () => {
    it("requires the project read scope used by the backend monitor endpoints", () => {
      expect(getMonitorDetails.requiredScopes).toEqual(["project:read"]);
    });
  });
});
