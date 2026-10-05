/**
 * Feedback List Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/feedback/list.js";
import { ApiError, ValidationError } from "../../../src/lib/errors.js";
import { parsePeriod } from "../../../src/lib/time-range.js";
import type { SentryFeedback } from "../../../src/types/index.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/db/pagination.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/pagination.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as paginationDb from "../../../src/lib/db/pagination.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

function sampleFeedback(
  overrides: Partial<SentryFeedback> = {}
): SentryFeedback {
  return {
    id: "5146636313",
    shortId: "TEST-PROJECT-2SDJ",
    title: "User Feedback",
    issueCategory: "feedback",
    issueType: "feedback",
    status: "unresolved",
    hasSeen: false,
    firstSeen: "2026-07-16T12:00:00Z",
    permalink:
      "https://sentry.io/organizations/test-org/feedback/?feedbackSlug=test-project%3A5146636313",
    project: { id: "42", slug: "test-project", name: "Test Project" },
    metadata: {
      message: "The checkout button does not work",
      name: "Ada",
      contact_email: "ada@example.com",
    },
    ...overrides,
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

describe("feedback list", () => {
  let listFeedbackSpy: ReturnType<typeof vi.spyOn>;
  let getProjectSpy: ReturnType<typeof vi.spyOn>;
  let resolveTargetSpy: ReturnType<typeof vi.spyOn>;
  let resolveCursorSpy: ReturnType<typeof vi.spyOn>;
  let advancePaginationStateSpy: ReturnType<typeof vi.spyOn>;
  let hasPreviousPageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listFeedbackSpy = vi.spyOn(apiClient, "listFeedback");
    getProjectSpy = vi.spyOn(apiClient, "getProject").mockResolvedValue({
      id: "42",
      slug: "test-project",
      name: "Test Project",
    });
    resolveTargetSpy = vi.spyOn(resolveTarget, "resolveOrgOptionalFromArg");
    resolveCursorSpy = vi.spyOn(paginationDb, "resolveCursor").mockReturnValue({
      cursor: undefined,
      direction: "next",
    });
    advancePaginationStateSpy = vi
      .spyOn(paginationDb, "advancePaginationState")
      .mockReturnValue(undefined);
    hasPreviousPageSpy = vi
      .spyOn(paginationDb, "hasPreviousPage")
      .mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders the standard JSON envelope for a project", async () => {
    resolveTargetSpy.mockResolvedValue({
      org: "test-org",
      project: "test-project",
      projectData: { id: "42", slug: "test-project", name: "Test Project" },
    });
    listFeedbackSpy.mockResolvedValue({
      feedback: [sampleFeedback()],
      nextCursor: "0:25:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      {
        status: "unresolved",
        limit: 25,
        period: parsePeriod("14d"),
        json: true,
        fresh: false,
      },
      "test-org/test-project"
    );

    expect(listFeedbackSpy).toHaveBeenCalledWith("test-org", "test-project", {
      limit: 25,
      status: "unresolved",
      query: undefined,
      cursor: undefined,
      projectId: 42,
      statsPeriod: "14d",
    });
    expect(getProjectSpy).not.toHaveBeenCalled();

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(JSON.parse(output)).toMatchObject({
      data: [{ shortId: "TEST-PROJECT-2SDJ" }],
      hasMore: true,
      hasPrev: false,
      nextCursor: "0:25:0",
    });
  });

  test("preserves filters, limit, and bidirectional pagination hints", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org" });
    resolveCursorSpy.mockReturnValue({ cursor: "previous", direction: "prev" });
    hasPreviousPageSpy.mockReturnValue(true);
    listFeedbackSpy.mockResolvedValue({
      feedback: [sampleFeedback({ status: "ignored", hasSeen: true })],
      nextCursor: "next",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      {
        status: "spam",
        limit: 250,
        query: "browser:Chrome",
        period: parsePeriod("30d"),
        cursor: "prev",
        json: false,
        fresh: false,
      },
      "test-org/"
    );

    expect(listFeedbackSpy).toHaveBeenCalledWith("test-org", "", {
      limit: 250,
      status: "spam",
      query: "browser:Chrome",
      cursor: "previous",
      projectId: undefined,
      statsPeriod: "30d",
    });
    expect(advancePaginationStateSpy).toHaveBeenCalledWith(
      "feedback-list",
      expect.any(String),
      "prev",
      "next"
    );
    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("Spam");
    expect(output).toContain("Read");
    expect(output).toContain(
      'sentry feedback list test-org/ -c prev --status spam --limit 250 -q "browser:Chrome" --period 30d'
    );
    expect(output).toContain(
      'sentry feedback list test-org/ -c next --status spam --limit 250 -q "browser:Chrome" --period 30d'
    );
  });

  test("supports per-item field filtering in JSON", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org" });
    listFeedbackSpy.mockResolvedValue({ feedback: [sampleFeedback()] });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, {
      status: "all",
      limit: 25,
      period: parsePeriod("14d"),
      json: true,
      fields: ["shortId"],
      fresh: false,
    });

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(JSON.parse(output).data).toEqual([{ shortId: "TEST-PROJECT-2SDJ" }]);
    expect(resolveTargetSpy).toHaveBeenCalledWith(
      undefined,
      "/tmp",
      "feedback list"
    );
  });

  test("supports bare-project search results without refetching the project", async () => {
    resolveTargetSpy.mockResolvedValue({
      org: "test-org",
      project: "test-project",
      projectData: { id: "42", slug: "test-project", name: "Test Project" },
    });
    listFeedbackSpy.mockResolvedValue({ feedback: [sampleFeedback()] });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      {
        status: "unresolved",
        limit: 25,
        period: parsePeriod("14d"),
        json: true,
        fresh: false,
      },
      "test-project"
    );

    expect(resolveTargetSpy).toHaveBeenCalledWith(
      "test-project",
      "/tmp",
      "feedback list"
    );
    expect(listFeedbackSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      expect.objectContaining({ projectId: 42 })
    );
    expect(getProjectSpy).not.toHaveBeenCalled();
  });

  test("renders an empty result without a navigation hint", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org" });
    listFeedbackSpy.mockResolvedValue({ feedback: [] });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, {
      status: "unresolved",
      limit: 25,
      period: parsePeriod("14d"),
      json: false,
      fresh: false,
    });

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("No feedback found");
    expect(output).not.toContain("Next:");
  });

  test("converts user query 400 responses to ValidationError", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org" });
    listFeedbackSpy.mockRejectedValue(
      new ApiError("bad query", 400, "Error parsing search query")
    );

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await expect(
      func.call(context, {
        status: "unresolved",
        limit: 25,
        query: "bad:::query",
        period: parsePeriod("14d"),
        json: true,
        fresh: false,
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
