/**
 * Tests for single- and multi-issue Seer root-cause analysis.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/commands/issue/utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/commands/issue/utils.js")
    >();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ]),
  );
});

import { explainCommand } from "../../../src/commands/issue/explain.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as issueUtils from "../../../src/commands/issue/utils.js";
import { ApiError, ContextError, EXIT } from "../../../src/lib/errors.js";
import type { IssueArgument } from "../../../src/lib/issue-arguments.js";
import type { AutofixState, RootCause } from "../../../src/types/seer.js";
import { loadCommand } from "../../helpers.js";
import type { Writer } from "../../../src/types/index.js";

const EXPLAIN_FLAGS = {
  json: true,
  force: false,
  fresh: false,
} as const;

function sampleCause(description: string): RootCause {
  return { id: 0, description };
}

function sampleState(cause: RootCause): AutofixState {
  return {
    status: "COMPLETED",
    steps: [
      {
        id: "root-cause",
        key: "root_cause_analysis",
        status: "COMPLETED",
        title: "Root cause",
        causes: [cause],
      },
    ],
  };
}

function createMockContext() {
  const stdoutWrite = vi.fn((_chunk: string) => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn<Writer["write"]>(() => true) },
      cwd: "/tmp",
    },
    stdoutWrite,
  };
}

describe("issue explain multiple IDs", () => {
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let analyzeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSpy = vi.spyOn(issueUtils, "resolveOrgAndIssueId");
    analyzeSpy = vi.spyOn(issueUtils, "ensureRootCauseAnalysis");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("preserves the JSON root-cause array for one issue", async () => {
    resolveSpy.mockResolvedValue({ org: "test-org", issueId: "1" });
    analyzeSpy.mockResolvedValue(sampleState(sampleCause("Single cause")));

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(explainCommand);
    await func.call(context, EXPLAIN_FLAGS, "IOS-1");

    expect(JSON.parse(stdoutWrite.mock.calls[0]?.[0] ?? "")).toEqual([
      expect.objectContaining({ description: "Single cause" }),
    ]);
  });

  test("returns labeled JSON results for multiple issues", async () => {
    resolveSpy.mockImplementation(
      async (options: { issueArg: IssueArgument }) => ({
        org: "test-org",
        issueId: options.issueArg.text === "IOS-1" ? "1" : "2",
      }),
    );
    analyzeSpy.mockImplementation(async (options: { issueId: string }) =>
      sampleState(sampleCause(`Cause ${options.issueId}`)),
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(explainCommand);
    await func.call(context, EXPLAIN_FLAGS, "IOS-1", "IOS-2");

    expect(JSON.parse(stdoutWrite.mock.calls[0]?.[0] ?? "")).toEqual([
      {
        issue: "IOS-1",
        org: "test-org",
        issueId: "1",
        rootCauses: [expect.objectContaining({ description: "Cause 1" })],
      },
      {
        issue: "IOS-2",
        org: "test-org",
        issueId: "2",
        rootCauses: [expect.objectContaining({ description: "Cause 2" })],
      },
    ]);
  });

  test("suppresses per-issue progress for human batch output", async () => {
    resolveSpy.mockImplementation(
      async (options: { issueArg: IssueArgument }) => ({
        org: "test-org",
        issueId: options.issueArg.text,
      }),
    );
    analyzeSpy.mockResolvedValue(sampleState(sampleCause("Cause")));

    const func = await loadCommand(explainCommand);
    await func.call(
      createMockContext().context,
      { json: false, force: false, fresh: false },
      "IOS-1",
      "IOS-2",
    );

    expect(analyzeSpy).toHaveBeenCalledTimes(2);
    for (const [options] of analyzeSpy.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ json: true }));
    }
  });

  test("keeps batch JSON shape after a partial failure", async () => {
    resolveSpy.mockImplementation(
      async (options: { issueArg: IssueArgument }) => {
        if (options.issueArg.text === "MISSING") {
          throw new Error("not found");
        }
        return { org: "test-org", issueId: "1" };
      },
    );
    analyzeSpy.mockResolvedValue(sampleState(sampleCause("Cause")));

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(explainCommand);
    await func.call(context, EXPLAIN_FLAGS, "IOS-1", "MISSING");

    const output = JSON.parse(stdoutWrite.mock.calls[0]?.[0] ?? "");
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(expect.objectContaining({ issue: "IOS-1" }));
  });

  test("rethrows the primary error when every issue fails", async () => {
    const error = new Error("analysis failed");
    resolveSpy.mockRejectedValue(error);

    const func = await loadCommand(explainCommand);
    await expect(
      func.call(createMockContext().context, EXPLAIN_FLAGS, "IOS-1", "IOS-2"),
    ).rejects.toBe(error);
  });

  test("throws out_of_credits when Sentry refuses the analysis with a 402", async () => {
    resolveSpy.mockResolvedValue({ org: "test-org", issueId: "1" });
    analyzeSpy.mockRejectedValue(
      new ApiError(
        "Failed to start root cause analysis: 402 Payment Required",
        402,
        "Your organization does not have enough credits to start an Autofix run.",
        undefined,
        { code: "seer_out_of_credits" },
      ),
    );

    const func = await loadCommand(explainCommand);
    await expect(
      func.call(createMockContext().context, EXPLAIN_FLAGS, "IOS-1"),
    ).rejects.toMatchObject({ reason: "out_of_credits", orgSlug: "test-org" });
  });

  test("throws repos_not_linked when Sentry refuses the analysis with a 409", async () => {
    resolveSpy.mockResolvedValue({ org: "test-org", issueId: "1" });
    analyzeSpy.mockRejectedValue(
      new ApiError(
        "Failed to start root cause analysis: 409 Conflict",
        409,
        "Seer Autofix requires repositories to be connected to this project before a new run can be started.",
        undefined,
        { code: "repos_not_linked" },
      ),
    );

    const func = await loadCommand(explainCommand);
    await expect(
      func.call(createMockContext().context, EXPLAIN_FLAGS, "IOS-1"),
    ).rejects.toMatchObject({
      reason: "repos_not_linked",
      orgSlug: "test-org",
      exitCode: EXIT.SEER_SETUP_REQUIRED,
    });
  });

  test("fails to parse when no issue ID is provided", async () => {
    const func = await loadCommand(explainCommand);
    await expect(
      func.call(createMockContext().context, EXPLAIN_FLAGS),
    ).rejects.toMatchObject({ exception: expect.any(ContextError) });
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
