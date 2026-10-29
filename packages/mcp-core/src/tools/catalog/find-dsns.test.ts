import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getServerContext } from "../../test-setup";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import findDsns from "./find-dsns.js";

describe("find_dsns", () => {
  it("returns all project DSNs with status and rate limit as structured content", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/test-org/test-project/keys/",
        () =>
          HttpResponse.json([
            {
              id: 123,
              name: "Production",
              dsn: {
                public: "https://public@example.ingest.sentry.io/1",
                secret: "do-not-leak",
              },
              isActive: true,
              dateCreated: "2026-07-28T12:00:00.000Z",
              rateLimit: { window: 3600, count: 1000 },
              secretKey: "do-not-leak",
              backendOnlyField: "do-not-leak",
            },
            {
              id: "456",
              name: "Development",
              dsn: {
                public: "https://development@example.ingest.sentry.io/2",
              },
              isActive: false,
              dateCreated: "2026-07-28T12:00:00.000Z",
              rateLimit: null,
            },
          ]),
      ),
    );

    const result = await findDsns.handler(
      {
        organizationSlug: "test-org",
        projectSlug: "test-project",
        regionUrl: null,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "dsns": [
          {
            "dsn": "https://public@example.ingest.sentry.io/1",
            "id": "123",
            "isActive": true,
            "name": "Production",
            "rateLimit": {
              "count": 1000,
              "window": 3600,
            },
          },
          {
            "dsn": "https://development@example.ingest.sentry.io/2",
            "id": "456",
            "isActive": false,
            "name": "Development",
            "rateLimit": null,
          },
        ],
      }
    `);
  });

  it("returns an empty DSN array", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/test-org/empty-project/keys/",
        () => HttpResponse.json([]),
      ),
    );

    const result = await findDsns.handler(
      {
        organizationSlug: "test-org",
        projectSlug: "empty-project",
        regionUrl: null,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toEqual({ dsns: [] });
  });
});
