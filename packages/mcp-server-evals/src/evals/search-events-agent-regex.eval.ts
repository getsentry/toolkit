import { SentryApiService } from "@sentry/mcp-core/api-client";
import { searchEventsAgent } from "@sentry/mcp-core/tools/search-events/agent";
import { describeEval, ToolCallScorer } from "vitest-evals";
import { StructuredOutputScorer } from "./utils/structuredOutputScorer";
import "../setup-env";

function messageRegexPattern(query: unknown): string | undefined {
  if (typeof query !== "string") {
    return undefined;
  }
  return query.match(/(?:^|[\s(])!?message:\/\/(.+?)\/\/(?=[\s)]|$)/)?.[1];
}

describeEval("search-events-agent-regex", {
  data: async () => [
    {
      input:
        "Show logs from the last day whose message matches the regex `timeout after \\d+ms`",
      expectedTools: [],
      expected: {
        dataset: "logs",
        query: (value: unknown) => {
          const pattern = messageRegexPattern(value);
          return (
            pattern !== undefined &&
            pattern.includes("timeout after") &&
            pattern.includes("\\d")
          );
        },
        timeRange: { statsPeriod: "24h" },
      },
    },
    {
      input: "Find logs whose message contains an IPv4 address",
      expectedTools: [],
      expected: {
        dataset: "logs",
        query: (value: unknown) => {
          const pattern = messageRegexPattern(value);
          return (
            pattern !== undefined &&
            /\\d|\[0-9\]/.test(pattern) &&
            pattern.includes("\\.")
          );
        },
      },
    },
    {
      input:
        "Find error logs whose message ends with a 5xx status code, like 'upstream returned status=503'",
      expectedTools: [],
      expected: {
        dataset: "logs",
        query: (value: unknown) => {
          const pattern = messageRegexPattern(value);
          return (
            /\b(severity|level):error\b/.test(String(value)) &&
            pattern !== undefined &&
            pattern.includes("5") &&
            pattern.endsWith("$")
          );
        },
      },
    },
    {
      input:
        "Show logs whose message does not look like 'job <number> completed'",
      expectedTools: [],
      expected: {
        dataset: "logs",
        query: (value: unknown) =>
          typeof value === "string" &&
          value.includes("!message://") &&
          messageRegexPattern(value)?.includes("completed") === true,
      },
    },
    {
      input: "Show me error logs about database",
      expectedTools: [],
      expected: {
        dataset: "logs",
        query: (value: unknown) =>
          typeof value === "string" &&
          value.includes("*database*") &&
          !value.includes("://"),
      },
    },
    {
      input: "Find warning logs that mention memory",
      expectedTools: [],
      expected: {
        dataset: "logs",
        query: (value: unknown) =>
          typeof value === "string" &&
          value.includes("*memory*") &&
          !value.includes("://"),
      },
    },
  ],
  task: async (input) => {
    const apiService = new SentryApiService({ accessToken: "test-token" });
    const agentResult = await searchEventsAgent({
      query: input,
      organizationSlug: "sentry-mcp-evals",
      apiService,
    });

    return {
      result: JSON.stringify(agentResult.result),
      toolCalls: agentResult.toolCalls.map((call) => ({
        name: call.toolName,
        arguments:
          typeof call.args === "object" && call.args !== null
            ? { ...call.args }
            : {},
      })),
    };
  },
  scorers: [ToolCallScorer(), StructuredOutputScorer({ match: "fuzzy" })],
});
