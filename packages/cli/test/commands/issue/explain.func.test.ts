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
    ])
  );
});

import { explainCommand } from "../../../src/commands/issue/explain.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as issueUtils from "../../../src/commands/issue/utils.js";
import { ContextError } from "../../../src/lib/errors.js";
import type { AutofixState, RootCause } from "../../../src/types/seer.js";

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
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
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
    const func = await explainCommand.loader();
    await func.call(context, EXPLAIN_FLAGS, "IOS-1");

    expect(JSON.parse(stdoutWrite.mock.calls[0]?.[0] ?? "")).toEqual([
      expect.objectContaining({ description: "Single cause" }),
    ]);
  });

  test("returns labeled JSON results for multiple issues", async () => {
    resolveSpy.mockImplementation(async (options: { issueArg: string }) => ({
      org: "test-org",
      issueId: options.issueArg === "IOS-1" ? "1" : "2",
    }));
    analyzeSpy.mockImplementation(async (options: { issueId: string }) =>
      sampleState(sampleCause(`Cause ${options.issueId}`))
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await explainCommand.loader();
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
    resolveSpy.mockImplementation(async (options: { issueArg: string }) => ({
      org: "test-org",
      issueId: options.issueArg,
    }));
    analyzeSpy.mockResolvedValue(sampleState(sampleCause("Cause")));

    const func = await explainCommand.loader();
    await func.call(
      createMockContext().context,
      { json: false, force: false, fresh: false },
      "IOS-1",
      "IOS-2"
    );

    expect(analyzeSpy).toHaveBeenCalledTimes(2);
    for (const [options] of analyzeSpy.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ json: true }));
    }
  });

  test("keeps batch JSON shape after a partial failure", async () => {
    resolveSpy.mockImplementation(async (options: { issueArg: string }) => {
      if (options.issueArg === "MISSING") {
        throw new Error("not found");
      }
      return { org: "test-org", issueId: "1" };
    });
    analyzeSpy.mockResolvedValue(sampleState(sampleCause("Cause")));

    const { context, stdoutWrite } = createMockContext();
    const func = await explainCommand.loader();
    await func.call(context, EXPLAIN_FLAGS, "IOS-1", "MISSING");

    const output = JSON.parse(stdoutWrite.mock.calls[0]?.[0] ?? "");
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(expect.objectContaining({ issue: "IOS-1" }));
  });

  test("rethrows the primary error when every issue fails", async () => {
    const error = new Error("analysis failed");
    resolveSpy.mockRejectedValue(error);

    const func = await explainCommand.loader();
    await expect(
      func.call(createMockContext().context, EXPLAIN_FLAGS, "IOS-1", "IOS-2")
    ).rejects.toBe(error);
  });

  test("throws ContextError when no issue ID is provided", async () => {
    const func = await explainCommand.loader();
    await expect(
      func.call(createMockContext().context, EXPLAIN_FLAGS)
    ).rejects.toThrow(ContextError);
  });
});
