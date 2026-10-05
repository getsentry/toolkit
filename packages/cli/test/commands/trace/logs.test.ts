/**
 * Trace Logs Command Tests
 *
 * Tests for positional argument parsing and the command func() body
 * in src/commands/trace/logs.ts.
 *
 * Uses spyOn mocking to avoid real HTTP calls or database access.
 *
 * The command writes directly to `process.stdout.write()` via
 * `formatTraceLogs()`, so tests spy on `process.stdout.write` to
 * capture output instead of using mock context writers.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type mock,
  test,
  vi,
} from "vitest";
import { logsCommand } from "../../../src/commands/trace/logs.js";

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
import { ContextError } from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/polling.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/polling.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as polling from "../../../src/lib/polling.js";

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
import type { TraceLog } from "../../../src/types/sentry.js";

// Note: parseTraceTarget parsing tests are in test/lib/trace-target.test.ts

const TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";
const ORG = "test-org";

const sampleLogs: TraceLog[] = [
  {
    id: "log001",
    "project.id": 1,
    trace: TRACE_ID,
    severity_number: 9,
    severity: "info",
    timestamp: "2025-01-30T14:32:15+00:00",
    timestamp_precise: 1_738_247_535_123_456_000,
    message: "Request received",
  },
  {
    id: "log002",
    "project.id": 1,
    trace: TRACE_ID,
    severity_number: 13,
    severity: "warn",
    timestamp: "2025-01-30T14:32:16+00:00",
    timestamp_precise: 1_738_247_536_456_789_000,
    message: "Slow query detected",
  },
  {
    id: "log003",
    "project.id": 1,
    trace: TRACE_ID,
    severity_number: 17,
    severity: "error",
    timestamp: "2025-01-30T14:32:17+00:00",
    timestamp_precise: 1_738_247_537_789_012_000,
    message: "Database connection failed",
  },
];

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      cwd: "/tmp",
    },
    stdoutWrite,
  };
}

/**
 * Collect all output written to a mock write function.
 */
function collectMockOutput(
  writeMock: ReturnType<typeof mock<() => boolean>>
): string {
  return writeMock.mock.calls
    .map((c) => {
      const arg = c[0];
      if (typeof arg === "string") {
        return arg;
      }
      if (arg instanceof Uint8Array) {
        return new TextDecoder().decode(arg);
      }
      return String(arg);
    })
    .join("");
}

describe("logsCommand.func", () => {
  let listTraceLogsSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;
  let resolveOrgOnlyTargetSpy: ReturnType<typeof spyOn>;
  let withProgressSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listTraceLogsSpy = vi.spyOn(apiClient, "listTraceLogs");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    resolveOrgOnlyTargetSpy = vi
      .spyOn(resolveTarget, "resolveOrgOnlyTarget")
      .mockResolvedValue(ORG);
    // Bypass the withProgress spinner to prevent real stderr timers
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation((_opts, fn) =>
        fn(() => {
          /* no-op setMessage */
        })
      );
  });

  afterEach(() => {
    listTraceLogsSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    resolveOrgOnlyTargetSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  describe("JSON output mode", () => {
    test("outputs JSON envelope when --json flag is set", async () => {
      listTraceLogsSpy.mockResolvedValue(sampleLogs);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: true,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("data");
      expect(parsed).toHaveProperty("hasMore");
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.data).toHaveLength(3);
      // Default sort=newest preserves API return order
      expect(parsed.data[0].id).toBe("log001");
      expect(parsed.hasMore).toBe(false);
    });

    test("outputs empty JSON envelope when no logs found with --json", async () => {
      listTraceLogsSpy.mockResolvedValue([]);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: true,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      const parsed = JSON.parse(output);
      expect(parsed).toEqual({ data: [], hasMore: false });
    });
  });

  describe("human-readable output mode", () => {
    test("shows message about no logs when empty", async () => {
      listTraceLogsSpy.mockResolvedValue([]);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      expect(output).toContain("No logs found");
      expect(output).toContain(TRACE_ID);
    });

    test("includes period in empty result message", async () => {
      listTraceLogsSpy.mockResolvedValue([]);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("30d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      expect(output).toContain("30d");
    });

    test("renders log messages in output", async () => {
      listTraceLogsSpy.mockResolvedValue(sampleLogs);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      expect(output).toContain("Request received");
      expect(output).toContain("Slow query detected");
      expect(output).toContain("Database connection failed");
    });

    test("shows count footer", async () => {
      listTraceLogsSpy.mockResolvedValue(sampleLogs);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      expect(output).toContain("Showing 3 logs");
      expect(output).toContain(TRACE_ID);
    });

    test("uses singular 'log' for exactly one result", async () => {
      listTraceLogsSpy.mockResolvedValue([sampleLogs[0]]);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      expect(output).toContain("Showing 1 log for trace");
      expect(output).not.toContain("Showing 1 logs");
    });

    test("shows --limit tip when results match limit", async () => {
      listTraceLogsSpy.mockResolvedValue(sampleLogs);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        // limit equals number of returned logs → hasMore = true
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 3,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      expect(output).toContain("Use --limit to show more.");
    });

    test("does not show --limit tip when fewer results than limit", async () => {
      listTraceLogsSpy.mockResolvedValue(sampleLogs);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context, stdoutWrite } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      const output = collectMockOutput(stdoutWrite);
      expect(output).not.toContain("Use --limit to show more.");
    });
  });

  describe("org resolution", () => {
    test("resolves a bare first positional through the org-only resolver", async () => {
      listTraceLogsSpy.mockResolvedValue([]);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: true,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        ORG,
        TRACE_ID
      );

      expect(resolveOrgOnlyTargetSpy).toHaveBeenCalled();
    });

    test("passes undefined org when only trace ID given", async () => {
      listTraceLogsSpy.mockResolvedValue([]);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: true,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      expect(resolveOrgSpy).toHaveBeenCalledWith({
        org: undefined,
        cwd: "/tmp",
      });
    });

    test("throws ContextError when org cannot be resolved", async () => {
      resolveOrgSpy.mockResolvedValue(null);

      const { context } = createMockContext();
      const func = await logsCommand.loader();

      await expect(
        func.call(
          context,
          {
            json: false,
            web: false,
            period: parsePeriod("14d"),
            limit: 100,
            sort: "newest",
          },
          TRACE_ID
        )
      ).rejects.toThrow(ContextError);
    });
  });

  describe("flag forwarding to API", () => {
    test("passes traceId, period, limit, and query to listTraceLogs", async () => {
      listTraceLogsSpy.mockResolvedValue([]);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("7d"),
          limit: 50,
          query: "severity:error",
          sort: "newest",
        },
        TRACE_ID
      );

      expect(listTraceLogsSpy).toHaveBeenCalledWith(ORG, TRACE_ID, {
        statsPeriod: "7d",
        limit: 50,
        query: "severity:error",
        sort: "newest",
      });
    });

    test("passes undefined query when --query not provided", async () => {
      listTraceLogsSpy.mockResolvedValue([]);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      expect(listTraceLogsSpy).toHaveBeenCalledWith(ORG, TRACE_ID, {
        statsPeriod: "14d",
        limit: 100,
        query: undefined,
        sort: "newest",
      });
    });
  });

  describe("--web flag", () => {
    test("does not call listTraceLogs when --web is set", async () => {
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context } = createMockContext();
      const func = await logsCommand.loader();
      // --web would call openInBrowser which needs a real browser; catch any error
      try {
        await func.call(
          context,
          {
            json: false,
            web: true,
            period: parsePeriod("14d"),
            limit: 100,
            sort: "newest",
          },
          TRACE_ID
        );
      } catch {
        // openInBrowser may throw in test environment — that's OK
      }

      expect(listTraceLogsSpy).not.toHaveBeenCalled();
    });
  });

  describe("sort ordering", () => {
    test("default sort=newest passes sort to API", async () => {
      listTraceLogsSpy.mockResolvedValue(sampleLogs);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "newest",
        },
        TRACE_ID
      );

      expect(listTraceLogsSpy).toHaveBeenCalledWith(
        ORG,
        TRACE_ID,
        expect.objectContaining({ sort: "newest" })
      );
    });

    test("sort=oldest passes sort to API for server-side ordering", async () => {
      listTraceLogsSpy.mockResolvedValue(sampleLogs);
      resolveOrgSpy.mockResolvedValue({ org: ORG });

      const { context } = createMockContext();
      const func = await logsCommand.loader();
      await func.call(
        context,
        {
          json: false,
          web: false,
          period: parsePeriod("14d"),
          limit: 100,
          sort: "oldest",
        },
        TRACE_ID
      );

      expect(listTraceLogsSpy).toHaveBeenCalledWith(
        ORG,
        TRACE_ID,
        expect.objectContaining({ sort: "oldest" })
      );
    });
  });
});
