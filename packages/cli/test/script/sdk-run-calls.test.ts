import { describe, expect, test } from "vitest";
import {
  jsdocExamples,
  markdownTsBlocks,
  sdkRunCalls,
} from "../../script/sdk-run-calls.js";

describe("sdkRunCalls", () => {
  test("collects literal argv across lines, comments, and templates", () => {
    const code = [
      'await sdk.run("--version");',
      "await sdk.run(",
      '  "issue", // the group',
      "  `list`,",
      '  "-n", "5",',
      ");",
      'const nested = format(await sdk.run("help", "issue"));',
    ].join("\n");
    expect(sdkRunCalls(code)).toEqual([
      ["--version"],
      ["issue", "list", "-n", "5"],
      ["help", "issue"],
    ]);
  });

  test("skips calls whose argv isn't static", () => {
    const code = [
      "await sdk.run(...args);",
      'await sdk.run("issue", name);',
      'await sdk.run("issue", `${group}`);',
      'await other.run("issue", "list");',
    ].join("\n");
    expect(sdkRunCalls(code)).toEqual([]);
  });

  test("handles parentheses inside string arguments", () => {
    expect(sdkRunCalls('sdk.run("issue", "list", "--query", "a:(b)")')).toEqual(
      [["issue", "list", "--query", "a:(b)"]],
    );
  });
});

describe("jsdocExamples", () => {
  test("returns fenced code from every @example tag", () => {
    const source = [
      "/**",
      " * Module docs.",
      " *",
      " * @example",
      " * ```typescript",
      ' * await sdk.run("--version");',
      " * ```",
      " */",
      "",
      "/**",
      " * @example",
      ' * await sdk.run("help");',
      " */",
      "export function f() {}",
    ].join("\n");
    expect(
      jsdocExamples("index.ts", source).flatMap((code) => sdkRunCalls(code)),
    ).toEqual([["--version"], ["help"]]);
  });
});

describe("markdownTsBlocks", () => {
  test("returns only TypeScript and JavaScript fences", () => {
    const md = [
      "```bash",
      "sentry issue list",
      "```",
      "",
      "```ts",
      'sdk.run("issue", "list");',
      "```",
    ].join("\n");
    expect(markdownTsBlocks(md)).toEqual(['sdk.run("issue", "list");']);
  });
});
