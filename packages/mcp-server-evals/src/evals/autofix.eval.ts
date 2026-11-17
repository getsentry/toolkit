import { describeEval } from "vitest-evals/legacy";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

describeEval("begin-issue-fix", {
  data: async () => {
    return [
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
  },
  task: NoOpTaskRunner(),
  scorers: [ToolPredictionScorer()],
  threshold: 0.6,
  timeout: 30000,
});
