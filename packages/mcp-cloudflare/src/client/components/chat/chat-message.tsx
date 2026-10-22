import { memo } from "react";
import { Markdown } from "../ui/markdown";
import { InteractiveMarkdown } from "../ui/interactive-markdown";
import { Typewriter } from "../ui/typewriter";
import { ToolInvocation } from "./tool-invocation";
import { Terminal } from "lucide-react";
import type {
  MessagePartProps,
  TextPartProps,
  ToolPartProps,
  ChatToolInvocation,
} from "./types";

// Component for rendering text parts
const TextPart = memo(function TextPart({
  text,
  role,
  messageId,
  isStreaming,
  messageData,
  onSlashCommand,
}: TextPartProps) {
  const isAssistant = role === "assistant";
  const isUser = role === "user";
  const isSlashCommand = isUser && text.startsWith("/");
  const isPromptExecution = isUser && messageData?.type === "prompt-execution";

  if (isUser) {
    // User messages: flexible width with background
    return (
      <div className="flex justify-end">
        <div
          className={`px-4 py-2 rounded max-w-3xl ${
            isSlashCommand
              ? "bg-blue-900/50 border border-blue-700/50"
              : isPromptExecution
                ? "bg-purple-900/50 border border-purple-700/50"
                : "bg-slate-800"
          }`}
        >
          {isSlashCommand ? (
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-blue-400" />
              <span className="text-blue-300 font-mono text-sm">{text}</span>
            </div>
          ) : isPromptExecution ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-purple-400" />
                <span className="text-purple-300 font-semibold text-sm">
                  Prompt: {messageData.promptName}
                </span>
              </div>
              {messageData.parameters &&
                Object.keys(messageData.parameters).length > 0 && (
                  <div className="text-xs text-purple-200/80 ml-6">
                    {Object.entries(messageData.parameters).map(
                      ([key, value]) => (
                        <div key={key}>
                          <span className="text-purple-300">{key}:</span>{" "}
                          {String(value)}
                        </div>
                      ),
                    )}
                  </div>
                )}
              {messageData.wasExecuted && (
                <div className="text-xs text-purple-200/60 ml-6 italic">
                  ✓ Executed on server
                </div>
              )}
            </div>
          ) : (
            <Markdown>{text}</Markdown>
          )}
        </div>
      </div>
    );
  }

  // Assistant and system messages: no background, just text
  // System messages should animate if they're marked for streaming simulation
  const shouldAnimate =
    (isAssistant && isStreaming) ||
    (role === "system" && isStreaming && messageData?.simulateStreaming);
  const hasSlashCommands = messageData?.hasSlashCommands;

  return (
    <div className="mr-8">
      {shouldAnimate ? (
        <Typewriter text={text} speed={20}>
          {(displayedText) => (
            <InteractiveMarkdown
              hasSlashCommands={hasSlashCommands}
              onSlashCommand={onSlashCommand}
            >
              {displayedText}
            </InteractiveMarkdown>
          )}
        </Typewriter>
      ) : (
        <InteractiveMarkdown
          hasSlashCommands={hasSlashCommands}
          onSlashCommand={onSlashCommand}
        >
          {text}
        </InteractiveMarkdown>
      )}
    </div>
  );
});

// Component for rendering tool invocation parts
const ToolPart = memo(function ToolPart({
  toolInvocation,
  messageId,
  partIndex,
}: ToolPartProps) {
  return (
    <div className="mr-8">
      <ToolInvocation
        tool={toolInvocation}
        messageId={messageId}
        index={partIndex}
      />
    </div>
  );
});

// Helper to check if a part is an AI SDK 6 tool part (type starts with "tool-")
const isToolPart = (part: {
  type: string;
}): part is {
  type: `tool-${string}`;
} & ChatToolInvocation => {
  return part.type.startsWith("tool-") && part.type !== "tool-invocation";
};

// Helper to check if a part is a legacy tool-invocation part (AI SDK 4/5 format)
// Legacy format: { type: "tool-invocation", toolInvocation: ChatToolInvocation }
const isLegacyToolInvocation = (part: {
  type: string;
}): part is {
  type: "tool-invocation";
  toolInvocation: ChatToolInvocation;
} => {
  return (
    part.type === "tool-invocation" &&
    "toolInvocation" in part &&
    typeof (part as any).toolInvocation === "object"
  );
};

// Helper to convert tool output to proper content format
const convertToolOutput = (
  output: unknown,
): { content: Array<{ type: "text"; text: string }> } | undefined => {
  if (output === undefined || output === null) {
    return undefined;
  }

  // If output is already in MCP format with content array
  if (
    typeof output === "object" &&
    "content" in (output as object) &&
    Array.isArray((output as { content: unknown }).content)
  ) {
    return output as { content: Array<{ type: "text"; text: string }> };
  }

  // If output is a string, wrap it
  if (typeof output === "string") {
    return { content: [{ type: "text", text: output }] };
  }

  // For other objects, JSON stringify
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
};

// Main component for rendering individual message parts
const MessagePart = memo(function MessagePart({
  part,
  messageId,
  messageRole,
  partIndex,
  isStreaming,
  messageData,
  onSlashCommand,
}: MessagePartProps) {
  // Handle text parts
  if (part.type === "text") {
    return (
      <TextPart
        text={part.text}
        role={messageRole}
        messageId={messageId}
        isStreaming={isStreaming}
        messageData={messageData}
        onSlashCommand={onSlashCommand}
      />
    );
  }

  // Handle legacy tool-invocation parts (AI SDK 4/5 format from persisted messages)
  // Legacy format: { type: "tool-invocation", toolInvocation: {...} }
  if (isLegacyToolInvocation(part)) {
    return (
      <ToolPart
        toolInvocation={part.toolInvocation}
        messageId={messageId}
        partIndex={partIndex}
      />
    );
  }

  // Handle tool parts (AI SDK 6 format: type is "tool-${toolName}")
  if (isToolPart(part)) {
    // Map AI SDK 6 state to our ChatToolInvocation state
    const partState = (part as any).state;
    const mappedState: "partial-call" | "call" | "result" =
      partState === "result"
        ? "result"
        : partState === "partial-call"
          ? "partial-call"
          : "call";

    // Convert AI SDK 6 tool part to our ChatToolInvocation format
    const toolInvocation: ChatToolInvocation = {
      toolCallId: part.toolCallId,
      toolName: part.type.replace(/^tool-/, ""),
      args: (part as any).input ?? {},
      state: mappedState,
      result: convertToolOutput((part as any).output),
    };
    return (
      <ToolPart
        toolInvocation={toolInvocation}
        messageId={messageId}
        partIndex={partIndex}
      />
    );
  }

  // Fallback for unknown part types
  return null;
});

// Export the memoized components
export { TextPart, ToolPart, MessagePart };
