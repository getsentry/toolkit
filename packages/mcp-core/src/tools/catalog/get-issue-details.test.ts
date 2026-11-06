import {
  autofixStateFixture,
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
import { z } from "zod";
import type { Skill } from "../../skills";
import * as logging from "../../telem/logging";
import { getStructuredContent } from "../../test-utils/structured-content";
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

function parsePayload(result: unknown) {
  return getIssueDetailsOutputSchema.parse(getStructuredContent(result));
}

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
    expect(parsePayload(result)).toMatchInlineSnapshot(`
      {
        "aiConversations": null,
        "codeLocation": {
          "line": 19631,
          "path": "packages/mcp-cloudflare/src/index.ts",
          "repository": "getsentry/sentry-mcp",
          "url": "https://github.com/getsentry/sentry-mcp/blob/main/packages/mcp-cloudflare/src/index.ts#L19631",
        },
        "concerns": [
          {
            "caveat": "Source maps were not applied to this event; frames may point to minified code. See Concerns Identified.",
            "code": "js_source_maps",
            "diagnosis": [
              {
                "files": [
                  "/index.js",
                ],
                "fix": "Inject debug IDs into the build output with the Sentry bundler plugin or \`sentry-cli sourcemaps inject\`, deploy those files, and upload the same files with \`sentry-cli sourcemaps upload\`.",
                "problem": "The deployed file has no debug ID, and the project has no uploads with debug IDs",
              },
            ],
            "docsUrl": "https://docs.sentry.io/platforms/javascript/sourcemaps/",
            "errorTypes": [
              "js_no_source",
            ],
            "fileCount": 1,
            "files": [
              "/index.js",
            ],
            "message": "Sentry could not apply source maps to this event: the source file or its source map was not found. Troubleshooting: https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/",
            "title": "Fix JavaScript source maps",
          },
          {
            "caveat": null,
            "code": "missing_user_identity",
            "diagnosis": [],
            "docsUrl": "https://docs.sentry.io/platforms/javascript/enriching-events/identify-user/",
            "errorTypes": [],
            "fileCount": 0,
            "files": [],
            "message": "This event identifies the user only by IP address, so Users Impacted is approximate and you can't tell which signed-in users hit it. Call \`Sentry.setUser({ id: user.id })\` after sign-in; an opaque internal ID is enough.",
            "title": "Identify users in events",
          },
        ],
        "event": {
          "contexts": {
            "cloud_resource": {
              "cloud.provider": "cloudflare",
            },
            "culture": {
              "timezone": "Europe/London",
            },
            "runtime": {
              "name": "cloudflare",
            },
            "trace": {
              "client_sample_rate": 1,
              "sampled": true,
              "span_id": "953da703d2a6f4c7",
              "status": "unknown",
              "trace_id": "3032af8bcdfe4423b937fc5c041d5d82",
            },
          },
          "crashedThread": null,
          "csp": null,
          "evidence": null,
          "exceptions": [
            {
              "mechanism": {
                "handled": false,
                "type": "cloudflare",
              },
              "module": null,
              "stacktrace": {
                "frames": [
                  {
                    "absPath": "/index.js",
                    "colNo": 27,
                    "filename": "index.js",
                    "inApp": true,
                    "lineNo": 7809,
                    "module": "index",
                  },
                  {
                    "absPath": "/index.js",
                    "colNo": 24,
                    "filename": "index.js",
                    "function": "OAuthProviderImpl.fetch",
                    "inApp": true,
                    "lineNo": 8029,
                    "module": "index",
                  },
                  {
                    "absPath": "/index.js",
                    "colNo": 28,
                    "filename": "index.js",
                    "function": "Object.fetch",
                    "inApp": true,
                    "lineNo": 19631,
                    "module": "index",
                  },
                ],
                "framesOmitted": null,
              },
              "type": "Error",
              "value": "Tool list_organizations is already registered",
            },
          ],
          "extra": null,
          "id": "7ca573c0f4814912aaa9bdc77d1a7d51",
          "message": null,
          "metricAlert": null,
          "occurredAt": "2025-04-08T21:15:04.000Z",
          "performance": null,
          "platform": "javascript",
          "request": {
            "method": "GET",
            "url": "https://mcp.sentry.dev/sse",
          },
          "tags": [
            {
              "key": "environment",
              "value": "development",
            },
            {
              "key": "handled",
              "value": "no",
            },
            {
              "key": "level",
              "value": "error",
            },
            {
              "key": "mechanism",
              "value": "cloudflare",
            },
            {
              "key": "runtime.name",
              "value": "cloudflare",
            },
            {
              "key": "url",
              "value": "https://mcp.sentry.dev/sse",
            },
          ],
          "threadCount": 0,
          "threads": null,
          "type": "error",
          "user": {
            "data": null,
            "email": null,
            "geo": {
              "city": null,
              "countryCode": "US",
              "region": "United States",
            },
            "id": null,
            "ipAddress": "2a06:98c0:3600::103",
            "name": null,
            "username": null,
          },
        },
        "externalIssues": null,
        "issue": {
          "assignedTo": "Jane Developer",
          "culprit": "Object.fetch(index)",
          "firstSeen": "2025-04-03T22:51:19.403000Z",
          "issueCategory": "error",
          "issueType": "error",
          "lastSeen": "2025-04-12T11:34:11Z",
          "location": null,
          "occurrences": 25,
          "platform": "javascript",
          "project": "CLOUDFLARE-MCP",
          "queryPattern": null,
          "seerActionability": null,
          "shortId": "CLOUDFLARE-MCP-41",
          "status": "unresolved",
          "substatus": "ongoing",
          "title": "Error: Tool list_organizations is already registered",
          "url": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
          "usersImpacted": 1,
        },
        "replays": null,
        "seer": null,
        "suggestedActions": [
          {
            "arguments": {
              "organizationSlug": "sentry-mcp-evals",
              "traceId": "3032af8bcdfe4423b937fc5c041d5d82",
            },
            "reason": "Inspect the distributed trace this event belongs to.",
            "toolName": "get_trace_details",
            "type": "tool_call",
          },
          {
            "arguments": {
              "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
            },
            "reason": "Read the breadcrumb trail leading up to this event.",
            "toolName": "get_issue_breadcrumbs",
            "type": "tool_call",
          },
        ],
        "suspectCommit": null,
      }
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

    const payload = parsePayload(result);
    expect(payload.issue.title).toBe(
      "Error: Tool list_issues is already registered",
    );
    expect(payload.issue.culprit).toBeNull();
  });

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

    const payload = parsePayload(result);
    expect(payload.aiConversations).toEqual([
      { conversationId: "conv-123", spanId: "span-123" },
    ]);
    expect(payload.suggestedActions).toContainEqual(
      expect.objectContaining({
        toolName: "get_agent_conversation_details",
        arguments: {
          organizationSlug: "sentry-mcp-evals",
          conversationId: "conv-123",
        },
      }),
    );
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

    const payload = parsePayload(result);
    expect(payload.aiConversations).toBeNull();
    expect(
      payload.suggestedActions.map((action) => action.toolName),
    ).not.toContain("get_agent_conversation_details");
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

  it("returns the assigned team's name", async () => {
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

    expect(parsePayload(result).issue.assignedTo).toBe("Platform Team");
  });

  it("lists threads and offers the stacktrace lookup only for multi-thread events", async () => {
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

    const payload = parsePayload(result);
    expect(payload.event.threads).toEqual([
      {
        id: 11,
        name: "worker",
        state: "WAITING",
        crashed: false,
        current: false,
        frameCount: 1,
      },
      {
        id: 259,
        name: "main",
        state: "RUNNABLE",
        crashed: true,
        current: true,
        frameCount: 2,
      },
    ]);
    expect(payload.suggestedActions).toContainEqual(
      expect.objectContaining({
        toolName: "get_event_stacktrace",
        arguments: {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          eventId: "event-with-multiple-threads",
          thread: 11,
        },
      }),
    );
  });

  it("skips idle threads without frames when suggesting a stacktrace", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () =>
          HttpResponse.json(
            createDefaultEvent({
              id: "event-with-empty-idle-thread",
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
                        id: 7,
                        name: "Signal Catcher",
                        state: "WAITING",
                        crashed: false,
                        current: false,
                        stacktrace: null,
                      },
                      {
                        id: 11,
                        name: "worker",
                        state: "WAITING",
                        crashed: false,
                        current: false,
                        stacktrace: {
                          frames: [
                            {
                              filename: "Thread.java",
                              function: "run",
                              lineNo: 833,
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

    const payload = parsePayload(result);
    expect(payload.event.threads?.[0]).toMatchObject({ id: 7, frameCount: 0 });
    const stacktraceActions = payload.suggestedActions.filter(
      (action) => action.toolName === "get_event_stacktrace",
    );
    expect(stacktraceActions).toEqual([
      expect.objectContaining({
        arguments: expect.objectContaining({ thread: 11 }),
      }),
    ]);
  });

  it("omits the stacktrace lookup when no thread is idle", async () => {
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

    const payload = parsePayload(result);
    expect(payload.event.threads).toHaveLength(1);
    expect(
      payload.suggestedActions.map((action) => action.toolName),
    ).not.toContain("get_event_stacktrace");
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

    const payload = parsePayload(result);
    expect(payload.replays).toEqual({
      attached: "7e07485f12f9416b8b1426260799b51f",
      related: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      relatedCount: 1,
    });
    // the replay tag is reported as replays.attached, not again among the tags
    expect(payload.event.tags.map((tag) => tag.key)).not.toContain("replayId");
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

    const payload = parsePayload(result);
    expect(payload.issue.shortId).toBe("CLOUDFLARE-MCP-41");
    expect(payload.event.id).toBe("7ca573c0f4814912aaa9bdc77d1a7d51");
  });

  it("maps the related trace spans when the trace fetch succeeds", async () => {
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

    expect(parsePayload(result).event.performance).toMatchInlineSnapshot(`
      {
        "issueType": "performance_n_plus_one_db_queries",
        "parentOperation": "GET /api/users",
        "repeatCount": 3,
        "repeatedOperations": [
          "db - INSERT INTO "sentry_fileblobindex" ("offset", "file_id", "blob_id") VALUES (%s, %s, %s) RETURNING "sentry_fileblobindex"."id"",
          "function - sentry.models.files.abstractfileblob.AbstractFileBlob.from_file",
          "db - SELECT "sentry_fileblob"."id", "sentry_fileblob"."path", "sentry_fileblob"."size", "sentry_fileblob"."checksum", "sentry_fileblob"."timestamp" FROM "sentry_fileblob" WHERE "sentry_fileblob"."checksum" = %s LIMIT 21",
        ],
        "spans": [
          {
            "description": "GET /api/users",
            "durationMs": 250,
            "isOffender": false,
            "op": "http.server",
            "parentSpanId": null,
            "spanId": "parent123",
          },
          {
            "description": "SELECT * FROM users WHERE id = 1",
            "durationMs": 5,
            "isOffender": true,
            "op": "db.query",
            "parentSpanId": "parent123",
            "spanId": "span001",
          },
          {
            "description": "SELECT * FROM users WHERE id = 2",
            "durationMs": 5,
            "isOffender": true,
            "op": "db.query",
            "parentSpanId": "parent123",
            "spanId": "span002",
          },
          {
            "description": "SELECT * FROM users WHERE id = 3",
            "durationMs": 5,
            "isOffender": true,
            "op": "db.query",
            "parentSpanId": "parent123",
            "spanId": "span003",
          },
        ],
        "transactionName": "/api/users",
      }
    `);
  });

  it("falls back to the offending spans when the trace fetch fails", async () => {
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

    expect(parsePayload(result).event.performance).toMatchInlineSnapshot(`
      {
        "issueType": "performance_n_plus_one_db_queries",
        "parentOperation": "GET /api/users",
        "repeatCount": 3,
        "repeatedOperations": [
          "db - INSERT INTO "sentry_fileblobindex" ("offset", "file_id", "blob_id") VALUES (%s, %s, %s) RETURNING "sentry_fileblobindex"."id"",
          "function - sentry.models.files.abstractfileblob.AbstractFileBlob.from_file",
          "db - SELECT "sentry_fileblob"."id", "sentry_fileblob"."path", "sentry_fileblob"."size", "sentry_fileblob"."checksum", "sentry_fileblob"."timestamp" FROM "sentry_fileblob" WHERE "sentry_fileblob"."checksum" = %s LIMIT 21",
        ],
        "spans": [
          {
            "description": "GET /api/users",
            "durationMs": 250,
            "isOffender": false,
            "op": "http.server",
            "parentSpanId": null,
            "spanId": "parent123",
          },
          {
            "description": "SELECT * FROM users WHERE id = 1",
            "durationMs": 5,
            "isOffender": true,
            "op": "db.query",
            "parentSpanId": "parent123",
            "spanId": "span001",
          },
          {
            "description": "SELECT * FROM users WHERE id = 2",
            "durationMs": 5,
            "isOffender": true,
            "op": "db.query",
            "parentSpanId": "parent123",
            "spanId": "span002",
          },
          {
            "description": "SELECT * FROM users WHERE id = 3",
            "durationMs": 5,
            "isOffender": true,
            "op": "db.query",
            "parentSpanId": "parent123",
            "spanId": "span003",
          },
        ],
        "transactionName": "/api/users",
      }
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

    const payload = parsePayload(result);
    expect(payload.issue.shortId).toBe("CLOUDFLARE-MCP-41");
    expect(payload.event.id).toBe("7ca573c0f4814912aaa9bdc77d1a7d51");
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

  it("reports no Seer analysis when the issue has no run", async () => {
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

    const payload = parsePayload(result);
    expect(payload.issue.title).toBe(
      "Error: Tool list_organizations is already registered",
    );
    expect(payload.seer).toBeNull();
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
    expect(parsePayload(result).seer).toBeNull();
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

  it("maps the Seer run's status, root cause and solution", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/autofix/",
        () => HttpResponse.json(autofixStateFixture),
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
        ...baseContext,
        grantedSkills: new Set<Skill>(["inspect", "seer"]),
      },
    );

    expect(parsePayload(result).seer).toMatchInlineSnapshot(`
      {
        "rootCause": "The \`bottleById\` query fails because the input ID (3216) doesn't exist in the database.",
        "solution": "Use the canonical bottle ID for both batched TRPC calls.",
        "status": "Complete",
      }
    `);
  });

  it("maps a default event, which has no exception", async () => {
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

    const payload = parsePayload(result);
    expect(payload.issue.shortId).toBe("DEFAULT-001");
    expect(payload.event).toMatchObject({
      id: "abc123def456",
      type: "default",
      // default events carry dateCreated just like error events
      occurredAt: "2025-10-02T12:00:00.000Z",
      message: "Something went wrong",
      exceptions: null,
    });
  });

  it("maps a CSP violation report", async () => {
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

    const payload = parsePayload(result);
    expect(payload.issue.shortId).toBe("BLOG-CSP-4XC");
    expect(payload.event).toMatchObject({
      id: "bf5b6c7fd49f4f8da94085a43393051d",
      type: "csp",
      message: "Blocked 'image' from 'blob:'",
      csp: {
        blockedUri: "blob",
        effectiveDirective: "img-src",
        documentUri: expect.stringContaining("https://blog.sentry.io"),
      },
    });
  });

  it("drops event tags with null keys", async () => {
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

    expect(parsePayload(result).event.tags).toEqual([
      { key: "level", value: "error" },
    ]);
  });

  it("returns the extra data and contexts", async () => {
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

    const payload = parsePayload(result);
    expect(payload.event.extra).toEqual({
      custom_field: "custom_value",
      user_action: "submit_form",
      session_data: { session_id: "sess_12345", user_id: "user_67890" },
      environment_info: "production",
    });
    expect(payload.event.contexts).toEqual({
      runtime: { name: "node", version: "18.0.0" },
    });
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

    const payload = parsePayload(result);
    expect(payload.event.id).toBe(eventFixture.id);
    expect(payload.event.extra).toBeNull();
    expect(payload.event.exceptions?.[0]).toMatchObject({
      type: "Error",
      value: "Tool list_organizations is already registered",
    });
    expect(payload.event.contexts).toHaveProperty("cloud_resource");
  });

  it("maps a regressed performance issue, a generic event with no entries", async () => {
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

    const payload = parsePayload(result);
    expect(payload.event.type).toBe("generic");
    expect(payload.event.evidence).toMatchInlineSnapshot(`
      [
        {
          "name": "Regression",
          "value": "POST /oauth/token duration increased from 909.77ms to 1711.36ms (P95)",
        },
        {
          "name": "Transaction",
          "value": "POST /oauth/token",
        },
      ]
    `);
  });

  it("returns the external issue links", async () => {
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

    expect(parsePayload(result).externalIssues).toEqual([
      {
        serviceType: "jira",
        displayName: "AMP-12345",
        webUrl: "https://amplitude.atlassian.net/browse/AMP-12345",
      },
      {
        serviceType: "github",
        displayName: "getsentry/sentry#12345",
        webUrl: "https://github.com/getsentry/sentry/issues/12345",
      },
    ]);
  });

  it("reports no external issue links when there are none", async () => {
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

    expect(parsePayload(result).externalIssues).toBeNull();
  });

  it("returns the issue and event identity for an unsupported event type", async () => {
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

    const logIssueSpy = vi.spyOn(logging, "logIssue");
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

    const payload = parsePayload(result);
    expect(payload.issue.shortId).toBe("FUTURE-TYPE-001");
    expect(payload.event.type).toBe("future_ai_agent_trace");
    expect(payload.aiConversations).toEqual([
      { conversationId: "conv-unsupported", spanId: "span-unsupported" },
    ]);
    // still reported, so support for the type gets added
    expect(logIssueSpy).toHaveBeenCalledWith(
      "Unsupported event type encountered: future_ai_agent_trace",
      expect.anything(),
    );
    logIssueSpy.mockRestore();
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
  const experimentalContext = { ...baseContext, experimentalMode: true };

  function mockLatestEvent(overrides: Record<string, unknown> = {}) {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () => HttpResponse.json({ ...createDefaultEvent(), ...overrides }),
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

  it("returns a structured payload in experimental mode", async () => {
    mockLatestEvent();

    const result = await getIssueDetails.handler(params, experimentalContext);

    expect(result).toHaveProperty("structuredContent");
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    // the issue level fields the markdown used to assemble
    expect(payload.issue.shortId).toBe("CLOUDFLARE-MCP-41");
    expect(payload.issue.url).toContain("CLOUDFLARE-MCP-41");
    expect(typeof payload.issue.occurrences).toBe("number");
    expect(typeof payload.issue.usersImpacted).toBe("number");
  });

  it("produces a payload that satisfies the schema", async () => {
    mockLatestEvent();

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = (result as { structuredContent: unknown })
      .structuredContent;

    // a tool that advertises a schema has to return something that satisfies it
    expect(() => getIssueDetailsOutputSchema.parse(payload)).not.toThrow();
  });

  it("returns the same structured payload outside experimental mode", async () => {
    mockLatestEvent();

    const result = await getIssueDetails.handler(params, baseContext);

    mockLatestEvent();
    const experimental = await getIssueDetails.handler(
      params,
      experimentalContext,
    );

    expect(parsePayload(result)).toEqual(parsePayload(experimental));
  });

  it("maps the event entries into fields rather than rendering markdown", async () => {
    mockLatestEvent();

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.event).not.toHaveProperty("body");
    expect(payload.event.message).toBe("Something went wrong");
    expect(payload.event.tags).toEqual([
      { key: "level", value: "error" },
      { key: "environment", value: "production" },
    ]);
  });

  it("offers the follow-up calls the markdown notes describe as actions", async () => {
    mockLatestEvent();

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload).not.toHaveProperty("responseNotes");
    expect(payload.suggestedActions).toContainEqual(
      expect.objectContaining({
        toolName: "get_issue_breadcrumbs",
        arguments: {
          issueUrl: expect.stringContaining("CLOUDFLARE-MCP-41"),
        },
      }),
    );
  });

  it("carries the top level message, which the body does not render", async () => {
    mockLatestEvent({ message: "TOP-LEVEL-MESSAGE", entries: [] });

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.event.message).toBe("TOP-LEVEL-MESSAGE");
  });

  it("returns structured content for an unsupported event type", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/7777777777/events/latest/",
        () => HttpResponse.json(createUnknownEvent()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/FUTURE-TYPE-001",
        () => HttpResponse.json(createUnsupportedIssue()),
      ),
    );

    const logIssueSpy = vi.spyOn(logging, "logIssue");
    const result = await getIssueDetails.handler(
      { ...params, issueId: "FUTURE-TYPE-001" },
      experimentalContext,
    );
    const payload = getStructuredContent<Record<string, any>>(result);

    expect(() => getIssueDetailsOutputSchema.parse(payload)).not.toThrow();
    expect(payload.issue.shortId).toBe("FUTURE-TYPE-001");
    expect(payload.event.type).toBe("future_ai_agent_trace");
    expect(payload.event.exceptions).toBeNull();
    expect(payload.event.tags).toEqual([{ key: "level", value: "error" }]);
    // still reported, so support for the type gets added
    expect(logIssueSpy).toHaveBeenCalledWith(
      "Unsupported event type encountered: future_ai_agent_trace",
      expect.anything(),
    );
    logIssueSpy.mockRestore();
  });

  // Sentry's event serializer sends dateCreated and dateReceived on every
  // event, but the transaction and unknown (CSP and others) event schemas
  // drop dateCreated, so occurredAt comes from dateReceived.
  it("takes occurredAt from dateReceived for a transaction event", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/",
        () => HttpResponse.json(createPerformanceIssue()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
        () =>
          HttpResponse.json(
            createPerformanceEvent({
              dateReceived: "2025-08-06T18:00:01.250000Z",
            }),
          ),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/abcdef1234567890abcdef1234567890/",
        () => HttpResponse.json(createTraceResponseFixture()),
      ),
    );

    const result = await getIssueDetails.handler(
      { ...params, issueId: "PERF-N1-001" },
      experimentalContext,
    );
    const payload = getStructuredContent<Record<string, any>>(result);

    expect(payload.event.type).toBe("transaction");
    expect(payload.event.occurredAt).toBe("2025-08-06T18:00:01.250Z");
  });

  it("takes occurredAt from dateReceived for a CSP event", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/4256774711/events/latest/",
        () => HttpResponse.json(createCspEvent()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/BLOG-CSP-4XC/",
        () => HttpResponse.json(createCspIssue()),
      ),
    );

    const result = await getIssueDetails.handler(
      { ...params, issueId: "BLOG-CSP-4XC" },
      experimentalContext,
    );
    const payload = getStructuredContent<Record<string, any>>(result);

    expect(payload.event.type).toBe("csp");
    expect(payload.event.occurredAt).toBe("2025-11-19T19:24:12.491Z");
  });

  it("takes occurredAt from dateReceived for an unknown event type", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/7777777777/events/latest/",
        () => HttpResponse.json(createUnknownEvent()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/*/issues/FUTURE-TYPE-001",
        () => HttpResponse.json(createUnsupportedIssue()),
      ),
    );

    const result = await getIssueDetails.handler(
      { ...params, issueId: "FUTURE-TYPE-001" },
      experimentalContext,
    );
    const payload = getStructuredContent<Record<string, any>>(result);

    expect(payload.event.type).toBe("future_ai_agent_trace");
    expect(payload.event.occurredAt).toBe("2025-01-01T01:00:00.000Z");
  });

  it("maps a transaction's N+1 evidence and its spans", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/",
        () => HttpResponse.json(createPerformanceIssue()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
        () => HttpResponse.json(createPerformanceEvent()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/abcdef1234567890abcdef1234567890/",
        () => HttpResponse.json(createTraceResponseFixture()),
      ),
    );

    const result = await getIssueDetails.handler(
      { ...params, issueId: "PERF-N1-001" },
      experimentalContext,
    );
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.event.type).toBe("transaction");
    expect(() => getIssueDetailsOutputSchema.parse(payload)).not.toThrow();
    expect(payload.event.performance).toMatchObject({
      issueType: "performance_n_plus_one_db_queries",
      transactionName: "/api/users",
      parentOperation: "GET /api/users",
      repeatCount: 3,
      repeatedOperations: expect.arrayContaining([
        expect.stringContaining("SELECT"),
      ]),
    });
    // the span tree from the fetched trace, parents linked by id
    expect(payload.event.performance.spans).toEqual([
      {
        spanId: "parent123",
        parentSpanId: null,
        op: "http.server",
        description: "GET /api/users",
        durationMs: 250,
        isOffender: false,
      },
      {
        spanId: "span001",
        parentSpanId: "parent123",
        op: "db.query",
        description: "SELECT * FROM users WHERE id = 1",
        durationMs: 5,
        isOffender: true,
      },
      {
        spanId: "span002",
        parentSpanId: "parent123",
        op: "db.query",
        description: "SELECT * FROM users WHERE id = 2",
        durationMs: 5,
        isOffender: true,
      },
      {
        spanId: "span003",
        parentSpanId: "parent123",
        op: "db.query",
        description: "SELECT * FROM users WHERE id = 3",
        durationMs: 5,
        isOffender: true,
      },
    ]);
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
          }),
      ),
    );

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = (result as { structuredContent: Record<string, any> })
      .structuredContent;

    expect(payload.replays?.attached).toBe("1234567890abcdef1234567890abcdef");
    // and the attached id is not repeated in the related list
    expect(payload.replays?.related).not.toContain(
      "1234567890abcdef1234567890abcdef",
    );
    expect(JSON.stringify(payload.event)).not.toContain(
      "1234567890abcdef1234567890abcdef",
    );
  });

  it("reports no replays when there are none", async () => {
    mockLatestEvent();

    const result = await getIssueDetails.handler(params, experimentalContext);
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

    const result = await getIssueDetails.handler(params, experimentalContext);
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
          }),
      ),
    );

    const result = await getIssueDetails.handler(params, experimentalContext);
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
          }),
      ),
    );

    const result = await getIssueDetails.handler(params, experimentalContext);
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
          }),
      ),
    );

    const result = await getIssueDetails.handler(params, experimentalContext);
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

    const result = await getIssueDetails.handler(params, experimentalContext);
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
  const committersUrl = `https://sentry.io/api/0/projects/sentry-mcp-evals/CLOUDFLARE-MCP/events/${fixtureEventId}/committers/`;

  function mockEvent(eventSelector = "latest") {
    mswServer.use(
      http.get(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/${eventSelector}/`,
        () =>
          HttpResponse.json({
            ...createDefaultEvent({
              id: fixtureEventId,
              eventID: fixtureEventId,
            }),
          }),
      ),
    );
  }

  beforeEach(() => mswServer.resetHandlers());
  afterEach(() => {
    mswServer.resetHandlers();
    vi.restoreAllMocks();
  });

  it.each([
    { selection: "latest event", eventId: undefined },
    {
      selection: "explicit event ID",
      eventId: fixtureEventId,
    },
  ])("includes the suspect commit for the $selection", async ({ eventId }) => {
    mockEvent(eventId);
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

    expect(parsePayload(result).suspectCommit).toEqual({
      id: sha,
      message: "Fix duplicate tool registration",
      author: "Jane Developer",
      suspectCommitType: "via SCM integration",
    });
  });

  it("uses the author's email when the commit has no message", async () => {
    mockEvent();
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

    expect(parsePayload(result).suspectCommit).toEqual({
      id: sha,
      message: null,
      author: "dev@example.com",
      suspectCommitType: "via commit in release",
    });
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
      mockEvent();
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

describe("selected event package versions", () => {
  beforeEach(() => mswServer.resetHandlers());
  afterEach(() => mswServer.resetHandlers());
  const eventId = "7ca573c0f4814912aaa9bdc77d1a7d51";
  const params = {
    organizationSlug: "sentry-mcp-evals",
    issueId: "CLOUDFLARE-MCP-41",
    eventId,
    regionUrl: null,
    packageNames: ["example", "@example/client", "missing"],
  };

  function mockPackages(
    packages: unknown,
    suppliedFormatting: boolean | "json" = true,
  ) {
    mswServer.use(
      http.get(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/${eventId}/`,
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("llmFormat")).toBeNull();
          return HttpResponse.json({
            ...createDefaultEvent({ id: eventId, contexts: {} }),
            packages,
            formatted:
              suppliedFormatting === "json"
                ? {
                    format: "json",
                    content: JSON.stringify({ message: "Synthetic event" }),
                  }
                : suppliedFormatting
                  ? {
                      format: "markdown",
                      content: "### Message\n\nSynthetic event",
                    }
                  : undefined,
          });
        },
      ),
    );
  }

  it("retains only selected packages in structured event output", async () => {
    mockPackages(
      { example: "1.2.3", "@example/client": "2.0.0", unrelated: "9.9.9" },
      "json",
    );
    const result = await getIssueDetails.handler(params, baseContext);
    const payload = getIssueDetailsOutputSchema.parse(
      getStructuredContent(result),
    );
    expect(payload.event).toHaveProperty("packageVersions", {
      metadataAvailable: true,
      packages: [
        {
          name: "example",
          status: "recorded",
          version: "1.2.3",
          truncated: false,
        },
        {
          name: "@example/client",
          status: "recorded",
          version: "2.0.0",
          truncated: false,
        },
        {
          name: "missing",
          status: "not_listed",
          version: null,
          truncated: false,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("unrelated");
    expect(payload.event.message).toBe("Something went wrong");
    expect(payload).toMatchInlineSnapshot(`
      {
        "aiConversations": null,
        "codeLocation": null,
        "concerns": [
          {
            "caveat": null,
            "code": "missing_user_identity",
            "diagnosis": [],
            "docsUrl": "https://docs.sentry.io/platforms/python/enriching-events/identify-user/",
            "errorTypes": [],
            "fileCount": 0,
            "files": [],
            "message": "This event has no user, so it doesn't count toward Users Impacted. Call \`sentry_sdk.set_user({"id": user.id})\` after sign-in; an opaque internal ID is enough.",
            "title": "Identify users in events",
          },
        ],
        "event": {
          "contexts": null,
          "crashedThread": null,
          "csp": null,
          "evidence": null,
          "exceptions": null,
          "extra": null,
          "id": "7ca573c0f4814912aaa9bdc77d1a7d51",
          "message": "Something went wrong",
          "metricAlert": null,
          "occurredAt": "2025-10-02T12:00:00.000Z",
          "packageVersions": {
            "metadataAvailable": true,
            "packages": [
              {
                "name": "example",
                "status": "recorded",
                "truncated": false,
                "version": "1.2.3",
              },
              {
                "name": "@example/client",
                "status": "recorded",
                "truncated": false,
                "version": "2.0.0",
              },
              {
                "name": "missing",
                "status": "not_listed",
                "truncated": false,
                "version": null,
              },
            ],
          },
          "performance": null,
          "platform": "python",
          "request": null,
          "tags": [
            {
              "key": "level",
              "value": "error",
            },
            {
              "key": "environment",
              "value": "production",
            },
          ],
          "threadCount": 0,
          "threads": null,
          "type": "default",
          "user": null,
        },
        "externalIssues": null,
        "issue": {
          "assignedTo": "Jane Developer",
          "culprit": "Object.fetch(index)",
          "firstSeen": "2025-04-03T22:51:19.403000Z",
          "issueCategory": "error",
          "issueType": "error",
          "lastSeen": "2025-04-12T11:34:11Z",
          "location": null,
          "occurrences": 25,
          "platform": "javascript",
          "project": "CLOUDFLARE-MCP",
          "queryPattern": null,
          "seerActionability": null,
          "shortId": "CLOUDFLARE-MCP-41",
          "status": "unresolved",
          "substatus": "ongoing",
          "title": "Error: Tool list_organizations is already registered",
          "url": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
          "usersImpacted": 1,
        },
        "replays": null,
        "seer": null,
        "suggestedActions": [
          {
            "arguments": {
              "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
            },
            "reason": "Read the breadcrumb trail leading up to this event.",
            "toolName": "get_issue_breadcrumbs",
            "type": "tool_call",
          },
        ],
        "suspectCommit": null,
      }
    `);
  });

  it.each([undefined, null, {}])(
    "reports unavailable structured metadata for %j",
    async (packages) => {
      mockPackages(packages, "json");
      const payload = getIssueDetailsOutputSchema.parse(
        getStructuredContent(
          await getIssueDetails.handler(params, baseContext),
        ),
      );
      expect(payload.event.packageVersions).toEqual({
        metadataAvailable: false,
        packages: [],
      });
    },
  );

  it("preserves package states, exact names, bounds, and raw strings in structured output", async () => {
    const specialName = "<example>\n*client*";
    const specialVersion = "<version>\n`1.0`";
    mockPackages(
      {
        example: null,
        blank: " ",
        long: "v".repeat(300),
        [specialName]: specialVersion,
      },
      "json",
    );
    const result = await getIssueDetails.handler(
      {
        ...params,
        packageNames: [
          "example",
          "blank",
          "Example",
          "constructor",
          "long",
          specialName,
          "long",
        ],
      },
      baseContext,
    );
    const payload = getIssueDetailsOutputSchema.parse(
      getStructuredContent(result),
    );
    expect(payload.event.packageVersions).toEqual({
      metadataAvailable: true,
      packages: [
        {
          name: "example",
          status: "version_not_recorded",
          version: null,
          truncated: false,
        },
        {
          name: "blank",
          status: "version_not_recorded",
          version: null,
          truncated: false,
        },
        {
          name: "Example",
          status: "not_listed",
          version: null,
          truncated: false,
        },
        {
          name: "constructor",
          status: "not_listed",
          version: null,
          truncated: false,
        },
        {
          name: "long",
          status: "recorded",
          version: "v".repeat(256),
          truncated: true,
        },
        {
          name: specialName,
          status: "recorded",
          version: specialVersion,
          truncated: false,
        },
      ],
    });
  });

  it("preserves structured output when package selection is omitted", async () => {
    mockPackages({ example: "1.2.3" }, "json");
    const withMetadata = await getIssueDetails.handler(
      { ...params, packageNames: undefined },
      baseContext,
    );
    mockPackages(undefined, "json");
    const withoutMetadata = await getIssueDetails.handler(
      { ...params, packageNames: undefined },
      baseContext,
    );
    expect(withMetadata).toEqual(withoutMetadata);
    const payload = getIssueDetailsOutputSchema.parse(
      getStructuredContent(withMetadata),
    );
    expect(payload.event).not.toHaveProperty("packageVersions");
  });

  it("ignores supplied markdown formatting and keeps unrelated packages out", async () => {
    mockPackages({
      example: "1.2.3",
      "@example/client": "2.0.0",
      unrelated: "9.9.9",
    });
    const result = await getIssueDetails.handler(params, baseContext);
    const payload = parsePayload(result);
    expect(payload.event.packageVersions?.packages.map((p) => p.name)).toEqual([
      "example",
      "@example/client",
      "missing",
    ]);
    expect(JSON.stringify(result)).not.toContain("unrelated");
    expect(JSON.stringify(result)).not.toContain("Synthetic event");
  });

  it("distinguishes absent names and unrecorded versions", async () => {
    mockPackages({ example: null, "@example/client": "" });
    const result = await getIssueDetails.handler(params, baseContext);
    expect(
      parsePayload(result).event.packageVersions?.packages.map(
        ({ name, status }) => ({ name, status }),
      ),
    ).toEqual([
      { name: "example", status: "version_not_recorded" },
      { name: "@example/client", status: "version_not_recorded" },
      { name: "missing", status: "not_listed" },
    ]);
  });

  it("matches exact names, deduplicates selections, and ignores inherited properties", async () => {
    mockPackages({ example: "1" });
    const result = await getIssueDetails.handler(
      {
        ...params,
        packageNames: ["example", "example", "Example", "constructor"],
      },
      baseContext,
    );
    expect(
      parsePayload(result).event.packageVersions?.packages.map(
        ({ name, status }) => ({ name, status }),
      ),
    ).toEqual([
      { name: "example", status: "recorded" },
      { name: "Example", status: "not_listed" },
      { name: "constructor", status: "not_listed" },
    ]);
  });

  it("preserves surrounding spaces in selected package names and versions", async () => {
    mockPackages({ " example ": " 1.2.3 " });
    const result = await getIssueDetails.handler(
      { ...params, packageNames: [" example "] },
      baseContext,
    );
    expect(parsePayload(result).event.packageVersions?.packages).toEqual([
      {
        name: " example ",
        status: "recorded",
        version: " 1.2.3 ",
        truncated: false,
      },
    ]);
  });

  it.each(
    [
      [],
      Array.from({ length: 11 }, (_, i) => `package${i}`),
      [""],
      ["x".repeat(257)],
    ].map((packageNames) => ({ packageNames })),
  )("rejects out-of-bounds selection %j", ({ packageNames }) => {
    expect(
      z
        .object(getIssueDetails.inputSchema)
        .safeParse({ ...params, packageNames }).success,
    ).toBe(false);
  });

  it("accepts the maximum bounded selection", async () => {
    const packageNames = Array.from(
      { length: 10 },
      (_, i) => `${i}${"x".repeat(255)}`,
    );
    mockPackages(
      Object.fromEntries(packageNames.map((name) => [name, "v".repeat(256)])),
    );
    const input = z
      .object(getIssueDetails.inputSchema)
      .parse({ ...params, packageNames });
    const result = await getIssueDetails.handler(input, baseContext);
    const packages = parsePayload(result).event.packageVersions?.packages;
    expect(packages).toHaveLength(10);
    expect(
      packages?.every(
        (entry) =>
          entry.status === "recorded" &&
          entry.version === "v".repeat(256) &&
          !entry.truncated,
      ),
    ).toBe(true);
  });

  it("retains selected packages even for an unsupported event type", async () => {
    mswServer.use(
      http.get(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/${eventId}/`,
        () =>
          HttpResponse.json({
            ...createUnknownEvent({ id: eventId, contexts: {} }),
            packages: { example: "1.2.3" },
          }),
      ),
    );
    const result = await getIssueDetails.handler(params, baseContext);
    const payload = parsePayload(result);
    expect(payload.event.type).toBe("future_ai_agent_trace");
    expect(payload.event.packageVersions?.packages[0]).toEqual({
      name: "example",
      status: "recorded",
      version: "1.2.3",
      truncated: false,
    });
  });

  it("requires an exact event", async () => {
    await expect(
      getIssueDetails.handler({ ...params, eventId: undefined }, baseContext),
    ).rejects.toThrow("requires an explicit `eventId`");
  });
});

describe("concerns identified", () => {
  const params = {
    organizationSlug: "sentry-mcp-evals",
    issueId: "CLOUDFLARE-MCP-41",
    eventId: undefined,
    issueUrl: undefined,
    regionUrl: null,
  };
  const experimentalContext = { ...baseContext, experimentalMode: true };

  function mockLatestEvent(event: Record<string, unknown>) {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
        () => HttpResponse.json(event),
      ),
    );
  }

  // the fixture's user has only an IP address; give it an id to isolate other concerns
  const identifiedUser = { ...eventFixture.user, id: "8f3c2a" };

  async function getConcernCodes(issueId = params.issueId) {
    const result = await getIssueDetails.handler(
      { ...params, issueId },
      experimentalContext,
    );
    return getStructuredContent<{ concerns: { code: string }[] }>(
      result,
    ).concerns.map((concern) => concern.code);
  }

  afterEach(() => mswServer.resetHandlers());

  it("suggests fixing source maps in structured output", async () => {
    // the fixture's own js_no_source error, with no override
    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getStructuredContent<{ concerns: unknown }>(result);

    expect(payload.concerns).toMatchInlineSnapshot(`
      [
        {
          "caveat": "Source maps were not applied to this event; frames may point to minified code. See Concerns Identified.",
          "code": "js_source_maps",
          "diagnosis": [
            {
              "files": [
                "/index.js",
              ],
              "fix": "Inject debug IDs into the build output with the Sentry bundler plugin or \`sentry-cli sourcemaps inject\`, deploy those files, and upload the same files with \`sentry-cli sourcemaps upload\`.",
              "problem": "The deployed file has no debug ID, and the project has no uploads with debug IDs",
            },
          ],
          "docsUrl": "https://docs.sentry.io/platforms/javascript/sourcemaps/",
          "errorTypes": [
            "js_no_source",
          ],
          "fileCount": 1,
          "files": [
            "/index.js",
          ],
          "message": "Sentry could not apply source maps to this event: the source file or its source map was not found. Troubleshooting: https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/",
          "title": "Fix JavaScript source maps",
        },
        {
          "caveat": null,
          "code": "missing_user_identity",
          "diagnosis": [],
          "docsUrl": "https://docs.sentry.io/platforms/javascript/enriching-events/identify-user/",
          "errorTypes": [],
          "fileCount": 0,
          "files": [],
          "message": "This event identifies the user only by IP address, so Users Impacted is approximate and you can't tell which signed-in users hit it. Call \`Sentry.setUser({ id: user.id })\` after sign-in; an opaque internal ID is enough.",
          "title": "Identify users in events",
        },
      ]
    `);
  });

  it("dedupes source map errors by type and caps the files", async () => {
    mockLatestEvent({
      ...eventFixture,
      user: identifiedUser,
      errors: [
        ...["a", "b", "c", "d"].map((name) => ({
          type: "js_no_source",
          message: "Source code was not found",
          data: { symbolicator_type: "missing_source", url: `/${name}.js` },
        })),
        {
          type: "js_invalid_sourcemap_location",
          message: "Invalid location in sourcemap",
          data: { column: 27, row: 7809, source: "/a.js" },
        },
        // not a source map problem
        { type: "invalid_data", message: "Discarded invalid value", data: {} },
        // malformed entries must not fail the event
        { message: "no type" },
        null,
      ],
    });

    const { concerns } = parsePayload(
      await getIssueDetails.handler(params, baseContext),
    );

    // one concern for the whole event, however many error types it has
    expect(concerns).toHaveLength(1);
    expect(concerns).toMatchInlineSnapshot(`
      [
        {
          "caveat": "Source maps were not applied to this event; frames may point to minified code. See Concerns Identified.",
          "code": "js_source_maps",
          "diagnosis": [],
          "docsUrl": "https://docs.sentry.io/platforms/javascript/sourcemaps/",
          "errorTypes": [
            "js_no_source",
            "js_invalid_sourcemap_location",
          ],
          "fileCount": 4,
          "files": [
            "/a.js",
            "/b.js",
            "/c.js",
          ],
          "message": "Sentry could not apply source maps to this event: the source file or its source map was not found; the source map does not match the minified file. Fix: Upload source maps for this release from the same build that was deployed. Troubleshooting: https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/",
          "title": "Fix JavaScript source maps",
        },
      ]
    `);
  });

  it("falls back to the fix for the error types when the source map check fails", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/:project/events/:eventId/source-map-debug/",
        () => HttpResponse.json({ detail: "Not found" }, { status: 404 }),
      ),
    );

    const result = await getIssueDetails.handler(params, experimentalContext);
    const [concern] = getStructuredContent<{
      concerns: Array<{ message: string; diagnosis: unknown[] }>;
    }>(result).concerns;

    expect(concern.diagnosis).toEqual([]);
    expect(concern.message).toContain(
      "Fix: Upload source maps for this release from the same build that was deployed.",
    );
  });

  it("omits the section and caveat when the event has no concerns", async () => {
    mockLatestEvent({
      ...eventFixture,
      user: identifiedUser,
      errors: [
        {
          type: "native_missing_dsym",
          message: "A required debug information file was missing.",
          data: {},
        },
      ],
    });
    let checked = false;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/:project/events/:eventId/source-map-debug/",
        () => {
          checked = true;
          return HttpResponse.json({}, { status: 500 });
        },
      ),
    );

    const result = await getIssueDetails.handler(params, baseContext);
    expect(parsePayload(result).concerns).toEqual([]);
    // a healthy event needs no source map check
    expect(checked).toBe(false);
  });

  it("suggests identifying users after source maps when the user has only an IP address", async () => {
    // the fixture's own IP-only user and js_no_source error
    expect(await getConcernCodes()).toEqual([
      "js_source_maps",
      "missing_user_identity",
    ]);

    // only source maps adds a caveat; user identity has none
    const { concerns } = parsePayload(
      await getIssueDetails.handler(params, baseContext),
    );
    expect(
      concerns.filter((concern) => concern.caveat !== null).map((c) => c.code),
    ).toEqual(["js_source_maps"]);
  });

  it("suggests identifying users when the event has no user", async () => {
    // a Python message event with `user: null`
    mockLatestEvent(createDefaultEvent());

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getStructuredContent<{ concerns: unknown }>(result);

    expect(payload.concerns).toMatchInlineSnapshot(`
      [
        {
          "caveat": null,
          "code": "missing_user_identity",
          "diagnosis": [],
          "docsUrl": "https://docs.sentry.io/platforms/python/enriching-events/identify-user/",
          "errorTypes": [],
          "fileCount": 0,
          "files": [],
          "message": "This event has no user, so it doesn't count toward Users Impacted. Call \`sentry_sdk.set_user({"id": user.id})\` after sign-in; an opaque internal ID is enough.",
          "title": "Identify users in events",
        },
      ]
    `);
  });

  it("does not suggest identifying users when the event has a user id", async () => {
    mockLatestEvent({ ...eventFixture, user: identifiedUser });

    expect(await getConcernCodes()).toEqual(["js_source_maps"]);
  });

  it("does not suggest identifying users for performance or generic issues", async () => {
    // both events have `user: null`
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/",
        () => HttpResponse.json(createPerformanceIssue()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
        () => HttpResponse.json(createPerformanceEvent()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/MCP-SERVER-EQE/",
        () => HttpResponse.json(createRegressedIssue()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/6898891101/events/latest/",
        () => HttpResponse.json(createGenericEvent()),
      ),
    );

    expect(await getConcernCodes("PERF-N1-001")).toEqual([]);
    expect(await getConcernCodes("MCP-SERVER-EQE")).toEqual([]);
  });
});
