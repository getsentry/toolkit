/**
 * Markdown builders for untrusted values in CLI and MCP output.
 *
 * Pick the helper by what the value is, not by which characters it contains:
 * `inlineCode` for identifiers and short values, `codeBlock` for multi-line
 * data, and `text` for values that should read as prose. Each one keeps the
 * value inside the surrounding construct, so a value cannot add headings,
 * list items, links, or other Markdown structure to the output.
 */
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

const LINE_BREAK = /\r\n?|\n/g;

/**
 * The first `w` of a `www.` domain, with any backslashes before it. GFM reads
 * a literal `www.` autolink from the raw source, so escapes inside it would
 * show up as backslashes. A character reference for this `w` keeps the parser
 * from starting one.
 */
const WWW_AUTOLINK_START = /(\\*)(w)(?=ww\\?\.)/gi;

/**
 * An escaped `_` between two letters or digits. CommonMark never treats such
 * an underscore as emphasis, so `text` leaves it unescaped to keep
 * `snake_case` names readable.
 */
const INTRAWORD_UNDERSCORE = /(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu;

/** Replaces line breaks with spaces, as CommonMark renders them in inline content. */
function toSingleLine(value: string): string {
  return value.replace(LINE_BREAK, " ");
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const run of value.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return longest;
}

/**
 * Formats a value as a code span. Nothing inside needs escaping.
 *
 * The fence is longer than any backtick run in the value. Padding keeps a
 * leading or trailing backtick or space, which CommonMark would otherwise
 * merge into the fence or strip. Line breaks become spaces.
 */
export function inlineCode(value: string): string {
  const content = toSingleLine(value);
  const fence = "`".repeat(longestBacktickRun(content) + 1);
  // CommonMark strips one space from each end unless the span is only spaces.
  const needsPadding = /^[` ]|[` ]$/.test(content) && !/^ +$/.test(content);
  return needsPadding
    ? `${fence} ${content} ${fence}`
    : `${fence}${content}${fence}`;
}

/**
 * Formats a value as a fenced code block.
 *
 * The fence is longer than any backtick run in the value, so no line of the
 * value can close the block. The language is reduced to characters that are
 * valid in an info string. Line breaks are normalized to `\n`.
 */
export function codeBlock(value: string, language = ""): string {
  const content = value.replace(/\r\n?/g, "\n");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  const info = language.replace(/[^\w+#.-]/g, "");
  return `${fence}${info}\n${content}\n${fence}`;
}

/**
 * Escapes a value so it renders as the same literal text.
 *
 * Escaping is context-aware and covers CommonMark and GitHub Flavored
 * Markdown, including emphasis, links, raw HTML, character references, and
 * strikethrough. A GFM renderer may still link a `www.` domain, but the link
 * text stays the same. Line breaks become spaces, so the value stays on the
 * line it is placed in. Pipes are not escaped; this is not a table cell
 * escaper.
 */
export function text(value: string): string {
  return toMarkdown(
    {
      type: "paragraph",
      children: [{ type: "text", value: toSingleLine(value) }],
    },
    { extensions: [gfmToMarkdown()] },
  )
    .replace(/\n$/, "")
    .replace(INTRAWORD_UNDERSCORE, "_")
    .replace(WWW_AUTOLINK_START, (_, backslashes: string, w: string) => {
      // An odd run ends in a literal backslash that would escape the `&`.
      const escaped = backslashes.length % 2 ? `${backslashes}\\` : backslashes;
      return `${escaped}&#x${w.charCodeAt(0).toString(16)};`;
    });
}
