/**
 * Tests for the issue-argument grammar (grammar/issue-argument.pegjs),
 * through src/lib/issue-arguments.ts.
 *
 * `parseIssueArg` keeps its own, older suite in arg-parsing.test.ts; these
 * cover what the parser returns besides the parsed form, and that it has no
 * side effects.
 */

import { describe, expect, test } from "vitest";
import { ValidationError } from "../../src/lib/errors.js";
import { parseIssueArgument } from "../../src/lib/issue-arguments.js";
import { useEnvSandbox } from "../helpers.js";

describe("parseIssueArgument", () => {
  useEnvSandbox(["SENTRY_HOST", "SENTRY_URL"]);

  test.each([
    ["123456789", { type: "numeric", id: "123456789" }],
    ["@latest", { type: "selector", selector: "@latest" }],
    [
      "acme/@mostFrequent",
      { type: "selector", selector: "@most_frequent", org: "acme" },
    ],
    ["cli-g", { type: "project-search", projectSlug: "cli", suffix: "G" }],
    [
      "/spotlight-electron-4y",
      {
        type: "project-search",
        projectSlug: "spotlight-electron",
        suffix: "4Y",
      },
    ],
    ["g", { type: "suffix-only", suffix: "G" }],
    ["CLI:CLI-G", { type: "project-search", projectSlug: "cli", suffix: "G" }],
    ["CLI:123", { type: "numeric", id: "123" }],
    ["#CLI-G", { type: "project-search", projectSlug: "cli", suffix: "G" }],
    ["cli#G", { type: "project-search", projectSlug: "cli", suffix: "G" }],
    [
      "acme/cli#CLI-G",
      { type: "explicit", org: "acme", project: "cli", suffix: "G" },
    ],
    [
      "acme/123",
      { type: "explicit-org-numeric", org: "acme", numericId: "123" },
    ],
    [
      "acme/cli/123",
      { type: "explicit-org-numeric", org: "acme", numericId: "123" },
    ],
    [
      "acme/CLI-G",
      { type: "explicit", org: "acme", project: "cli", suffix: "G" },
    ],
    ["acme/g", { type: "explicit-org-suffix", org: "acme", suffix: "G" }],
    [
      "acme/cli/CLI-G",
      { type: "explicit", org: "acme", project: "cli", suffix: "G" },
    ],
    [
      "acme/cli/SUB-G",
      { type: "explicit", org: "acme", project: "cli", suffix: "SUB-G" },
    ],
  ])("%j", (arg, parsed) => {
    expect(parseIssueArgument(arg)).toEqual({ text: arg, parsed });
  });

  test("keeps the argument as typed and parses its first line", () => {
    expect(parseIssueArgument("\n  CLI-G  \nCLI-H\n")).toEqual({
      text: "\n  CLI-G  \nCLI-H\n",
      parsed: { type: "project-search", projectSlug: "cli", suffix: "G" },
    });
  });

  test.each([
    ["acme/", "Missing issue ID after slash."],
    ["acme/cli/", "Missing project or issue ID segment."],
    ["acme//G", "Missing project or issue ID segment."],
    ["acme/-G", "Cannot use trailing slash before suffix."],
    ["acme/cli-", "Missing suffix after dash."],
    ["-G", "Missing project before suffix."],
    ["cli-", "Missing suffix after dash."],
  ])("rejects %j: %s", (arg, message) => {
    expect(() => parseIssueArgument(arg)).toThrow(
      new ValidationError(
        `Invalid issue format: "${arg}". ${message}`,
        "issue",
      ),
    );
  });

  test.each([
    "cli#",
    "cli#A#B",
    "cli#CLI:G",
    "CLI-G?x",
    "issue-1",
    "acme/issues-12",
    "   ",
  ])("rejects %j", (arg) => {
    expect(() => parseIssueArgument(arg)).toThrow(ValidationError);
  });

  test("returns a pasted URL's server without applying it", () => {
    const arg = "https://sentry.example.com/organizations/acme/issues/123/";
    expect(parseIssueArgument(arg)).toEqual({
      text: arg,
      parsed: { type: "explicit-org-numeric", org: "acme", numericId: "123" },
      baseUrl: "https://sentry.example.com",
    });
    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("reads short IDs from issue URLs", () => {
    expect(
      parseIssueArgument("https://acme.sentry.io/issues/CLI-G/").parsed,
    ).toEqual({ type: "explicit", org: "acme", project: "cli", suffix: "G" });
  });

  test("rejects a Sentry URL without an issue", () => {
    expect(() =>
      parseIssueArgument(
        "https://sentry.io/organizations/acme/explore/traces/trace/aaaa1111bbbb2222cccc3333dddd4444/",
      ),
    ).toThrow(/does not contain an issue ID/);
  });
});
