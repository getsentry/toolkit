/**
 * Dashboard Revisions Command Tests
 *
 * Tests for the dashboard revisions command in src/commands/dashboard/revisions.ts.
 * Uses spyOn pattern to mock API client, pagination DB, resolve, and polling modules.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolve from "../../../src/commands/dashboard/resolve.js";
import { revisionsCommand } from "../../../src/commands/dashboard/revisions.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as paginationDb from "../../../src/lib/db/pagination.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as polling from "../../../src/lib/polling.js";
import type { DashboardRevision } from "../../../src/types/dashboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(cwd = "/tmp") {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd,
    },
    stdoutWrite,
    stderrWrite,
  };
}

type RevisionsFlags = {
  readonly limit: number;
  readonly cursor?: string;
  readonly json?: boolean;
  readonly fields?: string[];
};

function defaultFlags(overrides: Partial<RevisionsFlags> = {}): RevisionsFlags {
  return {
    json: false,
    limit: 25,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const REVISION_A: DashboardRevision = {
  id: "1",
  title: "My Dashboard",
  dateCreated: "2026-01-15T10:00:00Z",
  createdBy: {
    id: "u1",
    name: "Alice",
    email: "alice@example.com",
    avatarType: "letter_avatar",
    avatarUrl: null,
  },
  source: "ui",
};

const REVISION_B: DashboardRevision = {
  id: "2",
  title: "My Dashboard (updated)",
  dateCreated: "2026-02-20T12:00:00Z",
  createdBy: {
    id: "u2",
    name: "Bob",
    email: "bob@example.com",
    avatarType: "letter_avatar",
    avatarUrl: null,
  },
  source: "ui",
};

const REVISION_C: DashboardRevision = {
  id: "3",
  title: "My Dashboard (v3)",
  dateCreated: "2026-03-01T08:00:00Z",
  createdBy: null,
  source: "api",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboard revisions command", () => {
  let listDashboardRevisionsPaginatedSpy: ReturnType<typeof spyOn>;
  let resolveOrgFromTargetSpy: ReturnType<typeof spyOn>;
  let resolveDashboardIdSpy: ReturnType<typeof spyOn>;
  let withProgressSpy: ReturnType<typeof spyOn>;
  let advancePaginationStateSpy: ReturnType<typeof spyOn>;
  let hasPreviousPageSpy: ReturnType<typeof spyOn>;
  let resolveCursorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listDashboardRevisionsPaginatedSpy = vi.spyOn(
      apiClient,
      "listDashboardRevisionsPaginated"
    );
    resolveOrgFromTargetSpy = vi.spyOn(resolve, "resolveOrgFromTarget");
    resolveDashboardIdSpy = vi.spyOn(resolve, "resolveDashboardId");
    // Bypass spinner — just run the callback directly
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation((_opts, fn) =>
        fn(() => {
          /* no-op setMessage */
        })
      );
    advancePaginationStateSpy = vi
      .spyOn(paginationDb, "advancePaginationState")
      .mockReturnValue(undefined);
    hasPreviousPageSpy = vi
      .spyOn(paginationDb, "hasPreviousPage")
      .mockReturnValue(false);
    resolveCursorSpy = vi.spyOn(paginationDb, "resolveCursor").mockReturnValue({
      cursor: undefined,
      direction: "next",
    });

    // Default mocks
    resolveOrgFromTargetSpy.mockResolvedValue("test-org");
    resolveDashboardIdSpy.mockResolvedValue("123");
  });

  afterEach(() => {
    listDashboardRevisionsPaginatedSpy.mockRestore();
    resolveOrgFromTargetSpy.mockRestore();
    resolveDashboardIdSpy.mockRestore();
    withProgressSpy.mockRestore();
    advancePaginationStateSpy.mockRestore();
    hasPreviousPageSpy.mockRestore();
    resolveCursorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // JSON output
  // -------------------------------------------------------------------------

  test("outputs JSON envelope with { data, hasMore, hasPrev } when --json", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [REVISION_A, REVISION_B],
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags({ json: true }), "123");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("hasMore", false);
    expect(parsed).toHaveProperty("hasPrev", false);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].id).toBe("1");
    expect(parsed.data[0].title).toBe("My Dashboard");
    expect(parsed.data[1].id).toBe("2");
  });

  test("outputs { data: [], hasMore: false } when no revisions exist", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags({ json: true }), "123");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ data: [], hasMore: false, hasPrev: false });
  });

  // -------------------------------------------------------------------------
  // Human output
  // -------------------------------------------------------------------------

  test("outputs human-readable table with column headers", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [REVISION_A, REVISION_B],
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags(), "123");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("ID");
    expect(output).toContain("TITLE");
    expect(output).toContain("AUTHOR");
    expect(output).toContain("CREATED");
  });

  test("shows empty state message when no revisions exist", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags(), "123");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No revisions found.");
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  test("hasMore is true in JSON when API returns nextCursor", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [REVISION_A, REVISION_B],
      nextCursor: "cursor-next-page",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags({ json: true, limit: 2 }), "123");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBeDefined();
  });

  test("hint includes -c next when more pages available", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [REVISION_A, REVISION_B],
      nextCursor: "cursor-next-page",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags({ limit: 2 }), "123");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("-c next");
  });

  test("hint includes -c prev when previous pages available", async () => {
    hasPreviousPageSpy.mockReturnValue(true);
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [REVISION_B, REVISION_C],
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags({ limit: 2 }), "123");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("-c prev");
  });

  test("auto-pagination: --limit larger than page size fetches multiple pages", async () => {
    // First page returns 2 items + nextCursor, second page returns 1 item
    listDashboardRevisionsPaginatedSpy
      .mockResolvedValueOnce({
        data: [REVISION_A, REVISION_B],
        nextCursor: "cursor-page-2",
      })
      .mockResolvedValueOnce({
        data: [REVISION_C],
        nextCursor: undefined,
      });

    const { context, stdoutWrite } = createMockContext();
    const func = await revisionsCommand.loader();
    // Request 3 items, which exceeds a single page of 2
    await func.call(context, defaultFlags({ json: true, limit: 3 }), "123");

    // Should have called API twice
    expect(listDashboardRevisionsPaginatedSpy).toHaveBeenCalledTimes(2);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.data).toHaveLength(3);
    expect(parsed.hasMore).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Org/dashboard argument parsing
  // -------------------------------------------------------------------------

  test("uses dashboard ID from positional argument", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [REVISION_A],
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags({ json: true }), "456");

    expect(resolveDashboardIdSpy).toHaveBeenCalledWith("test-org", "456");
    expect(listDashboardRevisionsPaginatedSpy).toHaveBeenCalledWith(
      "test-org",
      "123",
      { perPage: 25, cursor: undefined }
    );
  });

  test("two args parses target + dashboard correctly", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [REVISION_A],
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(context, defaultFlags({ json: true }), "my-org/", "789");

    expect(resolveDashboardIdSpy).toHaveBeenCalledWith("test-org", "789");
  });

  test("resolves dashboard by title", async () => {
    listDashboardRevisionsPaginatedSpy.mockResolvedValue({
      data: [REVISION_A],
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await revisionsCommand.loader();
    await func.call(
      context,
      defaultFlags({ json: true }),
      "My Dashboard Title"
    );

    expect(resolveDashboardIdSpy).toHaveBeenCalledWith(
      "test-org",
      "My Dashboard Title"
    );
  });
});
