import { describeEval, ToolCallScorer } from "vitest-evals/legacy";
import { FIXTURES, McpToolCallTaskRunner } from "./utils";

describeEval("find-related-issues", {
  data: async () => {
    return [
      {
        input: `Find issues related to CLOUDFLARE-MCP-41 in ${FIXTURES.organizationSlug}.`,
        expectedTools: [
          {
            name: "find_related_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: "CLOUDFLARE-MCP-41",
            },
          },
        ],
      },
      {
        input: `Is CLOUDFLARE-MCP-41 in ${FIXTURES.organizationSlug} a duplicate of another issue?`,
        expectedTools: [
          {
            name: "find_related_issues",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: "CLOUDFLARE-MCP-41",
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
