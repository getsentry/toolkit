/**
 * Markdown-to-Terminal Renderer
 *
 * Custom renderer that walks `marked` tokens and produces ANSI-styled
 * terminal output using `chalk`. Replaces `marked-terminal` to eliminate
 * its ~970KB dependency chain (cli-highlight, node-emoji, cli-table3,
 * parse5) while giving us full control over table rendering.
 *
 * Table rendering delegates to the text-table module which uses
 * OpenTUI-inspired column fitting algorithms and Unicode box-drawing
 * borders.
 *
 * Pre-rendered ANSI escape codes embedded in markdown source are preserved
 * — `string-width` correctly treats them as zero-width.
 *
 * ## Output mode resolution
 *
 * See {@link isPlainOutput} in `plain-detect.ts` for the full priority chain.
 */

import chalk from "chalk";
import { highlight as cliHighlight } from "cli-highlight";
import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import { COLORS, muted, terminalLink } from "./colors.js";
import { isPlainOutput, stripAnsi } from "./plain-detect.js";
import { type Alignment, renderTextTable } from "./text-table.js";

// Re-export isPlainOutput so existing importers don't break
export { isPlainOutput } from "./plain-detect.js";

// ──────────────────────────── Escape helpers ──────────────────────────

/**
 * Escape a string for safe use inside a markdown table cell.
 *
 * Collapses newlines, escapes backslashes, pipes, and angle brackets.
 * Angle brackets are backslash-escaped (`\<`/`\>`) so that user-supplied
 * content (e.g. `Expected <string>`) is not parsed as an HTML tag by
 * `marked`, which would silently drop the content via `renderHtmlToken`.
 */
export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>");
}

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

/**
 * Wrap a string in a backtick code span, sanitising characters that
 * would break the span or surrounding table structure.
 */
export function safeCodeSpan(value: string): string {
  return `\`${value.replace(/`/g, "\u02CB").replace(/\|/g, "\u2502").replace(/\n/g, " ")}\``;
}

// ──────────────────────── Streaming table helpers ─────────────────────

/**
 * Build a raw markdown table header row + separator from column names.
 *
 * Column names ending with `:` are right-aligned (the `:` is stripped).
 */
export function mdTableHeader(cols: readonly string[]): string {
  const names = cols.map((c) => (c.endsWith(":") ? c.slice(0, -1) : c));
  const seps = cols.map((c) => (c.endsWith(":") ? "---:" : "---"));
  return `| ${names.join(" | ")} |\n| ${seps.join(" | ")} |`;
}

/**
 * Build a streaming markdown table row. In plain mode emits raw markdown;
 * in rendered mode applies inline styling and replaces `|` with `│`.
 */
export function mdRow(cells: readonly string[]): string {
  // Both modes render through the same pipeline; plain mode strips ANSI.
  // Literal pipes are replaced with box-drawing │ to prevent breaking the
  // pipe-delimited table format.
  const out = cells.map((c) =>
    renderInlineMarkdown(c).replace(/\|/g, "\u2502")
  );
  return `| ${out.join(" | ")} |\n`;
}

/**
 * Build a key-value markdown table section with an optional heading.
 *
 * Each entry is rendered as `| **Label** | value |`.
 */
export function mdKvTable(
  rows: ReadonlyArray<readonly [string, string]>,
  heading?: string
): string {
  const lines: string[] = [];
  if (heading) {
    lines.push(`### ${heading}`);
    lines.push("");
  }
  lines.push("| | |");
  lines.push("|---|---|");
  for (const [label, value] of rows) {
    // Escape backslashes first, then replace pipes with a Unicode box character
    // so that backslash-pipe sequences in values don't produce escaped pipes in
    // the rendered output. Newlines are collapsed to spaces.
    // Only replace structural characters that break table syntax.
    // Content escaping (<>, \, _*`) is the caller's responsibility.
    lines.push(
      `| **${label}** | ${value.replace(/\n/g, " ").replace(/\|/g, "\u2502")} |`
    );
  }
  return lines.join("\n");
}

/**
 * Render a horizontal rule. Muted (dimmed) in TTY mode, plain in pipes.
 */
export function divider(width = 80): string {
  const line = "\u2500".repeat(width);
  return isPlainOutput() ? line : muted(line);
}

// ──────────────────────── Inline token rendering ─────────────────────

/**
 * Semantic HTML color tags supported in markdown strings.
 *
 * Formatters can embed `<red>text</red>`, `<green>text</green>`, etc. in
 * any markdown string and the custom renderer will apply the corresponding
 * ANSI color. In plain (non-TTY) mode the tags are stripped, leaving only
 * the inner text.
 *
 * Supported tags: red, green, yellow, blue, magenta, cyan, muted, bu (bold+underline)
 */
const COLOR_TAGS: Record<string, (text: string) => string> = {
  red: (t) => chalk.hex(COLORS.red)(t),
  green: (t) => chalk.hex(COLORS.green)(t),
  yellow: (t) => chalk.hex(COLORS.yellow)(t),
  blue: (t) => chalk.hex(COLORS.blue)(t),
  magenta: (t) => chalk.hex(COLORS.magenta)(t),
  cyan: (t) => chalk.hex(COLORS.cyan)(t),
  muted: (t) => chalk.hex(COLORS.muted)(t),
  bu: (t) => chalk.bold.underline(t),
};

/** Regex matching all supported color tag pairs — compiled once at module scope. */
const COLOR_TAG_RE = new RegExp(
  `<(${Object.keys(COLOR_TAGS).join("|")})>([\\s\\S]*?)<\\/\\1>`,
  "gi"
);

/**
 * Wrap text in a semantic color tag for use in markdown strings.
 *
 * In TTY mode the tag is rendered as an ANSI color by the custom renderer.
 * In plain mode the tag is stripped and only the inner text is emitted.
 *
 * @example
 * colorTag("red", "ERROR")   // → "<red>ERROR</red>"
 * colorTag("green", "✓")     // → "<green>✓</green>"
 */
export function colorTag(tag: keyof typeof COLOR_TAGS, text: string): string {
  return `<${tag}>${text}</${tag}>`;
}

// Pre-compiled regexes for HTML color tag parsing (module-level for performance)
const RE_OPEN_TAG = /^<([a-z]+)>$/i;
const RE_CLOSE_TAG = /^<\/([a-z]+)>$/i;
const RE_SELF_TAG = /^<([a-z]+)>([\s\S]*?)<\/\1>$/i;

/**
 * Strip color tags (`<red>…</red>`, `<green>…</green>`, etc.) from a string,
 * leaving only the inner text.
 *
 * Used in plain output mode so that `colorTag()` values don't leak as literal
 * HTML-like tags into piped / CI / redirected output.
 */
export function stripColorTags(text: string): string {
  // Repeatedly replace all supported color tag pairs until none remain.
  // The loop handles nested tags (uncommon but possible).
  let result = text;
  let prev: string;
  do {
    prev = result;
    COLOR_TAG_RE.lastIndex = 0;
    result = result.replace(COLOR_TAG_RE, "$2");
  } while (result !== prev);
  return result;
}

/**
 * Render an inline HTML token as a color-tagged string.
 *
 * Handles self-contained `<tag>text</tag>` forms. Bare open/close
 * tags are dropped (marked emits them as separate tokens; the
 * self-contained form is produced by `colorTag()`).
 */
function renderHtmlToken(raw: string): string {
  const trimmed = raw.trim();
  if (RE_OPEN_TAG.test(trimmed) || RE_CLOSE_TAG.test(trimmed)) {
    return "";
  }
  const m = RE_SELF_TAG.exec(trimmed);
  if (m) {
    const tagName = m[1];
    const inner = m[2];
    if (tagName !== undefined && inner !== undefined) {
      const colorFn = COLOR_TAGS[tagName.toLowerCase()];
      return colorFn ? colorFn(inner) : inner;
    }
  }
  return "";
}

/**
 * Syntax-highlight a code block. Falls back to uniform yellow if the
 * language is unknown or highlighting fails.
 */
function highlightCode(code: string, language?: string): string {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return cliHighlight(code, { language, ignoreIllegals: true });
  } catch {
    return chalk.hex(COLORS.yellow)(code);
  }
}

/**
 * Flatten a top-level token's inline content. Paragraphs and other block
 * tokens that wrap inline tokens are unwrapped; bare inline tokens pass
 * through as-is.
 */
function flattenInline(token: Token): Token[] {
  if (
    "tokens" in token &&
    token.tokens &&
    token.type !== "strong" &&
    token.type !== "em" &&
    token.type !== "link"
  ) {
    return token.tokens;
  }
  return [token];
}

/**
 * Render a code span token.
 *
 * Plain mode: raw text without padding so table column widths aren't inflated.
 * TTY mode: styled with background color and padded spaces for visual weight.
 */
function renderCodespan(token: Tokens.Codespan): string {
  if (isPlainOutput()) {
    return token.text;
  }
  return chalk.bgHex(COLORS.codeBg).hex(COLORS.codeFg)(` ${token.text} `);
}

/**
 * Render a single inline token to an ANSI string.
 */
function renderOneInline(token: Token): string {
  switch (token.type) {
    case "strong":
      return chalk.bold(renderInline((token as Tokens.Strong).tokens));
    case "em":
      return chalk.italic(renderInline((token as Tokens.Em).tokens));
    case "codespan":
      return renderCodespan(token as Tokens.Codespan);
    case "link": {
      const link = token as Tokens.Link;
      let linkText = renderInline(link.tokens);
      let href = link.href ?? "";
      // GFM autolinks absorb backslash-escapes literally (\_astro → \_astro).
      // Detect autolinks via link.raw (starts with URL, not "[") and strip artifacts.
      const raw = link.raw ?? "";
      if (raw.startsWith("http://") || raw.startsWith("https://")) {
        const stripEscapes = (s: string) =>
          s.replace(/\\([_*`[\]<>\\])/g, "$1");
        linkText = stripEscapes(linkText);
        href = stripEscapes(href);
      }
      const styled = chalk.hex(COLORS.blue)(linkText);
      return href ? terminalLink(styled, href) : styled;
    }
    case "del":
      return chalk.dim.gray.strikethrough(
        renderInline((token as Tokens.Del).tokens)
      );
    case "br":
      return "\n";
    case "escape":
      return (token as Tokens.Escape).text;
    case "text":
      if ("tokens" in token && (token as Tokens.Text).tokens) {
        return renderInline((token as Tokens.Text).tokens ?? []);
      }
      return (token as Tokens.Text).text;
    case "html": {
      const raw = (token as Tokens.HTML).raw ?? (token as Tokens.HTML).text;
      return renderHtmlToken(raw);
    }
    default:
      return (token as { raw?: string }).raw ?? "";
  }
}

/**
 * Render an array of inline tokens into an ANSI-styled string.
 *
 * Handles paired color tags (`<red>\u2026</red>`) that `marked` emits as
 * separate `html` tokens (open, inner tokens, close). Buffers inner
 * tokens until the matching close tag, then applies the color function.
 *
 * Also handles: strong, em, codespan, link, text, br, del, escape.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: paired color tag buffering
function renderInline(tokens: Token[]): string {
  const parts: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i] as Token;

    // Check for color tag open: <red>, <green>, etc.
    if (token.type === "html") {
      const raw = (
        (token as Tokens.HTML).raw ?? (token as Tokens.HTML).text
      ).trim();
      const openMatch = RE_OPEN_TAG.exec(raw);
      if (openMatch) {
        const tagName = (openMatch[1] ?? "").toLowerCase();
        const colorFn = COLOR_TAGS[tagName];
        if (colorFn) {
          // Collect inner tokens until matching </tag>
          const closeTag = `</${openMatch[1]}>`;
          const inner: Token[] = [];
          i += 1;
          while (i < tokens.length) {
            const t = tokens[i] as Token;
            if (
              t.type === "html" &&
              ((t as Tokens.HTML).raw ?? (t as Tokens.HTML).text)
                .trim()
                .toLowerCase() === closeTag.toLowerCase()
            ) {
              i += 1; // consume close tag
              break;
            }
            inner.push(t);
            i += 1;
          }
          parts.push(colorFn(renderInline(inner)));
          continue;
        }
      }
    }

    parts.push(renderOneInline(token));
    i += 1;
  }

  return parts.join("");
}

// ──────────────────────── Block token rendering ──────────────────────

/**
 * Render an array of block-level tokens into ANSI-styled terminal output.
 *
 * Handles: heading, paragraph, code, blockquote, list, table, hr, space.
 */
function renderBlocks(tokens: Token[]): string {
  const parts: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const t = token as Tokens.Heading;
        const text = renderInline(t.tokens);
        if (t.depth <= 2) {
          // h1/h2 → bold cyan with colored divider bar for visual weight
          parts.push(chalk.hex(COLORS.cyan).bold(text));
          parts.push(
            chalk.hex(COLORS.cyan)(
              "\u2501".repeat(Math.min(stringWidth(text), 30))
            )
          );
        } else {
          // h3+ → bold cyan (less prominent, no divider)
          parts.push(chalk.hex(COLORS.cyan).bold(text));
        }
        parts.push("");
        break;
      }
      case "paragraph": {
        const t = token as Tokens.Paragraph;
        parts.push(renderInline(t.tokens));
        parts.push("");
        break;
      }
      case "code": {
        const t = token as Tokens.Code;
        const highlighted = highlightCode(t.text, t.lang ?? undefined);
        const lines = highlighted.split("\n").map((l) => `  ${l}`);
        parts.push(lines.join("\n"));
        parts.push("");
        break;
      }
      case "blockquote": {
        const t = token as Tokens.Blockquote;
        const inner = renderBlocks(t.tokens).trim();
        const quoted = inner
          .split("\n")
          .map((l) => chalk.hex(COLORS.muted).italic(`  ${l}`))
          .join("\n");
        parts.push(quoted);
        parts.push("");
        break;
      }
      case "list": {
        const t = token as Tokens.List;
        parts.push(renderList(t));
        parts.push("");
        break;
      }
      case "table": {
        const t = token as Tokens.Table;
        parts.push(renderTableToken(t));
        break;
      }
      case "hr":
        parts.push(muted("\u2500".repeat(40)));
        parts.push("");
        break;
      case "space":
        // Intentional blank line — skip
        break;
      default: {
        // Unknown block type — emit raw text as fallback
        const raw = (token as { raw?: string }).raw;
        if (raw) {
          parts.push(raw);
        }
      }
    }
  }

  return parts.join("\n");
}

/**
 * Render a list token (ordered or unordered) with proper indentation.
 */
function renderList(list: Tokens.List, depth = 0): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i];
    if (!item) {
      continue;
    }
    const start = Number(list.start ?? 1);
    const bullet = list.ordered ? `${start + i}.` : "•";
    const body = item.tokens
      .map((t) => {
        if (t.type === "list") {
          return renderList(t as Tokens.List, depth + 1);
        }
        if (t.type === "text" && "tokens" in t && (t as Tokens.Text).tokens) {
          return renderInline((t as Tokens.Text).tokens ?? []);
        }
        if ("tokens" in t && (t as Tokens.Generic).tokens) {
          return renderInline(((t as Tokens.Generic).tokens as Token[]) ?? []);
        }
        return (t as { raw?: string }).raw ?? "";
      })
      .join("\n");

    lines.push(`${indent}${bullet} ${body}`);
  }

  return lines.join("\n");
}

/**
 * Render a markdown table token using the text-table renderer.
 *
 * Converts marked's `Tokens.Table` into headers + rows + alignments and
 * delegates to `renderTextTable()` for column fitting and box drawing.
 */
function renderTableToken(table: Tokens.Table): string {
  const headers = table.header.map((cell) => renderInline(cell.tokens));
  const rows = table.rows.map((row) =>
    row.map((cell) => renderInline(cell.tokens))
  );

  const alignments: Alignment[] = table.align.map((a) => {
    if (a === "right") {
      return "right";
    }
    if (a === "center") {
      return "center";
    }
    return "left";
  });

  return renderTextTable(headers, rows, { alignments });
}

// ──────────────────────── Public API ─────────────────────────────────

/**
 * Render a full markdown document as styled terminal output.
 *
 * In TTY mode: uses `marked.lexer()` to tokenize and a custom block/inline
 * renderer for ANSI output. Tables are rendered with Unicode box-drawing
 * borders via the text-table module.
 *
 * In plain mode: parses and renders the same way (preserving structural
 * formatting — headings, aligned tables, blockquote indentation, lists),
 * then strips ANSI codes. This produces human-readable output rather than
 * raw CommonMark source.
 *
 * @param md - Markdown source text
 * @returns Styled terminal string (TTY) or clean plain text (non-TTY / plain mode)
 */
export function renderMarkdown(md: string): string {
  if (isPlainOutput()) {
    // Parse and render to get structural formatting (headings, tables, lists),
    // then strip ANSI codes. This produces human-readable output with aligned
    // tables and proper heading emphasis, without ANSI escape sequences.
    const tokens = marked.lexer(md ?? "");
    return stripAnsi(renderBlocks(tokens)).trimEnd();
  }
  const tokens = marked.lexer(md ?? "");
  return renderBlocks(tokens).trimEnd();
}

/**
 * Render inline markdown (bold, code spans, emphasis, links) as styled
 * terminal output, or return plain text when in plain mode.
 *
 * Both modes use the same `marked.lexer()` → `renderInline()` pipeline.
 * In plain mode, ANSI codes are stripped from the result, producing
 * clean text. This avoids maintaining a separate regex-based stripping
 * function that would need to replicate the markdown parser's rules.
 *
 * @param md - Inline markdown text
 * @returns Styled string (TTY) or plain text (non-TTY / plain mode)
 */
export function renderInlineMarkdown(md: string): string {
  const tokens = marked.lexer(md ?? "");
  const rendered = renderInline(tokens.flatMap(flattenInline));
  return isPlainOutput() ? stripAnsi(rendered) : rendered;
}
