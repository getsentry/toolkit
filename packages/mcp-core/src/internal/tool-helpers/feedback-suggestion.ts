import type { ServerContext } from "../../types";
import { formatToolCallInstruction } from "./tool-call-formatting";

export const FEEDBACK_TOOL_NAME = "submit_feedback_to_sentry_team";

export type FeedbackSuggestionSession = Pick<
  ServerContext,
  "experimentalMode" | "availableToolNames" | "directToolNames"
>;

/**
 * Formats a response note that points the agent at
 * submit_feedback_to_sentry_team for a result that likely means a Sentry MCP
 * bug or gap, or null when the session cannot call that tool.
 *
 * Use it only for the cases in docs/contributing/tool-responses.md#feedback-suggestions.
 * The note is guidance, not a suggestedActions entry: the agent has to write
 * the task and description itself, so no call here is complete.
 */
export function formatFeedbackSuggestion({
  condition,
  kind,
  eventId,
  session,
}: {
  /** When the agent should report it, e.g. "If no Sentry tool can do this task". */
  condition: string;
  kind: "missing" | "broken";
  eventId?: string | null;
  session: FeedbackSuggestionSession;
}): string | null {
  // Require explicit availability. The tool is hidden when Sentry has no DSN,
  // so a caller without session tool metadata must not advertise it.
  if (!session.availableToolNames?.has(FEEDBACK_TOOL_NAME)) {
    return null;
  }

  const prefilled = eventId
    ? `kind='${kind}' and eventId='${eventId}'`
    : `kind='${kind}'`;
  const instruction = formatToolCallInstruction({
    toolName: FEEDBACK_TOOL_NAME,
    experimentalMode: session.experimentalMode ?? false,
    availableToolNames: session.availableToolNames,
    directToolNames: session.directToolNames,
    purpose: `with ${prefilled} to report it to the Sentry MCP team`,
    // Empty means the tool is not callable from this session's surface.
    fallbackInstruction: "",
  });
  if (!instruction) {
    return null;
  }

  return `${condition}, ${instruction.charAt(0).toLowerCase()}${instruction.slice(1)}.`;
}
