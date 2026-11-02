import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import getMonitorDetails from "./get-monitor-details.js";
import { prepareToolParams } from "../catalog-runtime/availability";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

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

    expect(result).toMatchInlineSnapshot(`
      "# Monitor Nightly Import in **sentry-mcp-evals**

      **Slug**: nightly-import
      **ID**: 4509100000000001
      **Project**: cloudflare-mcp
      **Status**: ok
      **Owner**: the-goats
      **Last Check-In**: 2025-04-14T02:00:13.000Z
      **Next Check-In**: 2025-04-15T02:00:00.000Z
      **URL**: [Open Monitor](https://sentry-mcp-evals.sentry.io/crons/cloudflare-mcp/nightly-import/)

      ## Schedule

      - **schedule**: ["crontab","0 2 * * *"]
      - **schedule_type**: crontab
      - **timezone**: UTC
      - **checkin_margin**: 5
      - **max_runtime**: 30

      ## Environments

      - production
        - Status: ok
        - Last check-in: 2025-04-14T02:00:13.000Z
        - Next check-in: 2025-04-15T02:00:00.000Z
      - staging
        - Status: missed_checkin
        - Last check-in: 2025-04-13T02:00:18.000Z
        - Next check-in: 2025-04-14T02:00:00.000Z

      ## Recent Check-Ins

      - 2025-04-14T02:00:13.000Z: ok, 13200ms, production
      - 2025-04-14T02:05:00.000Z: missed, staging

      ## Stats

      - 2025-04-14T02:00:00.000Z: ok=1, error=0, missed=0, timeout=0, unknown=0, duration=13200
      - 2025-04-15T02:00:00.000Z: ok=0, error=0, missed=1, timeout=0, unknown=0, duration=0

      ## Response Notes

      - Search issues from this monitor with \`search_issues\` query \`monitor.slug:nightly-import\`.
      "
    `);
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
        schedule: ["crontab", "0 2 * * *"],
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

    expect(result).toContain(
      "# Monitor Nightly Import in **sentry-mcp-evals**",
    );
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
        schedule: ["crontab", "0 2 * * *"],
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

    expect(result).toContain("# Monitor Nightly Import in **MyOrg**");
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
        schedule: ["crontab", "0 2 * * *"],
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
        schedule: ["crontab", "0 2 * * *"],
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
        schedule: ["crontab", "0 2 * * *"],
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

    expect(result).toContain(
      "[Open Monitor](https://sentry-mcp-evals.sentry.io/crons/cloudflare-mcp/nightly%2Fimport%201/)",
    );
    expect(result).not.toContain("## Stats");
  });

  describe("tool definition", () => {
    it("requires the project read scope used by the backend monitor endpoints", () => {
      expect(getMonitorDetails.requiredScopes).toEqual(["project:read"]);
    });
  });
});
