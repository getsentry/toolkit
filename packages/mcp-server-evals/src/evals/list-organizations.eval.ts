import { describeEval } from "vitest-evals";
import {
  createTaskHarness,
  defineEvalCases,
  NoOpTaskRunner,
  ToolPredictionJudge,
  type EvalCase,
} from "./utils";

const cases: EvalCase[] = [
  {
    input: `What organizations do I have access to in Sentry`,
    expectedTools: [
      {
        name: "find_organizations",
        arguments: {},
      },
    ],
  },
];

describeEval(
  "list-organizations",
  {
    harness: createTaskHarness("list-organizations", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
