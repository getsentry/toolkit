import { describe, expect, test } from "vitest";
import { setSynthesizedMarkdownAttributes } from "../agent/tailor-agent";

describe("setSynthesizedMarkdownAttributes", () => {
  test("stores the complete markdown without truncating it", () => {
    const attributes = new Map<string, number | string>();
    const markdown = `# Tailored guide\n\n${"full markdown ".repeat(5000)}`;

    setSynthesizedMarkdownAttributes(
      {
        setAttribute(name, value) {
          attributes.set(name, value);
        },
      },
      markdown,
    );

    expect(attributes.get("docs.synthesized_markdown")).toBe(markdown);
    expect(attributes.get("docs.synthesized_markdown_chars")).toBe(
      markdown.length,
    );
  });
});
