/**
 * Plain-text stand-in for `markdown.ts` in the standalone `@sentry/mcp-server`
 * bundle. The markdown renderer and its syntax highlighter would add over a
 * megabyte for the two inline hints the login flow prints.
 */

/** Strip inline markdown emphasis and code markers. */
export function renderInlineMarkdown(md: string): string {
  return (md ?? "").replace(/[`*]/g, "");
}
