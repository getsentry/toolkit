import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { ApiValidationError } from "../../api-client/index.js";
import { UserInputError } from "../../errors.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import updateUptimeMonitor, {
  updateUptimeMonitorOutputSchema,
} from "./update-uptime-monitor.js";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

describe("update_uptime_monitor", () => {
  it("updates monitor status", async () => {
    const result = await updateUptimeMonitor.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "cloudflare-mcp",
        uptimeMonitorId: "4509100000001001",
        status: "disabled",
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(updateUptimeMonitorOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(
      (structuredContent as { monitor: { status: string } }).monitor.status,
    ).toBe("disabled");
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "monitor": {
          "downtimeThreshold": 3,
          "environment": "production",
          "id": "4509100000001001",
          "intervalSeconds": 60,
          "method": "GET",
          "name": "API Health",
          "owner": "the-goats",
          "projectSlug": "cloudflare-mcp",
          "recoveryThreshold": 1,
          "responseCaptureEnabled": true,
          "status": "disabled",
          "timeoutMs": 5000,
          "traceSampling": false,
          "uptimeStatus": "ok",
          "url": "https://example.com/health",
          "webUrl": "https://sentry-mcp-evals.sentry.io/monitors/4509100000001001/",
        },
      }
    `);
  });

  it("explains how to get a seat when enabling fails", async () => {
    mswServer.use(
      http.put(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/",
        () =>
          HttpResponse.json(
            {
              status: [
                "You don't have enough pay-as-you-go available to create a new seat",
              ],
            },
            { status: 400 },
          ),
      ),
    );

    const error = await updateUptimeMonitor
      .handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          projectSlug: "cloudflare-mcp",
          uptimeMonitorId: "4509100000001001",
          status: "active",
        },
        context,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UserInputError);
    expect((error as Error).message).toContain(
      "You don't have enough pay-as-you-go available to create a new seat",
    );
    expect((error as Error).message).toContain("Do not retry");
  });

  it("does not treat other validation errors as seat errors", async () => {
    mswServer.use(
      http.put(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/",
        () => HttpResponse.json({ url: ["Invalid URL"] }, { status: 400 }),
      ),
    );

    const error = await updateUptimeMonitor
      .handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          projectSlug: "cloudflare-mcp",
          uptimeMonitorId: "4509100000001001",
          status: "active",
        },
        context,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiValidationError);
  });

  it("clears owner when null is provided", async () => {
    let requestBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.put(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/",
        async ({ request }) => {
          requestBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: "4509100000001001",
            projectSlug: "cloudflare-mcp",
            environment: "production",
            name: "API Health",
            status: "active",
            uptimeStatus: 1,
            owner: null,
            recoveryThreshold: 1,
            downtimeThreshold: 3,
            url: "https://example.com/health",
            method: "GET",
            body: null,
            headers: [],
            intervalSeconds: 60,
            timeoutMs: 5000,
            traceSampling: false,
            responseCaptureEnabled: true,
            assertion: null,
          });
        },
      ),
    );

    const result = await updateUptimeMonitor.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "cloudflare-mcp",
        uptimeMonitorId: "4509100000001001",
        owner: null,
      },
      context,
    );

    expect(requestBody).toEqual({ owner: null });
    assertStructuredOnlyResult(result);
    expect(
      (getStructuredContent(result) as { monitor: { owner?: string } }).monitor
        .owner,
    ).toBeUndefined();
  });

  it("rejects empty updates", async () => {
    await expect(
      updateUptimeMonitor.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          projectSlug: "cloudflare-mcp",
          uptimeMonitorId: "4509100000001001",
        },
        context,
      ),
    ).rejects.toThrow("Provide at least one field to update");
  });
});
