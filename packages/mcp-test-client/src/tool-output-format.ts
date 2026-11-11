import { z } from "zod";

const ToolContentPartSchema = z
  .object({
    type: z.string(),
    text: z.unknown().optional(),
  })
  .passthrough();

const ToolOutputSchema = z
  .object({
    content: z.array(z.unknown()).optional().catch(undefined),
    structuredContent: z.unknown().optional(),
    toolResult: z.unknown().optional(),
  })
  .passthrough();

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    const json = JSON.stringify(value) as string | undefined;
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatToolOutputForDisplay(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  const parsedOutput = ToolOutputSchema.safeParse(output);
  if (!parsedOutput.success) {
    return stringifyUnknown(output);
  }

  const { content, structuredContent, toolResult } = parsedOutput.data;
  if (content) {
    const renderedContent = content
      .map((item) => {
        const parsedItem = ToolContentPartSchema.safeParse(item);
        if (!parsedItem.success) {
          return "<unknown message>";
        }

        if (
          parsedItem.data.type === "text" &&
          typeof parsedItem.data.text === "string"
        ) {
          return parsedItem.data.text;
        }

        return `<${parsedItem.data.type} message>`;
      })
      .join("");

    if (renderedContent.length > 0) {
      return renderedContent;
    }
  }

  if (structuredContent !== undefined) {
    return stringifyUnknown(structuredContent);
  }

  if (toolResult !== undefined) {
    return stringifyUnknown(toolResult);
  }

  return stringifyUnknown(output);
}
