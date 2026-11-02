import { describe, expect, it } from "vitest";
import { formatInlineCode } from "./inline-code";

describe("formatInlineCode", () => {
  it("wraps plain values without escaping Markdown syntax", () => {
    expect(formatInlineCode("<script> [link](url) | *_")).toBe(
      "`<script> [link](url) | *_`",
    );
  });

  it("uses a longer fence than any backtick run in the value", () => {
    expect(formatInlineCode("a ``b`` c")).toBe("```a ``b`` c```");
    expect(formatInlineCode("`value`")).toBe("`` `value` ``");
  });

  it("keeps multi-line values on one line", () => {
    expect(formatInlineCode("one\n# two\r\nthree\rfour")).toBe(
      "`one # two three four`",
    );
  });
});
