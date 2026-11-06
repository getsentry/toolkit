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
    input: `What projects do I have access to in Sentry for '${FIXTURES.organizationSlug}'`,
    expectedTools: [
      {
        name: "find_organizations",
        arguments: {},
      },
      {
        name: "find_projects",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          regionUrl: "https://us.sentry.io",
        },
      },
    ],
  },
];

describeEval(
  "list-projects",
  {
    harness: createTaskHarness("list-projects", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
