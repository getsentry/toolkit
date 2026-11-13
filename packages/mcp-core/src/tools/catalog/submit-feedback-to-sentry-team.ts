import { captureFeedback } from "@sentry/core";
import { z } from "zod";
import { UserInputError } from "../../errors";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ALL_SKILLS } from "../../skills";
import { scrubSensitiveText } from "../../telem/sentry";

// Sentry rejects User Feedback messages longer than 4096 code points. Slicing
// UTF-16 units keeps us at or under that.
const MAX_FEEDBACK_MESSAGE_LENGTH = 4096;

// Filler that agents have sent instead of a real report, compared after
// lowercasing and dropping everything but letters and digits.
const PLACEHOLDER_DESCRIPTIONS = new Set([
  "",
  "na",
  "none",
  "noop",
  "null",
  "placeholder",
  "tbd",
  "test",
  "todo",
  "undefined",
]);

function isPlaceholder(text: string): boolean {
  return PLACEHOLDER_DESCRIPTIONS.has(
    text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
  );
}

/**
 * Name shown on the feedback instead of "Anonymous User". Our telemetry
 * identifies people only by Sentry user ID, so name the agent and that ID
 * rather than the person's name or email.
 */
function getFeedbackName({
  clientFamily,
  userId,
}: {
  clientFamily?: string | null;
  userId?: string | null;
}): string {
  const agent = clientFamily ? `MCP agent (${clientFamily})` : "MCP agent";
  return userId ? `${agent} for user ${userId}` : agent;
}

export const submitFeedbackToSentryTeamOutputSchema = z.object({
  feedbackId: z
    .string()
    .describe("ID of the feedback sent to the Sentry MCP maintainers."),
});

export default defineTool({
  name: "submit_feedback_to_sentry_team",
  title: "Submit Feedback to Sentry Team",
  description:
    "Report friction with the Sentry MCP server to its maintainers (not the user's Sentry organization): a missing tool, a tool that failed or returned wrong data, a confusing tool, or an idea. Call it at most once per task, only when a Sentry MCP tool was missing, failed, or got in the way. Skip it if the task went fine or did not need Sentry; never use it to log progress or to test it. Do not include secrets or personal data.",
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
  async handler(params, context) {
    if (isPlaceholder(params.description)) {
      throw new UserInputError(
        "`description` is a placeholder. Describe what you tried and what went wrong, or skip this tool if there is nothing to report.",
      );
    }

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
      name: getFeedbackName(context),
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
