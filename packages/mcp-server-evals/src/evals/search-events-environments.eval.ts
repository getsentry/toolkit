import { SentryApiService } from "@sentry/mcp-core/api-client";
import { searchEventsAgent } from "@sentry/mcp-core/tools/search-events/agent";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import "../setup-env";
import { StructuredOutputScorer } from "./utils/structuredOutputScorer";

describeEval("search-events-environment-grounding", {
  data: async () =>
    ["message:*decoder*", "message:*decoder* environment:production"].map(
      (query) => ({
        // Sanitized request shape from a real failure: a structured errors
        // aggregate exhausted all five steps on invented environment values,
        // despite the prompt already listing the only real environment.
        // Keep the handler's request wrapper, including environment: null.
        input: [
          "Translate this Sentry event search request.",
          "The query may be natural language or already-valid Sentry search syntax.",
          "Preserve valid explicit parameters, but correct dataset, query syntax, fields, sort, and time range when they conflict or would fail.",
          "If the user query already uses Sentry search syntax, treat its filters as authoritative unless validateSearch proves a field is invalid.",
          "Never replace a structured field filter with message/log.body/full-text matching. If no valid attribute exists for an explicit field:value filter, keep the field and let validation fail.",
          "For spans, logs, and metrics, use datasetAttributes to discover likely fields with substringMatch, query, and attributeTypes before dropping or renaming explicit fields.",
          "A broad datasetAttributes result may be truncated, so absence from that preview does not prove an explicit field is invalid.",
          "For non-replay datasets, call validateSearch on the candidate request and fix failures in this same pass before returning.",
          "For non-replay datasets, convert environment parameters into query filters. For replays, keep environment in the separate environment parameter.",
          "",
          `User query: ${query}`,
          "Current parameters:",
          JSON.stringify(
            {
              dataset: "errors",
              fields: ["count()"],
              sort: "-count()",
              statsPeriod: "90d",
              environment: null,
            },
            null,
            2,
          ),
        ].join("\n"),
        expected: {
          dataset: "errors",
          fields: ["count()"],
          sort: "-count()",
          environment: null,
          timeRange: { statsPeriod: "90d" },
        },
      }),
    ),
  task: async (input) => {
    const agentResult = await searchEventsAgent({
      query: input,
      organizationSlug: "sentry-mcp-evals",
      apiService: new SentryApiService({ accessToken: "test-token" }),
      environmentNames: ["production"],
    });

    const validationCalls = agentResult.toolCalls.filter(
      (call) => call.toolName === "validateSearch",
    );
    expect(validationCalls.length).toBeGreaterThan(0);

    const queries = [agentResult.result.query];
    for (const call of validationCalls) {
      expect(call.args).toBeTypeOf("object");
      expect(call.args).not.toBeNull();
      expect(call.args).not.toHaveProperty("environment");
      const args = call.args as Record<string, unknown>;
      expect(args.query).toBeTypeOf("string");
      queries.push(args.query as string);
    }

    // Check every attempted validation, not just the final successful query:
    // repeated invalid tool calls can consume the budget before any output.
    const requestedEnvironment = input.includes("environment:production");
    for (const query of queries) {
      expect(query).toContain("message:*decoder*");
      if (requestedEnvironment) {
        expect(query).toMatch(
          /(?:^|\s)environment:(?:production|"production")(?=\s|$)/,
        );
        expect(query.match(/\benvironment\s*:/g)).toHaveLength(1);
      } else {
        expect(query).not.toMatch(/\benvironment\s*:/);
      }
    }
    expect(agentResult.result.environment).toBeNull();

    return { result: JSON.stringify(agentResult.result) };
  },
  scorers: [StructuredOutputScorer()],
  threshold: 1,
  timeout: 60000,
});
