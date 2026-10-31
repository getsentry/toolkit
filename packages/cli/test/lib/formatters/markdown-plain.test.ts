import { describe, expect, test } from "vitest";
import { renderInlineMarkdown } from "../../../src/lib/formatters/markdown-plain.js";

describe("renderInlineMarkdown (plain)", () => {
  test("drops code and emphasis markers", () => {
    expect(renderInlineMarkdown("  Code: `ABCD-EFGH`")).toBe(
      "  Code: ABCD-EFGH",
    );
    expect(renderInlineMarkdown(" *(`c` to copy URL)*")).toBe(
      " (c to copy URL)",
    );
  });
});
