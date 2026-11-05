import { z } from "zod";
import { isTopLevelToolName } from "../../tools/surfaces";
import { isToolAvailableInSession } from "./tool-call-formatting";

type SuggestedActionValue =
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
 * Builds a follow-up call for `toolName` on the session's direct or catalog
 * surface. Returns null when the session cannot call the tool.
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

  const isDirect = (name: string) =>
    directToolNames
      ? directToolNames.has(name)
      : isTopLevelToolName(name, experimentalMode);

  if (isDirect(toolName)) {
    return {
      type: "tool_call",
      toolName,
      arguments: targetArguments,
      reason,
    };
  }

  if (
    isDirect("execute_sentry_tool") &&
    isToolAvailableInSession("execute_sentry_tool", availableToolNames)
  ) {
    return {
      type: "tool_call",
      toolName: "execute_sentry_tool",
      arguments: { name: toolName, arguments: targetArguments },
      reason,
    };
  }

  return null;
}
