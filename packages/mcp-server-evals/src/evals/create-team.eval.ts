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
    input: `Create a new team in Sentry for '${FIXTURES.organizationSlug}' called 'the-goats' response with **only** the team slug and no other text.`,
    expectedTools: [
      {
        name: "find_organizations",
        arguments: {},
      },
      {
        name: "create_team",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          name: "the-goats",
          regionUrl: "https://us.sentry.io",
        },
      },
    ],
  },
];

describeEval(
  "create-team",
  {
    harness: createTaskHarness("create-team", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
