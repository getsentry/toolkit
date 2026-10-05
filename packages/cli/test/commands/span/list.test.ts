/**
 * Span List Command Tests
 *
 * Tests for the dual-mode span list command:
 * - parseSort: sort flag validation
 * - parseSpanListArgs: positional argument disambiguation (project vs trace mode)
 * - listCommand.func (trace mode): existing trace-scoped behavior
 * - listCommand.func (project mode): new project-scoped behavior
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  listCommand,
  parseSort,
  parseSpanListArgs,
} from "../../../src/commands/span/list.js";

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

import { ApiError, ValidationError } from "../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { parsePeriod } from "../../../src/lib/time-range.js";

const VALID_TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";

// Reference paginationDb early to prevent import stripping by auto-organize
const _paginationDbRef = paginationDb;

// Note: parseTraceTarget parsing tests are in test/lib/trace-target.test.ts

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

  test("rejects 'time' (use 'date' instead)", () => {
    expect(() => parseSort("time")).toThrow("Invalid sort value");
  });

  test("throws for invalid value", () => {
    expect(() => parseSort("name")).toThrow("Invalid sort value");
  });

  test("throws for empty string", () => {
    expect(() => parseSort("")).toThrow("Invalid sort value");
  });
});

// ============================================================================
// parseSpanListArgs — positional argument disambiguation
// ============================================================================

describe("parseSpanListArgs", () => {
  test("no args → project mode", () => {
    const result = parseSpanListArgs([]);
    expect(result).toEqual({ mode: "project" });
  });

  test("org/project → project mode with target", () => {
    const result = parseSpanListArgs(["my-org/my-project"]);
    expect(result.mode).toBe("project");
    if (result.mode === "project") {
      expect(result.target).toBe("my-org/my-project");
    }
  });

  test("bare project name → project mode with target", () => {
    const result = parseSpanListArgs(["my-project"]);
    expect(result.mode).toBe("project");
    if (result.mode === "project") {
      expect(result.target).toBe("my-project");
    }
  });

  test("trace ID → trace mode", () => {
    const result = parseSpanListArgs([VALID_TRACE_ID]);
    expect(result.mode).toBe("trace");
  });

  test("org/project/trace-id → trace mode", () => {
    const result = parseSpanListArgs([`my-org/my-project/${VALID_TRACE_ID}`]);
    expect(result.mode).toBe("trace");
  });

  test("project + trace-id (space-separated) → trace mode", () => {
    const result = parseSpanListArgs(["my-project", VALID_TRACE_ID]);
    expect(result.mode).toBe("trace");
  });

  test("org/project + trace-id (space-separated) → trace mode", () => {
    const result = parseSpanListArgs(["my-org/my-project", VALID_TRACE_ID]);
    expect(result.mode).toBe("trace");
  });

  test("short non-hex string → project mode", () => {
    const result = parseSpanListArgs(["frontend"]);
    expect(result.mode).toBe("project");
    if (result.mode === "project") {
      expect(result.target).toBe("frontend");
    }
  });

  test("32-char non-hex string → project mode", () => {
    // 32 chars but not valid hex
    const result = parseSpanListArgs(["abcdefghijklmnopqrstuvwxyz123456"]);
    expect(result.mode).toBe("project");
  });
});

// ============================================================================
// listCommand.func — trace mode (backwards compatibility)
// ============================================================================

type ListFunc = (
  this: unknown,
  flags: Record<string, unknown>,
  ...args: string[]
) => Promise<void>;

describe("listCommand.func (trace mode)", () => {
  let func: ListFunc;
  let listSpansSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;
  let resolveCursorSpy: ReturnType<typeof spyOn>;
  let advancePaginationStateSpy: ReturnType<typeof spyOn>;
  let hasPreviousPageSpy: ReturnType<typeof spyOn>;

  function createContext() {
    const stdoutChunks: string[] = [];
    return {
      context: {
        stdout: {
          write: vi.fn((s: string) => {
            stdoutChunks.push(s);
          }),
        },
        stderr: {
          write: vi.fn((_s: string) => {
            /* no-op */
          }),
        },
        cwd: "/tmp/test-project",
      },
      getStdout: () => stdoutChunks.join(""),
    };
  }

  beforeEach(async () => {
    func = (await listCommand.loader()) as unknown as ListFunc;
    listSpansSpy = vi.spyOn(apiClient, "listSpans");
    resolveOrgAndProjectSpy = vi.spyOn(resolveTarget, "resolveOrgAndProject");
    resolveOrgAndProjectSpy.mockResolvedValue({
      org: "test-org",
      project: "test-project",
    });
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
    listSpansSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
    resolveCursorSpy.mockRestore();
    advancePaginationStateSpy.mockRestore();
    hasPreviousPageSpy.mockRestore();
  });

  test("calls listSpans with trace ID in query", async () => {
    listSpansSpy.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4e5f67890",
          "span.op": "http.client",
          description: "GET /api",
          "span.duration": 123,
          timestamp: "2024-01-15T10:30:00+00:00",
          project: "test-project",
          trace: VALID_TRACE_ID,
        },
      ],
      nextCursor: undefined,
    });

    const { context, getStdout } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      VALID_TRACE_ID
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      expect.objectContaining({
        query: `trace:${VALID_TRACE_ID}`,
      })
    );

    // Output should contain the span data (rendered by wrapper)
    const output = getStdout();
    expect(output).toContain("a1b2c3d4e5f67890");
  });

  test("translates query shorthand when --query is set", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        query: "op:db",
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      VALID_TRACE_ID
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      expect.objectContaining({
        query: `trace:${VALID_TRACE_ID} span.op:db`,
      })
    );
  });

  test("converts a search-query parse 400 to a ValidationError when --query is set (trace mode)", async () => {
    listSpansSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad op filter")
    );

    const { context } = createContext();

    await expect(
      func.call(
        context,
        {
          limit: 25,
          query: "op:::db",
          sort: "date",
          period: parsePeriod("7d"),
          fresh: false,
        },
        VALID_TRACE_ID
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("uses explicit org/project when target is provided", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      `my-org/my-project/${VALID_TRACE_ID}`
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "my-org",
      "my-project",
      expect.anything()
    );
    // Should NOT have called resolveOrgAndProject
    expect(resolveOrgAndProjectSpy).not.toHaveBeenCalled();
  });

  test("passes cursor to API when --cursor is set", async () => {
    resolveCursorSpy.mockReturnValue({
      cursor: "1735689600:0:0",
      direction: "next" as const,
    });
    listSpansSpy.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4e5f67890",
          timestamp: "2024-01-15T10:30:00+00:00",
          project: "test-project",
          trace: VALID_TRACE_ID,
        },
      ],
      nextCursor: undefined,
    });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("7d"),
        cursor: "1735689600:0:0",
        fresh: false,
      },
      VALID_TRACE_ID
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      expect.objectContaining({
        cursor: "1735689600:0:0",
      })
    );
  });

  test("includes nextCursor in JSON output when hasMore", async () => {
    listSpansSpy.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4e5f67890",
          timestamp: "2024-01-15T10:30:00+00:00",
          project: "test-project",
          trace: VALID_TRACE_ID,
        },
      ],
      nextCursor: "1735689600:0:1",
    });

    const { context, getStdout } = createContext();

    await func.call(
      context,
      {
        limit: 1,
        sort: "date",
        period: parsePeriod("7d"),
        json: true,
        fresh: false,
      },
      VALID_TRACE_ID
    );

    const output = getStdout();
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBe("1735689600:0:1");
  });

  test("hint shows -c next when more pages available", async () => {
    listSpansSpy.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4e5f67890",
          timestamp: "2024-01-15T10:30:00+00:00",
          project: "test-project",
          trace: VALID_TRACE_ID,
        },
      ],
      nextCursor: "1735689600:0:1",
    });

    const { context, getStdout } = createContext();

    await func.call(
      context,
      {
        limit: 1,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      VALID_TRACE_ID
    );

    const output = getStdout();
    expect(output).toContain("-c next");
  });

  test("passes statsPeriod to listSpans", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("24h"),
        fresh: false,
      },
      VALID_TRACE_ID
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      expect.objectContaining({
        statsPeriod: "24h",
      })
    );
  });

  test("trace mode passes allProjects: true to listSpans", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      VALID_TRACE_ID
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      expect.objectContaining({
        allProjects: true,
      })
    );
  });
});

// ============================================================================
// listCommand.func — project mode (new)
// ============================================================================

describe("listCommand.func (project mode)", () => {
  let func: ListFunc;
  // span/list.ts calls resolveProjectBoundFromArg (not resolveOrgAndProject)
  const resolveOrgAndProjectSpy = vi.mocked(
    resolveTarget.resolveProjectBoundFromArg
  );
  const listSpansSpy = vi.mocked(apiClient.listSpans);
  const resolveCursorSpy = vi.mocked(paginationDb.resolveCursor);
  const advancePaginationStateSpy = vi.mocked(
    paginationDb.advancePaginationState
  );
  const hasPreviousPageSpy = vi.mocked(paginationDb.hasPreviousPage);

  function createContext() {
    const stdoutChunks: string[] = [];
    return {
      context: {
        stdout: {
          write: vi.fn((s: string) => {
            stdoutChunks.push(s);
          }),
        },
        stderr: {
          write: vi.fn((_s: string) => {
            /* no-op */
          }),
        },
        cwd: "/tmp/test-project",
      },
      getStdout: () => stdoutChunks.join(""),
    };
  }

  beforeEach(async () => {
    func = (await listCommand.loader()) as unknown as ListFunc;
    // Mock resolveProjectBoundFromArg to parse explicit "org/project" targets
    // and fall back to a default for auto-detect (no target).
    resolveOrgAndProjectSpy.mockImplementation(
      async (target: string | undefined) => {
        if (target?.includes("/")) {
          const [org, project] = target.split("/");
          return { org: org!, project: project! };
        }
        return { org: "test-org", project: "test-project" };
      }
    );
    vi.spyOn(resolveTarget, "resolveLogProjectId").mockResolvedValue(4242);
    resolveCursorSpy.mockReturnValue({
      cursor: undefined,
      direction: "next" as const,
    });
    advancePaginationStateSpy.mockReturnValue(undefined);
    hasPreviousPageSpy.mockReturnValue(false);
  });

  afterEach(() => {
    listSpansSpy.mockReset();
    resolveOrgAndProjectSpy.mockReset();
    resolveCursorSpy.mockReset();
    advancePaginationStateSpy.mockReset();
    hasPreviousPageSpy.mockReset();
  });

  test("calls listSpans without trace filter when no trace ID given", async () => {
    listSpansSpy.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4e5f67890",
          "span.op": "db",
          description: "SELECT * FROM users",
          "span.duration": 45,
          timestamp: "2024-01-15T10:30:00+00:00",
          project: "test-project",
          trace: VALID_TRACE_ID,
        },
      ],
      nextCursor: undefined,
    });

    const { context, getStdout } = createContext();

    // No positional args → project mode via auto-detect
    await func.call(context, {
      limit: 25,
      sort: "date",
      period: parsePeriod("7d"),
      fresh: false,
    });

    // Should NOT have trace: prefix in the query
    const callArgs = listSpansSpy.mock.calls[0];
    const query = callArgs[2]?.query;
    expect(query).toBeUndefined();

    const output = getStdout();
    expect(output).toContain("a1b2c3d4e5f67890");
  });

  test("uses explicit org/project in project mode", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      "my-org/my-project"
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "my-org",
      "my-project",
      expect.anything()
    );
    // resolveProjectBoundFromArg is called with the explicit target
    expect(resolveOrgAndProjectSpy).toHaveBeenCalledWith(
      "my-org/my-project",
      expect.any(String),
      expect.any(String)
    );
  });

  test("translates query in project mode", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        query: "op:db duration:>100ms",
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      "my-org/my-project"
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "my-org",
      "my-project",
      expect.objectContaining({
        query: "span.op:db span.duration:>100ms",
      })
    );
  });

  test("converts a search-query parse 400 to a ValidationError when --query is set (project mode)", async () => {
    // Project mode must wrap listSpans with toSearchQueryError just like trace
    // mode does — a bad user --query is a user mistake, not a reported CLI bug.
    listSpansSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad op filter")
    );

    const { context } = createContext();

    await expect(
      func.call(
        context,
        {
          limit: 25,
          query: "op:::db",
          sort: "date",
          period: parsePeriod("7d"),
          fresh: false,
        },
        "my-org/my-project"
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("keeps a search-query parse 400 as a reported ApiError when no --query is set (project mode)", async () => {
    // No user --query means the CLI built the bad query — stays a reported
    // ApiError(400), not reclassified as user input.
    listSpansSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad op filter")
    );

    const { context } = createContext();

    await expect(
      func.call(
        context,
        {
          limit: 25,
          sort: "date",
          period: parsePeriod("7d"),
          fresh: false,
        },
        "my-org/my-project"
      )
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("passes statsPeriod in project mode", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("30d"),
        fresh: false,
      },
      "my-org/my-project"
    );

    expect(listSpansSpy).toHaveBeenCalledWith(
      "my-org",
      "my-project",
      expect.objectContaining({
        statsPeriod: "30d",
      })
    );
  });

  test("shows project header in human output", async () => {
    listSpansSpy.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4e5f67890",
          "span.op": "http.client",
          description: "GET /api",
          "span.duration": 123,
          timestamp: "2024-01-15T10:30:00+00:00",
          project: "my-project",
          trace: VALID_TRACE_ID,
        },
      ],
      nextCursor: undefined,
    });

    const { context, getStdout } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      "my-org/my-project"
    );

    const output = getStdout();
    expect(output).toContain("Spans in my-org/my-project:");
    // Should NOT contain "Spans in trace"
    expect(output).not.toContain("Spans in trace");
  });

  test("JSON output has correct envelope in project mode", async () => {
    listSpansSpy.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4e5f67890",
          timestamp: "2024-01-15T10:30:00+00:00",
          project: "test-project",
          trace: VALID_TRACE_ID,
        },
      ],
      nextCursor: "1735689600:0:1",
    });

    const { context, getStdout } = createContext();

    await func.call(context, {
      limit: 1,
      sort: "date",
      period: parsePeriod("7d"),
      json: true,
      fresh: false,
    });

    const output = getStdout();
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBe("1735689600:0:1");
    expect(Array.isArray(parsed.data)).toBe(true);
  });

  test("shows 'No spans matched' when empty in project mode", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context, getStdout } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      "my-org/my-project"
    );

    const output = getStdout();
    expect(output).toContain("No spans matched the query.");
  });

  test("project mode does not pass allProjects to listSpans", async () => {
    listSpansSpy.mockResolvedValue({ data: [], nextCursor: undefined });

    const { context } = createContext();

    await func.call(
      context,
      {
        limit: 25,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      "my-org/my-project"
    );

    const callArgs = listSpansSpy.mock.calls[0];
    const options = callArgs[2];
    expect(options.allProjects).toBeUndefined();
    expect(options.projectId).toBe(4242);
  });

  test("hint shows -c next with project target when more pages available", async () => {
    listSpansSpy.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4e5f67890",
          timestamp: "2024-01-15T10:30:00+00:00",
          project: "test-project",
          trace: VALID_TRACE_ID,
        },
      ],
      nextCursor: "1735689600:0:1",
    });

    const { context, getStdout } = createContext();

    await func.call(
      context,
      {
        limit: 1,
        sort: "date",
        period: parsePeriod("7d"),
        fresh: false,
      },
      "my-org/my-project"
    );

    const output = getStdout();
    expect(output).toContain("-c next");
    expect(output).toContain("sentry span list my-org/my-project");
    // Should NOT contain a trace ID in the next-page hint
    expect(output).not.toContain(VALID_TRACE_ID);
  });
});
