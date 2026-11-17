import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { clientKeyFixture, mswServer } from "@sentry/mcp-server-mocks";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import updateDsn, { updateDsnOutputSchema } from "./update-dsn.js";

function getDsn(result: unknown) {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent(result);
  const parsed = updateDsnOutputSchema.parse(content);
  expect(parsed).toEqual(content);
  return parsed.dsn;
}
import { UserInputError } from "../../errors.js";

describe("update_dsn", () => {
  it("updates name and active status", async () => {
    const result = await updateDsn.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
        name: "New Key Name",
        isActive: false,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    const dsn = getDsn(result);
    expect(dsn).toMatchInlineSnapshot(`
      {
        "browserSdkVersion": "8.x",
        "dsn": "https://d20df0a1ab5031c7f3c7edca9c02814d@o4509106732793856.ingest.us.sentry.io/4509109104082945",
        "id": "d20df0a1ab5031c7f3c7edca9c02814d",
        "isActive": false,
        "loaderOptions": {
          "hasDebug": false,
          "hasPerformance": true,
          "hasReplay": true,
        },
        "name": "New Key Name",
        "rateLimit": null,
      }
    `);
    // Only the public DSN is exposed; secret keys and other key metadata stay private.
    const text = JSON.stringify(dsn);
    expect(text).not.toContain(clientKeyFixture.secret);
    expect(text).not.toContain(clientKeyFixture.dsn.secret);
    expect(text).not.toContain("dateCreated");
  });

  it("updates rate limit settings", async () => {
    const result = await updateDsn.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
        rateLimitWindow: 3600,
        rateLimitCount: 100,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(getDsn(result).rateLimit).toEqual({
      count: 100,
      windowSeconds: 3600,
    });
  });

  it("treats zero-valued rate limit updates as disabled", async () => {
    const result = await updateDsn.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
        rateLimitWindow: 3600,
        rateLimitCount: 0,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(getDsn(result).rateLimit).toBeNull();
  });

  it("treats zero-valued API rate limit responses as disabled", async () => {
    mswServer.use(
      http.put(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/:keyId/",
        ({ params }) =>
          HttpResponse.json(
            {
              id: String(params.keyId),
              name: "Default",
              dsn: {
                public:
                  "https://d20df0a1ab5031c7f3c7edca9c02814d@o4509106732793856.ingest.us.sentry.io/4509109104082945",
              },
              isActive: true,
              dateCreated: "2025-04-07T00:12:25.139394Z",
              rateLimit: {
                count: 0,
                window: 3600,
              },
            },
            { status: 200 },
          ),
        { once: true },
      ),
    );

    const result = await updateDsn.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
        rateLimitWindow: 3600,
        rateLimitCount: 100,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(getDsn(result).rateLimit).toBeNull();
  });

  it("disables rate limit entirely", async () => {
    const result = await updateDsn.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
        disableRateLimit: true,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(getDsn(result).rateLimit).toBeNull();
  });

  it("updates loader options", async () => {
    const result = await updateDsn.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
        loaderHasReplay: true,
        loaderHasPerformance: false,
        loaderHasDebug: true,
        loaderHasFeedback: true,
        loaderHasLogsAndMetrics: true,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(getDsn(result).loaderOptions).toEqual({
      hasReplay: true,
      hasPerformance: false,
      hasDebug: true,
      hasFeedback: true,
      hasLogsAndMetrics: true,
    });
  });

  it("throws when no update fields are provided", async () => {
    await expect(
      updateDsn.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
          regionUrl: null,
        },
        {
          constraints: { organizationSlug: null, projectSlug: null },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("validates rate limit input combinations", async () => {
    const mockContext = {
      constraints: { organizationSlug: null, projectSlug: null },
      accessToken: "access-token",
      userId: "1",
    };

    await expect(
      updateDsn.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
          rateLimitWindow: 3600,
          regionUrl: null,
        },
        mockContext,
      ),
    ).rejects.toThrow(UserInputError);

    await expect(
      updateDsn.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
          rateLimitCount: 100,
          regionUrl: null,
        },
        mockContext,
      ),
    ).rejects.toThrow(UserInputError);

    await expect(
      updateDsn.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          keyId: "d20df0a1ab5031c7f3c7edca9c02814d",
          rateLimitWindow: 3600,
          rateLimitCount: 100,
          disableRateLimit: true,
          regionUrl: null,
        },
        mockContext,
      ),
    ).rejects.toThrow(UserInputError);
  });
});
