import { describeEval, ToolCallScorer } from "vitest-evals/legacy";
import { FIXTURES, McpToolCallTaskRunner } from "./utils";

describeEval("get-trace-details", {
  data: async () => {
    return [
      {
        input: `Show me trace ${FIXTURES.traceId} from Sentry in ${FIXTURES.organizationSlug}.`,
        expectedTools: [
          {
            name: "get_trace_details",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              traceId: FIXTURES.traceId,
            },
          },
        ],
      },
      {
        input: `Explain trace ${FIXTURES.traceId} in ${FIXTURES.organizationSlug}.`,
        expectedTools: [
          {
            name: "get_trace_details",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              traceId: FIXTURES.traceId,
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
