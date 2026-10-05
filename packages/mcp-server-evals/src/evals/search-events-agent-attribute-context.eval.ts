import { describeEval } from "vitest-evals";
import { ToolCallScorer } from "vitest-evals";
import { searchEventsAgent } from "@sentry/mcp-core/tools/search-events/agent";
import { SentryApiService } from "@sentry/mcp-core/api-client";
import { StructuredOutputScorer } from "./utils/structuredOutputScorer";
import "../setup-env";

// Compares the attribute the agent picks when the trace-items attributes
// endpoint is called with and without `expand=context`. The with-context span
// fixtures list the replacement for each deprecated attribute (e.g.
// user.geo.region for geo.region), so only that path should use it.
//
// The datasetAttributes tool does not request context itself, so this service
// forces it on or off for every attributes request.
class AttributeContextApiService extends SentryApiService {
  constructor(private readonly attributeContext: boolean) {
    super({ accessToken: "test-token" });
  }

  override listTraceItemAttributes(
    ...[params, opts]: Parameters<SentryApiService["listTraceItemAttributes"]>
  ) {
    return super.listTraceItemAttributes(
      { ...params, context: this.attributeContext },
      opts,
    );
  }
}

describeEval("search-events-agent-attributes-without-context", {
  data: async () => {
    return [
      {
        // http.method is also picked from the static span fields
        input: "Count spans grouped by HTTP method over the last 7 days",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "spans",
            },
          },
        ],
        expected: {
          dataset: "spans",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("http.method") &&
            !value.includes("http.request.method"),
        },
      },
      {
        // http.status_code is also picked from static span fields
        input: "Show me spans with HTTP status code 503 in the last 24 hours",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "spans",
            },
          },
        ],
        expected: {
          dataset: "spans",
          query: (value: unknown) =>
            typeof value === "string" &&
            value.includes("http.status_code:503") &&
            !value.includes("http.response.status_code"),
        },
      },
    ];
  },
  task: async (input) => {
    // Create an API service that never requests attribute context
    const apiService = new AttributeContextApiService(false);

    const agentResult = await searchEventsAgent({
      query: input,
      organizationSlug: "sentry-mcp-evals",
      apiService,
    });

    return {
      result: JSON.stringify(agentResult.result),
      toolCalls: agentResult.toolCalls.map((call: any) => ({
        name: call.toolName,
        arguments: call.args,
      })),
    };
  },
  scorers: [
    ToolCallScorer({ params: "fuzzy" }), // Validates tool calls
    StructuredOutputScorer({ match: "fuzzy" }), // Validates the structured query output with flexible matching
  ],
});

// Context not enabled yet so these should not show the correct queries. Asserting them to the wrong queries for now.
describeEval("search-events-agent-attributes-with-context", {
  data: async () => {
    return [
      {
        // EVENTUALLY Context marks http.method as deprecated in favor of http.request.method
        input: "Count spans grouped by HTTP method over the last 7 days",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "spans",
            },
          },
        ],
        expected: {
          dataset: "spans",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            !value.includes("http.request.method") &&
            value.includes("http.method"),
        },
      },
      {
        // EVENTUALLY Context marks http.status_code as deprecated in favor of
        // http.response.status_code
        input: "Show me spans with HTTP status code 503 in the last 24 hours",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "spans",
            },
          },
        ],
        expected: {
          dataset: "spans",
          query: (value: unknown) =>
            typeof value === "string" &&
            !value.includes("http.response.status_code:503") &&
            value.includes("http.status_code"),
        },
      },
    ];
  },
  task: async (input) => {
    // Create an API service that always requests attribute context
    const apiService = new AttributeContextApiService(true);

    const agentResult = await searchEventsAgent({
      query: input,
      organizationSlug: "sentry-mcp-evals",
      apiService,
    });

    return {
      result: JSON.stringify(agentResult.result),
      toolCalls: agentResult.toolCalls.map((call: any) => ({
        name: call.toolName,
        arguments: call.args,
      })),
    };
  },
  scorers: [
    ToolCallScorer({ params: "fuzzy" }), // Validates tool calls
    StructuredOutputScorer({ match: "fuzzy" }), // Validates the structured query output with flexible matching
  ],
});
