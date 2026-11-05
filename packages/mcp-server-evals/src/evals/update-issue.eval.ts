import { describeEval } from "vitest-evals/legacy";
import { FIXTURES, NoOpTaskRunner, ToolPredictionScorer } from "./utils";

describeEval("update-issue", {
  data: async () => {
    return [
      // Core use case: Resolve an issue
      {
        input: `Resolve the issue ${FIXTURES.issueId} in organization ${FIXTURES.organizationSlug}. Output only the new status as a single word.`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "update_issue",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              status: "resolved",
              regionUrl: "https://us.sentry.io",
            },
          },
        ],
      },
      // Core use case: Assign an issue
      {
        input: `Assign the issue ${FIXTURES.issueId} in organization ${FIXTURES.organizationSlug} to 'john.doe'. Output only the assigned username.`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "update_issue",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              assignedTo: "john.doe",
              regionUrl: "https://us.sentry.io",
            },
          },
        ],
      },
      // Core use case: Using issue URL (alternative input method)
      {
        input: `Resolve the issue at ${FIXTURES.issueUrl}. Output only the new status as a single word.`,
        expectedTools: [
          {
            name: "update_issue",
            arguments: {
              issueUrl: FIXTURES.issueUrl,
              status: "resolved",
            },
          },
        ],
      },
      // Regression: default ignored status should map to "until escalating"
      {
        input: `Ignore the issue ${FIXTURES.issueId} in organization ${FIXTURES.organizationSlug} until it escalates. Output only the new status as a single word.`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "update_issue",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              status: "ignored",
              regionUrl: "https://us.sentry.io",
            },
          },
        ],
      },
      // Regression: permanent ignores need the explicit forever mode
      {
        input: `Ignore the issue ${FIXTURES.issueId} in organization ${FIXTURES.organizationSlug} forever. Output only the new status as a single word.`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "update_issue",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              status: "ignored",
              ignoreMode: "forever",
              regionUrl: "https://us.sentry.io",
            },
          },
        ],
      },
      // Regression: count-based ignores should use the structured ignore fields
      {
        input: `Ignore the issue ${FIXTURES.issueId} in organization ${FIXTURES.organizationSlug} until it happens 100 times in 60 minutes. Output only the new status as a single word.`,
        expectedTools: [
          {
            name: "find_organizations",
            arguments: {},
          },
          {
            name: "update_issue",
            arguments: {
              organizationSlug: FIXTURES.organizationSlug,
              issueId: FIXTURES.issueId,
              status: "ignored",
              ignoreMode: "untilOccurrenceCount",
              ignoreCount: 100,
              ignoreWindowMinutes: 60,
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
