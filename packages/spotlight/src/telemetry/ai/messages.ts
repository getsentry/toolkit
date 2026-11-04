import type { AIPrompt } from "../types.ts";
import { parsed, record } from "../internal/wireValues.ts";

/**
 * Normalizes message content from v1 (string) or v2 (array of content blocks) format to a string.
 * v1: content = "text string"
 * v2: content = [{ type: "text", text: "text string" }]
 *
 * Only extracts text content blocks. Other block types (image, file, tool-call)
 * would require UI changes to display properly and are filtered out for now.
 */
function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Only extract text content - images/files would need UI changes to display
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block?.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}

export function normalizePromptMessages(value: unknown): AIPrompt["messages"] {
  const messages = parsed(value);
  if (!Array.isArray(messages)) return undefined;
  const normalized: NonNullable<AIPrompt["messages"]> = [];
  for (const value of messages) {
    const message = record(value);
    if (typeof message.role !== "string") return undefined;
    normalized.push({
      ...message,
      role: message.role,
      content: normalizeMessageContent(message.content),
    });
  }
  return normalized;
}
