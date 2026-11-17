import { describeEval } from "vitest-evals/legacy";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

// Note: This eval requires OPENROUTER_API_KEY to be set in the environment
// The search_issues tool uses the AI SDK to translate natural language queries
describeEval("search-issues", {
  data: async () => {
    return [
      // Core test: Basic issue search
      {
        input: `Show me unresolved issues in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "unresolved issues",
            },
          },
        ],
      },
      // Core test: Search with 'me' reference (tests whoami integration)
      {
        input: `Find issues assigned to me in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "whoami",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "issues assigned to me",
            },
          },
        ],
      },
      // Core test: Project-specific search
      {
        input: `Search for database errors in ${FIXTURES.organizationSlug}/${FIXTURES.projectSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              projectSlugOrId: FIXTURES.projectSlug,
              query: "database errors",
            },
          },
        ],
      },
      // Core test: Complex natural language query
      {
        input: `Find critical production errors affecting more than 100 users in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "critical production errors affecting more than 100 users",
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
