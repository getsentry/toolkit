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
    input: `Create a new DSN named "Production" for '${FIXTURES.organizationSlug}/${FIXTURES.projectSlug}'`,
    expectedTools: [
      {
        name: "create_dsn",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          projectSlug: FIXTURES.projectSlug,
          name: "Production",
        },
      },
    ],
  },
];

describeEval(
  "create-dsn",
  {
    harness: createTaskHarness("create-dsn", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
