/** Tests the issue link command, including its shared output wrapper. */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { linkCommand } from "../../../src/commands/issue/link.js";
import { resolveOrgAndIssueId } from "../../../src/commands/issue/utils.js";
import { ValidationError } from "../../../src/lib/errors.js";
import {
  type ExternalIssueLinkResult,
  linkExternalIssue,
} from "../../../src/lib/issue-links.js";

vi.mock("../../../src/commands/issue/utils.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/commands/issue/utils.js")
  >()),
  resolveOrgAndIssueId: vi.fn(),
}));

vi.mock("../../../src/lib/issue-links.js", () => ({
  linkExternalIssue: vi.fn(),
}));

const externalUrl = "https://github.com/example/app/issues/42";
const defaultFlags = {
  "dry-run": false,
  json: false,
};
const linkedResult: ExternalIssueLinkResult = {
  org: "test-org",
  issueId: "123456789",
  action: "link",
  linked: true,
  changed: true,
  externalIssue: {
    id: "789",
    identifier: "example/app#42",
    url: externalUrl,
    provider: "github",
  },
};

function createMockContext() {
  const stdoutWrite = vi.fn((_chunk: string) => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn((_chunk: string) => true) },
      cwd: "/tmp/example-project",
    },
    output: () => stdoutWrite.mock.calls.map(([chunk]) => chunk).join(""),
  };
}

describe("issue link", () => {
  beforeEach(() => {
    vi.mocked(resolveOrgAndIssueId).mockReset();
    vi.mocked(linkExternalIssue).mockReset();
    vi.mocked(resolveOrgAndIssueId).mockResolvedValue({
      org: "test-org",
      issueId: "123456789",
      projectId: "456",
    });
    vi.mocked(linkExternalIssue).mockResolvedValue(linkedResult);
  });

  test("forwards resolved organization, issue and project with the integration selector", async () => {
    const { context, output } = createMockContext();
    const func = await linkCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, integration: "99" },
      "test-org/APP-42",
      externalUrl,
    );

    expect(resolveOrgAndIssueId).toHaveBeenCalledExactlyOnceWith({
      issueArg: "test-org/APP-42",
      cwd: "/tmp/example-project",
      command: "link",
    });
    expect(linkExternalIssue).toHaveBeenCalledExactlyOnceWith({
      orgSlug: "test-org",
      issueId: "123456789",
      projectId: "456",
      url: externalUrl,
      integrationId: "99",
      appSlug: undefined,
      fields: undefined,
      dryRun: false,
    });
    expect(output()).toContain("Linked");
    expect(output()).toContain(externalUrl);
    expect(output()).toContain("test-org/123456789");
  });

  test("forwards an App selector and parses repeatable fields without losing values", async () => {
    const { context } = createMockContext();
    const func = await linkCommand.loader();
    await func.call(
      context,
      {
        ...defaultFlags,
        app: "custom-tracker",
        field: ["team=team-1", "query=key=value", "optional="],
      },
      "APP-42",
      "https://tracker.example/issues/42",
    );

    expect(linkExternalIssue).toHaveBeenCalledExactlyOnceWith({
      orgSlug: "test-org",
      issueId: "123456789",
      projectId: "456",
      url: "https://tracker.example/issues/42",
      integrationId: undefined,
      appSlug: "custom-tracker",
      fields: { team: "team-1", query: "key=value", optional: "" },
      dryRun: false,
    });
  });

  test.each([
    ["team"],
    ["=team-1"],
    ["team=one", "team=two"],
    ["__proto__=value"],
    ["constructor=value"],
    ["prototype=value"],
  ])(
    "rejects malformed or ambiguous --field input %j before resolving or writing",
    async (...fields) => {
      const { context, output } = createMockContext();
      const func = await linkCommand.loader();

      await expect(
        func.call(
          context,
          { ...defaultFlags, app: "custom-tracker", field: fields },
          "APP-42",
          externalUrl,
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(resolveOrgAndIssueId).not.toHaveBeenCalled();
      expect(linkExternalIssue).not.toHaveBeenCalled();
      expect(output()).toBe("");
    },
  );

  test("renders a dry-run preview while forwarding the no-write flag", async () => {
    vi.mocked(linkExternalIssue).mockResolvedValue({
      ...linkedResult,
      linked: false,
      changed: false,
      dryRun: true,
    });
    const { context, output } = createMockContext();
    const func = await linkCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, "dry-run": true },
      "APP-42",
      externalUrl,
    );

    expect(linkExternalIssue).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(output()).toContain("Would link");
    expect(output()).toContain("dry run");
  });

  test("emits the link result unchanged in JSON", async () => {
    const { context, output } = createMockContext();
    const func = await linkCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, json: true },
      "APP-42",
      externalUrl,
    );

    expect(JSON.parse(output())).toEqual(linkedResult);
  });
});
