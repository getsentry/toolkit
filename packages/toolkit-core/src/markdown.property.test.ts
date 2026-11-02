/**
 * Property-Based Tests for Markdown builders
 *
 * Parses each helper's output with micromark (CommonMark + GFM) and checks
 * that any input comes back as the same literal value, inside the construct
 * it was placed in, with no other Markdown structure.
 */

import { assert as fcAssert, constantFrom, property, string } from "fast-check";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, test } from "vitest";
import { codeBlock, inlineCode, text } from "./markdown.js";

const NUM_RUNS = 500;

/** Characters with meaning in CommonMark or GFM, plus line breaks and spacing. */
const markdownArb = string({
  unit: constantFrom(
    ..."\\`*_~[]()<>!#&;|:@.-+=/\"'{}^".split(""),
    "a",
    "1",
    "x",
    "www.",
    "http://",
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

function parse(markdown: string) {
  return fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

type Root = ReturnType<typeof parse>;

/** Returns the first list item's paragraph children after the `**k**` label. */
function firstItemAfterLabel(root: Root) {
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
  return rest;
}

const singleLine = (value: string) => value.replace(/\r\n?|\n/g, " ");

type Phrasing = ReturnType<typeof firstItemAfterLabel>[number];

/**
 * Concatenates the literal text of `nodes`, failing on any Markdown structure.
 * GFM literal autolinks are allowed: remark links `www.` domains even after
 * escaping, and the link text is still the original text.
 */
function literalText(nodes: Phrasing[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.value;
      if (
        node.type === "link" &&
        node.children.every((c) => c.type === "text")
      ) {
        return literalText(node.children);
      }
      throw new Error(`unexpected ${node.type} node`);
    })
    .join("");
}

describe("text", () => {
  test.each([
    ["mid-line", (v: string) => `- **k**: ${v} end\n- next\n`, " end"],
    ["end of line", (v: string) => `- **k**: ${v}\n- next\n`, ""],
  ])("round-trips any value as plain text (%s)", (_, render, suffix) => {
    fcAssert(
      // An empty value leaves the label's trailing space at the end of the line.
      property(markdownArb.filter(Boolean), (value) => {
        const nodes = firstItemAfterLabel(parse(render(text(value))));
        expect(literalText(nodes)).toBe(`: ${singleLine(value)}${suffix}`);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("inlineCode", () => {
  test("round-trips any non-empty value as one code span", () => {
    fcAssert(
      property(
        markdownArb.filter((value) => value.length > 0),
        (value) => {
          const nodes = firstItemAfterLabel(
            parse(`- **k**: ${inlineCode(value)} end\n- next\n`),
          );
          expect(nodes).toEqual([
            expect.objectContaining({ type: "text", value: ": " }),
            expect.objectContaining({
              type: "inlineCode",
              value: singleLine(value),
            }),
            expect.objectContaining({ type: "text", value: " end" }),
          ]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("codeBlock", () => {
  test("round-trips any value as one code block", () => {
    fcAssert(
      property(markdownArb, (value) => {
        const root = parse(`${codeBlock(value, "text")}\n\nafter\n`);
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
});
