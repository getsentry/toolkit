import { z } from "zod";
import { isTopLevelToolName } from "../../tools/surfaces";
import { isToolAvailableInSession } from "./tool-call-formatting";

/** See docs/contributing/tool-responses.md#suggested-actions. */
export const MAX_SUGGESTED_ACTIONS = 3;

export type SuggestedActionValue =
  | string
  | number
  | boolean
  | null
  | SuggestedActionValue[]
  | { [key: string]: SuggestedActionValue };

/** A concrete, session-callable MCP follow-up action. */
export interface SuggestedToolAction {
  type: "tool_call";
  toolName: string;
  arguments: Record<string, SuggestedActionValue>;
  reason: string;
}

export const suggestedToolActionSchema = z.object({
  type: z.literal("tool_call"),
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  reason: z.string(),
});

/**
 * Builds a follow-up call that matches the session's direct or catalog
 * surface, or null when the target tool cannot be called in this session.
 */
export function buildSuggestedToolAction({
  toolName,
  arguments: targetArguments,
  reason,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  toolName: string;
  arguments: Record<string, SuggestedActionValue>;
  reason: string;
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): SuggestedToolAction | null {
  if (!isToolAvailableInSession(toolName, availableToolNames)) {
    return null;
  }

  const targetIsDirect = directToolNames
    ? directToolNames.has(toolName)
    : isTopLevelToolName(toolName, experimentalMode);
  if (targetIsDirect) {
    return { type: "tool_call", toolName, arguments: targetArguments, reason };
  }

  const executeToolIsDirect = directToolNames
    ? directToolNames.has("execute_sentry_tool")
    : isTopLevelToolName("execute_sentry_tool", experimentalMode);
  if (
    !executeToolIsDirect ||
    !isToolAvailableInSession("execute_sentry_tool", availableToolNames)
  ) {
    return null;
  }

  return {
    type: "tool_call",
    toolName: "execute_sentry_tool",
    arguments: { name: toolName, arguments: targetArguments },
    reason,
  };
}
