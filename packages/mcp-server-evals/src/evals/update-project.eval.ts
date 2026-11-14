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
    input: `Update the project '${FIXTURES.projectSlug}' in organization '${FIXTURES.organizationSlug}' to change its name to 'Updated Project Name' and slug to 'updated-project-slug'. Output only the new project slug as plain text without any formatting:\nupdated-project-slug`,
    expectedTools: [
      {
        name: "update_project",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          projectSlug: FIXTURES.projectSlug,
          name: "Updated Project Name",
          slug: "updated-project-slug",
        },
      },
    ],
  },
  {
    input: `Grant the team '${FIXTURES.teamSlug}' access to the project '${FIXTURES.projectSlug}' in organization '${FIXTURES.organizationSlug}'. Output only the team slug as plain text without any formatting:\nthe-goats`,
    expectedTools: [
      {
        name: "add_team_to_project",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          projectSlug: FIXTURES.projectSlug,
          teamSlug: FIXTURES.teamSlug,
        },
      },
    ],
  },
];

describeEval(
  "update-project",
  {
    harness: createTaskHarness("update-project", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
