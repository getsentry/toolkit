import { describeEval } from "vitest-evals/legacy";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

describeEval("list-projects", {
  data: async () => {
    return [
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
  },
  task: NoOpTaskRunner(),
  scorers: [ToolPredictionScorer()],
  threshold: 0.6,
  timeout: 30000,
});
