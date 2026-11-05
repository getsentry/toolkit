import { describeEval } from "vitest-evals";
import {
  createTaskHarness,
  defineEvalCases,
  FIXTURES,
  McpToolCallTaskRunner,
  ToolCallJudge,
  type EvalCase,
} from "./utils";

const cases: EvalCase[] = [
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

describeEval(
  "get-trace-details",
  {
    harness: createTaskHarness("get-trace-details", McpToolCallTaskRunner()),
    judges: [ToolCallJudge({ ordered: true, params: "fuzzy" })],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 90000 }),
);
