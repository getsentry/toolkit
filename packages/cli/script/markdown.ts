/**
 * Markdown structure helpers for doc-checking scripts.
 *
 * Backed by the `marked` lexer so headings and code blocks are recognized the
 * same way the docs renderer sees them. Use these instead of regexes when a
 * script needs markdown structure.
 */
import { marked, type Tokens } from "marked";

/** A markdown heading with its level and plain heading text. */
export type MarkdownHeading = { depth: number; text: string };

/** Collect the top-level headings of a markdown document. */
export function markdownHeadings(md: string): MarkdownHeading[] {
  return marked
    .lexer(md)
    .filter((token) => token.type === "heading")
    .map((token) => ({ depth: token.depth, text: token.text }));
}

/**
 * Blank out top-level code blocks while keeping their line breaks, so line
 * numbers in the result still match the original document.
 */
export function blankCodeBlocks(md: string): string {
  return marked
    .lexer(md)
    .map((token) =>
      token.type === "code"
        ? "\n".repeat(token.raw.split("\n").length - 1)
        : token.raw,
    )
    .join("");
}

/**
 * Body of the section under the first heading whose text equals `heading`,
 * up to the next heading of the same or a higher level. Returns null when the
 * heading is missing.
 */
export function markdownSection(md: string, heading: string): string | null {
  const tokens = marked.lexer(md);
  const start = tokens.findIndex(
    (token) => token.type === "heading" && token.text.trim() === heading,
  );
  if (start === -1) {
    return null;
  }
  const { depth } = tokens[start] as Tokens.Heading;
  const rest = tokens.slice(start + 1);
  const end = rest.findIndex(
    (token) => token.type === "heading" && token.depth <= depth,
  );
  return (end === -1 ? rest : rest.slice(0, end))
    .map((token) => token.raw)
    .join("")
    .trim();
}

/** A fenced or indented code block with its language (first info-string word). */
export type MarkdownCodeBlock = { code: string; lang: string };

/** Collect the top-level code blocks of a markdown document. */
export function markdownCodeBlocks(md: string): MarkdownCodeBlock[] {
  return marked
    .lexer(md)
    .filter((token) => token.type === "code")
    .map((token) => ({
      code: token.text.trim(),
      lang: (token.lang ?? "").split(" ")[0] ?? "",
    }));
}

/** Demote every top-level ATX heading of level 2 or deeper by one level. */
export function demoteHeadings(md: string): string {
  return marked
    .lexer(md)
    .map((token) =>
      token.type === "heading" && token.depth >= 2 && token.raw.startsWith("#")
        ? `#${token.raw}`
        : token.raw,
    )
    .join("");
}
