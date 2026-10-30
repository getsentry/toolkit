import { captureFeedback } from "@sentry/core";
import { z } from "zod";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ALL_SKILLS } from "../../skills";
import { scrubSensitiveText } from "../../telem/sentry";

// Sentry rejects User Feedback messages longer than 4096 code points. Slicing
// UTF-16 units keeps us at or under that.
const MAX_FEEDBACK_MESSAGE_LENGTH = 4096;

export const submitFeedbackToSentryTeamOutputSchema = z.object({
  feedbackId: z
    .string()
    .describe("ID of the feedback sent to the Sentry MCP maintainers."),
});

export default defineTool({
  name: "submit_feedback_to_sentry_team",
  description: [
    "Report friction with the Sentry MCP server to its maintainers.",
    "",
    "Use this tool when you need to:",
    "- Report that no Sentry MCP tool could do what the user asked",
    "- Report a tool that failed, returned wrong data, or was confusing",
    "- Suggest an improvement to the Sentry MCP tools",
    "",
    "<examples>",
    "submit_feedback_to_sentry_team(task='find slow endpoints', kind='missing', impact='blocked', description='No tool returns p95 latency per endpoint.')",
    "</examples>",
    "",
    "<hints>",
    "- Call at most once per task, after you finish or give up.",
    "- Feedback goes to the Sentry MCP maintainers, not the user's Sentry organization.",
    "- Do not include secrets, credentials, or personal data.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    task: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("A short phrase naming what the user asked you to do."),
    kind: z
      .enum(["missing", "broken", "confusing", "idea"])
      .describe(
        "missing: no tool could do it; broken: a tool failed or returned something wrong; confusing: a tool or its docs were unclear; idea: a suggestion.",
      ),
    impact: z
      .enum(["blocked", "worked_around", "friction"])
      .describe(
        "blocked: you could not finish; worked_around: you finished another way; friction: you finished, but it was harder than it should be.",
      ),
    description: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .describe(
        "What you tried, including tool calls and any error, and what went wrong.",
      ),
    toolName: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe("The Sentry MCP tool the feedback is about, if any."),
  },
  outputSchema: submitFeedbackToSentryTeamOutputSchema,
  skills: ALL_SKILLS,
  requiredScopes: [],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params) {
    const message = scrubSensitiveText(
      [
        `Task: ${params.task}`,
        params.toolName ? `Tool: ${params.toolName}` : null,
        "",
        params.description,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );

    const feedbackId = captureFeedback({
      source: "mcp_agent",
      message: message.slice(0, MAX_FEEDBACK_MESSAGE_LENGTH),
      tags: {
        "feedback.kind": params.kind,
        "feedback.impact": params.impact,
        ...(params.toolName ? { "feedback.tool": params.toolName } : {}),
      },
    });

    return structuredResult({ feedbackId });
  },
});
