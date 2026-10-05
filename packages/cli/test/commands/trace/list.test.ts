/**
 * Trace List Command Tests
 *
 * Tests for internal helper functions and the command func() body
 * in src/commands/trace/list.ts.
 *
 * Uses mock.module to mock api-client and resolve-target to test
 * the func() body without real HTTP calls or database access.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand, parseSort } from "../../../src/commands/trace/list.js";
import type { ProjectWithOrg } from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import { validateLimit } from "../../../src/lib/arg-parsing.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";

vi.mock("../../../src/lib/db/pagination.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/pagination.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as paginationDb from "../../../src/lib/db/pagination.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ContextError, ResolutionError } from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { parsePeriod } from "../../../src/lib/time-range.js";
import type { TransactionListItem } from "../../../src/types/sentry.js";

// Reference paginationDb early to prevent import stripping by auto-organize
const _paginationDbRef = paginationDb;

// ============================================================================
// validateLimit (shared utility from arg-parsing.ts)
// ============================================================================

describe("validateLimit", () => {
  test("returns number for valid value", () => {
    expect(validateLimit("1", 1, 1000)).toBe(1);
    expect(validateLimit("500", 1, 1000)).toBe(500);
    expect(validateLimit("1000", 1, 1000)).toBe(1000);
  });

  test("returns number for boundary values", () => {
    expect(validateLimit("1", 1, 1000)).toBe(1);
    expect(validateLimit("1000", 1, 1000)).toBe(1000);
  });

  test("throws for value below minimum", () => {
    expect(() => validateLimit("0", 1, 1000)).toThrow("must be between");
    expect(() => validateLimit("-1", 1, 1000)).toThrow("must be between");
  });

  test("throws for value above maximum", () => {
    expect(() => validateLimit("1001", 1, 1000)).toThrow("must be between");
    expect(() => validateLimit("9999", 1, 1000)).toThrow("must be between");
  });

  test("throws for non-numeric value", () => {
    expect(() => validateLimit("abc", 1, 1000)).toThrow("must be between");
    expect(() => validateLimit("", 1, 1000)).toThrow("must be between");
  });
});

// ============================================================================
// parseSort
// ============================================================================

describe("parseSort", () => {
  test("accepts 'date'", () => {
    expect(parseSort("date")).toBe("date");
  });

  test("accepts 'duration'", () => {
    expect(parseSort("duration")).toBe("duration");
  });

  test("throws for invalid sort value", () => {
    expect(() => parseSort("invalid")).toThrow("Invalid sort value");
    expect(() => parseSort("")).toThrow("Invalid sort value");
    expect(() => parseSort("name")).toThrow("Invalid sort value");
  });
});

// ============================================================================
// resolveProjectBoundFromArg (via shared resolve-target.ts)
// ============================================================================

describe("resolveProjectBoundFromArg", () => {
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    resolveOrgAndProjectSpy = vi.spyOn(resolveTarget, "resolveOrgAndProject");
    // Pre-populate org cache so resolveEffectiveOrg hits the fast path
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
  });

  test("returns explicit org/project directly", async () => {
    const result = await resolveTarget.resolveProjectBoundFromArg(
      "my-org/my-project",
      "/tmp",
      "trace list"
    );
    expect(result).toEqual({ org: "my-org", project: "my-project" });
    expect(findProjectsBySlugSpy).not.toHaveBeenCalled();
    expect(resolveOrgAndProjectSpy).not.toHaveBeenCalled();
  });

  test("throws for org-all target (org/ without project)", async () => {
    await expect(
      resolveTarget.resolveProjectBoundFromArg("my-org/", "/tmp", "trace list")
    ).rejects.toThrow(ContextError);
  });

  test("throws ContextError with project hint for org-all", async () => {
    try {
      await resolveTarget.resolveProjectBoundFromArg(
        "my-org/",
        "/tmp",
        "trace list"
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      expect((error as ContextError).message).toContain("Project");
      expect((error as ContextError).message).toContain("my-org/<project>");
    }
  });

  test("resolves single project match", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { slug: "frontend", orgSlug: "acme", id: "1", name: "Frontend" },
      ] as ProjectWithOrg[],
      orgs: [],
    });

    const result = await resolveTarget.resolveProjectBoundFromArg(
      "frontend",
      "/tmp",
      "trace list"
    );
    expect(result).toMatchObject({ org: "acme", project: "frontend" });
    expect(result.projectData).toBeDefined();
  });

  test("throws when no project found", async () => {
    findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

    await expect(
      resolveTarget.resolveProjectBoundFromArg(
        "nonexistent",
        "/tmp",
        "trace list"
      )
    ).rejects.toThrow(ResolutionError);
  });

  test("throws when multiple projects found", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { slug: "frontend", orgSlug: "org-a", id: "1", name: "Frontend" },
        { slug: "frontend", orgSlug: "org-b", id: "2", name: "Frontend" },
      ] as ProjectWithOrg[],
      orgs: [],
    });

    try {
      await resolveTarget.resolveProjectBoundFromArg(
        "frontend",
        "/tmp",
        "trace list"
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      // Message says "is ambiguous", not "is required"
      expect((error as ResolutionError).message).toContain("is ambiguous");
      expect((error as ResolutionError).message).toContain("2 organizations");
    }
  });

  // Skip: resolveProjectBoundFromArg calls resolveOrgAndProject internally
  // (same-file call). vi.spyOn on the export doesn't intercept same-file
  // calls in vitest, so the mock has no effect and the real code runs.
  // biome-ignore lint/suspicious/noSkippedTests: vitest can't intercept same-file internal calls
  test.skip("uses auto-detect when no target provided", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue({
      org: "detected-org",
      project: "detected-project",
    });

    const result = await resolveTarget.resolveProjectBoundFromArg(
      undefined,
      "/tmp",
      "trace list"
    );
    expect(result).toEqual({
      org: "detected-org",
      project: "detected-project",
    });
    expect(resolveOrgAndProjectSpy).toHaveBeenCalledWith({
      cwd: "/tmp",
      usageHint: "sentry trace list <org>/<project>",
    });
  });

  // Skip: same reason — resolveOrgAndProject is an internal same-file call
  // biome-ignore lint/suspicious/noSkippedTests: vitest can't intercept same-file internal calls
  test.skip("throws when auto-detect returns null", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue(null);

    await expect(
      resolveTarget.resolveProjectBoundFromArg(undefined, "/tmp", "trace list")
    ).rejects.toThrow(ContextError);
  });
});

// ============================================================================
// listCommand.func()
// ============================================================================

describe("listCommand.func", () => {
  let listTransactionsSpy: ReturnType<typeof spyOn>;
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;
  let resolveCursorSpy: ReturnType<typeof spyOn>;
  let advancePaginationStateSpy: ReturnType<typeof spyOn>;
  let hasPreviousPageSpy: ReturnType<typeof spyOn>;

  const sampleTraces: TransactionListItem[] = [
    {
      trace: "aaaa1111bbbb2222cccc3333dddd4444",
      id: "evt001",
      transaction: "GET /api/users",
      timestamp: "2025-01-30T14:32:15+00:00",
      "span.duration": 245,
      project: "test-project",
    },
    {
      trace: "eeee5555ffff6666aaaa7777bbbb8888",
      id: "evt002",
      transaction: "POST /api/checkout",
      timestamp: "2025-01-30T14:31:00+00:00",
      "span.duration": 1823,
      project: "test-project",
    },
  ];

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

  beforeEach(() => {
    listTransactionsSpy = vi.spyOn(apiClient, "listTransactions");
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    resolveOrgAndProjectSpy = vi.spyOn(resolveTarget, "resolveOrgAndProject");
    vi.spyOn(resolveTarget, "resolveLogProjectId").mockResolvedValue(4242);
    resolveCursorSpy = vi.spyOn(paginationDb, "resolveCursor").mockReturnValue({
      cursor: undefined,
      direction: "next" as const,
    });
    advancePaginationStateSpy = vi
      .spyOn(paginationDb, "advancePaginationState")
      .mockReturnValue(undefined);
    hasPreviousPageSpy = vi
      .spyOn(paginationDb, "hasPreviousPage")
      .mockReturnValue(false);
  });

  afterEach(() => {
    listTransactionsSpy.mockRestore();
    findProjectsBySlugSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
    resolveCursorSpy.mockRestore();
    advancePaginationStateSpy.mockRestore();
    hasPreviousPageSpy.mockRestore();
  });

  test("outputs JSON with data array when --json flag is set", async () => {
    listTransactionsSpy.mockResolvedValue({ data: sampleTraces });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: true, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.hasPrev).toBe(false);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].transaction).toBe("GET /api/users");
  });

  test("outputs empty JSON with hasMore false when no traces found with --json", async () => {
    listTransactionsSpy.mockResolvedValue({ data: [] });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: true, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output)).toEqual({
      data: [],
      hasMore: false,
      hasPrev: false,
    });
  });

  test("writes 'No traces found.' when empty without --json", async () => {
    listTransactionsSpy.mockResolvedValue({ data: [] });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: false, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No traces found.");
  });

  test("writes header, rows, and footer for human output", async () => {
    listTransactionsSpy.mockResolvedValue({ data: sampleTraces });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: false, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Recent traces in test-org/test-project:");
    expect(output).toContain("GET /api/users");
    expect(output).toContain("POST /api/checkout");
    expect(output).toContain("Showing 2 traces.");
    expect(output).toContain("sentry trace view");
  });

  test("shows next page hint when nextCursor is present", async () => {
    listTransactionsSpy.mockResolvedValue({
      data: sampleTraces,
      nextCursor: "1735689600:0:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 2, sort: "date", json: false, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Next:");
    expect(output).toContain("-c next");
  });

  test("shows trace view tip when no nextCursor", async () => {
    listTransactionsSpy.mockResolvedValue({ data: sampleTraces });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 100, sort: "date", json: false, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).not.toContain("Next:");
    expect(output).toContain("sentry trace view");
  });

  test("uses singular 'trace' for single result", async () => {
    listTransactionsSpy.mockResolvedValue({ data: [sampleTraces[0]] });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: false, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Showing 1 trace.");
    expect(output).not.toContain("Showing 1 traces.");
  });

  test("passes query, limit, sort, and cursor to listTransactions", async () => {
    listTransactionsSpy.mockResolvedValue({ data: [] });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      {
        limit: 50,
        sort: "duration",
        json: false,
        query: "transaction:GET",
        period: parsePeriod("7d"),
      },
      "test-org/test-project"
    );

    expect(listTransactionsSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      {
        query: "transaction:GET",
        limit: 50,
        sort: "duration",
        cursor: undefined,
        projectId: 4242,
        statsPeriod: "7d",
      }
    );
  });

  test("JSON output includes nextCursor when more pages exist", async () => {
    listTransactionsSpy.mockResolvedValue({
      data: sampleTraces,
      nextCursor: "1735689600:0:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: true, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.hasPrev).toBe(false);
    expect(parsed.nextCursor).toBe("1735689600:0:0");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(2);
  });

  test("shows next page hint with sort flag when more traces available", async () => {
    listTransactionsSpy.mockResolvedValue({
      data: sampleTraces,
      nextCursor: "1735689600:0:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "duration", json: false, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Next:");
    expect(output).toContain("-c next");
    expect(output).toContain("--sort duration");
  });

  test("cursor is not passed to listTransactions when flag is not set", async () => {
    listTransactionsSpy.mockResolvedValue({ data: [] });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: false, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const callArgs = listTransactionsSpy.mock.calls[0];
    expect(callArgs[2].cursor).toBeUndefined();
  });

  test("shows 'try next page' hint when no traces on page but hasMore", async () => {
    listTransactionsSpy.mockResolvedValue({
      data: [],
      nextCursor: "1735689600:0:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: false, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No traces on this page");
    expect(output).toContain("-c next");
  });

  test("next page hint includes query flag when --query is set", async () => {
    listTransactionsSpy.mockResolvedValue({
      data: sampleTraces,
      nextCursor: "1735689600:0:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      {
        limit: 20,
        sort: "date",
        json: false,
        query: "transaction:POST",
        period: parsePeriod("7d"),
      },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain('-q "transaction:POST"');
    expect(output).toContain("-c next");
  });

  test("JSON output with no nextCursor has hasMore false", async () => {
    listTransactionsSpy.mockResolvedValue({ data: sampleTraces });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: true, period: parsePeriod("7d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.hasPrev).toBe(false);
    expect(parsed.nextCursor).toBeUndefined();
  });

  test("passes statsPeriod to listTransactions when --period is set", async () => {
    listTransactionsSpy.mockResolvedValue({ data: [] });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: false, period: parsePeriod("24h") },
      "test-org/test-project"
    );

    expect(listTransactionsSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      expect.objectContaining({
        statsPeriod: "24h",
      })
    );
  });

  test("next page hint includes --period when non-default", async () => {
    listTransactionsSpy.mockResolvedValue({
      data: sampleTraces,
      nextCursor: "1735689600:0:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 20, sort: "date", json: false, period: parsePeriod("30d") },
      "test-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("--period 30d");
    expect(output).toContain("-c next");
  });
});
