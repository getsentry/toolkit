import { describeEval } from "vitest-evals/legacy";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

// Note: This eval requires OPENROUTER_API_KEY to be set in the environment
// The search_issue_events tool uses the AI SDK to translate natural language queries
describeEval("search-issue-events", {
  data: async () => {
    return [
      // Core test: Basic time-based filtering within an issue
      {
        input: `Show me events from the last hour in issue ${FIXTURES.issueId} in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issue_events",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              query: "from the last hour",
            },
          },
        ],
      },
      // Core test: Environment and release filtering
      {
        input: `Find production events with release v1.0 in issue ${FIXTURES.issueId} in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issue_events",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              query: "production events with release v1.0",
            },
          },
        ],
      },
      // Core test: User-specific filtering
      {
        input: `Show me events affecting user alice@example.com in issue ${FIXTURES.issueId} in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issue_events",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              query: "affecting user alice@example.com",
            },
          },
        ],
      },
      // Core test: Trace ID filtering
      {
        input: `Find events with trace ID abc123 in issue ${FIXTURES.issueId} in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issue_events",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              query: "with trace ID abc123",
            },
          },
        ],
      },
    ];
  },
  task: NoOpTaskRunner(),
  scorers: [ToolPredictionScorer()],
  threshold: 0.6,
  timeout: 30000,
});
