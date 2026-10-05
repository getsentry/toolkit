import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { metricMonitor } from "../../test-utils/metric-monitor";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import findAlertRules, {
  findAlertRulesOutputSchema,
} from "./find-alert-rules.js";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

const params = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  kind: "all" as const,
  projectSlug: null,
  query: null,
  cursor: null,
  limit: 10,
};

const issueAlertRule = {
  id: "123",
  name: "Notify backend team",
  enabled: true,
  config: {
    frequency: 30,
  },
  environment: "production",
  detectorIds: ["789"],
  owner: "team:backend",
  dateCreated: "2026-01-02T03:04:05.000Z",
  dateUpdated: "2026-01-02T04:04:05.000Z",
};

const metricAlertRule = {
  ...metricMonitor,
  id: "789",
  alertRuleId: 456,
  projectId: "4509109104082945",
};

const project = {
  id: "4509109104082945",
  slug: "cloudflare-mcp",
  name: "cloudflare-mcp",
};

function useAlertRuleHandlers() {
  mswServer.use(
    http.get(
      "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
      () => HttpResponse.json(project),
    ),
    http.get(
      "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/",
      () => HttpResponse.json([issueAlertRule]),
    ),
    http.get(
      "https://sentry.io/api/0/organizations/sentry-mcp-evals/detectors/",
      () => HttpResponse.json([metricAlertRule]),
    ),
  );
}

describe("find_alert_rules", () => {
  it("serializes project-scoped issue and metric searches", async () => {
    useAlertRuleHandlers();
    let issueRequestUrl: string | null = null;
    const metricRequestUrls: string[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/",
        ({ request }) => {
          issueRequestUrl = request.url;
          return HttpResponse.json([issueAlertRule]);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/detectors/",
        ({ request }) => {
          metricRequestUrls.push(request.url);
          return HttpResponse.json([metricAlertRule]);
        },
      ),
    );

    const result = await findAlertRules.handler(
      { ...params, projectSlug: "cloudflare-mcp", query: "backend" },
      context,
    );

    const issueParams = new URL(issueRequestUrl ?? "").searchParams;
    expect(issueParams.get("projectSlug")).toBe("cloudflare-mcp");
    expect(issueParams.get("query")).toBe('name:"*backend*"');
    expect(metricRequestUrls).toHaveLength(1);
    const metricParams = new URL(metricRequestUrls[0]).searchParams;
    expect(metricParams.get("project")).toBe(project.id);
    expect(metricParams.get("query")).toBe('name:"*backend*"');
    expect(metricParams.getAll("type")).toEqual(["metric_issue"]);
    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findAlertRulesOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "issueRules": [
          {
            "actionMatch": null,
            "dateCreated": "2026-01-02T03:04:05.000Z",
            "dateUpdated": "2026-01-02T04:04:05.000Z",
            "environment": "production",
            "filterMatch": null,
            "frequencyMinutes": 30,
            "id": "123",
            "lastTriggered": null,
            "name": "Notify backend team",
            "owner": "team:backend",
            "status": "enabled",
            "webUrl": "https://sentry-mcp-evals.sentry.io/monitors/alerts/123/",
          },
        ],
        "metricMonitorHint": "Use get_metric_monitor_details with monitorId. Legacy get_alert_rule(kind=metric) accepts each entry's id; never pass monitorId as a bare legacy ID.",
        "metricRules": [
          {
            "aggregate": "count()",
            "dataset": "events",
            "dateCreated": "2026-01-01T00:00:00.000Z",
            "enabled": false,
            "environment": "production",
            "id": "456",
            "monitorId": "789",
            "name": "High error rate",
            "owner": "Backend",
            "projectId": "4509109104082945",
            "query": "level:error",
            "status": "disabled",
            "timeWindowMinutes": 5,
            "webUrl": "https://sentry-mcp-evals.sentry.io/monitors/789/",
          },
        ],
        "pagination": {
          "issue": {
            "nextCursor": null,
          },
          "metric": {
            "nextCursor": null,
          },
        },
      }
    `);
  });

  it("resolves project redirects before listing metric alerts", async () => {
    let metricRequestUrl: string | null = null;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/legacy-cloudflare-mcp/",
        () => HttpResponse.json(project),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/detectors/",
        ({ request }) => {
          metricRequestUrl = request.url;
          return HttpResponse.json([metricAlertRule]);
        },
      ),
    );

    await findAlertRules.handler(
      { ...params, kind: "metric", projectSlug: "legacy-cloudflare-mcp" },
      context,
    );

    expect(metricRequestUrl).not.toBeNull();
    expect(new URL(metricRequestUrl ?? "").searchParams.get("project")).toBe(
      project.id,
    );
  });

  it("returns next cursors for direct alert rule list endpoints", async () => {
    useAlertRuleHandlers();
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/",
        () =>
          HttpResponse.json([issueAlertRule], {
            headers: {
              Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/?cursor=issue-page-2>; rel="next"; results="true"; cursor="issue-page-2"',
            },
          }),
      ),
    );

    const result = await findAlertRules.handler(
      { ...params, kind: "issue", projectSlug: "cloudflare-mcp" },
      context,
    );

    expect(getStructuredContent(result).pagination).toEqual({
      issue: { nextCursor: "issue-page-2" },
      metric: null,
    });
  });

  it("preserves unattached Alerts and their organization-wide pagination", async () => {
    const requests: URL[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/",
        ({ request }) => {
          requests.push(new URL(request.url));
          return HttpResponse.json([{ ...issueAlertRule, detectorIds: [] }], {
            headers: {
              Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/?cursor=workflow-page-2>; rel="next"; results="true"; cursor="workflow-page-2"',
            },
          });
        },
      ),
    );

    const result = await findAlertRules.handler(
      { ...params, kind: "issue", cursor: "workflow-page-1", limit: 1 },
      context,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("projectSlug")).toBeNull();
    expect(requests[0].searchParams.get("cursor")).toBe("workflow-page-1");
    expect(getStructuredContent(result)).toMatchObject({
      issueRules: [{ id: "123" }],
      pagination: { issue: { nextCursor: "workflow-page-2" }, metric: null },
    });
  });

  it("does not expose a workflow cursor when an overfull page is capped", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/",
        () =>
          HttpResponse.json(
            [
              issueAlertRule,
              {
                ...issueAlertRule,
                id: "124",
                name: "Notify frontend team",
              },
            ],
            {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/?cursor=workflow-page-2>; rel="next"; results="true"; cursor="workflow-page-2"',
              },
            },
          ),
      ),
    );

    const result = await findAlertRules.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        kind: "issue",
        projectSlug: "cloudflare-mcp",
        query: null,
        cursor: null,
        limit: 1,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchObject({
      issueRules: [{ id: "123" }],
      metricRules: [],
      pagination: { issue: { nextCursor: null }, metric: null },
    });
    expect(getStructuredContent(result).issueRules).toHaveLength(1);
  });

  it("returns next cursors for detector query searches", async () => {
    useAlertRuleHandlers();
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/detectors/",
        ({ request }) => {
          const params = new URL(request.url).searchParams;
          return HttpResponse.json(
            params.get("type") === "metric_issue" ? [metricAlertRule] : [],
            {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/detectors/?cursor=metric-query-page-2>; rel="next"; results="true"; cursor="metric-query-page-2"',
              },
            },
          );
        },
      ),
    );

    const result = await findAlertRules.handler(
      {
        ...params,
        kind: "metric",
        projectSlug: "cloudflare-mcp",
        query: "error",
      },
      context,
    );

    expect(getStructuredContent(result)).toMatchObject({
      metricRules: [{ id: "456", name: metricMonitor.name }],
      pagination: {
        issue: null,
        metric: { nextCursor: "metric-query-page-2" },
      },
    });
  });

  it("uses the constrained project for an organization-wide request", async () => {
    let requestUrl: URL | undefined;
    useAlertRuleHandlers();
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/",
        ({ request }) => {
          requestUrl = new URL(request.url);
          return HttpResponse.json([issueAlertRule]);
        },
      ),
    );

    await findAlertRules.handler(
      { ...params, kind: "issue" },
      { ...context, constraints: { projectSlug: "cloudflare-mcp" } },
    );

    expect(requestUrl?.searchParams.get("projectSlug")).toBe("cloudflare-mcp");
  });

  it.each([null, "error"])(
    "lists mapped and new monitors without retired endpoints (query: %s)",
    async (query) => {
      useAlertRuleHandlers();
      const legacyRequests: string[] = [];
      mswServer.use(
        http.get("*/alert-rules/", ({ request }) => {
          legacyRequests.push(request.url);
          return HttpResponse.json({ detail: "Gone" }, { status: 410 });
        }),
        http.get("*/combined-rules/", ({ request }) => {
          legacyRequests.push(request.url);
          return HttpResponse.json({ detail: "Gone" }, { status: 410 });
        }),
        http.get("*/detectors/", () =>
          HttpResponse.json([
            metricAlertRule,
            { ...metricAlertRule, id: "790", alertRuleId: null },
          ]),
        ),
      );
      const content = getStructuredContent(
        await findAlertRules.handler({ ...params, query }, context),
      );
      expect(content).toMatchObject({
        issueRules: [{ id: "123" }],
        metricRules: [
          { id: "456", monitorId: "789" },
          { id: "detector:790", monitorId: "790" },
        ],
        pagination: { metric: { nextCursor: null } },
      });
      expect(legacyRequests).toEqual([]);
    },
  );

  it.each([
    { kind: "metric", endpoint: "detectors", status: 410 },
    { kind: "all", endpoint: "detectors", status: 403 },
    { kind: "all", endpoint: "detectors", status: 500 },
    { kind: "all", endpoint: "workflows", status: 410 },
  ] as const)(
    "preserves $status errors from $endpoint for kind=$kind",
    async ({ kind, endpoint, status }) => {
      useAlertRuleHandlers();
      mswServer.use(
        http.get(
          `https://sentry.io/api/0/organizations/sentry-mcp-evals/${endpoint}/`,
          () =>
            HttpResponse.json({ detail: "Metric alert API error" }, { status }),
        ),
      );

      await expect(
        findAlertRules.handler({ ...params, kind }, context),
      ).rejects.toMatchObject({ status });
    },
  );

  it.each([null, "cloudflare-mcp"])(
    "rejects shared cursors when searching both families (project: %s)",
    async (projectSlug) => {
      await expect(
        findAlertRules.handler(
          { ...params, projectSlug, cursor: "endpoint-specific-cursor" },
          context,
        ),
      ).rejects.toThrow(
        "cursor cannot be used with `kind='all'` when both issue and metric alert rules are included.",
      );
    },
  );
});
