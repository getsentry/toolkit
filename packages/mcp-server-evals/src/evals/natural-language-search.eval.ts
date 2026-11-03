import { SentryApiService } from "@sentry/mcp-core/api-client";
import { searchEventsAgent } from "@sentry/mcp-core/tools/search-events/agent";
import { searchIssuesAgent } from "@sentry/mcp-core/tools/search-issues/agent";
import { describeEval, ToolCallScorer } from "vitest-evals";
import "../setup-env";
import { StructuredOutputScorer } from "./utils/structuredOutputScorer";

function toToolArguments(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

describeEval("natural-language-search-events", {
  data: async () => [
    {
      input:
        "Count unhandled error events by environment over the last 24 hours",
      expectedTools: [],
      expected: {
        dataset: "errors",
        query: /error\.handled:false|error\.unhandled:true/,
        fields: (value: unknown) =>
          Array.isArray(value) &&
          value.includes("environment") &&
          value.includes("count()"),
        sort: "-count()",
        timeRange: { statsPeriod: "24h" },
      },
    },
    {
      input: "Show warning logs from production over the last 7 days",
      expectedTools: [],
      expected: {
        dataset: "logs",
        query: (value: unknown) =>
          typeof value === "string" &&
          /(?:severity|level):warn(?:ing)?/.test(value) &&
          value.includes("environment:production"),
        sort: "-timestamp",
        timeRange: { statsPeriod: "7d" },
      },
    },
    {
      input:
        "In spans, show p95 span duration grouped by span.op over the last 7 days",
      expectedTools: [],
      expected: {
        dataset: "spans",
        query: "",
        fields: (value: unknown) =>
          Array.isArray(value) &&
          value.includes("span.op") &&
          value.includes("p95(span.duration)"),
        sort: "-p95(span.duration)",
        timeRange: { statsPeriod: "7d" },
      },
    },
    {
      input:
        "In metrics, show p95 http.request.duration grouped by environment over the last 24 hours",
      expectedTools: [
        {
          name: "datasetAttributes",
        },
      ],
      expected: {
        dataset: "metrics",
        query: (value: unknown) =>
          typeof value === "string" &&
          value.includes("metric.name:http.request.duration") &&
          value.includes("metric.type:distribution"),
        fields: (value: unknown) =>
          Array.isArray(value) &&
          value.includes("sentry.environment") &&
          value.includes(
            "p95(value,http.request.duration,distribution,millisecond)",
          ),
        sort: "-p95(value,http.request.duration,distribution,millisecond)",
        timeRange: { statsPeriod: "24h" },
      },
    },
  ],
  task: async (input) => {
    const apiService = new SentryApiService({ accessToken: "test-token" });
    const agentResult = await searchEventsAgent({
      query: input,
      organizationSlug: "sentry-mcp-evals",
      apiService,
      environmentNames: [],
    });

    return {
      result: JSON.stringify(agentResult.result),
      toolCalls: agentResult.toolCalls.map((call) => ({
        name: call.toolName,
        arguments: toToolArguments(call.args),
      })),
    };
  },
  scorers: [ToolCallScorer(), StructuredOutputScorer({ match: "fuzzy" })],
  threshold: 0.6,
  timeout: 30000,
});

describeEval("natural-language-search-issues", {
  data: async () => [
    {
      input: "Show resolved high-priority issues, newest first",
      expectedTools: [],
      expected: {
        query: (value: unknown) =>
          typeof value === "string" &&
          value.includes("is:resolved") &&
          value.includes("issue.priority:high"),
        sort: "new",
      },
    },
  ],
  task: async (input) => {
    const apiService = new SentryApiService({ accessToken: "test-token" });
    const agentResult = await searchIssuesAgent({
      query: input,
      organizationSlug: "sentry-mcp-evals",
      apiService,
    });

    return {
      result: JSON.stringify(agentResult.result),
      toolCalls: agentResult.toolCalls.map((call) => ({
        name: call.toolName,
        arguments: toToolArguments(call.args),
      })),
    };
  },
  scorers: [ToolCallScorer(), StructuredOutputScorer({ match: "fuzzy" })],
  threshold: 0.6,
  timeout: 30000,
});
