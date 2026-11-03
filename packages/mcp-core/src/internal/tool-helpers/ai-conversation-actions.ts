import { inlineCode } from "@sentry/toolkit-core/markdown";
import { isTopLevelToolName } from "../../tools/surfaces";
import {
  formatToolCall,
  isToolAvailableInSession,
} from "./tool-call-formatting";

const MAX_SUGGESTED_ACTIONS = 3;

export interface AIConversationReference {
  conversationId: string;
  spanId?: string;
}

type SuggestedActionValue =
  | string
  | number
  | boolean
  | null
  | SuggestedActionValue[]
  | { [key: string]: SuggestedActionValue };

/** A concrete, session-callable MCP follow-up action. */
interface SuggestedToolAction {
  type: "tool_call";
  toolName: string;
  arguments: Record<string, SuggestedActionValue>;
  reason: string;
}

/** Builds transcript actions that match the session's direct or catalog surface. */
export function getAIConversationSuggestedActions({
  organizationSlug,
  aiConversations,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  organizationSlug: string;
  aiConversations: AIConversationReference[];
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): SuggestedToolAction[] {
  if (
    aiConversations.length === 0 ||
    !isToolAvailableInSession(
      "get_agent_conversation_details",
      availableToolNames,
    )
  ) {
    return [];
  }

  const targetIsDirect = directToolNames
    ? directToolNames.has("get_agent_conversation_details")
    : isTopLevelToolName("get_agent_conversation_details", experimentalMode);
  const executeToolIsDirect = directToolNames
    ? directToolNames.has("execute_sentry_tool")
    : isTopLevelToolName("execute_sentry_tool", experimentalMode);
  const useCatalogGateway =
    !targetIsDirect &&
    executeToolIsDirect &&
    isToolAvailableInSession("execute_sentry_tool", availableToolNames);

  if (!targetIsDirect && !useCatalogGateway) {
    return [];
  }

  return aiConversations.slice(0, MAX_SUGGESTED_ACTIONS).map((conversation) => {
    const targetArguments = {
      organizationSlug,
      conversationId: conversation.conversationId,
    };

    return targetIsDirect
      ? {
          type: "tool_call",
          toolName: "get_agent_conversation_details",
          arguments: targetArguments,
          reason: "Fetch the full transcript for this agent conversation.",
        }
      : {
          type: "tool_call",
          toolName: "execute_sentry_tool",
          arguments: {
            name: "get_agent_conversation_details",
            arguments: targetArguments,
          },
          reason: "Fetch the full transcript for this agent conversation.",
        };
  });
}

/** Returns markdown instructions that mirror the callable structured actions. */
export function formatAIConversationActionInstructions({
  organizationSlug,
  aiConversations,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  organizationSlug: string;
  aiConversations: AIConversationReference[];
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): string[] {
  const actions = getAIConversationSuggestedActions({
    organizationSlug,
    aiConversations,
    experimentalMode,
    availableToolNames,
    directToolNames,
  });

  if (actions.length === 0) {
    return [
      "Agent conversation detail lookup is not available in this session.",
    ];
  }

  return actions.map(
    (action) =>
      `Use the Sentry tool ${inlineCode(
        formatToolCall({
          toolName: action.toolName,
          arguments: action.arguments,
        }),
      )} to fetch the full transcript.`,
  );
}
