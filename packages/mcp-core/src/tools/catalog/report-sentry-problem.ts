import { captureFeedback, getClient } from "@sentry/core";
import { z } from "zod";
import { ConfigurationError } from "../../errors";
import { defineTool } from "../../internal/tool-helpers/define";
import { ALL_SKILLS } from "../../skills";
import type { ServerContext } from "../../types";

const MAX_TAG_LENGTH = 200;

const SURFACE_LABELS = {
  mcp: "Sentry MCP",
  api: "Sentry API",
  docs: "Sentry docs",
} as const;

function truncateTag(value: string): string {
  return value.length > MAX_TAG_LENGTH
    ? `${value.slice(0, MAX_TAG_LENGTH - 1)}…`
    : value;
}

export default defineTool({
  name: "report_sentry_problem",
  skills: ALL_SKILLS,
  requiredScopes: [],
  description: [
    "Report a problem with Sentry itself to the Sentry team as User Feedback.",
    "",
    "Use this tool when you need to:",
    "- Report a Sentry MCP tool that errors, returns wrong data, or behaves differently than its description",
    "- Report a Sentry API endpoint that behaves differently than documented",
    "- Report Sentry documentation that is wrong, outdated, or missing",
    "",
    "<examples>",
    "report_sentry_problem(surface='mcp', target='search_issues', expected='Issues matching is:unresolved', actual='Tool returned a schema validation error')",
    "report_sentry_problem(surface='docs', target='https://docs.sentry.io/platforms/python/', expected='Install command for current SDK', actual='Page references a removed option')",
    "</examples>",
    "",
    "<hints>",
    "- Only report problems with Sentry products, not errors in the user's own application.",
    "- Tell the user what you will send before calling this tool.",
    "- Never include credentials, tokens, prompt text, source code, customer data, or other sensitive content.",
    "- Keep expected and actual short and factual.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    surface: z
      .enum(["mcp", "api", "docs"])
      .describe("Which Sentry surface has the problem."),
    target: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "The MCP tool name, API endpoint (method and path), or docs URL with the problem.",
      ),
    expected: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe("What you expected to happen."),
    actual: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("What actually happened, such as the error message."),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .default(null)
      .describe(
        "Optional request ID, trace ID, or event ID returned by Sentry for the failing call.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    if (!getClient()?.getDsn()) {
      throw new ConfigurationError(
        "Problem report not sent: Sentry telemetry is not configured for this MCP server.",
      );
    }

    const message = [
      `[${SURFACE_LABELS[params.surface]}] ${params.target}`,
      "",
      `Expected: ${params.expected}`,
      `Actual: ${params.actual}`,
      params.reference ? `Reference: ${params.reference}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    const feedbackId = captureFeedback({
      message,
      source: "mcp_agent_report",
      tags: {
        "agent_report.surface": params.surface,
        "agent_report.target": truncateTag(params.target),
        "agent_report.client_family": context.clientFamily ?? "unknown",
      },
    });

    return [
      "# Problem Reported",
      "",
      `Sent a report about **${SURFACE_LABELS[params.surface]}** (\`${params.target}\`) to the Sentry team.`,
      "",
      `**Report ID**: ${feedbackId}`,
      "",
      "## Response Notes",
      "",
      "- Tell the user the report was sent and share the report ID.",
    ].join("\n");
  },
});
