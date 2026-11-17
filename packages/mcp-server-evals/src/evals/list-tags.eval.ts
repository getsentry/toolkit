import { describeEval } from "vitest-evals/legacy";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

describeEval("list-tags", {
  data: async () => {
    return [
      {
        input: `What are common tags in ${FIXTURES.organizationSlug}`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "find_tags",
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
