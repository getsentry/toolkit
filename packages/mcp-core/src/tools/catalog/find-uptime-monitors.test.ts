import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import findUptimeMonitors, {
  findUptimeMonitorsOutputSchema,
} from "./find-uptime-monitors.js";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

describe("find_uptime_monitors", () => {
  it("serializes uptime monitors", async () => {
    const result = await findUptimeMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        limit: 10,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findUptimeMonitorsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "monitors": [
          {
            "environment": "production",
            "id": "4509100000001001",
            "intervalSeconds": 60,
            "method": "GET",
            "name": "API Health",
            "owner": "the-goats",
            "projectSlug": "cloudflare-mcp",
            "status": "active",
            "uptimeStatus": "ok",
            "url": "https://example.com/health",
            "webUrl": "https://sentry-mcp-evals.sentry.io/monitors/4509100000001001/",
          },
        ],
      }
    `);
  });

  it("resolves projectSlug to project id query param", async () => {
    let requestUrl: string | undefined;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/uptime/",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json([]);
        },
      ),
    );

    await findUptimeMonitors.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        projectSlug: "cloudflare-mcp",
        environment: "production",
        owner: "team:123",
        query: "health",
        limit: 25,
      },
      context,
    );

    expect(requestUrl).toBeDefined();
    const params = new URL(requestUrl ?? "").searchParams;
    expect(params.get("project")).toBe("4509109104082945");
    expect(params.get("environment")).toBe("production");
    expect(params.get("owner")).toBe("team:123");
    expect(params.get("query")).toBe("health");
    expect(params.get("per_page")).toBe("26");
  });
});
