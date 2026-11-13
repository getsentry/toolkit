import { describeEval, ToolCallScorer } from "vitest-evals/legacy";
import { FIXTURES, McpToolCallTaskRunner } from "./utils";

describeEval("get-issue", {
  data: async () => {
    return [
      {
        input: `Explain CLOUDFLARE-MCP-41 from Sentry in ${FIXTURES.organizationSlug}.`,
        expectedTools: [
          {
            name: "get_issue_details",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: "CLOUDFLARE-MCP-41",
            },
          },
        ],
      },
      {
        input: `Explain the event with ID 7ca573c0f4814912aaa9bdc77d1a7d51 from Sentry in ${FIXTURES.organizationSlug}.`,
        expectedTools: [
          {
            name: "get_issue_details",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              eventId: "7ca573c0f4814912aaa9bdc77d1a7d51",
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
