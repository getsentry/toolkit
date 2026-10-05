/**
 * SQL syntax highlighting for DB span descriptions.
 *
 * Uses `@sentry/sqlish` to parse SQL-ish strings (including parameterized
 * queries with `%s`, `$1`, `?`) and applies ANSI colorization via the
 * project's chalk-based color palette.
 *
 * Respects {@link isPlainOutput} — all functions return plain uncolored
 * text when output is piped, `NO_COLOR` is set, or `SENTRY_PLAIN_OUTPUT=1`.
 */

import type { Token } from "@sentry/sqlish";
import { SQLishParser, string as sqlishFormat } from "@sentry/sqlish";
import { cyan, magenta, muted } from "./colors.js";
import { isPlainOutput } from "./plain-detect.js";

const parser = new SQLishParser();

/**
 * Check whether a span operation is a database span.
 *
 * Matches `"db"`, `"db.query"`, `"db.sql.query"`, `"db.redis"`, etc.
 * The `@sentry/sqlish` parser is tolerant of non-SQL content, so it's
 * safe to colorize any `db.*` description — non-SQL tokens simply render
 * as generic (uncolored) text.
 *
 * @param op - Span operation string (e.g. from `span.op`)
 * @returns `true` if the operation starts with `"db"`
 */
export function isDbSpanOp(op?: string | null): boolean {
  if (!op) {
    return false;
  }
  return op === "db" || op.startsWith("db.");
}

/**
 * Colorize a single token based on its type.
 *
 * Token → color mapping:
 * - `Keyword` → cyan (matches `codeFg` feel; stands out without being loud)
 * - `Parameter` → magenta (visually distinct for `%s`, `$1`, `?`)
 * - `CollapsedColumns` → muted (de-emphasized, not actual SQL)
 * - `LeftParenthesis` / `RightParenthesis` → muted (structural)
 * - `GenericToken` → default terminal foreground
 * - `Whitespace` → as-is
 */
function colorizeToken(token: Token): string {
  // Nested content: recurse
  if (Array.isArray(token.content)) {
    return token.content.map(colorizeToken).join("");
  }

  // Token content is another token (shouldn't happen per spec but handle gracefully)
  if (typeof token.content === "object" && token.content !== null) {
    return colorizeToken(token.content);
  }

  const text = typeof token.content === "string" ? token.content : "";

  switch (token.type) {
    case "Keyword":
      return cyan(text);
    case "Parameter":
      return magenta(text);
    case "CollapsedColumns":
    case "LeftParenthesis":
    case "RightParenthesis":
      return muted(text);
    default:
      return text;
  }
}

/**
 * Inline SQL syntax highlighting for a single line.
 *
 * Parses the SQL string with `@sentry/sqlish` and applies ANSI colors
 * to each token. Whitespace is normalized to single spaces.
 *
 * Returns the original string unchanged when {@link isPlainOutput} is true.
 *
 * @param sql - SQL-ish description from a span (e.g. `"SELECT * FROM users WHERE id = %s"`)
 * @returns ANSI-colored string, or plain text in non-TTY mode
 */
export function colorizeSql(sql: string): string {
  if (isPlainOutput()) {
    return sql;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const tokens = parser.parse(sql);
    return tokens.map(colorizeToken).join("");
  } catch {
    // If parsing fails, return the original string uncolored
    return sql;
  }
}

/**
 * Pretty-printed, colorized SQL block for detail views.
 *
 * In TTY mode: reformats the SQL with newlines at major keywords
 * (`SELECT`, `FROM`, `WHERE`, `ORDER`, etc.) and applies syntax
 * highlighting. Returns a section like:
 *
 * ```
 * ─── Query ───
 *
 * SELECT id, name
 * FROM users
 * WHERE id = %s
 * ```
 *
 * In non-TTY / plain mode: returns the original SQL as a compact
 * single line with no ANSI codes and no reformatting, safe for piping
 * and machine consumption.
 *
 * @param sql - SQL-ish description from a DB span
 * @returns Formatted section string
 */
export function formatSqlBlock(sql: string): string {
  if (isPlainOutput()) {
    return `\n─── Query ───\n\n${sql}\n`;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const tokens = parser.parse(sql);
    // Use sqlish's string formatter for structural formatting (newlines at keywords)
    const structured = sqlishFormat(tokens);
    // Re-parse the structured output to colorize it
    const coloredTokens = parser.parse(structured);
    const colored = coloredTokens.map(colorizeToken).join("");
    return `\n${muted("─── Query ───")}\n\n${colored}\n`;
  } catch {
    // Fallback: show unformatted but with header
    return `\n${muted("─── Query ───")}\n\n${sql}\n`;
  }
}
