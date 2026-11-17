/**
 * Property-Based Tests for Markdown builders
 *
 * Parses each helper's output with `marked` (the CLI renderer) and micromark
 * (the CommonMark reference parser, with GFM) and checks that any input comes
 * back as the same literal value, inside the construct it was placed in, with
 * no other Markdown structure.
 */

import { assert as fcAssert, constantFrom, property, string } from "fast-check";
import { type Token, marked } from "marked";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, test } from "vitest";
import { codeBlock, inlineCode, tableCell, text } from "./markdown.js";

const NUM_RUNS = 500;

/** Characters with meaning in CommonMark or GFM, plus line breaks and spacing. */
const markdownArb = string({
  unit: constantFrom(
    ..."\\`*_~[]()<>!#&;|:@.-+=/\"'{}^".split(""),
    "a",
    "é",
    "1",
    "x",
    "www.",
    "http://",
    "a@b.c",
    "&amp;",
    "&#x20;",
    " ",
    "  ",
    "\t",
    "\n",
    "\r\n",
    "\r",
  ),
  maxLength: 40,
});

/** Markdown that places `value` in the first of two list items, after a label. */
const listItem = (value: string, suffix: string) =>
  `- **k**: ${value}${suffix}\n- next\n`;

const singleLine = (value: string) => value.replace(/\r\n?|\n/g, " ");

/** A parsed list item reduced to what tests compare. */
interface Inline {
  type: "text" | "code";
  value: string;
}

/** Parses with micromark; returns the first list item's content after the label. */
function parseMicromark(markdown: string): Inline[] {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  expect(root.children).toHaveLength(1);
  const list = root.children[0];
  if (list?.type !== "list")
    throw new Error(`expected list, got ${list?.type}`);
  expect(list.children).toHaveLength(2);
  const paragraph = list.children[0]?.children[0];
  if (paragraph?.type !== "paragraph") {
    throw new Error(`expected paragraph, got ${paragraph?.type}`);
  }
  const [label, ...rest] = paragraph.children;
  expect(label).toMatchObject({
    type: "strong",
    children: [{ type: "text", value: "k" }],
  });
  return rest.map((node) => {
    if (node.type === "text") return { type: "text", value: node.value };
    if (node.type === "inlineCode") return { type: "code", value: node.value };
    // mdast-util-gfm links literal `www.` domains, URLs, and emails in decoded
    // text, escaped or not. The link text is still the original text.
    if (node.type === "link" && node.children.every((c) => c.type === "text")) {
      return {
        type: "text",
        value: node.children.map((c) => c.value).join(""),
      };
    }
    throw new Error(`unexpected ${node.type} node`);
  });
}

/** Parses with marked; returns the first list item's content after the label. */
function parseMarked(markdown: string): Inline[] {
  const tokens = marked.lexer(markdown).filter((t) => t.type !== "space");
  expect(tokens).toHaveLength(1);
  const list = tokens[0];
  if (list?.type !== "list")
    throw new Error(`expected list, got ${list?.type}`);
  expect(list.items).toHaveLength(2);
  const item = list.items[0]?.tokens[0];
  if (item?.type !== "text" || !("tokens" in item) || !item.tokens) {
    throw new Error(`expected inline text, got ${item?.type}`);
  }
  const [label, ...rest] = item.tokens as Token[];
  expect(label).toMatchObject({ type: "strong", text: "k" });
  return rest.map((token) => {
    // `marked` keeps character references in text tokens, and the CLI prints
    // text tokens as they are, so none may reach the output.
    if (token.type === "text" || token.type === "escape") {
      return { type: "text", value: token.text };
    }
    if (token.type === "codespan") return { type: "code", value: token.text };
    throw new Error(`unexpected ${token.type} token`);
  });
}

/** Merges adjacent text so both parsers compare the same shape. */
function merge(nodes: Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (last?.type === "text" && node.type === "text") {
      last.value += node.value;
    } else {
      merged.push({ ...node });
    }
  }
  return merged;
}

const parsers = [
  ["marked", parseMarked],
  ["micromark", parseMicromark],
] as const;

describe.each(parsers)("with %s", (_, parse) => {
  test.each([
    ["mid-line", " end"],
    ["end of line", ""],
  ])("text round-trips any value as plain text (%s)", (_, suffix) => {
    fcAssert(
      // An empty value leaves the label's trailing space at the end of the line.
      property(
        markdownArb.filter((value) => singleLine(value).trim() !== ""),
        (value) => {
          expect(merge(parse(listItem(text(value), suffix)))).toEqual([
            {
              type: "text",
              value: `: ${singleLine(value).trim()}${suffix}`,
            },
          ]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("inlineCode round-trips any non-empty value as one code span", () => {
    fcAssert(
      property(
        markdownArb.filter((value) => value.length > 0),
        (value) => {
          expect(merge(parse(listItem(inlineCode(value), " end")))).toEqual([
            { type: "text", value: ": " },
            { type: "code", value: singleLine(value) },
            { type: "text", value: " end" },
          ]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/** Parses a single heading with micromark; returns its literal text. */
function headingMicromark(markdown: string): string {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const [heading] = root.children;
  expect(root.children).toHaveLength(1);
  if (heading?.type !== "heading") {
    throw new Error(`expected heading, got ${heading?.type}`);
  }
  return heading.children
    .map((node) => {
      if (node.type === "text") return node.value;
      // See parseMicromark: mdast-util-gfm links literal URLs after parsing.
      if (node.type === "link") {
        return node.children.map((c) => ("value" in c ? c.value : "")).join("");
      }
      throw new Error(`unexpected ${node.type} node`);
    })
    .join("");
}

/** Parses a single heading with marked; returns its literal text. */
function headingMarked(markdown: string): string {
  const tokens = marked.lexer(markdown).filter((t) => t.type !== "space");
  const [heading] = tokens;
  expect(tokens).toHaveLength(1);
  if (heading?.type !== "heading") {
    throw new Error(`expected heading, got ${heading?.type}`);
  }
  return (heading.tokens as Token[])
    .map((token) => {
      if (token.type === "text" || token.type === "escape") return token.text;
      throw new Error(`unexpected ${token.type} token`);
    })
    .join("");
}

describe.each([
  ["marked", headingMarked],
  ["micromark", headingMicromark],
] as const)("text in a heading with %s", (_, parseHeading) => {
  test("round-trips any value, including trailing hashes", () => {
    fcAssert(
      property(
        markdownArb.filter((value) => singleLine(value).trim() !== ""),
        (value) => {
          expect(parseHeading(`### ${text(value)}\n`)).toBe(
            singleLine(value).trim(),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/** A two-column table whose only body row holds `cell` and then `end`. */
const tableRow = (cell: string) =>
  `| a | b |\n| --- | --- |\n| ${cell} | end |\n`;

/** Parses a table with micromark; returns the body row's cells as literal text. */
function tableMicromark(markdown: string): string[] {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const [table] = root.children;
  expect(root.children).toHaveLength(1);
  if (table?.type !== "table") {
    throw new Error(`expected table, got ${table?.type}`);
  }
  expect(table.children).toHaveLength(2);
  return (table.children[1]?.children ?? []).map((cell) =>
    cell.children
      .map((node) => {
        if (node.type === "text") return node.value;
        // See parseMicromark: mdast-util-gfm links literal URLs after parsing.
        if (node.type === "link") {
          return node.children
            .map((c) => ("value" in c ? c.value : ""))
            .join("");
        }
        throw new Error(`unexpected ${node.type} node`);
      })
      .join(""),
  );
}

/** Parses a table with marked; returns the body row's cells as literal text. */
function tableMarked(markdown: string): string[] {
  const tokens = marked.lexer(markdown).filter((t) => t.type !== "space");
  const [table] = tokens;
  expect(tokens).toHaveLength(1);
  if (table?.type !== "table") {
    throw new Error(`expected table, got ${table?.type}`);
  }
  expect(table.rows).toHaveLength(1);
  return (table.rows[0] as { tokens: Token[] }[]).map((cell) =>
    cell.tokens
      .map((token) => {
        if (token.type === "text" || token.type === "escape") return token.text;
        throw new Error(`unexpected ${token.type} token`);
      })
      .join(""),
  );
}

describe.each([
  ["marked", tableMarked],
  ["micromark", tableMicromark],
] as const)("tableCell with %s", (_, parseTable) => {
  test("round-trips any value inside its cell", () => {
    fcAssert(
      property(
        markdownArb.filter((value) => singleLine(value).trim() !== ""),
        (value) => {
          expect(parseTable(tableRow(tableCell(value)))).toEqual([
            singleLine(value).trim(),
            "end",
          ]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("codeBlock", () => {
  test("round-trips any value as one code block with micromark", () => {
    fcAssert(
      property(markdownArb, (value) => {
        const root = fromMarkdown(`${codeBlock(value, "text")}\n\nafter\n`, {
          extensions: [gfm()],
          mdastExtensions: [gfmFromMarkdown()],
        });
        expect(root.children).toEqual([
          expect.objectContaining({
            type: "code",
            lang: "text",
            value: value.replace(/\r\n?/g, "\n"),
          }),
          expect.objectContaining({ type: "paragraph" }),
        ]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("round-trips any value as one code block with marked", () => {
    fcAssert(
      property(markdownArb, (value) => {
        const tokens = marked
          .lexer(`${codeBlock(value, "text")}\n\nafter\n`)
          .filter((t) => t.type !== "space");
        expect(tokens).toEqual([
          expect.objectContaining({
            type: "code",
            lang: "text",
            text: value.replace(/\r\n?/g, "\n"),
          }),
          expect.objectContaining({ type: "paragraph" }),
        ]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
