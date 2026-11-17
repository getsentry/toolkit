import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import getUptimeMonitorDetails, {
  getUptimeMonitorDetailsOutputSchema,
} from "./get-uptime-monitor-details.js";

function getOutput(result: unknown) {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent(result);
  const parsed = getUptimeMonitorDetailsOutputSchema.parse(content);
  expect(parsed).toEqual(content);
  return parsed;
}

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

describe("get_uptime_monitor_details", () => {
  it("serializes uptime monitor details without leaking secrets", async () => {
    const result = await getUptimeMonitorDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "cloudflare-mcp",
        uptimeMonitorId: "4509100000001001",
        period: "24h",
        checkLimit: 10,
      },
      context,
    );

    const output = getOutput(result);
    expect(output).toMatchInlineSnapshot(`
      {
        "checks": [
          {
            "durationMs": 142,
            "environment": "production",
            "httpStatusCode": 200,
            "region": "US East",
            "status": "success",
            "statusReason": null,
            "time": "2025-04-14T02:00:13.000Z",
          },
          {
            "durationMs": 5000,
            "environment": "production",
            "httpStatusCode": null,
            "region": "US East",
            "status": "failure_incident",
            "statusReason": "timeout",
            "time": "2025-04-14T01:59:13.000Z",
          },
        ],
        "monitor": {
          "assertion": null,
          "downtimeThreshold": 3,
          "environment": "production",
          "hasRequestBody": true,
          "headers": [
            {
              "name": "Accept",
              "value": "application/json",
            },
            {
              "name": "Authorization",
              "value": "[REDACTED]",
            },
          ],
          "id": "4509100000001001",
          "intervalSeconds": 60,
          "method": "GET",
          "name": "API Health",
          "owner": "the-goats",
          "projectSlug": "cloudflare-mcp",
          "recoveryThreshold": 1,
          "responseCaptureEnabled": true,
          "status": "active",
          "timeoutMs": 5000,
          "traceSampling": false,
          "uptimeStatus": "ok",
          "url": "https://example.com/health",
          "webUrl": "https://sentry-mcp-evals.sentry.io/monitors/4509100000001001/",
        },
      }
    `);
    const text = JSON.stringify(output);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("should-not-appear");
    expect(output.monitor.hasRequestBody).toBe(true);
  });

  it("returns the configured assertion tree as stored", async () => {
    // Shape of DEFAULT_2XX_STATUS_ASSERTION in sentry/uptime/types.py.
    const assertion = {
      root: {
        op: "and",
        children: [
          {
            op: "status_code_check",
            operator: { cmp: "greater_than" },
            value: 199,
          },
          {
            op: "status_code_check",
            operator: { cmp: "less_than" },
            value: 300,
          },
        ],
      },
    };
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/",
        () =>
          HttpResponse.json({
            id: "4509100000001001",
            projectSlug: "cloudflare-mcp",
            environment: null,
            name: "API Health",
            status: "active",
            uptimeStatus: 1,
            url: "https://example.com/health",
            method: "GET",
            body: null,
            headers: [],
            intervalSeconds: 60,
            timeoutMs: 5000,
            assertion,
          }),
      ),
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/checks/",
        () => HttpResponse.json([]),
      ),
    );

    const result = await getUptimeMonitorDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "cloudflare-mcp",
        uptimeMonitorId: "4509100000001001",
        period: "24h",
        checkLimit: 10,
      },
      context,
    );

    expect(getOutput(result).monitor.assertion).toEqual(assertion);
  });

  it("skips malformed short header arrays", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/",
        () =>
          HttpResponse.json({
            id: "4509100000001001",
            projectSlug: "cloudflare-mcp",
            environment: null,
            name: "API Health",
            status: "active",
            uptimeStatus: 1,
            url: "https://example.com/health",
            method: "GET",
            body: null,
            headers: [["Authorization"], ["X-Custom", "ok"]],
            intervalSeconds: 60,
            timeoutMs: 5000,
          }),
      ),
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/checks/",
        () => HttpResponse.json([]),
      ),
    );

    const result = await getUptimeMonitorDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "cloudflare-mcp",
        uptimeMonitorId: "4509100000001001",
        period: "24h",
        checkLimit: 10,
      },
      context,
    );

    expect(getOutput(result).monitor.headers).toEqual([
      { name: "X-Custom", value: "ok" },
    ]);
  });
});
