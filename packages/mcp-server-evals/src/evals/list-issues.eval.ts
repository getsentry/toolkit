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
    input: `What are the most common production errors in ${FIXTURES.organizationSlug}?`,
    expectedTools: [
      {
        name: "find_organizations",
        arguments: {},
      },
      {
        name: "search_issues",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          query: "is:unresolved",
          sort: "freq",
        },
      },
    ],
  },
  {
    input: `Show me the top issues in ${FIXTURES.organizationSlug} organization`,
    expectedTools: [
      {
        name: "find_organizations",
        arguments: {},
      },
      {
        name: "search_issues",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          sort: "freq",
        },
      },
    ],
  },
  {
    input: `What are the most recent issues in ${FIXTURES.organizationSlug}?`,
    expectedTools: [
      {
        name: "find_organizations",
        arguments: {},
      },
      {
        name: "search_issues",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          sort: "date",
        },
      },
    ],
  },
  {
    input: `Find the newest production issues in ${FIXTURES.organizationSlug}`,
    expectedTools: [
      {
        name: "find_organizations",
        arguments: {},
      },
      {
        name: "search_issues",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          sort: "new",
        },
      },
    ],
  },
  {
    input: `What issues is david@sentry.io experiencing in ${FIXTURES.organizationSlug}?`,
    expectedTools: [
      {
        name: "find_organizations",
        arguments: {},
      },
      {
        name: "search_issues",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          query: "user.email:david@sentry.io",
        },
      },
    ],
  },
];

describeEval(
  "list-issues",
  {
    harness: createTaskHarness("list-issues", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
