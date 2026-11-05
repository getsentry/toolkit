import { describeEval } from "vitest-evals/legacy";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

describeEval("list-teams", {
  data: async () => {
    return [
      {
        input: `What teams do I have access to in Sentry for '${FIXTURES.organizationSlug}'`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "find_teams",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              regionUrl: "https://us.sentry.io",
            },
          },
        ],
      },
      {
        input: `Do I have access to the team '${FIXTURES.teamSlug}' for '${FIXTURES.organizationSlug}'`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "find_teams",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              regionUrl: "https://us.sentry.io",
            },
          },
        ],
      },
      {
        input: `Do I have access to the team 'an-imaginary-team' for '${FIXTURES.organizationSlug}'`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "find_teams",
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
