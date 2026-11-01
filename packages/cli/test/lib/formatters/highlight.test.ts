/**
 * Tests for the lazy, build-time-removable syntax highlighting boundary.
 */

import { createRequire } from "node:module";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { COLORS } from "../../../src/lib/formatters/colors.js";
import { highlightCode } from "../../../src/lib/formatters/highlight.js";

const require = createRequire(import.meta.url);
const cliHighlightPath = require.resolve("cli-highlight");
const { highlight } = require(
  cliHighlightPath,
) as typeof import("cli-highlight");
/** cli-highlight colors through its own chalk instance. */
const cliHighlightChalk = createRequire(cliHighlightPath)("chalk") as {
  level: number;
};

const CODE = "def greet(name):\n    return f'hello {name}'";

let savedLevels: [typeof chalk.level, number];

beforeEach(() => {
  savedLevels = [chalk.level, cliHighlightChalk.level];
  chalk.level = 3;
  cliHighlightChalk.level = 3;
});

afterEach(() => {
  [chalk.level, cliHighlightChalk.level] = savedLevels;
  vi.unstubAllGlobals();
});

describe("highlightCode", () => {
  test("matches cli-highlight output when highlighting is available", () => {
    const expected = highlight(CODE, {
      language: "python",
      ignoreIllegals: true,
    });
    expect(expected).not.toBe(CODE);
    expect(highlightCode(CODE, "python")).toBe(expected);
  });

  test("renders the fallback color when highlighting is compiled out", () => {
    vi.stubGlobal("__SENTRY_CLI_SYNTAX_HIGHLIGHT__", false);
    const expected = chalk.hex(COLORS.yellow)(CODE);
    expect(expected).not.toBe(CODE);
    expect(highlightCode(CODE, "python")).toBe(expected);
  });
});
