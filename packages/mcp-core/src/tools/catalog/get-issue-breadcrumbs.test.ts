import { eventFixture, mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import getIssueBreadcrumbs from "./get-issue-breadcrumbs.js";

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

    expect(result).toMatchInlineSnapshot(`
      "# Breadcrumbs for CLOUDFLARE-MCP-41

      **Event ID**: 7ca573c0f4814912aaa9bdc77d1a7d51
      **Total Breadcrumbs**: 4

      \`\`\`
      2025-04-08T21:14:50.000Z info    [fetch] GET /api/0/organizations/ [200] {"method":"GET","url":"/api/0/organizations/","status_code":200}
      2025-04-08T21:14:52.000Z warning [console] Deprecation warning: use v2 endpoint
      2025-04-08T21:14:55.000Z info    [navigation] {"from":"/dashboard","to":"/settings"}
      2025-04-08T21:15:04.000Z error   [console] Tool list_organizations is already registered
      \`\`\`

      Breadcrumbs show the trail of events leading up to the error, in chronological order.
      Use \`get_sentry_resource(resourceType='issue', organizationSlug='...', resourceId='CLOUDFLARE-MCP-41')\` for full issue details."
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

    expect(result).toContain("# Breadcrumbs for CLOUDFLARE-MCP-41");
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

    expect(result).toContain(
      "No breadcrumbs found in this event for the issue.",
    );
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

    expect(result).toContain("# Breadcrumbs for CLOUDFLARE-MCP-41");
    expect(result).toContain("**Event ID**: c49541c747cb4d8aa3efb70ca5aba243");
  });
});
