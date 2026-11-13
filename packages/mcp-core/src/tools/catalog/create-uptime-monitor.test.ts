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
  it("creates an uptime monitor with camelCase payload", async () => {
    let requestBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/",
        async ({ request }) => {
          requestBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
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
            },
            { status: 201 },
          );
        },
      ),
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
        headers: [["Accept", "application/json"]],
        environment: "production",
      },
      context,
    );

    expect(requestBody).toMatchObject({
      name: "Checkout Health",
      url: "https://example.com/checkout",
      intervalSeconds: 300,
      timeoutMs: 8000,
      method: "GET",
      headers: [["Accept", "application/json"]],
      environment: "production",
    });
    expect(requestBody).not.toHaveProperty("interval_seconds");
    expect(requestBody).not.toHaveProperty("timeout_ms");
    expect(requestBody).not.toHaveProperty("assertion");

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

  it("accepts only [name, value] header pairs in the input schema", () => {
    const { headers } = createUptimeMonitor.inputSchema;
    expect(headers.safeParse([["Accept", "application/json"]]).success).toBe(
      true,
    );
    expect(headers.safeParse([["Accept"]]).success).toBe(false);
    expect(headers.safeParse([["Accept", "a", "b"]]).success).toBe(false);
  });

  it("rejects empty owner in the input schema", () => {
    const result = createUptimeMonitor.inputSchema.owner.safeParse("   ");
    expect(result.success).toBe(false);
  });
});
