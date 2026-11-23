import { describeEval, ToolCallScorer } from "vitest-evals/legacy";
import { FIXTURES, McpToolCallTaskRunner } from "./utils";

// render_sentry_chart rejects issue filters, so an issue trend question must
// land on render_issue_chart.
describeEval("render-issue-chart", {
  data: async () => {
    return [
      {
        input: `How is CLOUDFLARE-MCP-41 in ${FIXTURES.organizationSlug} trending this week?`,
        expectedTools: [
          {
            name: "render_issue_chart",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: "CLOUDFLARE-MCP-41",
              period: "7d",
            },
          },
        ],
      },
      {
        input: `Chart the events and affected users of PERF-N1-001 in ${FIXTURES.organizationSlug}.`,
        expectedTools: [
          {
            name: "render_issue_chart",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: "PERF-N1-001",
            },
          },
        ],
      },
    ];
  },
  task: McpToolCallTaskRunner(),
  scorers: [ToolCallScorer({ ordered: true, params: "fuzzy" })],
  threshold: 0.6,
  timeout: 90000,
});
