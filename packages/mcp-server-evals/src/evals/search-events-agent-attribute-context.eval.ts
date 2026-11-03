import { describeEval } from "vitest-evals";
import { ToolCallScorer } from "vitest-evals";
import { searchEventsAgent } from "@sentry/mcp-core/tools/search-events/agent";
import { SentryApiService } from "@sentry/mcp-core/api-client";
import { StructuredOutputScorer } from "./utils/structuredOutputScorer";
import "../setup-env";

// Compares the attribute the agent picks when the trace-items attributes
// endpoint is called with and without `expand=context`. The with-context
// fixtures list the replacement for each deprecated attribute (e.g.
// user.geo.region for geo.region), so only that path should use it.
//
// This service forces the context on or off for every attributes request.
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
      {
        // transaction is picked from span fields
        input: "total request duration by endpoint (transaction boundaries)",
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
            value.includes("transaction") &&
            !value.includes("sentry.segment.name"),
        },
      },
      {
        // environment is picked from the common fields
        input:
          "Show me spans from non production environments in the last 24 hours",
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
            value.includes("!environment:production") &&
            !value.includes("sentry.environment"),
        },
      },
      {
        // kiosk.firmware and kiosk.firmware_revision are made-up attributes, so
        // the agent has no prior knowledge of either. Without briefs it can
        // only match on the name, and kiosk.firmware_revision matches
        // "firmware revision"
        input:
          "Count spans grouped by the kiosk's installed firmware revision over the last 7 days",
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
            value.includes("kiosk.firmware_revision") &&
            !value.includes("kiosk.firmware"),
        },
      },
      {
        // Without context the logs attributes only list code.filepath
        input:
          "Count error logs grouped by source code file path over the last 24 hours",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "logs",
            },
          },
        ],
        expected: {
          dataset: "logs",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("code.filepath") &&
            !value.includes("code.file.path"),
        },
      },
      {
        // Without context the metrics attributes only list http.method
        input:
          "In metrics, show p95 http.request.duration grouped by HTTP method over the last 24 hours",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "metrics",
            },
          },
        ],
        expected: {
          dataset: "metrics",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("http.method") &&
            !value.includes("http.request.method"),
        },
      },
      {
        // worker.queue_wait and worker.queue_wait_time are made-up attributes.
        // Without briefs the agent can only match on the name, and
        // worker.queue_wait_time matches "worker queue wait time"
        input:
          "From logs, what is the average worker queue wait time jobs actually experienced over the last 24 hours?",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "logs",
            },
          },
        ],
        expected: {
          dataset: "logs",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("avg(worker.queue_wait_time)") &&
            !value.includes("avg(worker.queue_wait)"),
        },
      },
      {
        // fleet.region and fleet.deployment_region are made-up attributes.
        // Without briefs the agent can only match on the name, and
        // fleet.deployment_region matches "fleet deployment region"
        input:
          "In metrics, show p95 http.request.duration grouped by the fleet deployment region each server is currently running in over the last 24 hours",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "metrics",
            },
          },
        ],
        expected: {
          dataset: "metrics",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("fleet.deployment_region") &&
            !value.includes("fleet.region"),
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

describeEval("search-events-agent-attributes-with-context", {
  data: async () => {
    return [
      {
        // Context marks http.method as deprecated in favor of http.request.method
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
            value.includes("http.request.method") &&
            !value.includes("http.method"),
        },
      },
      {
        // Context marks http.status_code as deprecated in favor of
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
            value.includes("http.response.status_code:503") &&
            !value.includes("http.status_code"),
        },
      },
      {
        // sentry.segment.name is picked from span fields due to transaction deprecation and validation endpoint passing
        // even though transaction is shown in example queries
        input: "total request duration by endpoint (transaction boundaries)",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "spans",
            },
          },
          {
            name: "validateSearch",
            arguments: {
              dataset: "spans",
              fields: ["sentry.segment.name"],
            },
          },
        ],
        expected: {
          dataset: "spans",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            !value.includes("transaction") &&
            value.includes("sentry.segment.name"),
        },
      },
      {
        // Context marks environment as deprecated in favor of
        // sentry.environment
        input:
          "Show me spans from non production environments in the last 24 hours",
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
          // sentry.environment:production contains environment:production, so
          // look for a bare environment key not preceded by "sentry."
          query: (value: unknown) =>
            typeof value === "string" &&
            value.includes("!sentry.environment:production") &&
            !/(?<!sentry\.)environment:/.test(value),
        },
      },
      {
        // deviceMemory and device.memory both look like a match by name, but
        // only device.memory has a brief describing the device's total memory
        input:
          "What is the average estimated total memory capacity of devices across spans in the last 7 days?",
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
            value.includes("avg(device.memory)") &&
            !value.some(
              (field) =>
                typeof field === "string" && field.includes("deviceMemory"),
            ),
        },
      },
      {
        // kiosk.firmware_revision matches "firmware revision" by name, but its
        // brief says it is the staged revision. Only kiosk.firmware's brief
        // describes the installed firmware
        input:
          "Count spans grouped by the kiosk's installed firmware revision over the last 7 days",
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
            value.includes("kiosk.firmware") &&
            !value.includes("kiosk.firmware_revision"),
        },
      },
      {
        // Context marks code.filepath as deprecated in favor of code.file.path
        input:
          "Count error logs grouped by source code file path over the last 24 hours",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "logs",
            },
          },
        ],
        expected: {
          dataset: "logs",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("code.file.path") &&
            !value.includes("code.filepath"),
        },
      },
      {
        // Context marks http.method as deprecated in favor of
        // http.request.method
        input:
          "In metrics, show p95 http.request.duration grouped by HTTP method over the last 24 hours",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "metrics",
            },
          },
        ],
        expected: {
          dataset: "metrics",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("http.request.method") &&
            !value.includes("http.method"),
        },
      },
      {
        // worker.queue_wait_time matches "worker queue wait time" by name, but
        // its brief says it is a configured limit. Only worker.queue_wait's
        // brief describes the measured wait
        input:
          "From logs, what is the average worker queue wait time jobs actually experienced over the last 24 hours?",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "logs",
            },
          },
        ],
        expected: {
          dataset: "logs",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("avg(worker.queue_wait)") &&
            !value.includes("avg(worker.queue_wait_time)"),
        },
      },
      {
        // fleet.deployment_region matches "fleet deployment region" by name,
        // but its brief says it is the region the server moves to next. Only
        // fleet.region's brief describes where the server runs now
        input:
          "In metrics, show p95 http.request.duration grouped by the fleet deployment region each server is currently running in over the last 24 hours",
        expectedTools: [
          {
            name: "datasetAttributes",
            arguments: {
              dataset: "metrics",
            },
          },
        ],
        expected: {
          dataset: "metrics",
          fields: (value: unknown) =>
            Array.isArray(value) &&
            value.includes("fleet.region") &&
            !value.includes("fleet.deployment_region"),
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
