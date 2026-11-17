import { inlineCode } from "@sentry/toolkit-core/markdown";
import {
  MAX_SUGGESTED_ACTIONS,
  type SuggestedToolAction,
  buildSuggestedToolAction,
} from "./suggested-actions";
import { formatToolCall } from "./tool-call-formatting";

export interface AIConversationReference {
  conversationId: string;
  spanId?: string;
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
  return aiConversations
    .slice(0, MAX_SUGGESTED_ACTIONS)
    .map((conversation) =>
      buildSuggestedToolAction({
        toolName: "get_agent_conversation_details",
        arguments: {
          organizationSlug,
          conversationId: conversation.conversationId,
        },
        reason: "Fetch the full transcript for this agent conversation.",
        experimentalMode,
        availableToolNames,
        directToolNames,
      }),
    )
    .filter((action): action is SuggestedToolAction => action !== null);
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
