/** Tests the issue unlink command with its real destructive-command guard. */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { unlinkCommand } from "../../../src/commands/issue/unlink.js";
import { resolveOrgAndIssueId } from "../../../src/commands/issue/utils.js";
import {
  type ExternalIssueLinkResult,
  unlinkExternalIssue,
} from "../../../src/lib/issue-links.js";
import { confirmByTyping } from "../../../src/lib/mutate-command.js";

const { mockIsatty } = vi.hoisted(() => ({ mockIsatty: vi.fn(() => false) }));

vi.mock("node:tty", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tty")>();
  return {
    ...actual,
    isatty: mockIsatty,
    default: { ...actual, isatty: mockIsatty },
  };
});

vi.mock("../../../src/commands/issue/utils.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/commands/issue/utils.js")
  >()),
  resolveOrgAndIssueId: vi.fn(),
}));

vi.mock("../../../src/lib/issue-links.js", () => ({
  unlinkExternalIssue: vi.fn(),
}));

vi.mock("../../../src/lib/mutate-command.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/lib/mutate-command.js")
  >()),
  confirmByTyping: vi.fn(),
}));

const externalUrl = "https://github.com/example/app/issues/42";
const defaultFlags = {
  "dry-run": false,
  yes: false,
  force: false,
  json: false,
};
const unlinkedResult: ExternalIssueLinkResult = {
  org: "test-org",
  issueId: "123456789",
  action: "unlink",
  linked: false,
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

describe("issue unlink", () => {
  beforeEach(() => {
    mockIsatty.mockReset().mockReturnValue(false);
    vi.mocked(resolveOrgAndIssueId).mockReset();
    vi.mocked(unlinkExternalIssue).mockReset();
    vi.mocked(confirmByTyping).mockReset().mockResolvedValue(true);
    vi.mocked(resolveOrgAndIssueId).mockResolvedValue({
      org: "test-org",
      issueId: "123456789",
    });
    vi.mocked(unlinkExternalIssue).mockResolvedValue(unlinkedResult);
  });

  test.each([
    {
      selector: { integration: "99" },
      expected: { integrationId: "99", appSlug: undefined },
    },
    {
      selector: { app: "custom-tracker" },
      expected: { integrationId: undefined, appSlug: "custom-tracker" },
    },
  ])("forwards resolved issue context and selector $selector", async ({
    selector,
    expected,
  }) => {
    const { context, output } = createMockContext();
    const func = await unlinkCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, ...selector, yes: true },
      "test-org/APP-42",
      externalUrl
    );

    expect(resolveOrgAndIssueId).toHaveBeenCalledExactlyOnceWith({
      issueArg: "test-org/APP-42",
      cwd: "/tmp/example-project",
      command: "unlink",
    });
    expect(unlinkExternalIssue).toHaveBeenCalledExactlyOnceWith({
      orgSlug: "test-org",
      issueId: "123456789",
      url: externalUrl,
      ...expected,
      dryRun: false,
    });
    expect(confirmByTyping).not.toHaveBeenCalled();
    expect(output()).toContain("Unlinked");
    expect(output()).toContain("external issue was not deleted");
  });

  test("refuses non-interactive mutation without explicit confirmation before resolving", async () => {
    const { context, output } = createMockContext();
    const func = await unlinkCommand.loader();

    await expect(
      func.call(context, defaultFlags, "APP-42", externalUrl)
    ).rejects.toThrow("Use --yes or --force to confirm.");

    expect(resolveOrgAndIssueId).not.toHaveBeenCalled();
    expect(confirmByTyping).not.toHaveBeenCalled();
    expect(unlinkExternalIssue).not.toHaveBeenCalled();
    expect(output()).toBe("");
  });

  test.each([
    "yes",
    "force",
  ] as const)("allows non-interactive --%s without prompting", async (flag) => {
    const { context } = createMockContext();
    const func = await unlinkCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, [flag]: true },
      "APP-42",
      externalUrl
    );

    expect(confirmByTyping).not.toHaveBeenCalled();
    expect(unlinkExternalIssue).toHaveBeenCalledExactlyOnceWith({
      orgSlug: "test-org",
      issueId: "123456789",
      url: externalUrl,
      integrationId: undefined,
      appSlug: undefined,
      dryRun: false,
    });
  });

  test("confirms the selected issue and external URL before unlinking interactively", async () => {
    mockIsatty.mockReturnValue(true);
    const { context } = createMockContext();
    const func = await unlinkCommand.loader();
    await func.call(context, defaultFlags, "test-org/APP-42", externalUrl);

    expect(confirmByTyping).toHaveBeenCalledExactlyOnceWith(
      "test-org/APP-42",
      `Type 'test-org/APP-42' to unlink ${externalUrl}:`
    );
    expect(unlinkExternalIssue).toHaveBeenCalledOnce();
    expect(vi.mocked(confirmByTyping).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(unlinkExternalIssue).mock.invocationCallOrder[0]
    );
  });

  test("cancelling confirmation leaves the association untouched", async () => {
    mockIsatty.mockReturnValue(true);
    vi.mocked(confirmByTyping).mockResolvedValue(false);
    const { context, output } = createMockContext();
    const func = await unlinkCommand.loader();
    await func.call(context, defaultFlags, "APP-42", externalUrl);

    expect(confirmByTyping).toHaveBeenCalledOnce();
    expect(unlinkExternalIssue).not.toHaveBeenCalled();
    expect(output()).toContain("Cancelled.");
  });

  test("permits --dry-run without a TTY and preserves current link state in JSON", async () => {
    const result = {
      ...unlinkedResult,
      linked: true,
      changed: false,
      dryRun: true,
    };
    vi.mocked(unlinkExternalIssue).mockResolvedValue(result);
    const { context, output } = createMockContext();
    const func = await unlinkCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, "dry-run": true, json: true },
      "APP-42",
      externalUrl
    );

    expect(confirmByTyping).not.toHaveBeenCalled();
    expect(unlinkExternalIssue).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
    expect(JSON.parse(output())).toEqual(result);
  });
});
