import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createIssueAlertRule,
  createMetricAlertRule,
  deleteIssueAlertRule,
  deleteMetricAlertRule,
  getIssueAlertRule,
  getIssueAlertWorkflowDocument,
  getMetricAlertRule,
  getMetricAlertRuleDocument,
  listIssueAlertsPaginated,
  listMetricAlertsPaginated,
  putMetricAlertRule,
  resolveErrorDetectorId,
  updateIssueAlertRule,
} from "../../../src/lib/api/alerts.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("api-alerts-");

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  resetAuthenticatedFetch();
  await setAuthToken("test-token");
  setOrgRegion("test-org", DEFAULT_SENTRY_URL);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

describe("deleteIssueAlertRule", () => {
  test("treats empty-body 204 as success", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("DELETE");
      expect(req.url).toBe(
        `${DEFAULT_SENTRY_URL}/api/0/organizations/test-org/workflows/42/`
      );
      expect(req.headers.get("Authorization")).toBe("Bearer test-token");
      return new Response(null, { status: 204 });
    });

    await expect(
      deleteIssueAlertRule("test-org", "42")
    ).resolves.toBeUndefined();
  });
});

/** Minimal workflow/rule payload from the org-scoped `/workflows/` endpoint. */
function workflowRule(overrides: Record<string, unknown>) {
  return {
    id: "1",
    name: "Rule",
    status: "active",
    actionMatch: "any",
    conditions: [],
    actions: [],
    frequency: 30,
    environment: null,
    owner: null,
    projects: [],
    detectorIds: [7],
    dateCreated: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("listIssueAlertsPaginated", () => {
  test("reads from org-scoped /workflows/ and drops unattached workflows", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/workflows/");
      expect(url.searchParams.get("projectSlug")).toBe("test-project");
      return Response.json([
        workflowRule({ id: "1", name: "Attached", detectorIds: [7] }),
        workflowRule({ id: "2", name: "Unattached", detectorIds: [] }),
      ]);
    });

    const { data } = await listIssueAlertsPaginated("test-org", "test-project");
    expect(data).toHaveLength(1);
    expect(data[0]?.id).toBe("1");
  });
});

describe("getIssueAlertRule", () => {
  test("reads from /workflows/ filtered by project and id", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/workflows/");
      expect(url.searchParams.get("projectSlug")).toBe("test-project");
      expect(url.searchParams.get("id")).toBe("42");
      return Response.json([workflowRule({ id: "42", name: "My Rule" })]);
    });

    const rule = await getIssueAlertRule("test-org", "test-project", "42");
    expect(rule.id).toBe("42");
    expect(rule.name).toBe("My Rule");
  });

  test("throws 404 ApiError when no attached rule matches", async () => {
    globalThis.fetch = mockFetch(async () =>
      // Only an unattached workflow comes back → filtered out → not found.
      Response.json([workflowRule({ id: "42", detectorIds: [] })])
    );

    await expect(
      getIssueAlertRule("test-org", "test-project", "42")
    ).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });
});

/** Minimal metric-issue detector payload from the org-scoped `/detectors/` endpoint. */
function metricDetector(overrides: Record<string, unknown>) {
  return {
    id: "9",
    name: "P95 latency",
    type: "metric_issue",
    enabled: true,
    projectSlug: "backend",
    owner: null,
    dateCreated: "2026-01-01T00:00:00Z",
    dataSources: [
      {
        aggregate: "p95(span.duration)",
        dataset: "spans",
        query: "environment:prod",
        // Detectors expose the window in seconds; 300s == 5m.
        timeWindow: 300,
        environment: "prod",
      },
    ],
    conditionGroup: null,
    config: { detectionType: "static" },
    ...overrides,
  };
}

describe("listMetricAlertsPaginated", () => {
  test("reads from org-scoped /detectors/ filtered to metric_issue and flattens the payload", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/detectors/");
      expect(url.searchParams.get("query")).toBe("type:metric_issue");
      return Response.json([metricDetector({ id: "9", name: "P95 latency" })]);
    });

    const { data } = await listMetricAlertsPaginated("test-org");
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: "9",
      name: "P95 latency",
      status: 0,
      aggregate: "p95(span.duration)",
      dataset: "spans",
      query: "environment:prod",
      // 300s from the detector payload is normalized to 5 minutes.
      timeWindow: 5,
      environment: "prod",
      projects: ["backend"],
    });
  });
});

describe("getMetricAlertRule", () => {
  test("reads from /detectors/{id}/ and maps disabled detectors to status 1", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/detectors/9/");
      return Response.json(
        metricDetector({ id: "9", name: "Disabled rule", enabled: false })
      );
    });

    const rule = await getMetricAlertRule("test-org", "9");
    expect(rule.id).toBe("9");
    expect(rule.name).toBe("Disabled rule");
    expect(rule.status).toBe(1);
  });

  test("reads threshold fields nested under snubaQuery", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(
        metricDetector({
          dataSources: [
            {
              snubaQuery: {
                aggregate: "count()",
                dataset: "errors",
                query: "event.type:error",
                // 900s == 15m after normalization.
                timeWindow: 900,
              },
            },
          ],
        })
      )
    );

    const rule = await getMetricAlertRule("test-org", "9");
    expect(rule.aggregate).toBe("count()");
    expect(rule.dataset).toBe("errors");
    expect(rule.query).toBe("event.type:error");
    expect(rule.timeWindow).toBe(15);
  });

  test("reads threshold fields nested under queryObj.snubaQuery", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(
        metricDetector({
          dataSources: [
            {
              queryObj: {
                snubaQuery: {
                  aggregate: "p75(measurements.lcp)",
                  dataset: "spans",
                  query: "span.op:pageload",
                  timeWindow: 600,
                },
              },
            },
          ],
        })
      )
    );

    const rule = await getMetricAlertRule("test-org", "9");
    expect(rule.aggregate).toBe("p75(measurements.lcp)");
    expect(rule.dataset).toBe("spans");
    expect(rule.query).toBe("span.op:pageload");
    expect(rule.timeWindow).toBe(10);
  });

  test("prefers projectSlug and falls back to a projects array for projects", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(
        metricDetector({ projectSlug: undefined, projects: ["frontend"] })
      )
    );

    const rule = await getMetricAlertRule("test-org", "9");
    expect(rule.projects).toEqual(["frontend"]);
  });

  test("coerces a non-numeric timeWindow to 0 instead of NaN", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(
        metricDetector({
          dataSources: [{ snubaQuery: { timeWindow: "not-a-number" } }],
        })
      )
    );

    const rule = await getMetricAlertRule("test-org", "9");
    expect(rule.timeWindow).toBe(0);
  });

  test("rejects a non-metric detector with a 404 instead of mapping it", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(metricDetector({ type: "uptime_domain_failure" }))
    );

    await expect(getMetricAlertRule("test-org", "9")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });

  test("reconstructs the legacy actor identifier from an object owner", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(
        metricDetector({ owner: { type: "team", id: "42", name: "backend" } })
      )
    );

    const rule = await getMetricAlertRule("test-org", "9");
    expect(rule.owner).toBe("team:42");
  });
});

describe("createIssueAlertRule", () => {
  test("POSTs the body to the org-scoped /workflows/ endpoint", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe(
        "/api/0/organizations/test-org/workflows/"
      );
      expect(await req.json()).toEqual({ name: "New", detectorIds: [7] });
      return Response.json(workflowRule({ id: "5", name: "New" }));
    });

    const created = await createIssueAlertRule("test-org", {
      name: "New",
      detectorIds: [7],
    });
    expect(created.id).toBe("5");
  });
});

describe("updateIssueAlertRule", () => {
  test("PUTs the body to the /workflows/{id}/ endpoint", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("PUT");
      expect(new URL(req.url).pathname).toBe(
        "/api/0/organizations/test-org/workflows/42/"
      );
      expect(await req.json()).toEqual({ name: "Renamed" });
      return Response.json(workflowRule({ id: "42", name: "Renamed" }));
    });

    const updated = await updateIssueAlertRule("test-org", "42", {
      name: "Renamed",
    });
    expect(updated.name).toBe("Renamed");
  });
});

describe("getIssueAlertWorkflowDocument", () => {
  test("reads the single workflow detail endpoint", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/workflows/42/");
      return Response.json(workflowRule({ id: "42" }));
    });

    const doc = await getIssueAlertWorkflowDocument("test-org", "42");
    expect(doc.id).toBe("42");
  });
});

describe("resolveErrorDetectorId", () => {
  test("returns the id of the project's error detector", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/detectors/");
      expect(url.searchParams.get("project")).toBe("test-project");
      expect(url.searchParams.get("query")).toBe("type:error");
      return Response.json([{ id: 7, type: "error" }]);
    });

    await expect(
      resolveErrorDetectorId("test-org", "test-project")
    ).resolves.toBe(7);
  });

  test("throws 404 ApiError when the project has no error detector", async () => {
    globalThis.fetch = mockFetch(async () => Response.json([]));

    await expect(
      resolveErrorDetectorId("test-org", "test-project")
    ).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });
});

describe("deleteMetricAlertRule", () => {
  test("deletes via the org-scoped /detectors/{id}/ endpoint", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe(
        "/api/0/organizations/test-org/detectors/9/"
      );
      expect(req.headers.get("Authorization")).toBe("Bearer test-token");
      return new Response(null, { status: 204 });
    });

    await expect(
      deleteMetricAlertRule("test-org", "9")
    ).resolves.toBeUndefined();
  });
});

describe("createMetricAlertRule", () => {
  test("POSTs a nested detector body to the project-scoped /detectors/ endpoint", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe(
        "/api/0/organizations/test-org/projects/backend/detectors/"
      );
      expect(await req.json()).toEqual({
        name: "P95 latency",
        type: "metric_issue",
        dataSources: [
          {
            aggregate: "p95(span.duration)",
            dataset: "spans",
            query: "environment:prod",
            queryType: 1,
            eventTypes: ["trace_item_span"],
            // 5m from the flat body is sent to the detector API as 300s.
            timeWindow: 300,
            environment: "prod",
          },
        ],
        config: { detectionType: "static" },
        conditionGroup: {
          logicType: "any",
          conditions: [{ alertThreshold: 500, actions: [{ id: "notify" }] }],
        },
      });
      return Response.json(
        { ...metricDetector({ id: "77", name: "P95 latency" }) },
        { status: 201 }
      );
    });

    const created = await createMetricAlertRule("test-org", {
      name: "P95 latency",
      query: "environment:prod",
      aggregate: "p95(span.duration)",
      dataset: "spans",
      timeWindow: 5,
      environment: "prod",
      triggers: [{ alertThreshold: 500, actions: [{ id: "notify" }] }],
      projects: ["backend"],
    });
    expect(created.id).toBe("77");
  });

  test("maps error-like datasets to queryType 0 and error eventTypes", async () => {
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = mockFetch(async (input, init) => {
      sentBody = (await new Request(input!, init).json()) as Record<
        string,
        unknown
      >;
      return Response.json(metricDetector({ id: "1" }), { status: 201 });
    });

    await createMetricAlertRule("test-org", {
      name: "Error volume",
      query: "event.type:error",
      aggregate: "count()",
      dataset: "errors",
      timeWindow: 15,
      triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
      projects: ["backend"],
    });

    const source = (sentBody.dataSources as Record<string, unknown>[])[0];
    expect(source?.queryType).toBe(0);
    expect(source?.eventTypes).toEqual(["error", "default"]);
    expect(source?.timeWindow).toBe(900);
  });

  test("throws ValidationError when no project is provided", async () => {
    await expect(
      createMetricAlertRule("test-org", {
        name: "No project",
        query: "",
        aggregate: "count()",
        dataset: "errors",
        timeWindow: 5,
        triggers: [{ alertThreshold: 1, actions: [{ id: "notify" }] }],
      })
    ).rejects.toMatchObject({ name: "ValidationError" });
  });
});

describe("getMetricAlertRuleDocument", () => {
  test("returns the flat rule baseline from the detector GET", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/detectors/9/");
      return Response.json(metricDetector({ id: "9", name: "Baseline" }));
    });

    const doc = await getMetricAlertRuleDocument("test-org", "9");
    expect(doc).toMatchObject({
      id: "9",
      name: "Baseline",
      aggregate: "p95(span.duration)",
      dataset: "spans",
      timeWindow: 5,
    });
  });
});

describe("putMetricAlertRule", () => {
  test("PUTs a nested detector body to the /detectors/{id}/ endpoint", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("PUT");
      expect(new URL(req.url).pathname).toBe(
        "/api/0/organizations/test-org/detectors/9/"
      );
      const body = (await req.json()) as Record<string, unknown>;
      expect(body.name).toBe("Renamed");
      expect(body.type).toBe("metric_issue");
      // status 1 (disabled) maps onto the detector's enabled=false flag.
      expect(body.enabled).toBe(false);
      return Response.json(metricDetector({ id: "9", name: "Renamed" }));
    });

    const updated = await putMetricAlertRule("test-org", "9", {
      name: "Renamed",
      query: "environment:prod",
      aggregate: "p95(span.duration)",
      dataset: "spans",
      timeWindow: 5,
      status: 1,
      triggers: [{ alertThreshold: 500, actions: [{ id: "notify" }] }],
    });
    expect(updated.id).toBe("9");
  });
});
