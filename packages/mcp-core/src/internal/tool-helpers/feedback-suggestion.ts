import type { ServerContext } from "../../types";

export const FEEDBACK_TOOL_NAME = "submit_feedback_to_sentry_team";

/**
 * Formats a response note that points the agent at
 * submit_feedback_to_sentry_team for a result that likely means a Sentry MCP
 * bug or gap, or null when the session cannot call that tool.
 *
 * Use it only for the cases in docs/contributing/tool-responses.md#feedback-suggestions.
 * The note only names the tool: the agent already knows how to reach its
 * tools and writes the report, and the feedback event already carries the
 * user and client tags and the trace set on every tool call.
 */
export function formatFeedbackSuggestion(
  /** When the agent should report it, e.g. "If no Sentry tool can do this task". */
  condition: string,
  context: Pick<ServerContext, "availableToolNames">,
): string | null {
  // Require explicit availability. The tool is hidden when Sentry has no DSN,
  // so a caller without session tool metadata must not advertise it.
  if (!context.availableToolNames?.has(FEEDBACK_TOOL_NAME)) {
    return null;
  }

  return `${condition}, report it to the Sentry MCP team with \`${FEEDBACK_TOOL_NAME}\`.`;
}
