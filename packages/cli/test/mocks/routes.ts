/**
 * Mock API Routes for E2E Tests
 *
 * Defines all API routes and their responses using fixture data.
 * Routes are used by the mock server to simulate Sentry API responses.
 */

import methodNotAllowedFixture from "../fixtures/errors/method-not-allowed.json";
import notFoundFixture from "../fixtures/errors/not-found.json";
import eventFixture from "../fixtures/event.json";
import feedbackFixture from "../fixtures/feedback.json";
import feedbackEventFixture from "../fixtures/feedback-event.json";
import feedbacksFixture from "../fixtures/feedbacks.json";
import issueFixture from "../fixtures/issue.json";
import issuesFixture from "../fixtures/issues.json";
import logDetailFixture from "../fixtures/log-detail.json";
import logsFixture from "../fixtures/logs.json";
import organizationFixture from "../fixtures/organization.json";
import organizationsFixture from "../fixtures/organizations.json";
import projectFixture from "../fixtures/project.json";
import projectsFixture from "../fixtures/projects.json";
import traceSpansFixture from "../fixtures/trace-spans.json";
import transactionsFixture from "../fixtures/transactions.json";
import userFixture from "../fixtures/user.json";
import type { MockResponse, MockRoute, MockServer } from "./server.js";
import { createMockServer } from "./server.js";

export const TEST_ORG = "test-org";
export const TEST_PROJECT = "test-project";
export const TEST_TOKEN = "test-auth-token-12345";
export const TEST_ISSUE_ID = "400001";
export const TEST_ISSUE_SHORT_ID = "TEST-PROJECT-1A";
export const TEST_EVENT_ID = "abc123def456abc123def456abc12345";
export const TEST_FEEDBACK_ID = "5146636313";
export const TEST_FEEDBACK_SHORT_ID = "TEST-PROJECT-2SDJ";
export const TEST_FEEDBACK_EVENT_ID = "feed123def456abc123def456abc1234";
export const TEST_FEEDBACK_LATEST_ORG = "test-feedback-latest-org";
export const TEST_DSN = "https://abc123@o123.ingest.sentry.io/456789";
export const TEST_LOG_ID = "a0a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5";
export const TEST_TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";

const projectKeysFixture = [
  {
    id: "key-123",
    name: "Default",
    dsn: {
      public: TEST_DSN,
      secret: "https://abc123:secret@o123.ingest.sentry.io/456789",
    },
    isActive: true,
    dateCreated: "2024-01-01T00:00:00.000Z",
  },
];

function feedbackLimitContextResponse(
  url: URL,
  serverUrl: string
): MockResponse | undefined {
  const query = url.searchParams.get("query") ?? "";
  if (!query.includes("e2e-limit-context")) {
    return;
  }

  const limit = url.searchParams.get("limit") ?? "unknown";
  const expectedCursor = `feedback-limit-${limit}-next`;
  const cursor = url.searchParams.get("cursor");
  if (cursor && cursor !== expectedCursor) {
    return {
      status: 400,
      body: { detail: `Unexpected cursor ${cursor}` },
    };
  }
  return {
    body: Array.from(
      { length: Number.parseInt(limit, 10) },
      () => feedbacksFixture[0]
    ),
    headers: {
      Link: `<${serverUrl}/next>; rel="next"; results="true"; cursor="${expectedCursor}"`,
    },
  };
}

/** Validate the org-wide issue-index request made by `feedback view @latest`. */
function feedbackLatestValidationResponse(url: URL): MockResponse | undefined {
  const query = url.searchParams.get("query") ?? "";
  if (
    url.searchParams.get("limit") === "1" &&
    query.includes("status:unresolved") &&
    url.searchParams.get("sort") === "date"
  ) {
    return;
  }

  return {
    status: 400,
    body: { detail: "Invalid @latest Feedback query" },
  };
}

/** Build the Feedback-specific response for the shared issue-index route. */
function feedbackIssueIndexResponse(
  url: URL,
  orgSlug: string,
  serverUrl: string
): MockResponse {
  if (orgSlug === TEST_FEEDBACK_LATEST_ORG) {
    const latestValidationResponse = feedbackLatestValidationResponse(url);
    if (latestValidationResponse) {
      return latestValidationResponse;
    }
  }

  const paginationResponse = feedbackLimitContextResponse(url, serverUrl);
  if (paginationResponse) {
    return paginationResponse;
  }

  const query = url.searchParams.get("query") ?? "";
  if (
    query.includes("e2e-status-check") &&
    !query.includes("status:unresolved")
  ) {
    return {
      status: 400,
      body: { detail: "Missing default Feedback status filter" },
    };
  }

  return { body: feedbacksFixture };
}

/** Build the org issue-index response for issue and Feedback E2E tests. */
function issueIndexResponse(
  req: Request,
  params: Record<string, string>,
  serverUrl: string
): MockResponse {
  const supportedOrgs = [TEST_ORG, TEST_FEEDBACK_LATEST_ORG];
  if (!supportedOrgs.includes(params.orgSlug)) {
    return { status: 404, body: notFoundFixture };
  }

  const url = new URL(req.url);
  const query = url.searchParams.get("query") ?? "";
  if (query.includes("issue.category:feedback")) {
    return feedbackIssueIndexResponse(url, params.orgSlug, serverUrl);
  }
  return { body: issuesFixture };
}

/**
 * Resolve the events-endpoint body for the logs dataset.
 *
 * If the query contains a sentry.item_id filter, returns the matching detailed
 * log. Query format: "project:${proj} sentry.item_id:${id}" or
 * "project:${proj} sentry.item_id:[id1,id2,...]"
 */
function resolveLogEventsBody(query: string | null) {
  if (query?.includes("sentry.item_id:")) {
    const bracketMatch = query.match(/sentry\.item_id:\[([^\]]+)\]/);
    const singleMatch = query.match(/sentry\.item_id:([0-9a-f]{32})/i);
    let ids: string[] = [];
    if (bracketMatch) {
      ids = bracketMatch[1].split(",").map((s) => s.trim());
    } else if (singleMatch) {
      ids = [singleMatch[1]];
    }
    if (ids.includes(TEST_LOG_ID)) {
      return logDetailFixture;
    }
    return { data: [], meta: { fields: {} } };
  }
  return logsFixture;
}

export const apiRoutes: MockRoute[] = [
  // User Regions (multi-region support)
  // Returns the mock server itself as the only region
  {
    method: "GET",
    path: "/api/0/users/me/regions/",
    response: (_req, _params, serverUrl) => ({
      body: {
        regions: [{ name: "monolith", url: serverUrl }],
      },
    }),
  },

  // Auth / current user (works with all token types including OAuth)
  {
    method: "GET",
    path: "/api/0/auth/",
    response: userFixture,
  },

  // Users (legacy endpoint, kept for backward compatibility)
  {
    method: "GET",
    path: "/api/0/users/me/",
    response: userFixture,
  },

  // Organizations
  {
    method: "GET",
    path: "/api/0/organizations/",
    response: organizationsFixture,
  },
  {
    method: "GET",
    path: "/api/0/empty-error/",
    response: () => ({ status: 404 }),
  },
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG) {
        return { body: organizationFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "DELETE",
    path: "/api/0/organizations/",
    response: methodNotAllowedFixture,
    status: 405,
  },
  {
    method: "POST",
    path: "/api/0/organizations/",
    response: methodNotAllowedFixture,
    status: 405,
  },

  // Projects
  {
    method: "GET",
    path: "/api/0/projects/",
    response: projectsFixture,
  },
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/projects/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG) {
        return { body: projectsFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "GET",
    path: "/api/0/projects/:orgSlug/:projectSlug/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG && params.projectSlug === TEST_PROJECT) {
        return { body: projectFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "GET",
    path: "/api/0/projects/:orgSlug/:projectSlug/keys/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG && params.projectSlug === TEST_PROJECT) {
        return { body: projectKeysFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },

  // Issues (org-scoped endpoint used by @sentry/api SDK)
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/issues/",
    response: issueIndexResponse,
  },
  // Issues (legacy project-scoped endpoint)
  {
    method: "GET",
    path: "/api/0/projects/:orgSlug/:projectSlug/issues/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG && params.projectSlug === TEST_PROJECT) {
        return { body: issuesFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "GET",
    path: "/api/0/issues/:issueId/",
    response: (_req, params) => {
      if (params.issueId === TEST_FEEDBACK_ID) {
        return { body: feedbackFixture };
      }
      if (params.issueId === TEST_ISSUE_ID) {
        return { body: issueFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/issues/:shortId/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG && params.shortId === TEST_FEEDBACK_ID) {
        return { body: feedbackFixture };
      }
      if (
        params.orgSlug === TEST_ORG &&
        params.shortId.toUpperCase() === TEST_FEEDBACK_SHORT_ID
      ) {
        return { body: feedbackFixture };
      }
      if (
        params.orgSlug === TEST_ORG &&
        params.shortId.toUpperCase() === TEST_ISSUE_SHORT_ID
      ) {
        return { body: issueFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/shortids/:shortId/",
    response: (_req, params) => {
      if (
        params.orgSlug === TEST_ORG &&
        params.shortId.toUpperCase() === TEST_FEEDBACK_SHORT_ID
      ) {
        return { body: { group: feedbackFixture } };
      }
      if (
        params.orgSlug === TEST_ORG &&
        params.shortId.toUpperCase() === TEST_ISSUE_SHORT_ID
      ) {
        return { body: { group: issueFixture } };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "PUT",
    path: "/api/0/organizations/:orgSlug/issues/:issueId/",
    response: async (req, params) => {
      if (
        ![TEST_ORG, TEST_FEEDBACK_LATEST_ORG].includes(params.orgSlug) ||
        params.issueId !== TEST_FEEDBACK_ID
      ) {
        return { status: 404, body: notFoundFixture };
      }
      const body = await req.json();
      if (
        !["resolved", "unresolved", "ignored"].includes(body.status) ||
        Object.keys(body).length !== 1
      ) {
        return {
          status: 400,
          body: {
            detail: "Expected only a resolved, unresolved, or ignored status",
          },
        };
      }
      return { body: { ...feedbackFixture, status: body.status } };
    },
  },
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/issues/:issueId/events/latest/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG && params.issueId === TEST_FEEDBACK_ID) {
        return { body: feedbackEventFixture };
      }
      if (params.orgSlug === TEST_ORG && params.issueId === TEST_ISSUE_ID) {
        return { body: eventFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },

  // Events
  {
    method: "GET",
    path: "/api/0/projects/:orgSlug/:projectSlug/events/:eventId/",
    response: (_req, params) => {
      if (
        params.orgSlug === TEST_ORG &&
        params.projectSlug === TEST_PROJECT &&
        params.eventId === TEST_EVENT_ID
      ) {
        return { body: eventFixture };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "GET",
    path: "/api/0/projects/:orgSlug/:projectSlug/events/:eventId/attachments/",
    response: (_req, params) => {
      if (
        params.orgSlug === TEST_ORG &&
        params.projectSlug === TEST_PROJECT &&
        params.eventId === TEST_FEEDBACK_EVENT_ID
      ) {
        return {
          body: [
            {
              id: "attachment-1",
              event_id: TEST_FEEDBACK_EVENT_ID,
              type: "event.attachment",
              name: "screenshot.png",
              mimetype: "image/png",
              dateCreated: "2026-07-16T12:00:00Z",
              size: 2048,
              headers: {},
              sha1: null,
            },
          ],
        };
      }
      if (
        params.orgSlug === TEST_ORG &&
        params.projectSlug === TEST_PROJECT &&
        params.eventId === TEST_EVENT_ID
      ) {
        return { body: [] };
      }
      return { status: 404, body: notFoundFixture };
    },
  },
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/replay-count/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG) {
        return {
          body: {
            [TEST_FEEDBACK_ID]: [
              "346789a703f6454384f1de473b8b9fcc",
              "aaaaaaaa03f6454384f1de473b8b9fcc",
            ],
          },
        };
      }
      return { status: 404, body: notFoundFixture };
    },
  },

  // Logs & trace list (Events API - dispatches on dataset param)
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/events/",
    response: (req, params) => {
      if (params.orgSlug === TEST_ORG) {
        const url = new URL(req.url);
        const dataset = url.searchParams.get("dataset");
        const query = url.searchParams.get("query");
        if (
          dataset === "spans" &&
          (query ?? "").includes("is_transaction:true")
        ) {
          return { body: transactionsFixture };
        }
        return { body: resolveLogEventsBody(query) };
      }
      return { status: 404, body: notFoundFixture };
    },
  },

  // Trace detail (span tree)
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/trace/:traceId/",
    response: (_req, params) => {
      if (params.orgSlug === TEST_ORG && params.traceId === TEST_TRACE_ID) {
        return { body: traceSpansFixture };
      }
      // Empty array = no spans found for this trace
      return { body: [] };
    },
  },

  // Trace logs (org-scoped)
  {
    method: "GET",
    path: "/api/0/organizations/:orgSlug/trace-logs/",
    response: (req, params) => {
      if (params.orgSlug !== TEST_ORG) {
        return { status: 404, body: notFoundFixture };
      }
      const url = new URL(req.url);
      const traceId = url.searchParams.get("traceId");
      if (traceId === TEST_TRACE_ID) {
        return {
          body: {
            data: [
              {
                id: "trace-log-001",
                "project.id": 456_789,
                trace: TEST_TRACE_ID,
                severity_number: 9,
                severity: "info",
                timestamp: "2026-03-01T12:00:00Z",
                timestamp_precise: 1_740_826_800_000_000_000,
                message: "Trace log message 1",
              },
              {
                id: "trace-log-002",
                "project.id": 456_789,
                trace: TEST_TRACE_ID,
                severity_number: 13,
                severity: "warning",
                timestamp: "2026-03-01T11:59:00Z",
                timestamp_precise: 1_740_826_740_000_000_000,
                message: "Trace log message 2",
              },
            ],
          },
        };
      }
      return { body: { data: [] } };
    },
  },
];

export function createSentryMockServer(): MockServer {
  return createMockServer(apiRoutes, { validTokens: [TEST_TOKEN] });
}
