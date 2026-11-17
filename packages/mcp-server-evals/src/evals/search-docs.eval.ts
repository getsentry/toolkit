import { describeEval } from "vitest-evals/legacy";
import { NoOpTaskRunner, ToolPredictionScorer } from "./utils";

describeEval("search-docs", {
  data: async () => {
    return [
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
  },
  task: NoOpTaskRunner(),
  scorers: [ToolPredictionScorer()],
  threshold: 0.6,
  timeout: 30000,
});
