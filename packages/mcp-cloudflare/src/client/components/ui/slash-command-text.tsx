/**
 * Component that renders text with clickable slash commands
 */
import { Fragment } from "react";

interface SlashCommandTextProps {
  children: string;
  onSlashCommand: (command: string) => void;
}

const SLASH_COMMAND_REGEX = /\/([a-zA-Z]+)/g;

export function SlashCommandText({
  children,
  onSlashCommand,
}: SlashCommandTextProps) {
  const parts = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset regex state before using
  SLASH_COMMAND_REGEX.lastIndex = 0;

  // Find all slash commands in the text
  match = SLASH_COMMAND_REGEX.exec(children);
  while (match !== null) {
    const fullMatch = match[0]; // e.g., "/help"
    const command = match[1] ?? fullMatch.slice(1); // e.g., "help"
    const startIndex = match.index;

    // Add text before the command
    if (startIndex > lastIndex) {
      parts.push(
        <Fragment key={`text-${lastIndex}`}>
          {children.slice(lastIndex, startIndex)}
        </Fragment>,
      );
    }

    // Add clickable command
    parts.push(
      <button
        key={`command-${startIndex}`}
        onClick={() => onSlashCommand(command)}
        className="inline-flex items-center gap-1 px-1 py-0.5 text-xs bg-blue-900/50 border border-blue-700/50 rounded text-blue-300 hover:bg-blue-800/50 hover:border-blue-600/50 transition-colors font-mono cursor-pointer"
        type="button"
      >
        {fullMatch}
      </button>,
    );

    lastIndex = startIndex + fullMatch.length;

    // Continue searching
    match = SLASH_COMMAND_REGEX.exec(children);
  }

  // Add remaining text
  if (lastIndex < children.length) {
    parts.push(
      <Fragment key={`text-${lastIndex}`}>
        {children.slice(lastIndex)}
      </Fragment>,
    );
  }

  return <>{parts}</>;
}
