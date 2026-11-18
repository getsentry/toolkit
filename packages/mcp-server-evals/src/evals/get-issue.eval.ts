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

describeEval(
  "get-issue",
  {
    harness: createTaskHarness("get-issue", McpToolCallTaskRunner()),
    judges: [ToolCallJudge({ ordered: true, params: "fuzzy" })],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 90000 }),
);
