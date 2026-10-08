import { describeEval } from "vitest-evals";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

// Note: This eval requires OPENROUTER_API_KEY to be set in the environment
// The dataset search tools (search_errors, search_traces, search_logs, ...) use the AI SDK to translate natural language queries
describeEval("search-events", {
  data: async () => {
    return [
      // Core test: Basic error event search
      {
        input: `Find database timeouts in ${FIXTURES.organizationSlug} from the last week`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_errors",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "database timeouts from the last week",
            },
          },
        ],
      },
      // Core test: Performance spans search
      {
        input: `Find slow API calls taking over 5 seconds in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_traces",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "slow API calls taking over 5 seconds",
            },
          },
        ],
      },
      // Core test: Logs search
      {
        input: `Show me error logs from the last hour in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_logs",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "error logs from the last hour",
            },
          },
        ],
      },
      // Core test: Project-specific search
      {
        input: `Show me authentication errors in ${FIXTURES.organizationSlug}/${FIXTURES.projectSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "search_errors",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              projectSlug: FIXTURES.projectSlug,
              query: "authentication errors",
            },
          },
        ],
      },
      // Core test: Search with 'me' reference
      {
        input: `Show me errors affecting me in ${FIXTURES.organizationSlug}`,
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
            name: "search_errors",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              query: "errors affecting user.id:12345",
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
