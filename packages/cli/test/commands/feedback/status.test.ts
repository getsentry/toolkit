/** Tests the Feedback category boundary and status mutation output contract. */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveCommand } from "../../../src/commands/feedback/resolve.js";
import { spamCommand } from "../../../src/commands/feedback/spam.js";
import { unresolveCommand } from "../../../src/commands/feedback/unresolve.js";
import { ApiError } from "../../../src/lib/errors.js";
import { resetCacheState } from "../../../src/lib/response-cache.js";
import type { SentryFeedback } from "../../../src/types/index.js";

vi.mock("../../../src/commands/issue/utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/commands/issue/utils.js")
    >();
  return { ...actual, resolveIssue: vi.fn() };
});

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return { ...actual, updateIssueStatus: vi.fn() };
});

import { resolveIssue } from "../../../src/commands/issue/utils.js";
import { updateIssueStatus } from "../../../src/lib/api-client.js";

function feedback(): SentryFeedback {
  return {
    id: "123",
    shortId: "TEST-PROJECT-1A",
    title: "User Feedback",
    issueCategory: "feedback",
    issueType: "feedback",
    status: "unresolved",
    metadata: { message: "Checkout is broken" },
  };
}

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    output: () => stdoutWrite.mock.calls.map((call) => call[0]).join(""),
  };
}

afterEach(() => {
  vi.resetAllMocks();
  resetCacheState();
});

describe.each([
  {
    name: "resolve",
    command: resolveCommand,
    status: "resolved",
    previousStatus: "unresolved",
  },
  {
    name: "unresolve",
    command: unresolveCommand,
    status: "unresolved",
    previousStatus: "resolved",
  },
  {
    name: "spam",
    command: spamCommand,
    status: "ignored",
    previousStatus: "unresolved",
  },
] as const)("feedback $name", ({ name, command, status, previousStatus }) => {
  beforeEach(() => {
    vi.mocked(resolveIssue).mockResolvedValue({
      org: "test-org",
      issue: { ...feedback(), status: previousStatus },
    });
    vi.mocked(updateIssueStatus).mockResolvedValue({
      ...feedback(),
      status,
      metadata: { message: "Updated by the server" },
    });
  });

  test("updates the checked Feedback and emits the server response as JSON", async () => {
    const { context, output } = createMockContext();
    const func = await command.loader();
    await func.call(context, { json: true }, "TEST-PROJECT-1A");

    expect(resolveIssue).toHaveBeenCalledWith({
      issueArg: "TEST-PROJECT-1A",
      cwd: "/tmp",
      command: name,
      commandBase: "sentry feedback",
    });
    expect(updateIssueStatus).toHaveBeenCalledExactlyOnceWith("123", status, {
      orgSlug: "test-org",
    });
    expect(JSON.parse(output())).toEqual({
      ...feedback(),
      status,
      metadata: { message: "Updated by the server" },
    });
  });

  test("rejects an ordinary issue before any status mutation", async () => {
    vi.mocked(resolveIssue).mockResolvedValue({
      org: "test-org",
      issue: { ...feedback(), issueCategory: "error", issueType: "error" },
    });
    const { context, output } = createMockContext();
    const func = await command.loader();

    await expect(
      func.call(context, { json: false }, "TEST-PROJECT-1A")
    ).rejects.toMatchObject({
      name: "ResolutionError",
      hint: "sentry issue view test-org/TEST-PROJECT-1A",
    });
    expect(updateIssueStatus).not.toHaveBeenCalled();
    expect(output()).toBe("");
  });

  test("does not report success when the update fails", async () => {
    const error = new ApiError("Permission denied", 403);
    vi.mocked(updateIssueStatus).mockRejectedValue(error);
    const { context, output } = createMockContext();
    const func = await command.loader();

    await expect(
      func.call(context, { json: false }, "TEST-PROJECT-1A")
    ).rejects.toBe(error);
    expect(output()).toBe("");
  });
});

test("feedback unresolve restores Feedback marked as spam", async () => {
  vi.mocked(resolveIssue).mockResolvedValue({
    org: "test-org",
    issue: { ...feedback(), status: "ignored" },
  });
  vi.mocked(updateIssueStatus).mockResolvedValue(feedback());
  const { context, output } = createMockContext();
  const func = await unresolveCommand.loader();

  await func.call(context, { json: true }, "TEST-PROJECT-1A");

  expect(updateIssueStatus).toHaveBeenCalledExactlyOnceWith(
    "123",
    "unresolved",
    { orgSlug: "test-org" }
  );
  expect(JSON.parse(output())).toEqual(feedback());
});
