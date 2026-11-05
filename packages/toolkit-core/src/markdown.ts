/**
 * Markdown builders for untrusted values in CLI and MCP output.
 *
 * Pick the helper by what the value is, not by which characters it contains:
 * `inlineCode` for identifiers and short values, `codeBlock` for multi-line
 * data, and `text` for values that should read as prose. Each one keeps the
 * value inside the surrounding construct, so a value cannot add headings,
 * list items, links, or other Markdown structure to the output.
 */
const LINE_BREAK = /\r\n?|\n/g;

/**
 * Characters `text` escapes wherever they appear, or in the context the
 * lookahead names: an `&` that starts a character reference, the `:` of a
 * `scheme://` URL, and the `.` of a `www.` domain, so GFM cannot start a
 * literal autolink, and a trailing run of `#` after a space, which would close
 * an ATX heading. An `_` between two letters or digits is never emphasis and
 * stays as is.
 */
const INLINE_SYNTAX =
  /[\\`*[\]<>~@]|&(?=#?[a-z0-9]+;)|:(?=\/\/)|(?<=www)\.|(?<=\s)#(?=#*$)|(?<=^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/giu;

/** `INLINE_SYNTAX` plus the pipe that would end a GFM table cell. */
const TABLE_CELL_SYNTAX = new RegExp(
  `\\||${INLINE_SYNTAX.source}`,
  INLINE_SYNTAX.flags,
);

/** Syntax that only counts at the start of a line: headings, quotes, lists, rules. */
const LINE_START_SYNTAX = /^(?:[#+=-]|\d{1,9}[.)])/;

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
 * Covers CommonMark and GitHub Flavored Markdown: emphasis, code spans,
 * links, raw HTML, character references, strikethrough, literal autolinks,
 * and syntax that only counts at the start of a line. Line breaks become
 * spaces and surrounding whitespace is dropped, so the value stays on the
 * line it is placed in. Escapes are backslashes only, which `marked` (the
 * CLI renderer) and micromark both resolve. Pipes are not escaped; use
 * `tableCell` inside a table.
 */
export function text(value: string): string {
  return escapeSyntax(value, INLINE_SYNTAX);
}

/**
 * Escapes a value as `text` does, plus pipes, so it stays in its GFM table
 * cell and renders as the same literal text.
 */
export function tableCell(value: string): string {
  return escapeSyntax(value, TABLE_CELL_SYNTAX);
}

/** Puts a value on one line and backslash-escapes `syntax` and line-start syntax. */
function escapeSyntax(value: string, syntax: RegExp): string {
  return toSingleLine(value)
    .trim()
    .replace(syntax, (char) => `\\${char}`)
    .replace(
      LINE_START_SYNTAX,
      (match) => `${match.slice(0, -1)}\\${match.slice(-1)}`,
    );
}
