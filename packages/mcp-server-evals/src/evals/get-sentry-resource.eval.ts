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
    input: `What's happening in this Sentry issue? ${FIXTURES.issueUrl}`,
    expectedTools: [
      {
        name: "get_sentry_resource",
        arguments: {
          url: FIXTURES.issueUrl,
        },
      },
    ],
  },
  {
    input: `Show me the breadcrumbs for ${FIXTURES.issueUrl}`,
    expectedTools: [
      {
        name: "get_issue_breadcrumbs",
        arguments: {
          issueUrl: FIXTURES.issueUrl,
        },
      },
    ],
  },
  {
    input: `Fetch the breadcrumbs for issue ${FIXTURES.issueId} in ${FIXTURES.organizationSlug}.`,
    expectedTools: [
      {
        name: "get_issue_breadcrumbs",
        arguments: {
          organizationSlug: FIXTURES.organizationSlug,
          issueId: FIXTURES.issueId,
        },
      },
    ],
  },
  {
    input: `Show me what happened in this trace: ${FIXTURES.traceUrl}`,
    expectedTools: [
      {
        name: "get_sentry_resource",
        arguments: {
          url: FIXTURES.traceUrl,
        },
      },
    ],
  },
  {
    input: `What widgets are on this dashboard? ${FIXTURES.dashboardUrl}`,
    expectedTools: [
      {
        name: "get_sentry_resource",
        arguments: {
          url: FIXTURES.dashboardUrl,
        },
      },
    ],
  },
];

describeEval(
  "get-sentry-resource",
  {
    harness: createTaskHarness("get-sentry-resource", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
