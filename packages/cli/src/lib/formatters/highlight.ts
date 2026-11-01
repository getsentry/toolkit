/**
 * Syntax highlighting for fenced code blocks in rendered markdown.
 *
 * This is the only module that loads `cli-highlight`, which brings all of
 * highlight.js and parse5 (~1.2 MB of the npm bundle, and ~50 ms of startup
 * when imported eagerly). Every command reaches this module through
 * `buildCommand` and the formatters, so the cost is kept off that path in two
 * ways:
 *
 * - `cli-highlight` is required on the first code block, not at import. The
 *   CLI bundle still contains it (script/bundle.ts and script/build.ts list
 *   this file in `REQUIRE_ALIAS_FILTER`), but only runs it when needed.
 * - A bundle that doesn't need colored code blocks, such as the MCP server,
 *   sets `define: { __SENTRY_CLI_SYNTAX_HIGHLIGHT__: "false" }`. esbuild then
 *   drops the `require()` with its dead branch, so highlight.js and parse5
 *   never enter the bundle. Code blocks render in the fallback color.
 */

import { createRequire } from "node:module";
import chalk from "chalk";
import { COLORS } from "./colors.js";

/** Build-time switch; undefined (enabled) outside bundles that define it. */
declare const __SENTRY_CLI_SYNTAX_HIGHLIGHT__: boolean | undefined;

const _require = createRequire(import.meta.url);

type CliHighlight = typeof import("cli-highlight");

let cliHighlight: CliHighlight["highlight"] | undefined;

/**
 * Syntax-highlight a code block. Falls back to uniform yellow if the
 * language is unknown, highlighting fails, or highlighting is compiled out.
 */
export function highlightCode(code: string, language?: string): string {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    if (
      typeof __SENTRY_CLI_SYNTAX_HIGHLIGHT__ === "undefined" ||
      __SENTRY_CLI_SYNTAX_HIGHLIGHT__
    ) {
      cliHighlight ??= (_require("cli-highlight") as CliHighlight).highlight;
      return cliHighlight(code, { language, ignoreIllegals: true });
    }
  } catch {
    // Fall through to the uniform color below.
  }
  return chalk.hex(COLORS.yellow)(code);
}
