import { HttpResponse, http } from "msw";
/**
 * MSW-based Mock Server for Sentry MCP Development and Testing.
 *
 * Provides comprehensive mock responses for all Sentry API endpoints used by the
 * MCP server. Built with MSW (Mock Service Worker) for realistic HTTP interception
 * and response handling during development and testing.
 *
 * **Usage in Tests:**
 * ```typescript
 * import { mswServer } from "@sentry/mcp-server-mocks";
 *
 * beforeAll(() => mswServer.listen());
 * afterEach(() => mswServer.resetHandlers());
 * afterAll(() => mswServer.close());
 * ```
 *
 * **Usage in Development:**
 * ```typescript
 * // Start mock server for local development
 * mswServer.listen();
 * // Now all Sentry API calls will be intercepted
 * ```
 */
import { setupServer } from "msw/node";

import autofixStateFixture from "./fixtures/autofix-state.json" with {
  type: "json",
};
import autofixStateExplorerFixture from "./fixtures/autofix-state-explorer.json" with {
  type: "json",
};
import clientKeyFixture from "./fixtures/client-key.json" with { type: "json" };
import dashboardDetailsFixture from "./fixtures/dashboard-details.json" with {
  type: "json",
};
import dashboardListFixture from "./fixtures/dashboard-list.json" with {
  type: "json",
};
import eventsFixture from "./fixtures/event.json" with { type: "json" };
import eventAttachmentsFixture from "./fixtures/event-attachments.json" with {
  type: "json",
};
import eventsErrorsFixture from "./fixtures/events-errors.json" with {
  type: "json",
};
import eventsErrorsEmptyFixture from "./fixtures/events-errors-empty.json" with {
  type: "json",
};
import eventsSpansFixture from "./fixtures/events-spans.json" with {
  type: "json",
};
import eventsSpansEmptyFixture from "./fixtures/events-spans-empty.json" with {
  type: "json",
};
import eventsTraceMetricsFixture from "./fixtures/events-tracemetrics.json" with {
  type: "json",
};
import eventsTraceMetricsAggregateFixture from "./fixtures/events-tracemetrics-aggregate.json" with {
  type: "json",
};
import eventsTraceMetricsEmptyFixture from "./fixtures/events-tracemetrics-empty.json" with {
  type: "json",
};
import flamegraphFixture from "./fixtures/flamegraph.json" with {
  type: "json",
};
import issueFixture from "./fixtures/issue.json" with { type: "json" };
import issueActivityFixture from "./fixtures/issue-activity.json" with {
  type: "json",
};
import issueCommentsFixture from "./fixtures/issue-comments.json" with {
  type: "json",
};
import issueNullCulpritFixture from "./fixtures/issue-null-culprit.json" with {
  type: "json",
};
import issueTagValuesFixture from "./fixtures/issue-tag-values.json" with {
  type: "json",
};
import issueUserReportsFixture from "./fixtures/issue-user-reports.json" with {
  type: "json",
};
import monitorFixture from "./fixtures/monitor.json" with { type: "json" };
import monitorCheckInsFixture from "./fixtures/monitor-checkins.json" with {
  type: "json",
};
import monitorStatsFixture from "./fixtures/monitor-stats.json" with {
  type: "json",
};
import organizationFixture from "./fixtures/organization.json" with {
  type: "json",
};
import performanceEventFixture from "./fixtures/performance-event.json" with {
  type: "json",
};
import profileChunkFixture from "./fixtures/profile-chunk.json" with {
  type: "json",
};
import projectFixture from "./fixtures/project.json" with { type: "json" };
import releaseFixture from "./fixtures/release.json" with { type: "json" };
import releaseCommitsFixture from "./fixtures/release-commits.json" with {
  type: "json",
};
import releaseDeploysFixture from "./fixtures/release-deploys.json" with {
  type: "json",
};
import replayDetailsFixture from "./fixtures/replay-details.json" with {
  type: "json",
};
import replayRecordingSegmentsFixture from "./fixtures/replay-recording-segments.json" with {
  type: "json",
};
import tagsFixture from "./fixtures/tags.json" with { type: "json" };
import teamFixture from "./fixtures/team.json" with { type: "json" };
import traceFixture from "./fixtures/trace.json" with { type: "json" };
import traceEventFixture from "./fixtures/trace-event.json" with {
  type: "json",
};
import traceItemsAttributesLogsNumberFixture from "./fixtures/trace-items-attributes-logs-number.json" with {
  type: "json",
};
import traceItemsAttributesLogsStringFixture from "./fixtures/trace-items-attributes-logs-string.json" with {
  type: "json",
};
import traceItemsAttributesSpansNumberFixture from "./fixtures/trace-items-attributes-spans-number.json" with {
  type: "json",
};
import traceItemsAttributesSpansStringFixture from "./fixtures/trace-items-attributes-spans-string.json" with {
  type: "json",
};
import traceItemsAttributesTraceMetricsNumberFixture from "./fixtures/trace-items-attributes-tracemetrics-number.json" with {
  type: "json",
};
import traceItemsAttributesTraceMetricsStringFixture from "./fixtures/trace-items-attributes-tracemetrics-string.json" with {
  type: "json",
};
import traceMetaFixture from "./fixtures/trace-meta.json" with { type: "json" };
import traceMetaWithNullsFixture from "./fixtures/trace-meta-with-nulls.json" with {
  type: "json",
};
import traceMixedFixture from "./fixtures/trace-mixed.json" with {
  type: "json",
};
import transactionProfileV1Fixture from "./fixtures/transaction-profile-v1.json" with {
  type: "json",
};
import transactionProfileV1MissingFunctionFixture from "./fixtures/transaction-profile-v1-missing-function.json" with {
  type: "json",
};
import uptimeChecksFixture from "./fixtures/uptime-checks.json" with {
  type: "json",
};
import uptimeMonitorFixture from "./fixtures/uptime-monitor.json" with {
  type: "json",
};
import userFixture from "./fixtures/user.json" with { type: "json" };
import { issueFixture2 } from "./payloads";

/**
 * Builds MSW handlers for both SaaS and self-hosted Sentry instances.
 *
 * Creates handlers based on the controlOnly flag:
 * - controlOnly: false (default) - Creates handlers for both sentry.io and us.sentry.io
 * - controlOnly: true - Creates handlers only for sentry.io (main host)
 *
 * @param handlers - Array of handler definitions with method, path, fetch function, and optional controlOnly flag
 * @returns Array of MSW http handlers
 *
 * @example Handler Definitions
 * ```typescript
 * buildHandlers([
 *   {
 *     method: "get",
 *     path: "/api/0/auth/",
 *     fetch: () => HttpResponse.json({ user: "data" }),
 *     controlOnly: true  // Only available on sentry.io
 *   },
 *   {
 *     method: "get",
 *     path: "/api/0/organizations/",
 *     fetch: () => HttpResponse.json([OrganizationPayload]),
 *     controlOnly: false  // Available on both sentry.io and us.sentry.io
 *   }
 * ]);
 * ```
 */
function buildHandlers(
  handlers: {
    method: keyof typeof http;
    path: string;
    fetch: Parameters<(typeof http)[keyof typeof http]>[1];
    controlOnly?: boolean;
  }[],
) {
  const result = [];

  for (const handler of handlers) {
    // Always add handler for main host (sentry.io)
    result.push(
      http[handler.method](`https://sentry.io${handler.path}`, handler.fetch),
    );

    // Only add handler for region-specific host if not controlOnly
    if (!handler.controlOnly) {
      result.push(
        http[handler.method](
          `https://us.sentry.io${handler.path}`,
          handler.fetch,
        ),
      );
    }
  }

  return result;
}

function withTraceItemAttributeMetadata(
  attributes: readonly { key: string; name: string }[],
  attributeType: "string" | "number" | "boolean",
) {
  return attributes.map((attribute) => ({
    ...attribute,
    attributeType,
    attributeSource: { source_type: "sentry" as const },
  }));
}

type IssueUpdateBody = {
  assignedTo?: unknown;
  ignoreCount?: number;
  ignoreDuration?: number;
  ignoreUserCount?: number;
  ignoreUserWindow?: number;
  ignoreWindow?: number;
  status?: string;
  substatus?: string;
};

type ClientKeyUpdateBody = {
  name?: string;
  isActive?: boolean;
  rateLimit?: { window: number; count: number } | null;
  browserSdkVersion?: string;
  dynamicSdkLoaderOptions?: {
    hasReplay?: boolean;
    hasPerformance?: boolean;
    hasDebug?: boolean;
    hasFeedback?: boolean;
    hasLogsAndMetrics?: boolean;
  };
};

function buildMockIgnoredStatusDetails(
  body: IssueUpdateBody,
  substatus: string | null | undefined,
) {
  if (substatus === "archived_until_escalating") {
    return { ignoreUntilEscalating: true };
  }

  if (substatus === "archived_until_condition_met") {
    return {
      ...(body.ignoreDuration !== undefined
        ? { ignoreDuration: body.ignoreDuration }
        : {}),
      ...(body.ignoreCount !== undefined
        ? { ignoreCount: body.ignoreCount }
        : {}),
      ...(body.ignoreWindow !== undefined
        ? { ignoreWindow: body.ignoreWindow }
        : {}),
      ...(body.ignoreUserCount !== undefined
        ? { ignoreUserCount: body.ignoreUserCount }
        : {}),
      ...(body.ignoreUserWindow !== undefined
        ? { ignoreUserWindow: body.ignoreUserWindow }
        : {}),
    };
  }

  return {};
}

function buildUpdatedIssueResponse(
  baseIssue: typeof issueFixture,
  body: IssueUpdateBody,
) {
  const hasIgnoreConditions =
    body.ignoreDuration !== undefined ||
    body.ignoreCount !== undefined ||
    body.ignoreUserCount !== undefined;
  const requestedStatus = body.status ?? baseIssue.status;
  const status =
    requestedStatus === "resolvedInNextRelease" ? "resolved" : requestedStatus;
  const substatus =
    status === "ignored"
      ? (body.substatus ??
        (hasIgnoreConditions
          ? "archived_until_condition_met"
          : "archived_until_escalating"))
      : baseIssue.substatus;

  let statusDetails = baseIssue.statusDetails;

  if (requestedStatus === "resolvedInNextRelease") {
    statusDetails = { inNextRelease: true };
  } else if (status === "ignored") {
    statusDetails = buildMockIgnoredStatusDetails(body, substatus);
  } else if (body.status !== undefined) {
    statusDetails = {};
  }

  return {
    ...baseIssue,
    status,
    substatus,
    statusDetails,
    assignedTo: body.assignedTo ?? baseIssue.assignedTo,
  };
}

/**
 * Complete set of Sentry API mock handlers.
 *
 * Covers all endpoints used by the MCP server with realistic responses,
 * parameter validation, and error scenarios.
 */
export const restHandlers = buildHandlers([
  // User data endpoints - controlOnly: true (only available on sentry.io)
  {
    method: "get",
    path: "/api/0/auth/",
    controlOnly: true,
    fetch: () => {
      return HttpResponse.json(userFixture);
    },
  },
  {
    method: "get",
    path: "/api/0/users/me/regions/",
    controlOnly: true,
    fetch: () => {
      return HttpResponse.json({
        regions: [{ name: "us", url: "https://us.sentry.io" }],
      });
    },
  },
  // All other endpoints - controlOnly: false (default, available on both hosts)
  {
    method: "get",
    path: "/api/0/organizations/",
    fetch: () => {
      return HttpResponse.json([organizationFixture]);
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/",
    fetch: () => {
      return HttpResponse.json(organizationFixture);
    },
  },
  // 404 handlers for test scenarios
  {
    method: "get",
    path: "/api/0/organizations/nonexistent-org/",
    fetch: () => {
      return HttpResponse.json(
        { detail: "The requested resource does not exist" },
        { status: 404 },
      );
    },
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/nonexistent-project/",
    fetch: () => {
      return HttpResponse.json(
        { detail: "The requested resource does not exist" },
        { status: 404 },
      );
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/teams/",
    fetch: () => {
      return HttpResponse.json([teamFixture]);
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/projects/",
    fetch: () => {
      return HttpResponse.json([
        {
          ...projectFixture,
          id: "4509106749636608", // Different ID for GET endpoint
        },
      ]);
    },
  },
  {
    method: "post",
    path: "/api/0/organizations/sentry-mcp-evals/onboarding/agent/status/",
    fetch: () => {
      return HttpResponse.json({
        schemaVersion: 1,
        runId: "2d27f6654b754dcaa2d26af18274d142",
        channelId: "6835652362204cb1b10719783c26983a",
        clientRunId: "e806c6f4-fef8-47b4-a720-5ab582b2fcf0",
        createdAt: "2026-08-12T12:00:00Z",
        updatedAt: "2026-08-12T12:01:00Z",
        sequence: 1,
        expiresAt: "2026-08-13T12:00:00Z",
        continueUpdates: true,
        runStatus: "active",
        stages: [
          {
            stage: "connect_mcp",
            status: "completed",
            eventNote: null,
            extra: null,
          },
        ],
      });
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/dashboards/",
    fetch: ({ request }) => {
      const url = new URL(request.url);
      const query = url.searchParams.get("query")?.toLowerCase();
      const perPage = Number(url.searchParams.get("per_page") ?? "10");
      const cursor = url.searchParams.get("cursor");
      const dashboards = query
        ? dashboardListFixture.filter((dashboard) =>
            dashboard.title.toLowerCase().includes(query),
          )
        : dashboardListFixture;
      const start = cursor === "dashboard-cursor" ? perPage : 0;
      const page = dashboards.slice(start, start + perPage);
      const hasMore = start + perPage < dashboards.length;

      return HttpResponse.json(page, {
        headers: hasMore
          ? {
              Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/?cursor=dashboard-cursor>; rel="next"; results="true"; cursor="dashboard-cursor"',
            }
          : undefined,
      });
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/dashboards/101/",
    fetch: () => HttpResponse.json(dashboardDetailsFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/dashboards/102/",
    fetch: () =>
      HttpResponse.json({
        ...dashboardDetailsFixture,
        id: "102",
        title: "Errors Overview Copy",
        widgets: [],
        isFavorited: false,
      }),
  },
  {
    method: "post",
    path: "/api/0/organizations/sentry-mcp-evals/teams/",
    fetch: () => {
      // TODO: validate payload (only accept 'the-goats' for team name)
      return HttpResponse.json(
        {
          ...teamFixture,
          id: "4509109078196224",
          dateCreated: "2025-04-07T00:05:48.196710Z",
          access: [
            "event:read",
            "org:integrations",
            "org:read",
            "member:read",
            "alerts:write",
            "event:admin",
            "team:admin",
            "project:releases",
            "team:read",
            "project:write",
            "event:write",
            "team:write",
            "project:read",
            "project:admin",
            "alerts:read",
          ],
        },
        { status: 201 },
      );
    },
  },
  {
    method: "post",
    path: "/api/0/teams/sentry-mcp-evals/the-goats/projects/",
    fetch: async ({ request }) => {
      // TODO: validate payload (only accept 'cloudflare-mcp' for project name)
      const body = (await request.json()) as any;
      return HttpResponse.json({
        ...projectFixture,
        name: body?.name || "cloudflare-mcp",
        slug: body?.slug || "cloudflare-mcp",
        platform: body?.platform || "node",
      });
    },
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
    fetch: () => {
      return HttpResponse.json(projectFixture);
    },
  },
  {
    method: "get",
    path: "/api/0/projects/:organizationSlug/:projectSlugOrId/",
    fetch: ({ params }) => {
      const projectSlugOrId = String(params.projectSlugOrId);
      const numericProjectId = Number(projectSlugOrId);

      return HttpResponse.json({
        ...projectFixture,
        id: Number.isNaN(numericProjectId)
          ? projectFixture.id
          : numericProjectId,
        slug: Number.isNaN(numericProjectId)
          ? projectSlugOrId
          : projectFixture.slug,
        name: Number.isNaN(numericProjectId)
          ? projectSlugOrId
          : projectFixture.name,
      });
    },
  },
  {
    method: "put",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as any;
      return HttpResponse.json({
        ...projectFixture,
        slug: body?.slug || "cloudflare-mcp",
        name: body?.name || "cloudflare-mcp",
        platform: body?.platform || "node",
      });
    },
  },
  {
    method: "post",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
    fetch: () => {
      // TODO: validate payload (only accept 'Default' for key name)
      return HttpResponse.json(clientKeyFixture);
    },
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
    fetch: () => {
      return HttpResponse.json([clientKeyFixture]);
    },
  },
  {
    method: "get",
    path: "/api/0/projects/:organizationSlug/:projectSlug/teams/",
    fetch: () => {
      return HttpResponse.json([teamFixture]);
    },
  },
  {
    method: "delete",
    path: "/api/0/projects/:organizationSlug/:projectSlug/teams/:teamSlug/",
    fetch: () => {
      return new HttpResponse(null, { status: 204 });
    },
  },
  {
    method: "put",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/:keyId/",
    fetch: async ({ request, params }) => {
      const body = (await request.json()) as ClientKeyUpdateBody;
      const rateLimit =
        body.rateLimit && body.rateLimit.count > 0 && body.rateLimit.window > 0
          ? body.rateLimit
          : null;
      return HttpResponse.json({
        ...clientKeyFixture,
        id: params.keyId,
        name: body.name ?? clientKeyFixture.name,
        isActive:
          body.isActive !== undefined
            ? body.isActive
            : clientKeyFixture.isActive,
        rateLimit:
          body.rateLimit !== undefined ? rateLimit : clientKeyFixture.rateLimit,
        browserSdkVersion:
          body.browserSdkVersion ?? clientKeyFixture.browserSdkVersion,
        dynamicSdkLoaderOptions: {
          ...clientKeyFixture.dynamicSdkLoaderOptions,
          ...body.dynamicSdkLoaderOptions,
        },
      });
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/events/",
    fetch: async ({ request }) => {
      const url = new URL(request.url);
      const dataset = url.searchParams.get("dataset");
      const query = url.searchParams.get("query");
      const fields = url.searchParams.getAll("field");

      if (dataset === "spans") {
        //[sentryApi] GET https://sentry.io/api/0/organizations/sentry-mcp-evals/events/?dataset=spans&per_page=10&referrer=sentry-mcp&sort=-span.duration&allowAggregateConditions=0&useRpc=1&field=id&field=trace&field=span.op&field=span.description&field=span.duration&field=transaction&field=project&field=timestamp&query=is_transaction%3Atrue
        if (query !== "is_transaction:true") {
          return HttpResponse.json(eventsSpansEmptyFixture);
        }

        if (url.searchParams.get("useRpc") !== "1") {
          return HttpResponse.json("Invalid useRpc", { status: 400 });
        }

        if (
          !fields.includes("id") ||
          !fields.includes("trace") ||
          !fields.includes("span.op") ||
          !fields.includes("span.description") ||
          !fields.includes("span.duration")
        ) {
          return HttpResponse.json("Invalid fields", { status: 400 });
        }
        return HttpResponse.json(eventsSpansFixture);
      }
      if (dataset === "errors") {
        //https://sentry.io/api/0/organizations/sentry-mcp-evals/events/?dataset=errors&per_page=10&referrer=sentry-mcp&sort=-count&statsPeriod=1w&field=issue&field=title&field=project&field=last_seen%28%29&field=count%28%29&query=

        if (
          !fields.includes("issue") ||
          !fields.includes("title") ||
          !fields.includes("project") ||
          !fields.includes("last_seen()") ||
          !fields.includes("count()")
        ) {
          return HttpResponse.json("Invalid fields", { status: 400 });
        }

        if (
          !["-count", "-last_seen"].includes(
            url.searchParams.get("sort") as string,
          )
        ) {
          return HttpResponse.json("Invalid sort", { status: 400 });
        }

        // TODO: this is not correct, but itll fix test flakiness for now
        const sortedQuery = query ? query?.split(" ").sort().join(" ") : null;
        if (
          ![
            null,
            "",
            "error.handled:false",
            "error.unhandled:true",
            "error.handled:false is:unresolved",
            "error.unhandled:true is:unresolved",
            "is:unresolved project:cloudflare-mcp",
            "project:cloudflare-mcp",
            "user.email:david@sentry.io",
          ].includes(sortedQuery)
        ) {
          return HttpResponse.json(eventsErrorsEmptyFixture);
        }

        return HttpResponse.json(eventsErrorsFixture);
      }

      if (dataset === "tracemetrics") {
        const sort = url.searchParams.get("sort");
        const isAggregateQuery = fields.some(
          (field) => field.includes("(") && field.includes(")"),
        );

        if (!sort) {
          return HttpResponse.json("Missing sort", { status: 400 });
        }

        if (isAggregateQuery) {
          if (!sort.includes("(")) {
            return HttpResponse.json("Invalid tracemetrics sort", {
              status: 400,
            });
          }

          return HttpResponse.json(eventsTraceMetricsAggregateFixture);
        }

        const sortedQuery = query ? query?.split(" ").sort().join(" ") : null;
        if (
          ![
            null,
            "",
            "metric.name:http.request.duration metric.type:distribution",
          ].includes(sortedQuery)
        ) {
          return HttpResponse.json(eventsTraceMetricsEmptyFixture);
        }

        return HttpResponse.json(eventsTraceMetricsFixture);
      }

      return HttpResponse.json("Invalid dataset", { status: 400 });
    },
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/foobar/issues/",
    fetch: () => HttpResponse.json([]),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/issues/",
    fetch: ({ request }) => {
      const url = new URL(request.url);
      const sort = url.searchParams.get("sort");

      if (![null, "user", "freq", "date", "new", null].includes(sort)) {
        return HttpResponse.json(
          `Invalid sort: ${url.searchParams.get("sort")}`,
          {
            status: 400,
          },
        );
      }

      const collapse = url.searchParams.getAll("collapse");
      if (collapse.includes("stats")) {
        return HttpResponse.json(`Invalid collapse: ${collapse.join(",")}`, {
          status: 400,
        });
      }

      const query = url.searchParams.get("query");
      const queryTokens = query?.split(" ").sort() ?? [];
      const sortedQuery = queryTokens ? queryTokens.join(" ") : null;
      if (
        ![
          null,
          "",
          "is:unresolved",
          "error.handled:false is:unresolved",
          "error.unhandled:true is:unresolved",
          "user.email:david@sentry.io",
        ].includes(sortedQuery)
      ) {
        return HttpResponse.json([]);
      }

      if (queryTokens.includes("user.email:david@sentry.io")) {
        return HttpResponse.json([issueFixture]);
      }

      if (sort === "date") {
        return HttpResponse.json([issueFixture, issueFixture2]);
      }
      return HttpResponse.json([issueFixture2, issueFixture]);
    },
  },

  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/",
    fetch: ({ request }) => {
      const url = new URL(request.url);
      const sort = url.searchParams.get("sort");

      if (![null, "user", "freq", "date", "new", null].includes(sort)) {
        return HttpResponse.json(
          `Invalid sort: ${url.searchParams.get("sort")}`,
          {
            status: 400,
          },
        );
      }

      const collapse = url.searchParams.getAll("collapse");
      if (collapse.includes("stats")) {
        return HttpResponse.json(`Invalid collapse: ${collapse.join(",")}`, {
          status: 400,
        });
      }

      const query = url.searchParams.get("query");
      const queryTokens = query?.split(" ").sort() ?? [];
      const sortedQuery = queryTokens ? queryTokens.join(" ") : null;
      if (query === "7ca573c0f4814912aaa9bdc77d1a7d51") {
        return HttpResponse.json([issueFixture]);
      }
      if (
        ![
          null,
          "",
          "is:unresolved",
          "error.handled:false is:unresolved",
          "error.unhandled:true is:unresolved",
          "project:cloudflare-mcp",
          "is:unresolved project:cloudflare-mcp",
          "user.email:david@sentry.io",
        ].includes(sortedQuery)
      ) {
        if (queryTokens.includes("project:remote-mcp")) {
          return HttpResponse.json(
            {
              detail:
                "Invalid query. Project(s) remote-mcp do not exist or are not actively selected.",
            },
            { status: 400 },
          );
        }
        return HttpResponse.json([]);
      }
      if (queryTokens.includes("user.email:david@sentry.io")) {
        return HttpResponse.json([issueFixture]);
      }

      if (sort === "date") {
        return HttpResponse.json([issueFixture, issueFixture2]);
      }
      return HttpResponse.json([issueFixture2, issueFixture]);
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
    fetch: () => HttpResponse.json(issueFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/6507376925/",
    fetch: () => HttpResponse.json(issueFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-42/",
    fetch: () => HttpResponse.json(issueFixture2),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/6507376926/",
    fetch: () => HttpResponse.json(issueFixture2),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/replay-count/",
    fetch: () => HttpResponse.json({}),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/replays/",
    fetch: () =>
      HttpResponse.json({
        data: [
          replayDetailsFixture,
          {
            ...replayDetailsFixture,
            id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            count_errors: 0,
            count_rage_clicks: 2,
            count_dead_clicks: 1,
            started_at: "2025-01-10T10:00:00Z",
            duration: 120,
            urls: ["/settings"],
            releases: ["frontend@2.0.0"],
          },
        ],
      }),
  },
  {
    method: "get",
    path: `/api/0/organizations/sentry-mcp-evals/replays/${replayDetailsFixture.id}/`,
    fetch: () => HttpResponse.json({ data: replayDetailsFixture }),
  },
  {
    method: "get",
    path: `/api/0/projects/sentry-mcp-evals/${replayDetailsFixture.project_id}/replays/${replayDetailsFixture.id}/recording-segments/`,
    fetch: () => HttpResponse.json(replayRecordingSegmentsFixture),
  },

  // Trace endpoints
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/trace-meta/a4d1aae7216b47ff8117cf4e09ce9d0a/",
    fetch: () => HttpResponse.json(traceMetaFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/trace/a4d1aae7216b47ff8117cf4e09ce9d0a/",
    fetch: () => HttpResponse.json(traceFixture),
  },

  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/events/7ca573c0f4814912aaa9bdc77d1a7d51/",
    fetch: () => HttpResponse.json(eventsFixture),
  },
  // Generic handler for listing events within an issue
  {
    method: "get",
    path: "/api/0/organizations/:org/issues/:issueId/events/",
    fetch: () => {
      // Return an array directly (not wrapped in {data: [...]})
      return HttpResponse.json([
        {
          id: "event1",
          timestamp: "2025-01-15T10:00:00Z",
          title: "Test Error",
          environment: "production",
          release: "v1.0",
        },
      ]);
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/events/latest/",
    fetch: () => HttpResponse.json(eventsFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/7ca573c0f4814912aaa9bdc77d1a7d51/",
    fetch: () => HttpResponse.json(eventsFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/6507376925/events/latest/",
    fetch: () => HttpResponse.json(eventsFixture),
  },
  // TODO: event payload should be tweaked to match issue
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-42/events/latest/",
    fetch: () => HttpResponse.json(eventsFixture),
  },
  // TODO: event payload should be tweaked to match issue
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/6507376926/events/latest/",
    fetch: () => HttpResponse.json(eventsFixture),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/CLOUDFLARE-MCP/stacktrace-link/",
    fetch: () =>
      HttpResponse.json({
        config: null,
        sourcePath: null,
        sourceUrl: null,
        integrations: [],
        error: "no_code_mappings_for_project",
      }),
  },

  // Performance issue with N+1 query detection
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/events/latest/",
    fetch: () => HttpResponse.json(performanceEventFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/7890123456/events/latest/",
    fetch: () => HttpResponse.json(performanceEventFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/events/a1b2c3d4e5f6789012345678901234567/",
    fetch: () => HttpResponse.json(performanceEventFixture),
  },

  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/environments/",
    fetch: () =>
      HttpResponse.json([
        { id: "1", name: "production" },
        { id: "2", name: "development" },
      ]),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/releases/",
    fetch: () => HttpResponse.json([releaseFixture]),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/releases/8ce89484-0fec-4913-a2cd-e8e2d41dee36/",
    fetch: () => HttpResponse.json(releaseFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/releases/8ce89484-0fec-4913-a2cd-e8e2d41dee36/deploys/",
    fetch: () => HttpResponse.json(releaseDeploysFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/releases/8ce89484-0fec-4913-a2cd-e8e2d41dee36/commits/",
    fetch: () => HttpResponse.json(releaseCommitsFixture),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/releases/",
    fetch: () => HttpResponse.json([releaseFixture]),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/releases/8ce89484-0fec-4913-a2cd-e8e2d41dee36/",
    fetch: () => HttpResponse.json(releaseFixture),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/releases/8ce89484-0fec-4913-a2cd-e8e2d41dee36/commits/",
    fetch: () => HttpResponse.json(releaseCommitsFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/uptime/",
    fetch: () => HttpResponse.json([uptimeMonitorFixture]),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/",
    fetch: () => HttpResponse.json(uptimeMonitorFixture),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/checks/",
    fetch: () => HttpResponse.json(uptimeChecksFixture),
  },
  {
    method: "post",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        {
          ...uptimeMonitorFixture,
          ...body,
          id: "4509100000001002",
          projectSlug: "cloudflare-mcp",
          status: body.status ?? "active",
          uptimeStatus: 1,
          method: body.method ?? "GET",
          headers: body.headers ?? [],
          body: body.body ?? null,
          assertion: body.assertion ?? null,
          recoveryThreshold: body.recoveryThreshold ?? 1,
          downtimeThreshold: body.downtimeThreshold ?? 3,
          traceSampling: body.traceSampling ?? false,
          responseCaptureEnabled: body.responseCaptureEnabled ?? true,
        },
        { status: 201 },
      );
    },
  },
  {
    method: "put",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        ...uptimeMonitorFixture,
        ...body,
      });
    },
  },
  {
    method: "delete",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/uptime/4509100000001001/",
    fetch: () => new HttpResponse(null, { status: 202 }),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/monitors/",
    fetch: () => HttpResponse.json([monitorFixture]),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/",
    fetch: () => HttpResponse.json(monitorFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/checkins/",
    fetch: () => HttpResponse.json(monitorCheckInsFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/monitors/nightly-import/stats/",
    fetch: () => HttpResponse.json(monitorStatsFixture),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/",
    fetch: () => HttpResponse.json(monitorFixture),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/checkins/",
    fetch: () => HttpResponse.json(monitorCheckInsFixture),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/stats/",
    fetch: () => HttpResponse.json(monitorStatsFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/tags/",
    fetch: () => HttpResponse.json(tagsFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/events/validate/",
    fetch: ({ request }) => {
      const url = new URL(request.url);
      const fields = url.searchParams.getAll("field");
      const query = url.searchParams.get("query");
      const orderby = url.searchParams.getAll("orderby");
      const environments = url.searchParams.getAll("environment");

      const fieldResults = fields.map((field) => ({
        name: field,
        valid: true,
        attrType:
          field.includes("sequence") ||
          field.includes("count") ||
          field.includes("duration")
            ? "number"
            : "string",
        error: null,
      }));

      const queryFieldResults = query
        ? [
            {
              name: "transaction",
              valid: true,
              attrType: "string",
              error: null,
            },
          ]
        : [];

      const orderbyResults = orderby.map((value) => ({
        name: value,
        valid: fields.length > 0,
        attrType: null,
        error:
          fields.length > 0 ? null : "Orderby must also be a selected field",
      }));

      const environmentResults = environments.map((environment) => ({
        valid: true,
        error: null,
      }));

      return HttpResponse.json({
        valid:
          fieldResults.every((field) => field.valid) &&
          queryFieldResults.every((item) => item.valid) &&
          orderbyResults.every((item) => item.valid) &&
          environmentResults.every((item) => item.valid),
        projects: [],
        dataset: [],
        environment: environmentResults,
        field: fieldResults,
        query: {
          valid: queryFieldResults.every((item) => item.valid),
          error: null,
          fields: queryFieldResults,
        },
        orderby: orderbyResults,
      });
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/trace-items/attributes/",
    fetch: ({ request }) => {
      const url = new URL(request.url);
      const itemType = url.searchParams.get("itemType");
      const attributeType = url.searchParams.get("attributeType");

      // Validate required parameters
      if (!itemType) {
        return HttpResponse.json(
          { detail: "itemType parameter is required" },
          { status: 400 },
        );
      }

      // Validate itemType values (API accepts both singular and plural forms)
      const normalizedItemType = itemType === "spans" ? "span" : itemType;
      if (!["span", "logs", "tracemetrics"].includes(normalizedItemType)) {
        return HttpResponse.json(
          {
            detail: `Invalid itemType '${itemType}'. Must be 'span', 'logs', or 'tracemetrics'`,
          },
          { status: 400 },
        );
      }

      if (!attributeType) {
        if (normalizedItemType === "span") {
          return HttpResponse.json([
            ...withTraceItemAttributeMetadata(
              traceItemsAttributesSpansStringFixture,
              "string",
            ),
            ...withTraceItemAttributeMetadata(
              traceItemsAttributesSpansNumberFixture,
              "number",
            ),
          ]);
        }
        if (normalizedItemType === "logs") {
          return HttpResponse.json([
            ...withTraceItemAttributeMetadata(
              traceItemsAttributesLogsStringFixture,
              "string",
            ),
            ...withTraceItemAttributeMetadata(
              traceItemsAttributesLogsNumberFixture,
              "number",
            ),
          ]);
        }
        return HttpResponse.json([
          ...withTraceItemAttributeMetadata(
            traceItemsAttributesTraceMetricsStringFixture,
            "string",
          ),
          ...withTraceItemAttributeMetadata(
            traceItemsAttributesTraceMetricsNumberFixture,
            "number",
          ),
        ]);
      }

      // Validate attributeType values
      if (!["string", "number", "boolean"].includes(attributeType)) {
        return HttpResponse.json(
          {
            detail: `Invalid attributeType '${attributeType}'. Must be 'string', 'number', or 'boolean'`,
          },
          { status: 400 },
        );
      }

      // Return appropriate fixture based on parameters
      if (normalizedItemType === "span") {
        if (attributeType === "string") {
          return HttpResponse.json(
            withTraceItemAttributeMetadata(
              traceItemsAttributesSpansStringFixture,
              "string",
            ),
          );
        }
        return HttpResponse.json(
          withTraceItemAttributeMetadata(
            traceItemsAttributesSpansNumberFixture,
            "number",
          ),
        );
      }
      if (normalizedItemType === "logs") {
        if (attributeType === "string") {
          return HttpResponse.json(
            withTraceItemAttributeMetadata(
              traceItemsAttributesLogsStringFixture,
              "string",
            ),
          );
        }
        return HttpResponse.json(
          withTraceItemAttributeMetadata(
            traceItemsAttributesLogsNumberFixture,
            "number",
          ),
        );
      }
      if (normalizedItemType === "tracemetrics") {
        if (attributeType === "string") {
          return HttpResponse.json(
            withTraceItemAttributeMetadata(
              traceItemsAttributesTraceMetricsStringFixture,
              "string",
            ),
          );
        }
        return HttpResponse.json(
          withTraceItemAttributeMetadata(
            traceItemsAttributesTraceMetricsNumberFixture,
            "number",
          ),
        );
      }

      return HttpResponse.json(
        { detail: "Unsupported trace item attribute request" },
        { status: 400 },
      );
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/PEATED-A8/autofix/",
    fetch: () => HttpResponse.json(autofixStateFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/autofix/",
    fetch: () => HttpResponse.json({ autofix: null }),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/:issueId(\\d+)/autofix/",
    fetch: () => HttpResponse.json({ autofix: null }),
  },
  {
    method: "post",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-42/autofix/",
    fetch: () => HttpResponse.json({ run_id: 123 }),
  },
  {
    method: "post",
    path: "/api/0/organizations/sentry-mcp-evals/issues/PEATED-A8/autofix/",
    fetch: () => HttpResponse.json({ run_id: 123 }),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/PERF-N1-001/autofix/",
    fetch: () => HttpResponse.json({ autofix: null }),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/DEFAULT-001/autofix/",
    fetch: () => HttpResponse.json({ autofix: null }),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CONTEXT-001/autofix/",
    fetch: () => HttpResponse.json({ autofix: null }),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/MCP-SERVER-EQE/autofix/",
    fetch: () => HttpResponse.json({ autofix: null }),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/FUTURE-TYPE-001/autofix/",
    fetch: () => HttpResponse.json({ autofix: null }),
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/BLOG-CSP-4XC/autofix/",
    fetch: () => HttpResponse.json({ autofix: null }),
  },

  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-45/autofix/",
    fetch: () =>
      HttpResponse.json({
        autofix: {
          run_id: 13,
          status: "completed",
          updated_at: "2025-04-09T22:39:50.778146",
          owner_user_id: null,
          pending_user_input: null,
          repo_pr_states: {},
          blocks: [
            {
              id: "block-1",
              message: {
                role: "assistant",
                content: "The analysis has completed successfully.",
                thinking_content: null,
                tool_calls: null,
                metadata: null,
              },
              timestamp: "2025-04-09T22:39:50.000000",
              loading: false,
              artifacts: [
                {
                  key: "root_cause",
                  reason: "Root cause analysis completed",
                  data: {
                    one_line_description:
                      "The analysis has completed successfully.",
                    five_whys: [],
                    reproduction_steps: [],
                    relevant_repo: null,
                  },
                },
              ],
              file_patches: null,
              merged_file_patches: null,
              pr_commit_shas: null,
              todos: null,
              tool_links: null,
              tool_results: null,
            },
          ],
        },
      }),
  },
  // The backend returns 404 when no suspect committers are found.
  {
    method: "get",
    path: "/api/0/projects/:org/:project/events/:eventId/committers/",
    fetch: () =>
      HttpResponse.json({ detail: "No committers found" }, { status: 404 }),
  },
  // External issue links endpoints (default: empty for most issues)
  {
    method: "get",
    path: "/api/0/organizations/:org/issues/:issueId/external-issues/",
    fetch: () => HttpResponse.json([]),
  },
  // User reports endpoints
  {
    method: "get",
    path: "/api/0/organizations/:org/issues/:issueId/user-reports/",
    fetch: () => HttpResponse.json(issueUserReportsFixture),
  },
  // Issue tag values endpoints
  {
    method: "get",
    path: "/api/0/organizations/:org/issues/:issueId/tags/:tagKey/",
    fetch: ({ params }) => {
      const tagKey = params.tagKey as string;
      // Return fixture with the requested tag key
      return HttpResponse.json({
        ...issueTagValuesFixture,
        key: tagKey,
        name: tagKey.charAt(0).toUpperCase() + tagKey.slice(1),
      });
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/:org/issues/:issueId/activities/",
    fetch: () => HttpResponse.json(issueActivityFixture),
  },
  {
    method: "get",
    path: "/api/0/organizations/:org/issues/:issueId/notes/",
    fetch: () => HttpResponse.json(issueCommentsFixture),
  },
  {
    method: "post",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/teams/:teamSlug/",
    fetch: async ({ request, params }) => {
      const body = (await request.json()) as any;
      const teamSlug = params.teamSlug as string;
      return HttpResponse.json({
        ...teamFixture,
        id: "4509109078196224",
        slug: teamSlug,
        name: teamSlug,
        dateCreated: "2025-04-07T00:05:48.196710Z",
      });
    },
  },
  {
    method: "post",
    path: "/api/0/organizations/:org/issues/:issueId/notes/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as { text: string };
      return HttpResponse.json({
        id: "12345",
        user: userFixture,
        sentry_app: null,
        type: "note",
        data: {
          text: body.text,
        },
        dateCreated: "2025-04-14T12:34:56.000Z",
      });
    },
  },
  {
    method: "put",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as IssueUpdateBody;
      return HttpResponse.json(buildUpdatedIssueResponse(issueFixture, body));
    },
  },
  {
    method: "put",
    path: "/api/0/organizations/sentry-mcp-evals/issues/6507376925/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as IssueUpdateBody;
      return HttpResponse.json(buildUpdatedIssueResponse(issueFixture, body));
    },
  },
  {
    method: "put",
    path: "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-42/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as IssueUpdateBody;
      return HttpResponse.json(buildUpdatedIssueResponse(issueFixture2, body));
    },
  },
  {
    method: "put",
    path: "/api/0/organizations/sentry-mcp-evals/issues/6507376926/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as IssueUpdateBody;
      return HttpResponse.json(buildUpdatedIssueResponse(issueFixture2, body));
    },
  },
  // Profiling endpoints
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/profiling/flamegraph/",
    fetch: ({ request }) => {
      const url = new URL(request.url);
      const project = url.searchParams.get("project");
      const query = url.searchParams.get("query");

      // Return empty but valid flamegraph for unknown transactions
      // Note: Query may have quoted transaction name: transaction:"/api/users"
      if (
        !query?.includes('transaction:"/api/users"') &&
        !query?.includes("transaction:/api/users")
      ) {
        return HttpResponse.json({
          ...flamegraphFixture,
          projectID: Number(project) || flamegraphFixture.projectID,
          transactionName: "unknown",
          profiles: [],
          shared: {
            frames: [],
            frame_infos: [],
            profiles: [],
          },
        });
      }

      return HttpResponse.json(flamegraphFixture);
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/sentry-mcp-evals/profiling/chunks/",
    fetch: () => {
      return HttpResponse.json(profileChunkFixture);
    },
  },
  {
    method: "get",
    path: "/api/0/organizations/:organizationSlug/profiling/chunks/",
    fetch: () => {
      return HttpResponse.json(profileChunkFixture);
    },
  },
  {
    method: "get",
    path: "/api/0/projects/:organizationSlug/:projectSlugOrId/profiling/profiles/:profileId/",
    fetch: ({ params }) => {
      const profileId = String(params.profileId);
      return HttpResponse.json({
        ...transactionProfileV1Fixture,
        event_id: profileId,
        profile_id: profileId,
      });
    },
  },
  // Event attachment endpoints
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/7ca573c0f4814912aaa9bdc77d1a7d51/attachments/",
    fetch: () => HttpResponse.json(eventAttachmentsFixture),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/7ca573c0f4814912aaa9bdc77d1a7d51/attachments/123/",
    fetch: () => {
      // Mock attachment blob response
      const mockBlob = new Blob(["fake image data"], { type: "image/png" });
      return new HttpResponse(mockBlob, {
        headers: {
          "Content-Type": "image/png",
        },
      });
    },
  },
  // Scenario: metadata mimetype is stale "application/octet-stream" (pre-fix
  // ingest or legacy attachment) but the download response returns the correct
  // Content-Type. Validates that the MCP uses Step 2 (download header) over
  // Step 1 (metadata), so the attachment is rendered as an image not a blob.
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/d49541c747cb4d8aa3efb70ca5aba244/attachments/",
    fetch: () =>
      HttpResponse.json([
        {
          id: "456",
          name: "screenshot.png",
          type: "event.attachment",
          size: 1024,
          mimetype: "application/octet-stream",
          dateCreated: "2025-04-08T21:15:04.000Z",
          headers: { "Content-Type": "application/octet-stream" },
        },
      ]),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/d49541c747cb4d8aa3efb70ca5aba244/attachments/456/",
    fetch: () => {
      const mockBlob = new Blob(["fake image data"], { type: "image/png" });
      return new HttpResponse(mockBlob, {
        headers: {
          "Content-Type": "image/png",
        },
      });
    },
  },
  // A text/plain (.log) attachment (the shape reported in #1267).
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/e49541c747cb4d8aa3efb70ca5aba245/attachments/",
    fetch: () =>
      HttpResponse.json([
        {
          id: "789",
          name: "application.log",
          type: "event.attachment",
          size: 44,
          mimetype: "text/plain",
          dateCreated: "2025-04-08T21:15:04.000Z",
          headers: { "Content-Type": "text/plain" },
        },
      ]),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/e49541c747cb4d8aa3efb70ca5aba245/attachments/789/",
    fetch: () =>
      new HttpResponse(
        new Blob(["INFO app started\nERROR db connection failed\n"], {
          type: "text/plain",
        }),
        { headers: { "Content-Type": "text/plain" } },
      ),
  },
  // Oversized objectstore attachment: the download 302-redirects to a presigned
  // URL (mocked below).
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/f49541c747cb4d8aa3efb70ca5aba246/attachments/",
    fetch: () =>
      HttpResponse.json([
        {
          id: "999",
          name: "core.dmp",
          type: "event.attachment",
          size: 50 * 1024 * 1024,
          mimetype: "application/octet-stream",
          dateCreated: "2025-04-08T21:15:04.000Z",
          headers: { "Content-Type": "application/octet-stream" },
        },
      ]),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/f49541c747cb4d8aa3efb70ca5aba246/attachments/999/",
    fetch: () =>
      HttpResponse.redirect(
        "https://objectstore.example.test/attachments/999/blob?sig=test-signature",
        302,
      ),
  },
  // Oversized legacy attachment: the download streams a 200 with no redirect, so
  // there is no presigned URL.
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/h49541c747cb4d8aa3efb70ca5aba248/attachments/",
    fetch: () =>
      HttpResponse.json([
        {
          id: "222",
          // Hostile, uploader-controlled name: must never reach a shell command.
          name: "pwn; rm -rf ~ #.dmp",
          type: "event.attachment",
          size: 40 * 1024 * 1024,
          mimetype: "application/octet-stream",
          dateCreated: "2025-04-08T21:15:04.000Z",
          headers: { "Content-Type": "application/octet-stream" },
        },
      ]),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/h49541c747cb4d8aa3efb70ca5aba248/attachments/222/",
    fetch: () =>
      new HttpResponse(
        new Blob(["legacy bytes"], { type: "application/octet-stream" }),
        {
          headers: { "Content-Type": "application/octet-stream" },
        },
      ),
  },
  // Metadata reports a non-empty file but the download returns zero bytes.
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/g49541c747cb4d8aa3efb70ca5aba247/attachments/",
    fetch: () =>
      HttpResponse.json([
        {
          id: "111",
          name: "screenshot.png",
          type: "event.attachment",
          size: 1024,
          mimetype: "image/png",
          dateCreated: "2025-04-08T21:15:04.000Z",
          headers: { "Content-Type": "image/png" },
        },
      ]),
  },
  {
    method: "get",
    path: "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/g49541c747cb4d8aa3efb70ca5aba247/attachments/111/",
    fetch: () =>
      new HttpResponse(new Blob([], { type: "image/png" }), {
        headers: { "Content-Type": "image/png" },
      }),
  },
  {
    method: "get",
    path: "/api/0/organizations/:organizationSlug/repos/",
    fetch: () => {
      return HttpResponse.json([
        {
          id: "101",
          name: "getsentry/sentry",
          provider: { id: "integrations:github", name: "GitHub" },
          status: "active",
          externalSlug: "getsentry/sentry",
          externalId: "123456",
          integrationId: "1",
        },
      ]);
    },
  },
  {
    method: "post",
    path: "/api/0/organizations/:organizationSlug/code-mappings/bulk/",
    fetch: async ({ request }) => {
      const body = (await request.json()) as {
        mappings?: Array<{ stackRoot?: string; sourceRoot?: string }>;
      };
      const mappings = body.mappings ?? [{ stackRoot: "", sourceRoot: "" }];
      return HttpResponse.json({
        created: mappings.length,
        updated: 0,
        errors: 0,
        mappings: mappings.map((mapping) => ({
          stackRoot: mapping.stackRoot ?? "",
          sourceRoot: mapping.sourceRoot ?? "",
          status: "created",
        })),
      });
    },
  },
]);

// Add handlers for mcp.sentry.dev and localhost
export const searchHandlers = [
  // Presigned target for the oversized-attachment redirect (999).
  http.get("https://objectstore.example.test/attachments/999/blob", () =>
    HttpResponse.text("presigned blob bytes"),
  ),
  http.post("https://mcp.sentry.dev/api/search", async ({ request }) => {
    const body = (await request.json()) as any;

    // Mock different results based on guide
    let results = [
      {
        id: "product/rate-limiting.md",
        url: "https://docs.sentry.io/product/rate-limiting",
        snippet:
          "Learn how to configure rate limiting in Sentry to prevent quota exhaustion and control event ingestion.",
        relevance: 0.95,
      },
      {
        id: "product/accounts/quotas/spike-protection.md",
        url: "https://docs.sentry.io/product/accounts/quotas/spike-protection",
        snippet:
          "Spike protection helps prevent unexpected spikes in event volume from consuming your quota.",
        relevance: 0.87,
      },
    ];

    // If guide is specified, return platform-specific results
    if (body?.guide) {
      const guide = body.guide;
      if (guide.includes("/")) {
        const [platformName, guideName] = guide.split("/");
        results = [
          {
            id: `platforms/${platformName}/guides/${guideName}.md`,
            url: `https://docs.sentry.io/platforms/${platformName}/guides/${guideName}`,
            snippet: `Setup guide for ${guideName} on ${platformName}`,
            relevance: 0.95,
          },
        ];
      } else {
        results = [
          {
            id: `platforms/${guide}/index.md`,
            url: `https://docs.sentry.io/platforms/${guide}`,
            snippet: `Documentation for ${guide} platform`,
            relevance: 0.95,
          },
        ];
      }
    }

    // Return mock search results
    return HttpResponse.json({
      query: body?.query || "",
      results,
    });
  }),
];

// Mock handlers for documentation fetching
export const docsHandlers = [
  http.get("https://docs.sentry.io/product/rate-limiting.md", () => {
    return new HttpResponse(
      `# Project Rate Limits and Quotas

Rate limiting allows you to control the volume of events that Sentry accepts from your applications. This helps you manage costs and ensures that a sudden spike in errors doesn't consume your entire quota.

## Why Use Rate Limiting?

- **Cost Control**: Prevent unexpected charges from error spikes
- **Noise Reduction**: Filter out repetitive or low-value events
- **Resource Management**: Ensure critical projects have quota available
- **Performance**: Reduce load on your Sentry organization

## Types of Rate Limits

### 1. Organization Rate Limits

Set a maximum number of events per hour across your entire organization:

\`\`\`python
# In your organization settings
rate_limit = 1000  # events per hour
\`\`\`

### 2. Project Rate Limits

Configure limits for specific projects:

\`\`\`javascript
// Project settings
{
  "rateLimit": {
    "window": 3600,  // 1 hour in seconds
    "limit": 500     // max events
  }
}
\`\`\`

### 3. Key-Based Rate Limiting

Rate limit by specific attributes:

- **By Release**: Limit events from specific releases
- **By User**: Prevent single users from consuming quota
- **By Transaction**: Control high-volume transactions

## Configuration Examples

### SDK Configuration

Configure client-side sampling to reduce events before they're sent:

\`\`\`javascript
Sentry.init({
  dsn: "your-dsn",
  tracesSampleRate: 0.1,  // Sample 10% of transactions
  beforeSend(event) {
    // Custom filtering logic
    if (event.exception?.values?.[0]?.value?.includes("NetworkError")) {
      return null;  // Drop network errors
    }
    return event;
  }
});
\`\`\`

### Inbound Filters

Use Sentry's inbound filters to drop events server-side:

1. Go to **Project Settings** → **Inbound Filters**
2. Enable filters for:
   - Legacy browsers
   - Web crawlers
   - Specific error messages
   - IP addresses

### Spike Protection

Enable spike protection to automatically limit events during traffic spikes:

\`\`\`python
# Project settings
spike_protection = {
  "enabled": True,
  "max_events_per_hour": 10000,
  "detection_window": 300  # 5 minutes
}
\`\`\`

## Best Practices

1. **Start Conservative**: Begin with lower limits and increase as needed
2. **Monitor Usage**: Regularly review your quota consumption
3. **Use Sampling**: Implement transaction sampling for high-volume apps
4. **Filter Noise**: Drop known low-value events at the SDK level
5. **Set Alerts**: Configure notifications for quota thresholds

## Rate Limit Headers

Sentry returns rate limit information in response headers:

\`\`\`
X-Sentry-Rate-Limit: 60
X-Sentry-Rate-Limit-Remaining: 42
X-Sentry-Rate-Limit-Reset: 1634567890
\`\`\`

## Quota Management

### Viewing Quota Usage

1. Navigate to **Settings** → **Subscription**
2. View usage by:
   - Project
   - Event type
   - Time period

### On-Demand Budgets

Purchase additional events when approaching limits:

\`\`\`bash
# Via API
curl -X POST https://sentry.io/api/0/organizations/{org}/quotas/ \\
  -H 'Authorization: Bearer <token>' \\
  -d '{"events": 100000}'
\`\`\`

## Troubleshooting

### Events Being Dropped?

Check:
1. Organization and project rate limits
2. Spike protection status
3. SDK sampling configuration
4. Inbound filter settings

### Rate Limit Errors

If you see 429 errors:
- Review your rate limit configuration
- Implement exponential backoff
- Consider event buffering

## Related Documentation

- [SDK Configuration Guide](/platforms/javascript/configuration)
- [Quotas and Billing](/product/quotas)
- [Filtering Events](/product/data-management/filtering)`,
      {
        headers: {
          "Content-Type": "text/markdown",
        },
      },
    );
  }),
  http.get(
    "https://docs.sentry.io/product/accounts/quotas/spike-protection.md",
    () => {
      return new HttpResponse(
        `# Spike Protection

Spike protection prevents sudden spikes in event volume from consuming your entire quota.

## How it works

When Sentry detects an abnormal spike in events, it automatically activates spike protection...`,
        {
          headers: {
            "Content-Type": "text/markdown",
          },
        },
      );
    },
  ),
  // Catch-all for other doc paths - return 404
  http.get("https://docs.sentry.io/*.md", () => {
    return new HttpResponse(null, { status: 404 });
  }),
];

/**
 * Configured MSW server instance with all Sentry API mock handlers.
 *
 * Ready-to-use mock server for testing and development. Includes all endpoints
 * with realistic data, parameter validation, and error scenarios.
 *
 * @example Test Setup
 * ```typescript
 * import { mswServer } from "@sentry/mcp-server-mocks";
 *
 * beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
 * afterEach(() => mswServer.resetHandlers());
 * afterAll(() => mswServer.close());
 * ```
 *
 * @example Development Usage
 * ```typescript
 * import { mswServer } from "@sentry/mcp-server-mocks";
 *
 * // Start intercepting requests
 * mswServer.listen();
 *
 * // Your MCP server will now use mock responses
 * const apiService = new SentryApiService({ host: "sentry.io" });
 * const orgs = await apiService.listOrganizations();
 * console.log(orgs); // Returns mock organization data
 * ```
 *
 * @note User Data Endpoint Restrictions
 * The following endpoints are configured with `controlOnly: true` to work ONLY
 * with the main host (sentry.io) and will NOT respond to requests from
 * region-specific hosts (us.sentry.io, de.sentry.io):
 * - `/api/0/auth/` (whoami endpoint)
 * - `/api/0/users/me/regions/` (find_organizations endpoint)
 *
 * This matches the real Sentry API behavior where user data must always be queried
 * from the main API server.
 */
export const mswServer = setupServer(
  ...restHandlers,
  ...searchHandlers,
  ...docsHandlers,
);

// Export fixture factories
export {
  createCspEvent,
  createCspIssue,
  createDefaultEvent,
  createFeedbackIssue,
  createGenericEvent,
  createPerformanceEvent,
  createPerformanceIssue,
  createRegressedIssue,
  createUnknownEvent,
  createUnsupportedIssue,
} from "./fixtures";
// Export utilities for creating mock servers
export { setupMockServer, startMockServer } from "./utils";
// Export fixtures for use in tests
export {
  autofixStateExplorerFixture,
  autofixStateFixture,
  clientKeyFixture,
  dashboardDetailsFixture,
  dashboardListFixture,
  eventAttachmentsFixture,
  eventsErrorsEmptyFixture,
  eventsErrorsFixture,
  eventsFixture as eventFixture,
  eventsFixture,
  eventsSpansEmptyFixture,
  eventsSpansFixture,
  flamegraphFixture,
  issueFixture,
  issueNullCulpritFixture,
  organizationFixture,
  performanceEventFixture,
  profileChunkFixture,
  projectFixture,
  releaseFixture,
  replayDetailsFixture,
  replayRecordingSegmentsFixture,
  tagsFixture,
  teamFixture,
  traceEventFixture,
  traceFixture,
  traceItemsAttributesLogsNumberFixture,
  traceItemsAttributesLogsStringFixture,
  traceItemsAttributesSpansNumberFixture,
  traceItemsAttributesSpansStringFixture,
  traceMetaFixture,
  traceMetaWithNullsFixture,
  traceMixedFixture,
  transactionProfileV1Fixture,
  transactionProfileV1MissingFunctionFixture,
  userFixture,
};
