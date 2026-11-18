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
    input: `What is the SENTRY_DSN for ${FIXTURES.organizationSlug}/${FIXTURES.projectSlug}?`,
    expectedTools: [
      {
        name: "find_dsns",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          projectSlug: FIXTURES.projectSlug,
        },
      },
    ],
  },
];

describeEval(
  "list-dsns",
  {
    harness: createTaskHarness("list-dsns", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
