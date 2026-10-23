import { describe, expect, test } from "vitest";
import {
  findFragmentCommandIssues,
  stripAllowCommandMarkers,
} from "../../script/fragment-commands.js";

function lines(...parts: string[]): string {
  return parts.join("\n");
}

function block(lang: string, code: string): string {
  return lines(`\`\`\`${lang}`, code, "```");
}

describe("findFragmentCommandIssues", () => {
  test.each([
    "sentry issue list",
    "$ sentry org list",
    "SENTRY_HOST=x sentry auth status",
    "npm run build && sentry sourcemap upload ./dist",
    "cat file | sentry api /foo/",
    "sentry",
  ])("flags `%s`", (command) => {
    expect(findFragmentCommandIssues(block("bash", command))).toHaveLength(1);
  });

  test.each([
    ["bash", "# sentry local --open"],
    ["bash", "sentry-cli releases new 1.0"],
    ["bash", "curl https://sentry.io/api/0/"],
    ["bash", "npx @sentry/wizard"],
    ["ts", "sentry issue list"],
    ["json", "sentry issue list"],
  ])("ignores %s block `%s`", (lang, code) => {
    expect(findFragmentCommandIssues(block(lang, code))).toEqual([]);
  });

  test("flags commented examples under a non-Examples heading", () => {
    const md = lines(
      "## Using Attribute Keys",
      "",
      "Attribute keys work with other commands:",
      "",
      "```bash",
      "# Add the attribute as a column",
      "sentry span list my-org/my-project --fields gen_ai.request.model",
      "```",
    );
    const issues = findFragmentCommandIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(5);
    expect(issues[0]?.message).toContain("docs.examples");
  });

  test("flags unlabeled and nested blocks", () => {
    const md = lines(
      "```",
      "$ sentry org list",
      "```",
      "",
      "- Step one:",
      "",
      "  ```bash",
      "  sentry release finalize 1.0",
      "  ```",
    );
    expect(findFragmentCommandIssues(md)).toHaveLength(2);
  });

  test("accepts a marked block", () => {
    const md = lines(
      "Text.",
      "",
      "<!-- allow-commands: multi-step release workflow -->",
      "```bash",
      "sentry release create my-org/1.0.0",
      "sentry release finalize my-org/1.0.0",
      "```",
    );
    expect(findFragmentCommandIssues(md)).toEqual([]);
  });

  test("accepts a marker separated by a blank line", () => {
    const md = lines(
      "<!-- allow-commands: sample output -->",
      "",
      "```",
      "$ sentry org list",
      "```",
    );
    expect(findFragmentCommandIssues(md)).toEqual([]);
  });

  test("requires a reason on the marker", () => {
    const md = lines(
      "<!-- allow-commands: -->",
      "```bash",
      "sentry release create my-org/1.0.0",
      "```",
    );
    const issues = findFragmentCommandIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("needs a reason");
  });

  test("rejects markers that don't cover a command block", () => {
    const md = lines(
      "<!-- allow-commands: stale -->",
      "```bash",
      "npm run build",
      "```",
      "",
      "<!-- allow-commands: misplaced -->",
      "",
      "Some prose.",
      "",
      "<!-- allow-commands: trailing -->",
    );
    const messages = findFragmentCommandIssues(md).map((i) => i.message);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain("without sentry commands");
    expect(messages[1]).toContain("directly above a code block");
    expect(messages[2]).toContain("directly above a code block");
  });

  test("ignores other HTML comments and inline code", () => {
    const md = lines(
      "<!-- some other note -->",
      "Run `sentry issue list` to see issues.",
      "",
      "```ts",
      "// sentry local run",
      "```",
    );
    expect(findFragmentCommandIssues(md)).toEqual([]);
  });
});

describe("stripAllowCommandMarkers", () => {
  test("removes marker lines and keeps other comments", () => {
    const md = lines(
      "<!-- keep me -->",
      "<!-- allow-commands: workflow -->",
      "```bash",
      "sentry release finalize 1.0",
      "```",
    );
    expect(stripAllowCommandMarkers(md)).toBe(
      lines(
        "<!-- keep me -->",
        "```bash",
        "sentry release finalize 1.0",
        "```",
      ),
    );
  });
});
