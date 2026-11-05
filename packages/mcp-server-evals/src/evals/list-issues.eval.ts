import { describeEval } from "vitest-evals/legacy";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

describeEval("list-issues", {
  data: async () => {
    return [
      {
        input: `What are the most common production errors in ${FIXTURES.organizationSlug}?`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "is:unresolved",
              sort: "freq",
            },
          },
        ],
      },
      {
        input: `Show me the top issues in ${FIXTURES.organizationSlug} organization`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              sort: "freq",
            },
          },
        ],
      },
      {
        input: `What are the most recent issues in ${FIXTURES.organizationSlug}?`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              sort: "date",
            },
          },
        ],
      },
      {
        input: `Find the newest production issues in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              sort: "new",
            },
          },
        ],
      },
      {
        input: `What issues is david@sentry.io experiencing in ${FIXTURES.organizationSlug}?`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "user.email:david@sentry.io",
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
