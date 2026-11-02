import { describe, expect, test } from "vitest";
import { codeBlock, inlineCode, text } from "./markdown.js";

describe("inlineCode", () => {
  test("wraps a value without escaping Markdown syntax", () => {
    expect(inlineCode("<script> [link](url) | *_")).toBe(
      "`<script> [link](url) | *_`",
    );
  });

  test("uses a fence longer than any backtick run in the value", () => {
    expect(inlineCode("a ``b`` c")).toBe("```a ``b`` c```");
  });

  test("pads values that start or end with a backtick or space", () => {
    expect(inlineCode("`value`")).toBe("`` `value` ``");
    expect(inlineCode(" value")).toBe("`  value `");
  });

  test("keeps multi-line values on one line", () => {
    expect(inlineCode("one\n# two\r\nthree")).toBe("`one # two three`");
  });
});

describe("codeBlock", () => {
  test("fences a value with at least three backticks", () => {
    expect(codeBlock("SELECT 1", "sql")).toBe("```sql\nSELECT 1\n```");
  });

  test("uses a fence longer than any backtick run in the value", () => {
    expect(codeBlock("```\nnot the end\n```")).toBe(
      "````\n```\nnot the end\n```\n````",
    );
  });

  test("keeps only info-string characters in the language", () => {
    expect(codeBlock("x", "c++ `evil`")).toBe("```c++evil\nx\n```");
  });
});

describe("text", () => {
  test("escapes inline and block syntax", () => {
    expect(text("# _list_ *and* [links](url)")).toBe(
      "\\# \\_list\\_ \\*and\\* \\[links]\\(url)",
    );
  });

  test("leaves underscores inside words unescaped", () => {
    expect(text("user_id __init__")).toBe("user_id \\_\\_init\\_\\_");
  });

  test("escapes raw HTML and character references", () => {
    expect(text("<script> &lt;")).toBe("\\<script> \\&lt;");
  });

  test("keeps multi-line values on one line", () => {
    expect(text("line one\n\n- line two")).toBe("line one  - line two");
  });

  test("writes the start of a www domain as a character reference", () => {
    expect(text("see www.example.com")).toBe("see &#x77;ww\\.example.com");
  });
});
