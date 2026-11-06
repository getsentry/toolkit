import { describeEval } from "vitest-evals";
import {
  createTaskHarness,
  defineEvalCases,
  FIXTURES,
  NoOpTaskRunner,
  ToolPredictionJudge,
  type EvalCase,
} from "./utils";

const cases: EvalCase[] = [
  {
    input: `Whats the status on root causing this issue in Sentry?\n${FIXTURES.testIssueUrl}`,
    expectedTools: [
      {
        name: "analyze_issue_with_seer",
        arguments: {
          issueUrl: FIXTURES.testIssueUrl,
        },
      },
    ],
  },
  {
    input: `Can you root cause this issue and retrieve the analysis?\n${FIXTURES.testIssueUrl}`,
    expectedTools: [
      {
        name: "analyze_issue_with_seer",
        arguments: {
          issueUrl: FIXTURES.testIssueUrl,
        },
      },
    ],
  },
];

describeEval(
  "begin-issue-fix",
  {
    harness: createTaskHarness("begin-issue-fix", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
