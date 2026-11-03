import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import createUptimeMonitor, {
  createUptimeMonitorOutputSchema,
} from "./create-uptime-monitor.js";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

describe("create_uptime_monitor", () => {
  const detectorsUrl =
    "https://sentry.io/api/0/organizations/sentry-mcp-evals/projects/cloudflare-mcp/detectors/";
  const monitorUrl =
    "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001002/";
  const createdDetector = {
    id: "4509100000001002",
    projectId: "4509062593708032",
    name: "Checkout Health",
    type: "uptime_domain_failure",
    enabled: true,
    config: { mode: 1, environment: "production" },
    conditionGroup: null,
    dataSources: null,
    workflowIds: [],
    owner: null,
    createdBy: "1",
    dateCreated: "2026-11-02T00:00:00.000000Z",
    dateUpdated: "2026-11-02T00:00:00.000000Z",
  };
  const savedMonitor = {
    id: "4509100000001002",
    projectSlug: "cloudflare-mcp",
    environment: "production",
    name: "Checkout Health",
    status: "active",
    uptimeStatus: 1,
    mode: 1,
    owner: null,
    recoveryThreshold: 1,
    downtimeThreshold: 3,
    url: "https://example.com/checkout",
    method: "GET",
    body: null,
    headers: [],
    intervalSeconds: 300,
    timeoutMs: 8000,
    traceSampling: false,
    responseCaptureEnabled: true,
    assertion: null,
  };

  it("creates the monitor through the detectors endpoint", async () => {
    let requestBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(detectorsUrl, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(createdDetector, { status: 201 });
      }),
      http.get(monitorUrl, () => HttpResponse.json(savedMonitor)),
    );

    const result = await createUptimeMonitor.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "cloudflare-mcp",
        name: "Checkout Health",
        url: "https://example.com/checkout",
        intervalSeconds: 300,
        timeoutMs: 8000,
        method: "GET",
        environment: "production",
        downtimeThreshold: 3,
      },
      context,
    );

    expect(requestBody).toEqual({
      type: "uptime_domain_failure",
      name: "Checkout Health",
      dataSources: [
        {
          url: "https://example.com/checkout",
          intervalSeconds: 300,
          timeoutMs: 8000,
          method: "GET",
        },
      ],
      config: {
        environment: "production",
        downtimeThreshold: 3,
      },
    });

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(createUptimeMonitorOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "monitor": {
          "downtimeThreshold": 3,
          "environment": "production",
          "id": "4509100000001002",
          "intervalSeconds": 300,
          "method": "GET",
          "name": "Checkout Health",
          "projectSlug": "cloudflare-mcp",
          "recoveryThreshold": 1,
          "responseCaptureEnabled": true,
          "status": "active",
          "timeoutMs": 8000,
          "traceSampling": false,
          "uptimeStatus": "ok",
          "url": "https://example.com/checkout",
          "webUrl": "https://sentry-mcp-evals.sentry.io/monitors/4509100000001002/",
        },
      }
    `);
  });

  it("disables the monitor after creation when status is disabled", async () => {
    let createBody: Record<string, unknown> | null = null;
    let updateBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(detectorsUrl, async ({ request }) => {
        createBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(createdDetector, { status: 201 });
      }),
      http.put(monitorUrl, async ({ request }) => {
        updateBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...savedMonitor, status: "disabled" });
      }),
    );

    const result = await createUptimeMonitor.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "cloudflare-mcp",
        name: "Checkout Health",
        url: "https://example.com/checkout",
        intervalSeconds: 300,
        timeoutMs: 8000,
        status: "disabled",
      },
      context,
    );

    expect(createBody).not.toHaveProperty("status");
    expect(createBody).not.toHaveProperty("enabled");
    expect(updateBody).toEqual({ status: "disabled" });
    expect(getStructuredContent(result)).toMatchObject({
      monitor: { id: "4509100000001002", status: "disabled" },
    });
  });

  it("rejects empty owner in the input schema", () => {
    const result = createUptimeMonitor.inputSchema.owner.safeParse("   ");
    expect(result.success).toBe(false);
  });
});
