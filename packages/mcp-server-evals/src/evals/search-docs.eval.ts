import { describeEval } from "vitest-evals";
import {
  createTaskHarness,
  defineEvalCases,
  NoOpTaskRunner,
  ToolPredictionJudge,
  type EvalCase,
} from "./utils";

const cases: EvalCase[] = [
  {
    input:
      "I need documentation on how to set up error tracking with Sentry in JavaScript",
    expectedTools: [
      {
        name: "search_docs",
        arguments: {
          query: "set up error tracking JavaScript",
          maxResults: 3,
        },
      },
    ],
  },
  {
    input:
      "I need help configuring Sentry with React components and error boundaries",
    expectedTools: [
      {
        name: "search_docs",
        arguments: {
          query: "React components error boundaries",
          maxResults: 3,
        },
      },
    ],
  },
  {
    input: "What is Sentry's rate limiting and how does it work?",
    expectedTools: [
      {
        name: "search_docs",
        arguments: {
          query: "rate limiting",
          maxResults: 3,
        },
      },
    ],
  },
];

describeEval(
  "search-docs",
  {
    harness: createTaskHarness("search-docs", NoOpTaskRunner()),
    judges: [ToolPredictionJudge()],
    judgeThreshold: 0.6,
  },
  (it) => defineEvalCases(it, cases, { timeout: 30000 }),
);
