import { useEffect, useRef } from "react";
import { Send, CircleStop } from "lucide-react";
import { Button } from "../ui/button";

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  isOpen: boolean;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onSlashCommand?: (command: string) => void;
}

export function ChatInput({
  input,
  isLoading,
  isOpen,
  onInputChange,
  onSubmit,
  onStop,
  onSlashCommand,
}: ChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus when dialog opens (with delay for mobile animation)
  useEffect(() => {
    if (isOpen) {
      // Add delay to ensure the slide-in animation completes on mobile
      const timer = setTimeout(() => {
        // Use requestAnimationFrame to ensure browser has finished layout
        requestAnimationFrame(() => {
          if (inputRef.current && !inputRef.current.disabled) {
            inputRef.current.focus({ preventScroll: false });
          }
        });
      }, 600); // Delay to account for 500ms animation
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Re-focus when loading finishes
  useEffect(() => {
    if (inputRef.current && !isLoading && isOpen) {
      inputRef.current.focus();
    }
  }, [isLoading, isOpen]);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Check if input is a slash command
    if (input.startsWith("/") && onSlashCommand) {
      const command = input.slice(1).toLowerCase().trim();
      // Pass all slash commands to the handler, let it decide what to do
      onSlashCommand(command);
      return;
    }

    // Otherwise, submit normally
    onSubmit(e);
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+J or Cmd+J: Insert newline
    if ((e.ctrlKey || e.metaKey) && e.key === "j") {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = `${input.substring(0, start)}\n${input.substring(end)}`;

      // Create a synthetic event to update the input
      const syntheticEvent = {
        target: { value: newValue },
        currentTarget: { value: newValue },
      } as React.ChangeEvent<HTMLTextAreaElement>;

      onInputChange(syntheticEvent);

      // Move cursor after the inserted newline
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 1;
      }, 0);
      return;
    }

    // Enter without shift: Submit
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const form = e.currentTarget.form;
      if (form && input.trim()) {
        form.requestSubmit();
      }
    }
  };

  // Auto-resize textarea based on content
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`;
    }
  }, [input]);

  return (
    <form onSubmit={handleSubmit} className="relative flex-1 h-full">
      <div className="relative">
        <textarea
          ref={inputRef}
          value={input}
          onChange={onInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask me anything about your Sentry data..."
          disabled={isLoading}
          rows={1}
          className="w-full p-4 pr-12 rounded duration-150 bg-slate-800/50 xl:bg-background-3/50 xl:rounded-xl min-h-14 text-white placeholder-slate-400 xl:placeholder-white/50 focus:outline-none focus:ring-2 focus:border-transparent focus:ring-violet-300 disabled:opacity-50"
        />
        <Button
          type={isLoading ? "button" : "submit"}
          variant="ghost"
          onClick={isLoading ? onStop : undefined}
          disabled={!isLoading && !input.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-400 xl:text-white/50 xl:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-slate-400 disabled:hover:bg-transparent transition-colors"
          title={isLoading ? "Stop generation" : "Send message"}
        >
          {isLoading ? (
            <CircleStop className="h-4 w-4" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </form>
  );
}
