/**
 * Reusable chat UI component
 * Extracts the common chat interface used in both mobile and desktop views
 */

import ScrollToBottom from "react-scroll-to-bottom";
import { Button } from "../ui/button";
import { ChatInput, ChatMessages } from ".";
import type { UIMessage } from "@ai-sdk/react";

// Constant empty function to avoid creating new instances on every render
const EMPTY_FUNCTION = () => {};

// Sample prompts for quick access
const SAMPLE_PROMPTS = [
  {
    label: "Help",
    prompt: "/help",
  },
  {
    label: "React SDK Usage",
    prompt: "Show me how to set up the React SDK for error monitoring",
  },
  {
    label: "Recent Issues",
    prompt: "What are my most recent issues?",
  },
] as const;

interface ChatUIProps {
  messages: UIMessage[];
  input: string;
  error?: Error | undefined;
  isChatLoading: boolean;
  isMessageStreaming?: ((messageId: string) => boolean) | undefined;
  isOpen?: boolean;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onStop?: () => void;
  onRetry?: (() => void) | undefined;
  onSlashCommand?: ((command: string) => void) | undefined;
  onSendPrompt?: (prompt: string) => void;
}

export const ChatUI = ({
  messages,
  input,
  error,
  isChatLoading,
  isMessageStreaming,
  isOpen = true,
  onInputChange,
  onSubmit,
  onStop,
  onRetry,
  onSlashCommand,
  onSendPrompt,
}: ChatUIProps) => {
  return (
    <div className="h-full flex flex-col relative">
      {/* Chat Messages - Scrollable area */}
      <ScrollToBottom
        className="flex-1 mb-18 flex overflow-y-auto"
        scrollViewClassName="px-0"
        followButtonClassName="hidden"
        initialScrollBehavior="smooth"
      >
        <ChatMessages
          messages={messages}
          isChatLoading={isChatLoading}
          isMessageStreaming={isMessageStreaming}
          error={error}
          onRetry={onRetry}
          onSlashCommand={onSlashCommand}
        />
      </ScrollToBottom>

      {/* Chat Input - Always pinned at bottom */}
      <div className="py-4 px-6 bottom-0 left-0 right-0 absolute min-h-34 z-10">
        <div className="w-full [mask-image:linear-gradient(to_bottom,transparent,red_4.5rem)] pointer-events-none absolute bottom-0 left-0 h-full -z-10 backdrop-blur-md bg-gradient-to-t from-background/80 xl:from-background to-background/20 xl:to-[#160f2433]" />
        {/* Sample Prompt Buttons - Always visible above input */}
        {onSendPrompt && (
          <div className="mb-4 flex flex-wrap gap-2 justify-center xl:justify-end">
            {SAMPLE_PROMPTS.map((samplePrompt) => (
              <Button
                key={samplePrompt.label}
                type="button"
                className="backdrop-blur"
                onClick={() => onSendPrompt(samplePrompt.prompt)}
                size="sm"
                variant="outline"
              >
                {samplePrompt.label}
              </Button>
            ))}
          </div>
        )}

        <ChatInput
          input={input}
          isLoading={isChatLoading}
          isOpen={isOpen}
          onInputChange={onInputChange}
          onSubmit={onSubmit}
          onStop={onStop || EMPTY_FUNCTION}
          onSlashCommand={onSlashCommand}
        />
      </div>
    </div>
  );
};
