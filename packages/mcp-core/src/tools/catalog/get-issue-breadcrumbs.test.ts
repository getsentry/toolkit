import { eventFixture, mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { issueBreadcrumbsOutputSchema } from "../../internal/tool-helpers/breadcrumbs.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import getIssueBreadcrumbs from "./get-issue-breadcrumbs.js";

type BreadcrumbsOutput = {
  issueId: string;
  eventId: string;
  breadcrumbs: Array<Record<string, unknown>>;
};

const context = {
  constraints: { organizationSlug: undefined },
  accessToken: "access-token",
  userId: "1",
};

afterEach(() => {
  mswServer.resetHandlers();
});

describe("get_issue_breadcrumbs", () => {
  it("returns breadcrumbs from the latest issue event", async () => {
    const result = await getIssueBreadcrumbs.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        eventId: "latest",
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(getIssueBreadcrumbs.outputSchema).toBe(issueBreadcrumbsOutputSchema);
    expect(issueBreadcrumbsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "breadcrumbs": [
          {
            "category": "fetch",
            "data": "{"method":"GET","url":"/api/0/organizations/","status_code":200}",
            "level": "info",
            "message": "GET /api/0/organizations/ [200]",
            "timestamp": "2025-04-08T21:14:50.000Z",
            "type": "http",
          },
          {
            "category": "console",
            "data": null,
            "level": "warning",
            "message": "Deprecation warning: use v2 endpoint",
            "timestamp": "2025-04-08T21:14:52.000Z",
            "type": "default",
          },
          {
            "category": "navigation",
            "data": "{"from":"/dashboard","to":"/settings"}",
            "level": "info",
            "message": null,
            "timestamp": "2025-04-08T21:14:55.000Z",
            "type": "navigation",
          },
          {
            "category": "console",
            "data": null,
            "level": "error",
            "message": "Tool list_organizations is already registered",
            "timestamp": "2025-04-08T21:15:04.000Z",
            "type": "error",
          },
        ],
        "eventId": "7ca573c0f4814912aaa9bdc77d1a7d51",
        "issueId": "CLOUDFLARE-MCP-41",
      }
    `);
  });

  it("accepts an issue URL", async () => {
    const result = await getIssueBreadcrumbs.handler(
      {
        issueUrl:
          "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41/",
        regionUrl: null,
        eventId: "latest",
      },
      context,
    );

    expect(getStructuredContent<BreadcrumbsOutput>(result).issueId).toBe(
      "CLOUDFLARE-MCP-41",
    );
  });

  it("rejects issues outside the active project constraint", async () => {
    await expect(
      getIssueBreadcrumbs.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          regionUrl: null,
          eventId: "latest",
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
      'Issue is outside the active project constraint. Expected project "frontend".',
    );
  });

  it("handles an event with no breadcrumbs", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/events/latest/",
        () =>
          HttpResponse.json({
            ...eventFixture,
            entries: eventFixture.entries.filter(
              (entry: { type: string }) => entry.type !== "breadcrumbs",
            ),
          }),
        { once: true },
      ),
    );

    const result = await getIssueBreadcrumbs.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        eventId: "latest",
      },
      context,
    );

    expect(getStructuredContent(result)).toEqual({
      issueId: "CLOUDFLARE-MCP-41",
      eventId: "7ca573c0f4814912aaa9bdc77d1a7d51",
      breadcrumbs: [],
    });
  });

  it("returns breadcrumbs for an explicit event ID", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/events/c49541c747cb4d8aa3efb70ca5aba243/",
        () =>
          HttpResponse.json({
            ...eventFixture,
            id: "c49541c747cb4d8aa3efb70ca5aba243",
          }),
        { once: true },
      ),
    );

    const result = await getIssueBreadcrumbs.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        eventId: "c49541c747cb4d8aa3efb70ca5aba243",
      },
      context,
    );

    expect(getStructuredContent<BreadcrumbsOutput>(result).eventId).toBe(
      "c49541c747cb4d8aa3efb70ca5aba243",
    );
  });

  it("bounds breadcrumb text and maps only documented fields", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/events/latest/",
        () =>
          HttpResponse.json({
            ...eventFixture,
            entries: [
              {
                type: "breadcrumbs",
                data: {
                  values: [
                    {
                      timestamp: "not-a-date",
                      level: null,
                      category: null,
                      type: "default",
                      message: `line one\nline two ${"x".repeat(200)}`,
                      data: { body: "y".repeat(300) },
                      event_id: "must-not-leak",
                    },
                  ],
                },
              },
            ],
          }),
        { once: true },
      ),
    );

    const result = await getIssueBreadcrumbs.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        eventId: "latest",
      },
      context,
    );

    const [crumb] = getStructuredContent<BreadcrumbsOutput>(result).breadcrumbs;
    expect(Object.keys(crumb!).sort()).toEqual([
      "category",
      "data",
      "level",
      "message",
      "timestamp",
      "type",
    ]);
    expect(crumb).toMatchObject({
      timestamp: "not-a-date",
      level: "info",
      category: null,
      type: "default",
    });
    expect(crumb!.message).toMatch(/^line one line two x+\.\.\.$/);
    expect((crumb!.message as string).length).toBe(123);
    expect((crumb!.data as string).length).toBe(203);
    expect(JSON.stringify(crumb)).not.toContain("must-not-leak");
  });
});
