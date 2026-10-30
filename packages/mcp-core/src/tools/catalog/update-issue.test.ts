import { issueFixture, mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logIssue } from "../../telem/logging";
import { prepareToolParams } from "../catalog-runtime/availability.js";
import updateIssue from "./update-issue.js";

vi.mock("../../telem/logging", () => ({
  logIssue: vi.fn(),
}));

type MockIssue = typeof issueFixture;

const serverContext = {
  constraints: {
    organizationSlug: undefined,
  },
  accessToken: "access-token",
  userId: "1",
};

function createIssue(overrides: Partial<MockIssue> = {}): MockIssue {
  return {
    ...structuredClone(issueFixture),
    ...overrides,
  };
}

afterEach(() => {
  mswServer.resetHandlers();
  vi.clearAllMocks();
});

describe("update_issue", () => {
  it("updates issue status", async () => {
    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolved",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );
    expect(result).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 Updated in **sentry-mcp-evals**

      **Issue**: Error: Tool list_organizations is already registered
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Changes Made

      **Status**: unresolved → **resolved**

      ## Current Status

      **Status**: resolved
      **Assigned To**: Jane Developer

      ## Response Notes

      - The issue has been updated in Sentry.
      - Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="sentry-mcp-evals", resourceId="CLOUDFLARE-MCP-41")\`
      - The issue is now marked as resolved and will no longer generate alerts
      "
    `);
  });

  it("updates issue assignment", async () => {
    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: undefined,
        assignedTo: "john.doe",
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );
    expect(result).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 Updated in **sentry-mcp-evals**

      **Issue**: Error: Tool list_organizations is already registered
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Changes Made

      **Assigned To**: Jane Developer → **john.doe**

      ## Current Status

      **Status**: unresolved
      **Assigned To**: john.doe

      ## Response Notes

      - The issue has been updated in Sentry.
      - Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="sentry-mcp-evals", resourceId="CLOUDFLARE-MCP-41")\`
      "
    `);
  });

  it("unassigns an issue", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const currentIssue = createIssue();
    const updatedIssue = createIssue({ assignedTo: null });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        async ({ request }) => {
          requestBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(updatedIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: undefined,
        assignedTo: null,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(requestBody).toEqual({ assignedTo: "" });
    expect(result).toContain(
      "**Assigned To**: Jane Developer → **Unassigned**",
    );
    expect(result).toContain("**Assigned To**: Unassigned");
  });

  it("skips status updates when the requested status is already set", async () => {
    let putCalled = false;
    const currentIssue = createIssue({
      status: "resolved",
      statusDetails: {},
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => {
          putCalled = true;
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolved",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(putCalled).toBe(false);
    expect(result).toContain("No changes were needed.");
    expect(result).toContain("**Status**: resolved");
  });

  it("skips assignment updates when the requested assignee is already set", async () => {
    let putCalled = false;
    const currentIssue = createIssue();

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => {
          putCalled = true;
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: undefined,
        assignedTo: "user:12345",
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(putCalled).toBe(false);
    expect(result).toContain("No changes were needed.");
    expect(result).not.toContain("→");
  });

  it("updates both status and assignment", async () => {
    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolved",
        assignedTo: "me",
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );
    expect(result).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 Updated in **sentry-mcp-evals**

      **Issue**: Error: Tool list_organizations is already registered
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Changes Made

      **Status**: unresolved → **resolved**
      **Assigned To**: Jane Developer → **You**

      ## Current Status

      **Status**: resolved
      **Assigned To**: me

      ## Response Notes

      - The issue has been updated in Sentry.
      - Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="sentry-mcp-evals", resourceId="CLOUDFLARE-MCP-41")\`
      - The issue is now marked as resolved and will no longer generate alerts
      "
    `);
  });

  it("updates issue as resolved in next release", async () => {
    const currentIssue = createIssue({
      status: "unresolved",
      statusDetails: {},
    });
    const updatedIssue = createIssue({
      status: "resolved",
      statusDetails: {
        inNextRelease: true,
      },
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(updatedIssue),
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolvedInNextRelease",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(result).toContain(
      "**Status**: unresolved → **resolvedInNextRelease**",
    );
    expect(result).toContain("**Status**: resolvedInNextRelease");
    expect(result).toContain(
      "The issue is now marked as resolved in the upcoming release",
    );
  });

  it("skips updates when the issue is already resolved in next release", async () => {
    let putCalled = false;
    const currentIssue = createIssue({
      status: "resolved",
      statusDetails: {
        inNextRelease: true,
      },
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => {
          putCalled = true;
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolvedInNextRelease",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(putCalled).toBe(false);
    expect(result).toContain("No changes were needed.");
    expect(result).toContain("**Status**: resolvedInNextRelease");
  });

  it("assigns issue to team by slug", async () => {
    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: undefined,
        assignedTo: "team:the-goats",
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );
    expect(result).toContain("Assigned To");
    expect(result).toContain("team:the-goats");
  });

  it("ignores issue until it escalates by default", async () => {
    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "ignored",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );
    expect(result).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 Updated in **sentry-mcp-evals**

      **Issue**: Error: Tool list_organizations is already registered
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Changes Made

      **Status**: unresolved → **ignored**
      **Ignore Behavior**: **Until escalating**

      ## Current Status

      **Status**: ignored
      **Ignore Behavior**: Until escalating
      **Assigned To**: Jane Developer

      ## Response Notes

      - The issue has been updated in Sentry.
      - Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="sentry-mcp-evals", resourceId="CLOUDFLARE-MCP-41")\`
      - The issue is now ignored until it escalates
      "
    `);
  });

  it("ignores issue forever when requested", async () => {
    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "ignored",
        ignoreMode: "forever",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );
    expect(result).toContain("**Ignore Behavior**: Forever");
    expect(result).toContain("The issue is now ignored indefinitely");
  });

  it("ignores issue until it occurs a set number of times", async () => {
    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "ignored",
        ignoreMode: "untilOccurrenceCount",
        ignoreCount: 100,
        ignoreWindowMinutes: 60,
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );
    expect(result).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 Updated in **sentry-mcp-evals**

      **Issue**: Error: Tool list_organizations is already registered
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Changes Made

      **Status**: unresolved → **ignored**
      **Ignore Behavior**: **Until it occurs 100 times in 60 minutes**

      ## Current Status

      **Status**: ignored
      **Ignore Behavior**: Until it occurs 100 times in 60 minutes
      **Assigned To**: Jane Developer

      ## Response Notes

      - The issue has been updated in Sentry.
      - Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="sentry-mcp-evals", resourceId="CLOUDFLARE-MCP-41")\`
      - The issue is now ignored until it occurs 100 times in 60 minutes
      "
    `);
  });

  it("preserves existing ignore behavior when assigning an already ignored issue", async () => {
    let lastRequestBody: Record<string, unknown> | undefined;
    let currentIssue = createIssue({
      status: "ignored",
      substatus: "archived_until_condition_met",
      statusDetails: {
        ignoreCount: 3,
        ignoreWindow: 60,
      },
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        async ({ request }) => {
          lastRequestBody = (await request.json()) as Record<string, unknown>;
          currentIssue = {
            ...currentIssue,
            assignedTo: lastRequestBody.assignedTo ?? currentIssue.assignedTo,
          };
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "ignored",
        assignedTo: "john.doe",
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(lastRequestBody).toEqual({
      assignedTo: "john.doe",
    });
    expect(result).toContain(
      "**Ignore Behavior**: Until it occurs 3 times in 60 minutes",
    );
    expect(result).not.toContain("The issue is now ignored");
  });

  it("updates condition-based ignore behavior for already ignored issues", async () => {
    let lastRequestBody: Record<string, unknown> | undefined;
    let currentIssue = createIssue({
      status: "ignored",
      substatus: "archived_until_condition_met",
      statusDetails: {
        ignoreCount: 3,
        ignoreWindow: 60,
      },
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        async ({ request }) => {
          lastRequestBody = (await request.json()) as Record<string, unknown>;
          currentIssue = {
            ...currentIssue,
            status: "ignored",
            statusDetails: {
              ignoreCount: lastRequestBody.ignoreCount,
              ignoreWindow: lastRequestBody.ignoreWindow,
            },
          };
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "ignored",
        ignoreMode: "untilOccurrenceCount",
        ignoreCount: 10,
        ignoreWindowMinutes: 30,
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(lastRequestBody).toEqual({
      status: "ignored",
      substatus: "archived_until_condition_met",
      ignoreCount: 10,
      ignoreWindow: 30,
    });
    expect(result).toContain(
      "**Ignore Behavior**: Until it occurs 3 times in 60 minutes → **Until it occurs 10 times in 30 minutes**",
    );
    expect(result).toContain(
      "**Ignore Behavior**: Until it occurs 10 times in 30 minutes",
    );
  });

  it("returns no changes when the ignore behavior already matches", async () => {
    let putCalled = false;
    const currentIssue = createIssue({
      status: "ignored",
      substatus: "archived_until_condition_met",
      statusDetails: {
        ignoreCount: 3,
      },
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => {
          putCalled = true;
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "ignored",
        ignoreMode: "untilOccurrenceCount",
        ignoreCount: 3,
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(putCalled).toBe(false);
    expect(result).toContain("No changes were needed.");
    expect(result).toContain(
      "**Ignore Behavior**: Until it occurs 3 more times",
    );
  });

  it("rejects cross-family ignore changes for already ignored issues", async () => {
    let putCalled = false;
    const currentIssue = createIssue({
      status: "ignored",
      substatus: "archived_forever",
      statusDetails: {},
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => {
          putCalled = true;
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    await expect(
      updateIssue.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          status: "ignored",
          ignoreMode: "untilOccurrenceCount",
          ignoreCount: 10,
          assignedTo: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        serverContext,
      ),
    ).rejects.toThrow(
      "Changing ignore behavior on an already ignored issue between `untilEscalating`, `forever`, and condition-based modes is not supported.",
    );
    expect(putCalled).toBe(false);
  });

  it("returns no changes when the issue is already ignored as requested", async () => {
    let putCalled = false;
    const currentIssue = createIssue({
      status: "ignored",
      substatus: "archived_forever",
      statusDetails: {},
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => {
          putCalled = true;
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "ignored",
        ignoreMode: "forever",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(putCalled).toBe(false);
    expect(result).toContain("No changes were needed.");
    expect(result).toContain("**Ignore Behavior**: Forever");
  });

  it("treats archived_forever as authoritative over stale ignore details", async () => {
    let putCalled = false;
    const currentIssue = createIssue({
      status: "ignored",
      substatus: "archived_forever",
      statusDetails: {
        ignoreCount: 3,
      },
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => {
          putCalled = true;
          return HttpResponse.json(currentIssue);
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "ignored",
        ignoreMode: "forever",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(putCalled).toBe(false);
    expect(result).toContain("No changes were needed.");
    expect(result).toContain("**Ignore Behavior**: Forever");
  });

  it("validates required parameters", async () => {
    await expect(
      updateIssue.handler(
        {
          organizationSlug: undefined,
          issueId: undefined,
          status: undefined,
          assignedTo: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        serverContext,
      ),
    ).rejects.toThrow("Either `issueId` or `issueUrl` must be provided");
  });

  it("validates organization slug when using issueId", async () => {
    await expect(
      updateIssue.handler(
        {
          organizationSlug: undefined,
          issueId: "CLOUDFLARE-MCP-41",
          status: "resolved",
          assignedTo: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        serverContext,
      ),
    ).rejects.toThrow(
      "`organizationSlug` is required when providing `issueId`",
    );
  });

  it("rejects issues outside the active project constraint", async () => {
    await expect(
      updateIssue.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          status: "resolved",
          assignedTo: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        {
          ...serverContext,
          constraints: {
            ...serverContext.constraints,
            projectSlug: "frontend",
          },
        },
      ),
    ).rejects.toThrow(
      'Issue is outside the active project constraint. Expected project "frontend".',
    );
  });

  it("validates update parameters", async () => {
    await expect(
      updateIssue.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          status: undefined,
          assignedTo: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        serverContext,
      ),
    ).rejects.toThrow(
      "At least one of `status` or `assignedTo` must be provided to update the issue",
    );
  });

  it("validates ignore options require ignored status", async () => {
    await expect(
      updateIssue.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          status: "resolved",
          ignoreMode: "forever",
          assignedTo: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        serverContext,
      ),
    ).rejects.toThrow(
      "Ignore options can only be used when `status` is `ignored`",
    );
  });

  it("validates ignore windows require a matching count", async () => {
    await expect(
      updateIssue.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          status: "ignored",
          ignoreWindowMinutes: 60,
          assignedTo: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        serverContext,
      ),
    ).rejects.toThrow("`ignoreWindowMinutes` requires `ignoreCount`");
  });

  it("posts reason as a comment when updating issue status", async () => {
    let commentPosted: { text: string } | undefined;
    const currentIssue = createIssue({
      status: "unresolved",
      statusDetails: {},
    });
    const updatedIssue = createIssue({
      status: "resolved",
      statusDetails: {},
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(updatedIssue),
      ),
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/notes/",
        async ({ request }) => {
          commentPosted = (await request.json()) as { text: string };
          return HttpResponse.json({
            id: "12345",
            text: commentPosted.text,
            type: "note",
            dateCreated: new Date().toISOString(),
          });
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolved",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
        reason: "Resolved because the root cause was fixed in PR #123",
      },
      serverContext,
    );

    expect(commentPosted).toEqual({
      text: "Resolved because the root cause was fixed in PR #123",
    });
    expect(result).toContain(
      '**Comment posted**: "Resolved because the root cause was fixed in PR #123"',
    );
  });

  it("does not post a comment when reason is not provided", async () => {
    let commentPosted = false;
    const currentIssue = createIssue({
      status: "unresolved",
      statusDetails: {},
    });
    const updatedIssue = createIssue({
      status: "resolved",
      statusDetails: {},
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(updatedIssue),
      ),
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/notes/",
        () => {
          commentPosted = true;
          return HttpResponse.json({});
        },
      ),
    );

    await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolved",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      serverContext,
    );

    expect(commentPosted).toBe(false);
  });

  it("posts reason as a comment even when no state changes are needed", async () => {
    let commentPosted: { text: string } | undefined;
    const currentIssue = createIssue({
      status: "resolved",
      statusDetails: {},
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/notes/",
        async ({ request }) => {
          commentPosted = (await request.json()) as { text: string };
          return HttpResponse.json({
            id: "12345",
            text: commentPosted.text,
            type: "note",
            dateCreated: new Date().toISOString(),
          });
        },
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolved",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
        reason: "Confirmed this is no longer an issue after deploy",
      },
      serverContext,
    );

    expect(commentPosted).toEqual({
      text: "Confirmed this is no longer an issue after deploy",
    });
    expect(result).toContain("No changes were needed.");
    expect(result).toContain(
      '**Comment posted**: "Confirmed this is no longer an issue after deploy"',
    );
  });

  it("does not throw when comment posting fails after a successful update", async () => {
    const currentIssue = createIssue({
      status: "unresolved",
      statusDetails: {},
    });
    const updatedIssue = createIssue({
      status: "resolved",
      statusDetails: {},
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(updatedIssue),
      ),
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/notes/",
        () => HttpResponse.json({ detail: "Rate limited" }, { status: 429 }),
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolved",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
        reason: "Resolving because fix deployed",
      },
      serverContext,
    );

    // Update succeeded — output should show it
    expect(result).toContain("**Status**: unresolved → **resolved**");
    // Comment failure should be reported gracefully, not thrown
    expect(result).toContain("**Comment not posted**");
  });

  it("does not call logIssue when comment posting fails with a 403 permission error", async () => {
    const currentIssue = createIssue({
      status: "unresolved",
      statusDetails: {},
    });
    const updatedIssue = createIssue({
      status: "resolved",
      statusDetails: {},
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(currentIssue),
      ),
      http.put(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(updatedIssue),
      ),
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/notes/",
        () =>
          HttpResponse.json(
            { detail: "You do not have permission to perform this action." },
            { status: 403 },
          ),
      ),
    );

    const result = await updateIssue.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        status: "resolved",
        assignedTo: undefined,
        issueUrl: undefined,
        regionUrl: null,
        reason: "Resolving because fix deployed",
      },
      serverContext,
    );

    // Update succeeded — output should show it
    expect(result).toContain("**Status**: unresolved → **resolved**");
    // Comment failure should be reported gracefully, not thrown
    expect(result).toContain("**Comment not posted**");
    // Expected 403 permission errors must NOT be logged as Sentry issues
    expect(logIssue).not.toHaveBeenCalled();
  });

  it("strips null bytes from reason before posting as a comment", () => {
    // prepareToolParams runs the Zod schema (including transforms) the same
    // way the MCP server does at runtime, so this exercises the full parse path.
    const prepared = prepareToolParams({
      tool: updateIssue,
      params: {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        reason: "\0 Resolved\0because\0fix deployed \0",
      },
      context: serverContext,
    });
    expect(prepared.reason).toBe("Resolvedbecausefix deployed");
  });

  it.each(["\0", " \0 \0 "])(
    "rejects a reason that is empty after removing null bytes: %j",
    (reason) => {
      expect(() =>
        prepareToolParams({
          tool: updateIssue,
          params: {
            organizationSlug: "sentry-mcp-evals",
            issueId: "CLOUDFLARE-MCP-41",
            reason,
          },
          context: serverContext,
        }),
      ).toThrow();
    },
  );
});
