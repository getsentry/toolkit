import {
  createFeedbackIssue,
  createPerformanceIssue,
} from "@sentry/mcp-server-mocks";
import { describe, expect, it } from "vitest";
import { IssueSchema } from "../../../api-client/schema";
import {
  type BuildIssueResultsParams,
  buildIssueResults,
  searchIssuesOutputSchema,
} from "./results";

const baseParams: Omit<BuildIssueResultsParams, "issues"> = {
  organizationSlug: "test-org",
  regionUrl: "https://sentry.io",
  inputQuery: "is:unresolved",
  query: "is:unresolved",
  sort: "date",
  period: "30d",
  notes: [],
};

function build(params: Partial<BuildIssueResultsParams>) {
  const { structuredContent } = buildIssueResults({
    ...baseParams,
    issues: [],
    ...params,
  });
  expect(searchIssuesOutputSchema.parse(structuredContent)).toEqual(
    structuredContent,
  );
  return structuredContent;
}

describe("buildIssueResults", () => {
  it("maps a feedback issue explicitly", () => {
    const feedbackIssue = createFeedbackIssue({
      shortId: "PROJ-FB-1",
      title: "User Feedback: Checkout broken",
      status: "unresolved",
      userCount: 1,
      count: "1",
      firstSeen: "2025-01-01T00:00:00Z",
      lastSeen: "2025-01-01T00:00:00Z",
      issueCategory: "feedback",
      culprit: "User Feedback Widget",
      secretBackendField: "must-not-leak",
      metadata: { contact_email: "reporter@example.com", name: "Reporter" },
    } as Parameters<typeof createFeedbackIssue>[0]);

    const structuredContent = build({
      // Parse like the API client does so the reporter fields must survive it.
      issues: [IssueSchema.parse(feedbackIssue)],
      inputQuery: "show me user feedback",
    });

    const serialized = JSON.stringify(structuredContent);
    expect(serialized).not.toContain("must-not-leak");
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "executedSearch": {
          "period": "30d",
          "projectSlugOrId": null,
          "query": "is:unresolved",
          "sort": "date",
        },
        "explanation": null,
        "issues": [
          {
            "assignedTo": null,
            "assigneeEmail": null,
            "culprit": "User Feedback Widget",
            "firstSeen": "2025-01-01T00:00:00Z",
            "issueCategory": "feedback",
            "lastSeen": "2025-01-01T00:00:00Z",
            "occurrences": 1,
            "projectSlug": "CLOUDFLARE-MCP",
            "reporter": {
              "email": "reporter@example.com",
              "name": "Reporter",
            },
            "seerActionability": null,
            "shortId": "PROJ-FB-1",
            "status": "unresolved",
            "substatus": "new",
            "title": "User Feedback: Checkout broken",
            "url": "https://test-org.sentry.io/issues/PROJ-FB-1",
            "usersImpacted": 1,
          },
        ],
        "notes": [],
        "presentationHint": "Cards work well for these issues, with status, assignee, and issue ID links visible. Please tell the user this dashboard link is available if they want to open the results in Sentry.",
        "query": "show me user feedback",
        "suggestedActions": [
          {
            "arguments": {
              "organizationSlug": "test-org",
              "resourceId": "PROJ-FB-1",
              "resourceType": "issue",
            },
            "reason": "Read the full feedback and its linked error events.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
        "url": "https://test-org.sentry.io/issues/?query=is%3Aunresolved",
      }
    `);
  });

  it("reports the category, actionability, and numeric counts", () => {
    const structuredContent = build({
      issues: [
        createPerformanceIssue({
          shortId: "TEST-HIGH",
          count: "100",
          userCount: 10,
          seerFixabilityScore: 0.7,
          assignedTo: {
            type: "user",
            id: "1",
            name: "Jane Doe",
            email: "jane@example.com",
          },
        }),
        createPerformanceIssue({ shortId: "TEST-NONE" }),
      ],
    });

    expect(
      structuredContent.issues.map(
        ({
          shortId,
          issueCategory,
          occurrences,
          seerActionability,
          assignedTo,
          assigneeEmail,
        }) => ({
          shortId,
          issueCategory,
          occurrences,
          seerActionability,
          assignedTo,
          assigneeEmail,
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "assignedTo": "Jane Doe",
          "assigneeEmail": "jane@example.com",
          "issueCategory": "performance",
          "occurrences": 100,
          "seerActionability": "high",
          "shortId": "TEST-HIGH",
        },
        {
          "assignedTo": null,
          "assigneeEmail": null,
          "issueCategory": "performance",
          "occurrences": 25,
          "seerActionability": null,
          "shortId": "TEST-NONE",
        },
      ]
    `);
  });

  it("only reads the reporter from feedback issues", () => {
    const structuredContent = build({
      issues: [
        IssueSchema.parse(
          createPerformanceIssue({
            shortId: "TEST-NOT-FEEDBACK",
            metadata: {
              name: "Not a reporter",
              contact_email: "x@example.com",
            },
          } as Parameters<typeof createPerformanceIssue>[0]),
        ),
      ],
    });

    expect(structuredContent.issues[0]?.reporter).toBeNull();
  });

  it("adds a feedback follow-up when any result is feedback", () => {
    const structuredContent = build({
      issues: [
        createPerformanceIssue({ shortId: "TEST-PERF-3" }),
        createFeedbackIssue({
          shortId: "TEST-FEEDBACK-3",
          issueCategory: "feedback",
        }),
      ],
    });

    expect(
      structuredContent.suggestedActions.map((action) => [
        action.arguments.resourceId,
        action.reason,
      ]),
    ).toEqual([
      ["TEST-PERF-3", "Inspect the first matching issue."],
      [
        "TEST-FEEDBACK-3",
        "Read the full feedback and its linked error events.",
      ],
    ]);
  });

  it("omits follow-ups the session cannot call", () => {
    const structuredContent = build({
      issues: [createPerformanceIssue({ shortId: "TEST-NO-RESOURCE" })],
      availableToolNames: new Set(["search_issues"]),
      directToolNames: new Set(["search_issues"]),
    });

    expect(structuredContent.suggestedActions).toEqual([]);
  });

  it("explains an empty result in notes", () => {
    const structuredContent = build({
      issues: [],
      notes: ["Query rewritten: example. Ran `is:unresolved`."],
    });

    expect(structuredContent.issues).toEqual([]);
    expect(structuredContent.notes).toEqual([
      "Query rewritten: example. Ran `is:unresolved`.",
      "No issues found matching your search criteria. Try adjusting your search criteria or time range.",
    ]);
    expect(structuredContent.suggestedActions).toEqual([]);
  });

  it("uses the configured self-hosted host and protocol when regionUrl is absent", () => {
    const structuredContent = build({
      regionUrl: undefined,
      host: "sentry.internal:9000",
      protocol: "http",
      issues: [createFeedbackIssue({ shortId: "PROJ-FB-2" })],
    });

    expect(structuredContent.url).toBe(
      "http://sentry.internal:9000/organizations/test-org/issues/?query=is%3Aunresolved",
    );
    expect(structuredContent.issues[0]?.url).toBe(
      "http://sentry.internal:9000/organizations/test-org/issues/PROJ-FB-2",
    );
  });
});
