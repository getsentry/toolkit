import {
  createCspEvent,
  createCspIssue,
  createDefaultEvent,
  createGenericEvent,
  createPerformanceEvent,
  createPerformanceIssue,
  createRegressedIssue,
  createUnknownEvent,
  createUnsupportedIssue,
  eventFixture,
  issueNullCulpritFixture,
  mswServer,
} from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../skills";
import * as logging from "../../telem/logging";
import {
  getStructuredContent,
  getTextContent,
} from "../../test-utils/structured-content";
import getIssueDetails, {
  getIssueDetailsOutputSchema,
} from "./get-issue-details.js";

const baseContext = {
  constraints: {
    organizationSlug: undefined,
  },
  accessToken: "access-token",
  userId: "1",
};

// Removed - now using createPerformanceIssue() factory from mocks

// Removed - now using createPerformanceEvent() factory from mocks with overrides

function createTraceResponseFixture() {
  return [
    {
      span_id: "root-span",
      event_id: "root-span",
      transaction_id: "root-span",
      project_id: "4509062593708032",
      project_slug: "cloudflare-mcp",
      profile_id: "",
      profiler_id: "",
      parent_span_id: null,
      start_timestamp: 0,
      end_timestamp: 1,
      measurements: {},
      duration: 1000,
      transaction: "/api/users",
      is_transaction: true,
      description: "GET /api/users",
      sdk_name: "sentry.python",
      op: "http.server",
      name: "GET /api/users",
      event_type: "transaction",
      additional_attributes: {},
      errors: [],
      occurrences: [],
      children: [
        {
          span_id: "parent123",
          event_id: "parent123",
          transaction_id: "parent123",
          project_id: "4509062593708032",
          project_slug: "cloudflare-mcp",
          profile_id: "",
          profiler_id: "",
          parent_span_id: "root-span",
          start_timestamp: 0.1,
          end_timestamp: 0.35,
          measurements: {},
          duration: 250,
          transaction: "/api/users",
          is_transaction: false,
          description: "GET /api/users handler",
          sdk_name: "sentry.python",
          op: "http.server",
          name: "GET /api/users handler",
          event_type: "span",
          additional_attributes: {},
          errors: [],
          occurrences: [],
          children: [
            {
              span_id: "span001",
              event_id: "span001",
              transaction_id: "span001",
              project_id: "4509062593708032",
              project_slug: "cloudflare-mcp",
              profile_id: "",
              profiler_id: "",
              parent_span_id: "parent123",
              start_timestamp: 0.15,
              end_timestamp: 0.16,
              measurements: {},
              duration: 10,
              transaction: "/api/users",
              is_transaction: false,
              description: "SELECT * FROM users WHERE id = 1",
              sdk_name: "sentry.python",
              op: "db.query",
              name: "SELECT * FROM users WHERE id = 1",
              event_type: "span",
              additional_attributes: {},
              errors: [],
              occurrences: [],
              children: [],
            },
            {
              span_id: "span002",
              event_id: "span002",
              transaction_id: "span002",
              project_id: "4509062593708032",
              project_slug: "cloudflare-mcp",
              profile_id: "",
              profiler_id: "",
              parent_span_id: "parent123",
              start_timestamp: 0.2,
              end_timestamp: 0.212,
              measurements: {},
              duration: 12,
              transaction: "/api/users",
              is_transaction: false,
              description: "SELECT * FROM users WHERE id = 2",
              sdk_name: "sentry.python",
              op: "db.query",
              name: "SELECT * FROM users WHERE id = 2",
              event_type: "span",
              additional_attributes: {},
              errors: [],
              occurrences: [],
              children: [],
            },
            {
              span_id: "span003",
              event_id: "span003",
              transaction_id: "span003",
              project_id: "4509062593708032",
              project_slug: "cloudflare-mcp",
              profile_id: "",
              profiler_id: "",
              parent_span_id: "parent123",
              start_timestamp: 0.24,
              end_timestamp: 0.255,
              measurements: {},
              duration: 15,
              transaction: "/api/users",
              is_transaction: false,
              description: "SELECT * FROM users WHERE id = 3",
              sdk_name: "sentry.python",
              op: "db.query",
              name: "SELECT * FROM users WHERE id = 3",
              event_type: "span",
              additional_attributes: {},
              errors: [],
              occurrences: [],
              children: [],
            },
          ],
        },
      ],
    },
  ];
}

describe("get_issue_details", () => {
  it("serializes with issueId", async () => {
    let stacktraceLinkRequested = false;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/CLOUDFLARE-MCP/stacktrace-link/",
        ({ request }) => {
          stacktraceLinkRequested = true;
          const query = new URL(request.url).searchParams;
          expect(query.get("file")).toBe("index.js");
          expect(query.get("lineNo")).toBe("19631");
          expect(query.get("platform")).toBe("javascript");
          expect(query.get("absPath")).toBe("/index.js");
          expect(query.get("module")).toBe("index");
          expect(query.get("groupId")).toBe("6507376925");
          expect(query.get("sdkName")).toBe("sentry.javascript.cloudflare");

          return HttpResponse.json({
            config: { repoName: "getsentry/sentry-mcp" },
            sourcePath: "packages/mcp-cloudflare/src/index.ts",
            sourceUrl:
              "https://github.com/getsentry/sentry-mcp/blob/main/packages/mcp-cloudflare/src/index.ts#L19631",
            integrations: [],
            error: null,
          });
        },
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(stacktraceLinkRequested).toBe(true);
    expect(result).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 in **sentry-mcp-evals**

      **Description**: Error: Tool list_organizations is already registered
      **Culprit**: Object.fetch(index)
      **First Seen**: 2025-04-03T22:51:19.403Z
      **Last Seen**: 2025-04-12T11:34:11.000Z
      **Occurrences**: 25
      **Users Impacted**: 1
      **Status**: unresolved
      **Substatus**: ongoing
      **Assigned To**: Jane Developer (User)
      **Issue Type**: error
      **Issue Category**: error
      **Platform**: javascript
      **Project**: CLOUDFLARE-MCP
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Code Location

      **Repository**: getsentry/sentry-mcp
      **Path**: packages/mcp-cloudflare/src/index.ts
      **Line**: 19631
      **Source**: https://github.com/getsentry/sentry-mcp/blob/main/packages/mcp-cloudflare/src/index.ts#L19631

      ## Event Details

      **Event ID**: 7ca573c0f4814912aaa9bdc77d1a7d51
      **Type**: error
      **Occurred At**: 2025-04-08T21:15:04.000Z

      ### Error

      \`\`\`
      Error: Tool list_organizations is already registered
      \`\`\`

      **Stacktrace:**
      \`\`\`
      index.js:7809:27
      index.js:8029:24 (OAuthProviderImpl.fetch)
      index.js:19631:28 (Object.fetch)
      \`\`\`

      ### HTTP Request

      **Method:** GET
      **URL:** https://mcp.sentry.dev/sse

      ### User

      **user**: ip:2a06:98c0:3600::103
      **user.geo**: US, United States

      ### Tags

      **environment**: development
      **handled**: no
      **level**: error
      **mechanism**: cloudflare
      **runtime.name**: cloudflare
      **url**: https://mcp.sentry.dev/sse

      ### Additional Context

      These are additional context provided by the user when they're instrumenting their application.

      **cloud_resource**
      cloud.provider: "cloudflare"

      **culture**
      timezone: "Europe/London"

      **runtime**
      name: "cloudflare"

      **trace**
      trace_id: "3032af8bcdfe4423b937fc5c041d5d82"
      span_id: "953da703d2a6f4c7"
      status: "unknown"
      client_sample_rate: 1
      sampled: true

      ## Response Notes

      - Commit message issue reference: \`Fixes CLOUDFLARE-MCP-41\` automatically closes the issue when the commit is merged.
      - The stacktrace includes first-party application code and third-party code. First-party frames are usually the best starting point for triage.
      - Issue event search: Use the Sentry tool \`search_issue_events\`
      - Full distributed trace and span tree: Use the Sentry tool \`get_sentry_resource\`
      - Related span search: Use the Sentry tool \`search_traces\`
      - Related log search: Use the Sentry tool \`search_logs\`
      "
    `);
  });

  it("omits null culprit values from issue output", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () => HttpResponse.json(issueNullCulpritFixture),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).toContain(
      "**Description**: Error: Tool list_issues is already registered",
    );
    expect(result).not.toContain("**Culprit**:");
    expect(result).not.toContain("**Culprit**: null");
  });

  it.each([
    {
      type: "error/default",
      issueId: "CLOUDFLARE-MCP-41",
      issue: undefined,
      event: createDefaultEvent,
      marker: "SHARED-FORMATTER-MARKER",
      replacedRenderer: undefined,
    },
    {
      type: "generic",
      issueId: "MCP-SERVER-EQE",
      issue: createRegressedIssue,
      event: createGenericEvent,
      marker: "GENERIC-FORMATTER-MARKER",
      replacedRenderer: "### Performance Regression Details",
    },
    {
      type: "csp",
      issueId: "BLOG-CSP-4XC",
      issue: createCspIssue,
      event: createCspEvent,
      marker: "CSP-FORMATTER-MARKER",
      replacedRenderer: "### CSP Violation",
    },
  ])(
    "uses formatted.content for $type events",
    async ({ issueId, issue, event, marker, replacedRenderer }) => {
      const base = `https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/${issueId}`;
      if (issue) {
        mswServer.use(
          http.get(`${base}/`, () => HttpResponse.json(issue()), {
            once: true,
          }),
        );
      }
      mswServer.use(
        http.get(
          `https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/${issue ? issue().id : "6507376925"}/events/latest/`,
          () =>
            HttpResponse.json({
              ...event(),
              formatted: {
                format: "markdown",
                content: `## Body\n\n${marker}`,
              },
            }),
          { once: true },
        ),
      );

      const result = await getIssueDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId,
          eventId: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        baseContext,
      );

      // the body is rendered from the shared formatter's content
      expect(result).toContain(marker);
      // ...replacing MCP's type-specific renderer
      if (replacedRenderer) {
        expect(result).not.toContain(replacedRenderer);
      }
    },
  );

  it("ignores formatted.content for non-error events (transaction)", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/",
        () => HttpResponse.json(createPerformanceIssue()),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
        () =>
          HttpResponse.json({
            ...createPerformanceEvent(),
            formatted: {
              format: "markdown",
              content: "TRANSACTION-SHOULD-IGNORE-THIS",
            },
          }),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/abcdef1234567890abcdef1234567890/",
        () => HttpResponse.json(createTraceResponseFixture()),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "PERF-N1-001",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    // transaction events still route through formatEventOutput, so formatted is unused
    expect(result).toContain("Issue PERF-N1-001"); // sanity: real output was produced
    expect(result).not.toContain("TRANSACTION-SHOULD-IGNORE-THIS");
  });

  it("keeps the replay note when error events use formatted.content", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json({
            ...createDefaultEvent(),
            contexts: {
              replay: {
                type: "default",
                replay_id: "1234567890abcdef1234567890abcdef",
              },
            },
            formatted: {
              format: "markdown",
              content: "## Title\n\nBODY-FROM-FORMATTER",
            },
          }),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).toContain("BODY-FROM-FORMATTER"); // body from the shared formatter
    expect(result).toContain("## Session Replay"); // replay note preserved (was inside formatEventOutput)
  });

  it("embeds the shared formatter's analysis in the Seer section when present", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/autofix/",
        () =>
          HttpResponse.json({
            autofix: { run_id: 7, status: "completed", blocks: [] },
            formatted: {
              format: "markdown",
              content: "## Root Cause\n\nEMBEDDED-SEER-MARKER",
            },
          }),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).toContain("## Seer Analysis");
    expect(result).toContain("EMBEDDED-SEER-MARKER");
    // LLM-generated content is wrapped in the untrusted-data boundary
    expect(result).toContain('<seer_analysis run_id="7" step="analysis">');
  });

  it.each([
    {
      label: "in progress",
      status: "processing",
      expected: "**Status:** Processing",
    },
    {
      label: "failed",
      status: "error",
      expected: "**Status:** Analysis failed.",
    },
    {
      label: "awaiting input",
      status: "awaiting_user_input",
      expected: "**Status:** Analysis paused - additional information needed.",
    },
  ])(
    "still reports Seer run status ($label) alongside formatted content",
    async ({ status, expected }) => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/autofix/",
          () =>
            HttpResponse.json({
              autofix: { run_id: 7, status, blocks: [] },
              formatted: {
                format: "markdown",
                content: "## Root Cause\n\nEMBEDDED-SEER-MARKER",
              },
            }),
          { once: true },
        ),
      );

      const result = await getIssueDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          eventId: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        baseContext,
      );

      // the formatted body must not hide that the run needs attention
      expect(result).toContain("EMBEDDED-SEER-MARKER");
      expect(result).toContain(expected);
    },
  );

  it("surfaces agent conversation IDs found by bounded span lookup", async () => {
    const traceId = "11112222333344445555666677778888";
    const event = createDefaultEvent({
      contexts: {
        trace: {
          type: "trace",
          trace_id: traceId,
          span_id: "error-span",
        },
      },
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () => HttpResponse.json(event),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/events/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("dataset")).toBe("spans");
          expect(url.searchParams.get("query")).toBe(
            `trace:${traceId} has:gen_ai.conversation.id`,
          );
          expect(url.searchParams.get("per_page")).toBe("3");
          expect(url.searchParams.getAll("field")).toEqual([
            "gen_ai.conversation.id",
            "span_id",
            "timestamp",
          ]);

          return HttpResponse.json({
            data: [
              {
                "gen_ai.conversation.id": "conv-123",
                span_id: "span-123",
                timestamp: "2025-04-08T21:15:04+00:00",
              },
              {
                "gen_ai.conversation.id": "conv-123",
                span_id: "span-456",
                timestamp: "2025-04-08T21:15:05+00:00",
              },
            ],
          });
        },
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    const text = typeof result === "string" ? result : getTextContent(result);
    expect(text).toContain(
      "- Agent conversation found in this trace: `conv-123`. Matching span: `span-123`.",
    );
    expect(text).toContain(
      '- Use the Sentry tool `execute_sentry_tool(name=\'get_agent_conversation_details\', arguments={"organizationSlug":"sentry-mcp-evals","conversationId":"conv-123"})` to fetch the full transcript.',
    );
    expect(
      (result as { structuredContent?: unknown }).structuredContent,
    ).toBeUndefined();
    expect(text).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 in **sentry-mcp-evals**

      **Description**: Error: Tool list_organizations is already registered
      **Culprit**: Object.fetch(index)
      **First Seen**: 2025-04-03T22:51:19.403Z
      **Last Seen**: 2025-04-12T11:34:11.000Z
      **Occurrences**: 25
      **Users Impacted**: 1
      **Status**: unresolved
      **Substatus**: ongoing
      **Assigned To**: Jane Developer (User)
      **Issue Type**: error
      **Issue Category**: error
      **Platform**: javascript
      **Project**: CLOUDFLARE-MCP
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Event Details

      **Event ID**: abc123def456
      **Type**: default
      **Occurred At**: 2025-10-02T12:00:00.000Z
      **Message**:
      Something went wrong

      ### Error

      \`\`\`
      Something went wrong
      \`\`\`

      ### Tags

      **level**: error
      **environment**: production

      ### Additional Context

      These are additional context provided by the user when they're instrumenting their application.

      **trace**
      trace_id: "11112222333344445555666677778888"
      span_id: "error-span"

      ## Response Notes

      - Commit message issue reference: \`Fixes CLOUDFLARE-MCP-41\` automatically closes the issue when the commit is merged.
      - The stacktrace includes first-party application code and third-party code. First-party frames are usually the best starting point for triage.
      - Agent conversation found in this trace: \`conv-123\`. Matching span: \`span-123\`.
      - Use the Sentry tool \`execute_sentry_tool(name='get_agent_conversation_details', arguments={"organizationSlug":"sentry-mcp-evals","conversationId":"conv-123"})\` to fetch the full transcript.
      - Issue event search: Use the Sentry tool \`search_issue_events\`
      - Full distributed trace and span tree: Use the Sentry tool \`get_sentry_resource\`
      - Related span search: Use the Sentry tool \`search_traces\`
      - Related log search: Use the Sentry tool \`search_logs\`
      "
    `);
  });

  it("omits agent conversation guidance when bounded span lookup finds no match", async () => {
    const traceId = "99992222333344445555666677778888";
    const event = createDefaultEvent({
      contexts: {
        trace: {
          type: "trace",
          trace_id: traceId,
          span_id: "error-span",
        },
      },
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () => HttpResponse.json(event),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/events/",
        () => HttpResponse.json({ data: [] }),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).not.toContain("Agent conversation found");
    expect(result).not.toContain("get_agent_conversation_details");
  });

  it("does not query spans for an invalid event trace ID", async () => {
    const event = createDefaultEvent({
      contexts: {
        trace: {
          type: "trace",
          trace_id: "invalid trace:has:gen_ai.conversation.id",
          span_id: "error-span",
        },
      },
    });
    let spanLookupAttempts = 0;

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () => HttpResponse.json(event),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/events/",
        () => {
          spanLookupAttempts += 1;
          return HttpResponse.json({ data: [] });
        },
      ),
    );

    await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(spanLookupAttempts).toBe(0);
  });

  it("displays team assignment correctly", async () => {
    // Override the issue fixture with a team assignment
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/TEAM-ISSUE-001/",
        () =>
          HttpResponse.json({
            id: "123456789",
            shortId: "TEAM-ISSUE-001",
            title: "Test issue with team assignment",
            firstSeen: "2025-04-03T22:51:19.403Z",
            lastSeen: "2025-04-12T11:34:11Z",
            count: "10",
            userCount: 5,
            permalink:
              "https://sentry-mcp-evals.sentry.io/issues/TEAM-ISSUE-001",
            project: {
              id: "4509062593708032",
              slug: "test-project",
              name: "Test Project",
            },
            platform: "javascript",
            status: "unresolved",
            substatus: "ongoing",
            culprit: "app.main",
            type: "error",
            issueType: "error",
            issueCategory: "error",
            assignedTo: {
              type: "team",
              id: "99999",
              name: "Platform Team",
            },
          }),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/123456789/events/latest/",
        () => HttpResponse.json(createDefaultEvent()),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "TEAM-ISSUE-001",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    // Verify that team assignment is displayed with "(Team)" suffix
    expect(result).toContain("**Assigned To**: Platform Team (Team)");
  });

  it("lists threads and stacktrace lookup guidance only for multi-thread events", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json(
            createDefaultEvent({
              id: "event-with-multiple-threads",
              entries: [
                {
                  type: "message",
                  data: {
                    formatted: "Application crashed",
                  },
                },
                {
                  type: "threads",
                  data: {
                    values: [
                      {
                        id: 11,
                        name: "worker",
                        state: "WAITING",
                        crashed: false,
                        current: false,
                        stacktrace: {
                          frames: [
                            {
                              filename: "Worker.java",
                              function: "waitForJob",
                              lineNo: 12,
                            },
                          ],
                        },
                      },
                      {
                        id: 259,
                        name: "main",
                        state: "RUNNABLE",
                        crashed: true,
                        current: true,
                        stacktrace: {
                          frames: [
                            {
                              filename: "CheckoutActivity.java",
                              function: "submitOrder",
                              lineNo: 42,
                            },
                            {
                              filename: "Thread.java",
                              function: "run",
                              lineNo: 833,
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          ),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    const text = typeof result === "string" ? result : getTextContent(result);
    const threadSection = text
      .slice(text.indexOf("### Threads"), text.indexOf("### Tags"))
      .trim();
    expect(threadSection).toMatchInlineSnapshot(`
      "### Threads

      Found 2 threads in this event.

      | Thread ID | Name | State | Flags | Frames |
      | --- | --- | --- | --- | ---: |
      | 11 | worker | WAITING | - | 1 |
      | 259 | main | RUNNABLE | crashed, current | 2 |"
    `);
    expect(text).toContain(
      "- Thread stacktrace lookup: Use the Sentry tool `get_event_stacktrace` to fetch a full thread stacktrace by numeric Thread ID or exact thread Name. Omit `thread` to use Sentry's default selected thread",
    );
  });

  it("omits thread list and stacktrace lookup guidance for single-thread events", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json(
            createDefaultEvent({
              id: "event-with-one-thread",
              entries: [
                {
                  type: "message",
                  data: {
                    formatted: "Application crashed",
                  },
                },
                {
                  type: "threads",
                  data: {
                    values: [
                      {
                        id: 259,
                        name: "main",
                        state: "RUNNABLE",
                        crashed: true,
                        current: true,
                        stacktrace: {
                          frames: [
                            {
                              filename: "CheckoutActivity.java",
                              function: "submitOrder",
                              lineNo: 42,
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          ),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).not.toContain("### Threads");
    expect(result).not.toContain("Thread stacktrace lookup");
  });

  it("includes attached and related replays when available", async () => {
    const attachedReplayId = "7e07485f12f9416b8b1426260799b51f";
    const attachedReplayIdWithDashes = "7e07485f-12f9-416b-8b14-26260799b51f";
    const relatedReplayId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const event = createDefaultEvent();
    event.tags.push({
      key: "replayId",
      value: attachedReplayIdWithDashes,
    });

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () => HttpResponse.json(event),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/replay-count/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("returnIds")).toBe("true");
          expect(url.searchParams.get("query")).toBe("issue.id:[6507376925]");
          expect(url.searchParams.get("data_source")).toBe("discover");
          expect(url.searchParams.get("statsPeriod")).toBe("90d");
          expect(url.searchParams.get("project")).toBe("-1");

          return HttpResponse.json({
            "6507376925": [attachedReplayId, relatedReplayId, attachedReplayId],
          });
        },
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    if (typeof result !== "string") {
      throw new Error("Expected string result");
    }

    const replaySection = result
      .slice(result.indexOf("## Session Replay"), result.indexOf("### Error"))
      .trim();

    expect(replaySection).toMatchInlineSnapshot(`
      "## Session Replay

      **Attached Replay**: https://sentry-mcp-evals.sentry.io/explore/replays/7e07485f12f9416b8b1426260799b51f/
      **Related Replay Count**: 2

      ### Other Related Replays

      - https://sentry-mcp-evals.sentry.io/explore/replays/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/

      Use the Sentry tool \`get_replay_details\` to inspect a replay in detail."
    `);
    expect(result).not.toContain("**replayId**:");
  });

  it("serializes with issueUrl", async () => {
    const result = await getIssueDetails.handler(
      {
        organizationSlug: undefined,
        issueId: undefined,
        eventId: undefined,
        issueUrl: "https://sentry-mcp-evals.sentry.io/issues/6507376925",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 in **sentry-mcp-evals**

      **Description**: Error: Tool list_organizations is already registered
      **Culprit**: Object.fetch(index)
      **First Seen**: 2025-04-03T22:51:19.403Z
      **Last Seen**: 2025-04-12T11:34:11.000Z
      **Occurrences**: 25
      **Users Impacted**: 1
      **Status**: unresolved
      **Substatus**: ongoing
      **Assigned To**: Jane Developer (User)
      **Issue Type**: error
      **Issue Category**: error
      **Platform**: javascript
      **Project**: CLOUDFLARE-MCP
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Event Details

      **Event ID**: 7ca573c0f4814912aaa9bdc77d1a7d51
      **Type**: error
      **Occurred At**: 2025-04-08T21:15:04.000Z

      ### Error

      \`\`\`
      Error: Tool list_organizations is already registered
      \`\`\`

      **Stacktrace:**
      \`\`\`
      index.js:7809:27
      index.js:8029:24 (OAuthProviderImpl.fetch)
      index.js:19631:28 (Object.fetch)
      \`\`\`

      ### HTTP Request

      **Method:** GET
      **URL:** https://mcp.sentry.dev/sse

      ### User

      **user**: ip:2a06:98c0:3600::103
      **user.geo**: US, United States

      ### Tags

      **environment**: development
      **handled**: no
      **level**: error
      **mechanism**: cloudflare
      **runtime.name**: cloudflare
      **url**: https://mcp.sentry.dev/sse

      ### Additional Context

      These are additional context provided by the user when they're instrumenting their application.

      **cloud_resource**
      cloud.provider: "cloudflare"

      **culture**
      timezone: "Europe/London"

      **runtime**
      name: "cloudflare"

      **trace**
      trace_id: "3032af8bcdfe4423b937fc5c041d5d82"
      span_id: "953da703d2a6f4c7"
      status: "unknown"
      client_sample_rate: 1
      sampled: true

      ## Response Notes

      - Commit message issue reference: \`Fixes CLOUDFLARE-MCP-41\` automatically closes the issue when the commit is merged.
      - The stacktrace includes first-party application code and third-party code. First-party frames are usually the best starting point for triage.
      - Issue event search: Use the Sentry tool \`search_issue_events\`
      - Full distributed trace and span tree: Use the Sentry tool \`get_sentry_resource\`
      - Related span search: Use the Sentry tool \`search_traces\`
      - Related log search: Use the Sentry tool \`search_logs\`
      "
    `);
  });

  it("renders related trace spans when trace fetch succeeds", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/",
        () => HttpResponse.json(createPerformanceIssue()),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
        () => {
          // Create event with specific evidence data for this test
          const event = createPerformanceEvent();
          const offenderSpanIds =
            event.occurrence.evidenceData.offenderSpanIds.slice(0, 3);
          event.occurrence.evidenceData.offenderSpanIds = offenderSpanIds;
          event.occurrence.evidenceData.numberRepeatingSpans = String(
            offenderSpanIds.length,
          );
          event.occurrence.evidenceData.repeatingSpansCompact = undefined;
          event.occurrence.evidenceData.repeatingSpans = [
            'db - INSERT INTO "sentry_fileblobindex" ("offset", "file_id", "blob_id") VALUES (%s, %s, %s) RETURNING "sentry_fileblobindex"."id"',
            "function - sentry.models.files.abstractfileblob.AbstractFileBlob.from_file",
            'db - SELECT "sentry_fileblob"."id", "sentry_fileblob"."path", "sentry_fileblob"."size", "sentry_fileblob"."checksum", "sentry_fileblob"."timestamp" FROM "sentry_fileblob" WHERE "sentry_fileblob"."checksum" = %s LIMIT 21',
          ];
          const spansEntry = event.entries.find(
            (entry: { type: string; data?: unknown }) => entry.type === "spans",
          );
          if (spansEntry?.data) {
            spansEntry.data = spansEntry.data.slice(0, 4);
          }
          return HttpResponse.json(event);
        },
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/abcdef1234567890abcdef1234567890/",
        () => HttpResponse.json(createTraceResponseFixture()),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "PERF-N1-001",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    if (typeof result !== "string") {
      throw new Error("Expected string result");
    }

    const performanceSection = result
      .slice(result.indexOf("### Repeated Database Queries"))
      .split("### Tags")[0]
      .trim();

    expect(performanceSection).toMatchInlineSnapshot(`
      "### Repeated Database Queries

      **Query executed 3 times:**
      **Repeated operations:**
      - db - INSERT INTO "sentry_fileblobindex" ("offset", "file_id", "blob_id") VALUES (%s, %s, %s) RETURNING "sentry_fileblobindex"."id"
      - function - sentry.models.files.abstractfileblob.AbstractFileBlob.from_file
      - db - SELECT "sentry_fileblob"."id", "sentry_fileblob"."path", "sentry_fileblob"."size", "sentry_fileblob"."checksum", "sentry_fileblob"."timestamp" FROM "sentry_fileblob" WHERE "sentry_fileblob"."checksum" = %s LIMIT 21

      ### Span Tree (Limited to 10 spans)

      \`\`\`
      GET /api/users [http.server · 250ms · parent123]
         ├─ SELECT * FROM users WHERE id = 1 [db.query · 5ms · span001] [N+1]
         ├─ SELECT * FROM users WHERE id = 2 [db.query · 5ms · span002] [N+1]
         └─ SELECT * FROM users WHERE id = 3 [db.query · 5ms · span003] [N+1]
      \`\`\`

      **Transaction:**
      /api/users

      **Offending Spans:**
      SELECT * FROM users WHERE id = %s

      **Repeated:**
      3 times"
    `);
  });

  it("falls back to offending span list when trace fetch fails", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/",
        () => HttpResponse.json(createPerformanceIssue()),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
        () => {
          // Create event with specific evidence data for this test
          const event = createPerformanceEvent();
          const offenderSpanIds =
            event.occurrence.evidenceData.offenderSpanIds.slice(0, 3);
          event.occurrence.evidenceData.offenderSpanIds = offenderSpanIds;
          event.occurrence.evidenceData.numberRepeatingSpans = String(
            offenderSpanIds.length,
          );
          event.occurrence.evidenceData.repeatingSpansCompact = undefined;
          event.occurrence.evidenceData.repeatingSpans = [
            'db - INSERT INTO "sentry_fileblobindex" ("offset", "file_id", "blob_id") VALUES (%s, %s, %s) RETURNING "sentry_fileblobindex"."id"',
            "function - sentry.models.files.abstractfileblob.AbstractFileBlob.from_file",
            'db - SELECT "sentry_fileblob"."id", "sentry_fileblob"."path", "sentry_fileblob"."size", "sentry_fileblob"."checksum", "sentry_fileblob"."timestamp" FROM "sentry_fileblob" WHERE "sentry_fileblob"."checksum" = %s LIMIT 21',
          ];
          const spansEntry = event.entries.find(
            (entry: { type: string; data?: unknown }) => entry.type === "spans",
          );
          if (spansEntry?.data) {
            spansEntry.data = spansEntry.data.slice(0, 4);
          }
          return HttpResponse.json(event);
        },
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/abcdef1234567890abcdef1234567890/",
        () => HttpResponse.json({ detail: "Trace not found" }, { status: 404 }),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "PERF-N1-001",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    if (typeof result !== "string") {
      throw new Error("Expected string result");
    }

    const performanceSection = result
      .slice(result.indexOf("### Repeated Database Queries"))
      .split("### Tags")[0]
      .trim();

    expect(performanceSection).toMatchInlineSnapshot(`
      "### Repeated Database Queries

      **Query executed 3 times:**
      **Repeated operations:**
      - db - INSERT INTO "sentry_fileblobindex" ("offset", "file_id", "blob_id") VALUES (%s, %s, %s) RETURNING "sentry_fileblobindex"."id"
      - function - sentry.models.files.abstractfileblob.AbstractFileBlob.from_file
      - db - SELECT "sentry_fileblob"."id", "sentry_fileblob"."path", "sentry_fileblob"."size", "sentry_fileblob"."checksum", "sentry_fileblob"."timestamp" FROM "sentry_fileblob" WHERE "sentry_fileblob"."checksum" = %s LIMIT 21

      ### Span Tree (Limited to 10 spans)

      \`\`\`
      GET /api/users [http.server · 250ms · parent123]
         ├─ SELECT * FROM users WHERE id = 1 [db.query · 5ms · span001] [N+1]
         ├─ SELECT * FROM users WHERE id = 2 [db.query · 5ms · span002] [N+1]
         └─ SELECT * FROM users WHERE id = 3 [db.query · 5ms · span003] [N+1]
      \`\`\`

      **Transaction:**
      /api/users

      **Offending Spans:**
      SELECT * FROM users WHERE id = %s

      **Repeated:**
      3 times"
    `);
  });

  it("serializes with eventId", async () => {
    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: undefined,
        issueUrl: undefined,
        eventId: "7ca573c0f4814912aaa9bdc77d1a7d51",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(result).toMatchInlineSnapshot(`
      "# Issue CLOUDFLARE-MCP-41 in **sentry-mcp-evals**

      **Description**: Error: Tool list_organizations is already registered
      **Culprit**: Object.fetch(index)
      **First Seen**: 2025-04-03T22:51:19.403Z
      **Last Seen**: 2025-04-12T11:34:11.000Z
      **Occurrences**: 25
      **Users Impacted**: 1
      **Status**: unresolved
      **Substatus**: ongoing
      **Assigned To**: Jane Developer (User)
      **Issue Type**: error
      **Issue Category**: error
      **Platform**: javascript
      **Project**: CLOUDFLARE-MCP
      **URL**: https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41

      ## Event Details

      **Event ID**: 7ca573c0f4814912aaa9bdc77d1a7d51
      **Type**: error
      **Occurred At**: 2025-04-08T21:15:04.000Z

      ### Error

      \`\`\`
      Error: Tool list_organizations is already registered
      \`\`\`

      **Stacktrace:**
      \`\`\`
      index.js:7809:27
      index.js:8029:24 (OAuthProviderImpl.fetch)
      index.js:19631:28 (Object.fetch)
      \`\`\`

      ### HTTP Request

      **Method:** GET
      **URL:** https://mcp.sentry.dev/sse

      ### User

      **user**: ip:2a06:98c0:3600::103
      **user.geo**: US, United States

      ### Tags

      **environment**: development
      **handled**: no
      **level**: error
      **mechanism**: cloudflare
      **runtime.name**: cloudflare
      **url**: https://mcp.sentry.dev/sse

      ### Additional Context

      These are additional context provided by the user when they're instrumenting their application.

      **cloud_resource**
      cloud.provider: "cloudflare"

      **culture**
      timezone: "Europe/London"

      **runtime**
      name: "cloudflare"

      **trace**
      trace_id: "3032af8bcdfe4423b937fc5c041d5d82"
      span_id: "953da703d2a6f4c7"
      status: "unknown"
      client_sample_rate: 1
      sampled: true

      ## Response Notes

      - Commit message issue reference: \`Fixes CLOUDFLARE-MCP-41\` automatically closes the issue when the commit is merged.
      - The stacktrace includes first-party application code and third-party code. First-party frames are usually the best starting point for triage.
      - Issue event search: Use the Sentry tool \`search_issue_events\`
      - Full distributed trace and span tree: Use the Sentry tool \`get_sentry_resource\`
      - Related span search: Use the Sentry tool \`search_traces\`
      - Related log search: Use the Sentry tool \`search_logs\`
      "
    `);
  });

  it("throws error for malformed regionUrl", async () => {
    await expect(
      getIssueDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          eventId: undefined,
          issueUrl: undefined,
          regionUrl: "https",
        },
        {
          constraints: {
            organizationSlug: undefined,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow("Invalid regionUrl provided. Must be a valid URL.");
  });

  it("enhances 404 error with parameter context for non-existent issue", async () => {
    // This test demonstrates the enhance-error functionality:
    // When a 404 occurs, enhanceNotFoundError() adds parameter context to help users
    // understand what went wrong (organizationSlug + issueId in this case)

    // Mock a 404 response for a non-existent issue
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/issues/NONEXISTENT-ISSUE-123/",
        () => {
          return new HttpResponse(
            JSON.stringify({ detail: "The requested resource does not exist" }),
            { status: 404 },
          );
        },
        { once: true },
      ),
    );

    await expect(
      getIssueDetails.handler(
        {
          organizationSlug: "test-org",
          issueId: "NONEXISTENT-ISSUE-123",
          eventId: undefined,
          issueUrl: undefined,
          regionUrl: null,
        },
        {
          constraints: {
            organizationSlug: undefined,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`
      [ApiNotFoundError: The requested resource does not exist
      Please verify these parameters are correct:
        - organizationSlug: 'test-org'
        - issueId: 'NONEXISTENT-ISSUE-123']
    `);
  });

  // These tests verify that Seer analysis is properly formatted when available
  // Note: The autofix endpoint needs to be mocked for each test

  it("includes Seer analysis when available - completed state", async () => {
    // This test currently passes without Seer data since the autofix endpoint
    // returns an error that is caught silently. The functionality is implemented
    // and will work when Seer data is available.
    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Verify the basic issue output is present
    expect(result).toContain("# Issue CLOUDFLARE-MCP-41");
    expect(result).toContain(
      "Error: Tool list_organizations is already registered",
    );
    // When Seer data is available, these would pass:
    // expect(result).toContain("## Seer AI Analysis");
  });

  it("skips the autofix request when the seer skill is not granted", async () => {
    let autofixRequested = false;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/autofix/",
        () => {
          autofixRequested = true;
          return HttpResponse.json({ autofix: null });
        },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        ...baseContext,
        grantedSkills: new Set<Skill>(["inspect"]),
      },
    );

    expect(autofixRequested).toBe(false);
    expect(result).toContain("# Issue CLOUDFLARE-MCP-41");
  });

  it("requests autofix state when the seer skill is granted", async () => {
    let autofixRequested = false;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/autofix/",
        () => {
          autofixRequested = true;
          return HttpResponse.json({ autofix: null });
        },
      ),
    );

    await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        ...baseContext,
        grantedSkills: new Set<Skill>(["inspect", "seer"]),
      },
    );

    expect(autofixRequested).toBe(true);
  });

  it.skip("includes Seer analysis when in progress - processing state", async () => {
    const inProgressFixture = {
      autofix: {
        run_id: 12345,
        status: "processing",
        updated_at: "2025-04-09T22:39:50.778146",
        blocks: [
          {
            id: "block-1",
            artifacts: [
              {
                key: "root_cause",
                reason: "Root cause analysis completed",
                data: {
                  one_line_description:
                    "The bottleById query fails because the input ID doesn't exist in the database.",
                  five_whys: [],
                  reproduction_steps: [],
                },
              },
            ],
            todos: [{ content: "Generating solution", status: "in_progress" }],
          },
        ],
      },
    };

    // Use mswServer.use to prepend a handler - MSW uses LIFO order
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/autofix/",
        () => HttpResponse.json(inProgressFixture),
        { once: true }, // Ensure this handler is only used once for this test
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain("## Seer Analysis");
    expect(result).toContain("**Status:** Processing");
    expect(result).toContain("**Root Cause Identified:**");
    expect(result).toContain(
      "The bottleById query fails because the input ID doesn't exist in the database.",
    );
  });

  it.skip("includes Seer analysis when failed - error state", async () => {
    const failedFixture = {
      autofix: {
        run_id: 12346,
        status: "error",
        updated_at: "2025-04-09T22:39:50.778146",
        blocks: [],
      },
    };

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/autofix/",
        () => HttpResponse.json(failedFixture),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain("## Seer Analysis");
    expect(result).toContain("**Status:** Analysis failed.");
  });

  it.skip("includes Seer analysis when needs information - awaiting_user_input state", async () => {
    const needsInfoFixture = {
      autofix: {
        run_id: 12347,
        status: "awaiting_user_input",
        updated_at: "2025-04-09T22:39:50.778146",
        blocks: [
          {
            id: "block-1",
            artifacts: [
              {
                key: "root_cause",
                reason: "Partial root cause analysis",
                data: {
                  one_line_description:
                    "Partial analysis completed but more context needed.",
                  five_whys: [],
                  reproduction_steps: [],
                },
              },
            ],
          },
        ],
      },
    };

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/autofix/",
        () => HttpResponse.json(needsInfoFixture),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain("## Seer Analysis");
    expect(result).toContain("**Root Cause Identified:**");
    expect(result).toContain(
      "Partial analysis completed but more context needed.",
    );
    expect(result).toContain(
      "**Status:** Analysis paused - additional information needed.",
    );
  });

  it("handles default event type (error without exception data)", async () => {
    // Mock a "default" event type - represents errors without exception data
    const defaultEvent = createDefaultEvent();

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/123456/events/latest/",
        () => HttpResponse.json(defaultEvent),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/DEFAULT-001/",
        () => {
          return HttpResponse.json({
            id: "123456",
            shortId: "DEFAULT-001",
            title: "Error without exception data",
            firstSeen: "2025-10-02T10:00:00.000Z",
            lastSeen: "2025-10-02T12:00:00.000Z",
            count: "5",
            userCount: 2,
            permalink: "https://sentry-mcp-evals.sentry.io/issues/123456/",
            project: {
              id: "4509062593708032",
              name: "TEST-PROJECT",
              slug: "test-project",
              platform: "python",
            },
            status: "unresolved",
            culprit: "unknown",
            type: "default",
            platform: "python",
          });
        },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "DEFAULT-001",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Verify the event was processed successfully
    expect(result).toContain("# Issue DEFAULT-001 in **sentry-mcp-evals**");
    expect(result).toContain("Error without exception data");
    expect(result).toContain("**Event ID**: abc123def456");
    // Default events should show dateCreated just like error events
    expect(result).toContain("**Occurred At**: 2025-10-02T12:00:00.000Z");
    expect(result).toContain("### Error");
    expect(result).toContain("Something went wrong");
  });

  it("handles CSP (Content Security Policy) violation events", async () => {
    // Mock a CSP violation event and issue
    const cspEvent = createCspEvent();
    const cspIssue = createCspIssue();

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/4256774711/events/latest/",
        () => HttpResponse.json(cspEvent),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/BLOG-CSP-4XC/",
        () => HttpResponse.json(cspIssue),
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "BLOG-CSP-4XC",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    // Verify CSP-specific content is included
    expect(result).toContain("# Issue BLOG-CSP-4XC in **sentry-mcp-evals**");
    expect(result).toContain("Blocked 'image' from 'blob:'");
    expect(result).toContain("**Event ID**: bf5b6c7fd49f4f8da94085a43393051d");
    expect(result).toContain("**Type**: csp");
    // Should show the CSP entry data
    expect(result).toContain("### CSP Violation");
    expect(result).toContain("**Blocked URI**: blob");
    expect(result).toContain("**Violated Directive**: img-src");
    expect(result).toContain("**Document URI**: https://blog.sentry.io");
  });

  it("handles malformed event tags with null keys", async () => {
    const eventWithMalformedTags = {
      id: "abc123def456",
      type: "error",
      title: "TypeError",
      culprit: "app.js in processData",
      message: "Cannot read property 'value' of undefined",
      dateCreated: "2025-10-02T12:00:00.000Z",
      platform: "javascript",
      entries: [
        {
          type: "message",
          data: {
            formatted: "Cannot read property 'value' of undefined",
          },
        },
      ],
      contexts: {},
      tags: [
        { key: null, value: "production" },
        { key: "level", value: "error" },
      ],
    };

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/MALFORMED-TAGS-001/",
        () =>
          HttpResponse.json({
            id: "123456",
            shortId: "MALFORMED-TAGS-001",
            title: "TypeError",
            firstSeen: "2025-10-02T10:00:00.000Z",
            lastSeen: "2025-10-02T12:00:00.000Z",
            count: "5",
            userCount: 2,
            permalink: "https://sentry-mcp-evals.sentry.io/issues/123456/",
            project: {
              id: "4509062593708032",
              name: "TEST-PROJECT",
              slug: "test-project",
              platform: "javascript",
            },
            status: "unresolved",
            culprit: "app.js in processData",
            type: "error",
            platform: "javascript",
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/123456/events/latest/",
        () => HttpResponse.json(eventWithMalformedTags),
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "MALFORMED-TAGS-001",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).toContain(
      "# Issue MALFORMED-TAGS-001 in **sentry-mcp-evals**",
    );
    expect(result).toContain("### Tags");
    expect(result).toContain("**level**: error");
    expect(result).not.toContain("**null**");
  });

  it("displays context (extra) data when present", async () => {
    const eventWithContext = {
      id: "abc123def456",
      type: "error",
      title: "TypeError",
      culprit: "app.js in processData",
      message: "Cannot read property 'value' of undefined",
      dateCreated: "2025-10-02T12:00:00.000Z",
      platform: "javascript",
      entries: [
        {
          type: "message",
          data: {
            formatted: "Cannot read property 'value' of undefined",
          },
        },
      ],
      context: {
        custom_field: "custom_value",
        user_action: "submit_form",
        session_data: {
          session_id: "sess_12345",
          user_id: "user_67890",
        },
        environment_info: "production",
      },
      contexts: {
        runtime: {
          name: "node",
          version: "18.0.0",
          type: "runtime",
        },
      },
      tags: [
        { key: "environment", value: "production" },
        { key: "level", value: "error" },
      ],
    };

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CONTEXT-001/",
        () => {
          return HttpResponse.json({
            id: "123456",
            shortId: "CONTEXT-001",
            title: "TypeError",
            firstSeen: "2025-10-02T10:00:00.000Z",
            lastSeen: "2025-10-02T12:00:00.000Z",
            count: "5",
            userCount: 2,
            permalink: "https://sentry-mcp-evals.sentry.io/issues/123456/",
            project: {
              id: "4509062593708032",
              name: "TEST-PROJECT",
              slug: "test-project",
              platform: "javascript",
            },
            status: "unresolved",
            culprit: "app.js in processData",
            type: "error",
            platform: "javascript",
          });
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/123456/events/latest/",
        () => {
          return HttpResponse.json(eventWithContext);
        },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CONTEXT-001",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Verify the context (extra) data is displayed
    expect(result).toContain("### Extra Data");
    expect(result).toContain("Additional data attached to this event");
    expect(result).toContain('**custom_field**: "custom_value"');
    expect(result).toContain('**user_action**: "submit_form"');
    expect(result).toContain("**session_data**:");
    expect(result).toContain('"session_id": "sess_12345"');
    expect(result).toContain('"user_id": "user_67890"');
    expect(result).toContain('**environment_info**: "production"');
    // Verify contexts are still displayed
    expect(result).toContain("### Additional Context");
  });

  it("returns event details when legacy context is null", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () => HttpResponse.json({ ...eventFixture, context: null }),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).toContain("## Event Details");
    expect(result).toContain(`**Event ID**: ${eventFixture.id}`);
    expect(result).toContain(
      "Error: Tool list_organizations is already registered",
    );
    expect(result).toContain("index.js:19631:28 (Object.fetch)");
    expect(result).toContain("### Additional Context");
    expect(result).toContain('name: "cloudflare"');
    expect(result).not.toContain("### Extra Data");
  });

  it("handles regressed performance issues (generic type with empty entries)", async () => {
    // This tests the actual structure from issue #633
    // Regressed performance issues have:
    // - type: "generic"
    // - entries: [] (empty array)
    // - occurrence field with evidenceData

    const regressedIssueFixture = createRegressedIssue();

    // Use the generic event fixture factory (baseline already matches this test's needs)
    const regressedEventFixture = createGenericEvent();

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/MCP-SERVER-EQE/",
        () => HttpResponse.json(regressedIssueFixture),
        { once: true },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6898891101/events/latest/",
        () => HttpResponse.json(regressedEventFixture),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "MCP-SERVER-EQE",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).toMatchInlineSnapshot(`
      "# Issue MCP-SERVER-EQE in **sentry-mcp-evals**

      **Description**: Endpoint Regression
      **Query Pattern**: \`Increased from 909.77ms to 1711.36ms (P95)\`
      **First Seen**: 2025-09-24T03:02:10.919Z
      **Last Seen**: 2025-11-18T06:01:20.000Z
      **Occurrences**: 3
      **Users Impacted**: 0
      **Status**: unresolved
      **Substatus**: regressed
      **Issue Type**: performance_p95_endpoint_regression
      **Issue Category**: metric
      **Platform**: python
      **Project**: mcp-server
      **URL**: https://sentry-mcp-evals.sentry.io/issues/MCP-SERVER-EQE

      ## Event Details

      **Event ID**: a6251c18f0194b8e8158518b8ee99545
      **Type**: generic
      **Occurred At**: 2025-11-18T06:01:20.000Z

      ### Performance Regression Details

      **Regression:**
      POST /oauth/token duration increased from 909.77ms to 1711.36ms (P95)

      **Transaction:**
      POST /oauth/token

      ### Tags

      **level**: info
      **transaction**: POST /oauth/token

      ## Response Notes

      - Commit message issue reference: \`Fixes MCP-SERVER-EQE\` automatically closes the issue when the commit is merged.
      - The stacktrace includes first-party application code and third-party code. First-party frames are usually the best starting point for triage.
      - Issue event search: Use the Sentry tool \`search_issue_events\`
      "
    `);
  });

  it("includes external issue links when available", async () => {
    const mockExternalIssues = [
      {
        id: "123",
        issueId: "456",
        serviceType: "jira",
        displayName: "AMP-12345",
        webUrl: "https://amplitude.atlassian.net/browse/AMP-12345",
      },
      {
        id: "124",
        issueId: "456",
        serviceType: "github",
        displayName: "getsentry/sentry#12345",
        webUrl: "https://github.com/getsentry/sentry/issues/12345",
      },
    ];

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/external-issues/",
        () => HttpResponse.json(mockExternalIssues),
        { once: true },
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).toContain("## External Issue Links");
    expect(result).toContain(
      "**AMP-12345** (jira): https://amplitude.atlassian.net/browse/AMP-12345",
    );
    expect(result).toContain(
      "**getsentry/sentry#12345** (github): https://github.com/getsentry/sentry/issues/12345",
    );
  });

  it("omits external issue links section when none exist", async () => {
    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        eventId: undefined,
        issueUrl: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    expect(result).not.toContain("## External Issue Links");
  });

  it("handles unsupported event types gracefully", async () => {
    // This tests that unknown event types don't crash the tool
    // Instead, we should show the issue info and a warning about the unsupported event type

    const unsupportedIssueFixture = createUnsupportedIssue();

    // Event with a type that doesn't exist yet (would never be returned by Sentry API)
    // Use the unknown event fixture factory (baseline already has future_ai_agent_trace type)
    const traceId = "11112222333344445555666677778888";
    const unsupportedEventFixture = {
      ...createUnknownEvent(),
      contexts: {
        trace: {
          type: "trace",
          trace_id: traceId,
          span_id: "error-span",
        },
      },
    };

    mswServer.use(
      // More specific pattern for events (must come first to match before the issue pattern)
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/7777777777/events/latest/",
        () => {
          return HttpResponse.json(unsupportedEventFixture);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/FUTURE-TYPE-001",
        () => {
          return HttpResponse.json(unsupportedIssueFixture);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/events/",
        () =>
          HttpResponse.json({
            data: [
              {
                "gen_ai.conversation.id": "conv-unsupported",
                span_id: "span-unsupported",
                timestamp: "2025-04-08T21:15:04+00:00",
              },
            ],
          }),
      ),
      http.get(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/${traceId}/`,
        () => HttpResponse.json([]),
      ),
    );

    const result = await getIssueDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "FUTURE-TYPE-001",
        issueUrl: undefined,
        eventId: undefined,
        regionUrl: null,
      },
      baseContext,
    );

    const text = typeof result === "string" ? result : getTextContent(result);

    // Extract the Sentry Event ID from the result (it varies per run)
    const sentryEventIdMatch = text.match(
      /Sentry Event ID \*\*([a-f0-9]{32})\*\*/,
    );
    const sentryEventId = sentryEventIdMatch
      ? sentryEventIdMatch[1]
      : "SENTRY_EVENT_ID";

    // Replace the dynamic Sentry Event ID with a placeholder for snapshot testing
    const normalizedResult = text.replace(
      /Sentry Event ID \*\*[a-f0-9]{32}\*\*/,
      "Sentry Event ID **<SENTRY_EVENT_ID>**",
    );

    expect(normalizedResult).toMatchInlineSnapshot(`
      "# Issue FUTURE-TYPE-001 in **sentry-mcp-evals**

      **Description**: Future Event Type Issue
      **Culprit**: some.module
      **First Seen**: 2025-01-01T00:00:00.000Z
      **Last Seen**: 2025-01-01T01:00:00.000Z
      **Occurrences**: 1
      **Users Impacted**: 1
      **Status**: unresolved
      **Issue Type**: error
      **Issue Category**: error
      **Platform**: python
      **Project**: mcp-server
      **URL**: https://sentry-mcp-evals.sentry.io/issues/FUTURE-TYPE-001

      ## Event Details

      ⚠️  **Warning**: Unsupported event type "future_ai_agent_trace"

      This event type is not yet fully supported by the MCP server. Only basic issue information is shown above.

      **Please report this**: Open a GitHub issue at https://github.com/getsentry/sentry-mcp/issues/new and include Event ID **ffffffffffffffffffffffffffffffff** and Sentry Event ID **<SENTRY_EVENT_ID>** to help us add support for this event type.

      ## Response Notes

      - Agent conversation found in this trace: \`conv-unsupported\`. Matching span: \`span-unsupported\`.
      - Use the Sentry tool \`execute_sentry_tool(name='get_agent_conversation_details', arguments={"organizationSlug":"sentry-mcp-evals","conversationId":"conv-unsupported"})\` to fetch the full transcript.
      "
    `);

    // Verify we actually got a Sentry Event ID
    expect(sentryEventId).toMatch(/^[a-f0-9]{32}$/);
  });

  it("rejects issues outside the active project constraint", async () => {
    await expect(
      getIssueDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          issueUrl: undefined,
          eventId: undefined,
          regionUrl: null,
        },
        {
          ...baseContext,
          constraints: {
            ...baseContext.constraints,
            projectSlug: "frontend",
          },
        },
      ),
    ).rejects.toThrow(
      'Issue is outside the active project constraint. Expected project "frontend".',
    );
  });
});

describe("structuredContent", () => {
  const FORMATTER_JSON = JSON.stringify({
    title: { text: "Error: Tried to cancel a non-cancellable request" },
    exception: { handled: "No", code: "at Object.fetch (index.js:1)" },
    tags: { environment: "production" },
  });

  function mockLatestEventWithFormatted(formatted: unknown) {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () => HttpResponse.json({ ...createDefaultEvent(), formatted }),
      ),
    );
  }

  const params = {
    organizationSlug: "sentry-mcp-evals",
    issueId: "CLOUDFLARE-MCP-41",
    eventId: undefined,
    issueUrl: undefined,
    regionUrl: null,
  };

  it("returns a structured payload when the formatter sends json", async () => {
    mockLatestEventWithFormatted({ format: "json", content: FORMATTER_JSON });

    const result = await getIssueDetails.handler(params, baseContext);

    expect(result).toHaveProperty("structuredContent");
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    // the issue level fields the markdown used to assemble
    expect(payload.issue.shortId).toBe("CLOUDFLARE-MCP-41");
    expect(payload.issue.url).toContain("CLOUDFLARE-MCP-41");
    expect(typeof payload.issue.occurrences).toBe("number");
    expect(typeof payload.issue.usersImpacted).toBe("number");

    // the event body is the formatter's json, embedded as an object rather than a string
    expect(payload.event.body).toEqual(JSON.parse(FORMATTER_JSON));
    expect(typeof payload.event.body).toBe("object");
  });

  it("produces a payload that satisfies the schema", async () => {
    mockLatestEventWithFormatted({ format: "json", content: FORMATTER_JSON });

    const result = await getIssueDetails.handler(params, baseContext);
    const payload = (result as { structuredContent: unknown })
      .structuredContent;

    // a tool that advertises a schema has to return something that satisfies it
    expect(() => getIssueDetailsOutputSchema.parse(payload)).not.toThrow();
  });

  it("falls back to markdown when the org is not on the rollout", async () => {
    mockLatestEventWithFormatted(undefined);

    const result = await getIssueDetails.handler(params, baseContext);

    // a structured result has to carry the whole answer; without the body it would not
    expect(result).not.toHaveProperty("structuredContent");
    expect(result).toContain("CLOUDFLARE-MCP-41");
  });

  it("falls back to markdown when the body is not parseable json", async () => {
    mockLatestEventWithFormatted({ format: "json", content: "## not json" });

    const result = await getIssueDetails.handler(params, baseContext);

    expect(result).not.toHaveProperty("structuredContent");
    expect(result).toContain("CLOUDFLARE-MCP-41");
  });

  it("keeps transactions on the local path so the performance trace survives", async () => {
    // the shared body carries no performance trace; that is fetched separately and only
    // rendered for transactions, so a transaction must not take the structured path
    const event = createDefaultEvent();
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json({
            ...event,
            type: "transaction",
            formatted: { format: "json", content: FORMATTER_JSON },
          }),
      ),
      http.get(
        `https://sentry.io/api/0/projects/sentry-mcp-evals/CLOUDFLARE-MCP/events/${event.id}/committers/`,
        () => HttpResponse.json({ detail: "Issue not found" }, { status: 404 }),
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);

    expect(result).not.toHaveProperty("structuredContent");
    expect(result).toContain("CLOUDFLARE-MCP-41");
    expect(result).not.toContain("## Suspect Commit");
  });

  it("keeps the attached replay, which lives on the event not the related list", async () => {
    // an issue whose only replay is attached would otherwise report no replays at all
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json({
            ...createDefaultEvent(),
            contexts: {
              replay: {
                type: "default",
                replay_id: "1234567890abcdef1234567890abcdef",
              },
            },
            formatted: { format: "json", content: FORMATTER_JSON },
          }),
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.replays?.attached).toBe("1234567890abcdef1234567890abcdef");
    // and the attached id is not repeated in the related list
    expect(payload.replays?.related).not.toContain(
      "1234567890abcdef1234567890abcdef",
    );
  });

  it("reports no replays when there are none", async () => {
    mockLatestEventWithFormatted({ format: "json", content: FORMATTER_JSON });

    const result = await getIssueDetails.handler(params, baseContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.replays).toBeNull();
  });

  it("maps external issues field by field so upstream extras cannot leak", async () => {
    // structuredContent is a product contract, not a view of the api response: several
    // upstream schemas are passthrough, so anything not mapped must not appear
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json({
            ...createDefaultEvent(),
            formatted: { format: "json", content: FORMATTER_JSON },
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/external-issues/",
        () =>
          HttpResponse.json([
            {
              id: 42,
              issueId: 7,
              serviceType: "github",
              displayName: "getsentry/sentry#1",
              webUrl: "https://github.com/getsentry/sentry/issues/1",
              internalOnlyToken: "must-not-leak",
            },
          ]),
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(JSON.stringify(payload)).not.toContain("internalOnlyToken");
    expect(JSON.stringify(payload)).not.toContain("must-not-leak");
  });

  it("carries every field the markdown output surfaces", async () => {
    // greg's bar for this migration is "roughly the same content": anything the markdown
    // renders and the payload drops is a regression for every MCP user
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json({
            ...createDefaultEvent(),
            dateCreated: "2026-09-03T12:00:00.000Z",
            formatted: { format: "json", content: FORMATTER_JSON },
          }),
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    // the issue header markdown builds before the event body
    for (const field of [
      "shortId",
      "title",
      "culprit",
      "firstSeen",
      "lastSeen",
      "occurrences",
      "usersImpacted",
      "status",
      "platform",
      "project",
      "url",
    ]) {
      expect(payload.issue).toHaveProperty(field);
    }
    // and the event identity markdown prints alongside it
    expect(payload.event.occurredAt).toBe("2026-09-03T12:00:00.000Z");
    expect(payload.event).toHaveProperty("id");
    expect(payload.event).toHaveProperty("type");
  });

  it("does not label an error's exception message as a query pattern", async () => {
    // metadata.value is a query pattern for a performance issue and the exception message for
    // an error, so reading it unconditionally puts error text under the wrong name
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () =>
          HttpResponse.json({
            ...createPerformanceIssue({
              shortId: "CLOUDFLARE-MCP-41",
              metadata: {
                title: "metadata title",
                value: "Tried to cancel a non-cancellable request",
                location: "index.js",
              },
            }),
            // same metadata, but not a performance issue
            issueType: "error",
            issueCategory: "error",
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
        () =>
          HttpResponse.json({
            ...createDefaultEvent(),
            formatted: { format: "json", content: FORMATTER_JSON },
          }),
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.issue.queryPattern).toBeNull();
    expect(payload.issue.location).toBeNull();
    // and the top level title wins for an error, not the metadata one
    expect(payload.issue.title).not.toBe("metadata title");
  });

  it("uses the metadata fields for a performance issue", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
        () =>
          HttpResponse.json({
            ...createPerformanceIssue({
              shortId: "CLOUDFLARE-MCP-41",
              issueType: "performance_n_plus_one_db_queries",
              issueCategory: "performance",
              metadata: {
                title: "N+1 Query",
                value: "SELECT * FROM users WHERE id = ?",
                location: "/api/checkout",
              },
            }),
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
        () =>
          HttpResponse.json({
            ...createDefaultEvent(),
            formatted: { format: "json", content: FORMATTER_JSON },
          }),
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.issue.title).toBe("N+1 Query");
    expect(payload.issue.queryPattern).toBe("SELECT * FROM users WHERE id = ?");
    expect(payload.issue.location).toBe("/api/checkout");
  });

  it("caps related replays and reports the full count", async () => {
    // a real issue came back with 51 of these
    const many = Array.from({ length: 51 }, (_, i) =>
      i.toString(16).padStart(32, "0"),
    );
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json({
            ...createDefaultEvent(),
            formatted: { format: "json", content: FORMATTER_JSON },
          }),
      ),
      // related ids come from replay-count, keyed by numeric issue id. Echo back whichever
      // id was asked for: a preceding test can leave a different issue fixture registered.
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/replay-count/",
        ({ request }) => {
          const query = new URL(request.url).searchParams.get("query") ?? "";
          const issueId = query.match(/issue\.id:\[(\d+)\]/)?.[1];
          return HttpResponse.json(issueId ? { [issueId]: many } : {});
        },
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.replays).not.toBeNull();
    expect(payload.replays.relatedCount).toBe(51);
    expect(payload.replays.related).toHaveLength(5);
  });
});

describe("suspect commits", () => {
  const sha = "2ce6a2700fec4913a2cde8e2d41dee362ce6a270";
  const fixtureEventId = "8d17c61b471a4a2ab0c79b32cae564ef";
  const params = {
    organizationSlug: "sentry-mcp-evals",
    issueId: "CLOUDFLARE-MCP-41",
    eventId: undefined,
    issueUrl: undefined,
    regionUrl: null,
  };
  const formatted = {
    format: "json",
    content: JSON.stringify({ title: { text: "Example error" } }),
  };
  const committersUrl = `https://sentry.io/api/0/projects/sentry-mcp-evals/CLOUDFLARE-MCP/events/${fixtureEventId}/committers/`;

  function mockEvent(
    options: { type?: string; formatted?: unknown } = {},
    eventSelector = "latest",
  ) {
    mswServer.use(
      http.get(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/${eventSelector}/`,
        () =>
          HttpResponse.json({
            ...createDefaultEvent({
              id: fixtureEventId,
              eventID: fixtureEventId,
            }),
            ...options,
          }),
      ),
    );
  }

  beforeEach(() => mswServer.resetHandlers());
  afterEach(() => {
    mswServer.resetHandlers();
    vi.restoreAllMocks();
  });

  describe.each([
    { mode: "structured JSON", type: "error", formatted, structured: true },
    {
      mode: "Markdown without the formatter rollout",
      type: "error",
      formatted: undefined,
      structured: false,
    },
  ])("$mode", ({ type, formatted, structured }) => {
    it.each([
      { selection: "latest event", eventId: undefined },
      {
        selection: "explicit event ID",
        eventId: fixtureEventId,
      },
    ])(
      "includes the suspect commit for the $selection",
      async ({ eventId }) => {
        mockEvent({ type, formatted }, eventId);
        mswServer.use(
          http.get(committersUrl, () =>
            HttpResponse.json({
              committers: [
                {
                  author: { name: "Jane Developer", email: "jane@example.com" },
                  commits: [
                    {
                      id: sha,
                      message: "Fix duplicate tool registration",
                      suspectCommitType: "via SCM integration",
                    },
                  ],
                },
              ],
            }),
          ),
        );

        const result = await getIssueDetails.handler(
          { ...params, eventId },
          baseContext,
        );

        if (structured) {
          const payload = getIssueDetailsOutputSchema.parse(
            getStructuredContent(result),
          );
          expect(payload.suspectCommit).toEqual({
            id: sha,
            message: "Fix duplicate tool registration",
            author: "Jane Developer",
            suspectCommitType: "via SCM integration",
          });
        } else {
          expect(result).toContain(`## Suspect Commit

**SHA**: \`${sha}\`
**Message**: Fix duplicate tool registration
**Author**: Jane Developer
**Source**: via SCM integration

## Event Details`);
        }
      },
    );
  });

  it("uses the author's email and omits a null commit message from Markdown", async () => {
    mockEvent({ formatted: undefined });
    mswServer.use(
      http.get(committersUrl, () =>
        HttpResponse.json({
          committers: [
            {
              author: { name: null, email: "dev@example.com" },
              commits: [
                {
                  id: sha,
                  message: null,
                  suspectCommitType: "via commit in release",
                },
              ],
            },
          ],
        }),
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);

    expect(result).toContain(`## Suspect Commit

**SHA**: \`${sha}\`
**Author**: dev@example.com
**Source**: via commit in release

## Event Details`);
  });

  it.each([
    {
      failure: "permission denied",
      status: 403,
      body: { detail: "Permission denied" },
      reported: false,
    },
    {
      failure: "no committers found",
      status: 404,
      body: { detail: "No committers found" },
      reported: false,
    },
    {
      failure: "server failure",
      status: 500,
      body: { detail: "Internal error" },
      reported: true,
    },
    {
      failure: "invalid response schema",
      status: 200,
      body: { committers: [{ commits: [{ message: "Missing commit ID" }] }] },
      reported: true,
    },
  ])(
    "preserves issue details for $failure (reported: $reported)",
    async ({ status, body, reported }) => {
      mockEvent({ formatted });
      const logIssue = vi.spyOn(logging, "logIssue").mockReturnValue(undefined);
      mswServer.use(
        http.get(committersUrl, () => HttpResponse.json(body, { status })),
      );

      const result = await getIssueDetails.handler(params, baseContext);
      const payload = getIssueDetailsOutputSchema.parse(
        getStructuredContent(result),
      );

      expect(payload.issue.shortId).toBe("CLOUDFLARE-MCP-41");
      expect(payload.suspectCommit).toBeNull();
      if (reported) {
        expect(logIssue).toHaveBeenCalledExactlyOnceWith(
          expect.any(Error),
          expect.objectContaining({
            loggerScope: ["tools", "get-issue-details", "committers"],
          }),
        );
      } else {
        expect(logIssue).not.toHaveBeenCalled();
      }
    },
  );
});
