/** Pure Markdown escaping shared by CLI and MCP output. */

/**
 * Escape CommonMark inline emphasis characters.
 *
 * Prevents `_`, `*`, `` ` ``, `[`, `]`, `<`, and `>` from being consumed
 * by the parser. Angle brackets are backslash-escaped (`\<`/`\>`) so that
 * user-supplied content (e.g. `Expected <string> got <number>`) is not
 * silently dropped when `marked` parses the text as HTML tokens.
 */
export function escapeMarkdownInline(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>");
}
