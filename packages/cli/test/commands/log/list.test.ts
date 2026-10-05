/**
 * Log List Command Tests
 *
 * Tests for the `sentry log list` command func() body, covering:
 * - Standard project-scoped mode (positional org/project)
 * - Trace-filtered mode (positional 32-char hex trace-id)
 * - Positional argument disambiguation (trace vs project)
 * - Period flag behavior
 * - Follow/streaming mode for both standard and trace modes
 *
 * Uses spyOn mocking to avoid real HTTP calls or database access.
 * Follow-mode tests use SIGINT to cleanly stop the setTimeout-based
 * poll loop — the promise resolves on SIGINT (normal termination).
 * AuthError tests verify that fetch failures reject the promise.
 *
 * Non-follow (single-fetch) tests mock `withProgress` from `polling.ts`
 * to bypass the spinner. Follow-mode tests do NOT mock `withProgress`
 * because follow mode uses its own streaming banner, not the spinner.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/log/list.js";

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

vi.mock("../../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/auth.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";
import {
  ApiError,
  AuthError,
  ContextError,
  ValidationError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/formatters/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/formatters/index.js")
    >();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as formatters from "../../../src/lib/formatters/index.js";

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

vi.mock("../../../src/lib/trace-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/trace-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as traceTarget from "../../../src/lib/trace-target.js";

vi.mock("../../../src/lib/version-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/version-check.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as versionCheck from "../../../src/lib/version-check.js";
import type { SentryLog, TraceLog } from "../../../src/types/sentry.js";

// ============================================================================
// Helpers
// ============================================================================

const TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";
const ORG = "test-org";
const PROJECT = "test-project";

/**
 * Intercept `process.once("SIGINT", handler)` registrations so tests can
 * invoke the handler directly without sending a real signal (which would
 * kill the Bun test runner).
 *
 * Must be created BEFORE the code under test runs. Call `trigger()` to
 * simulate SIGINT, and `restore()` in afterEach.
 */
function interceptSigint() {
  let handler: ((...args: unknown[]) => void) | null = null;
  const originalOnce = process.once.bind(process);
  const spy = vi.spyOn(process, "once").mockImplementation(((
    event: string,
    fn: (...args: unknown[]) => void
  ) => {
    if (event === "SIGINT") {
      handler = fn;
      return process;
    }
    return originalOnce(event, fn);
  }) as typeof process.once);

  // Also intercept removeListener so AuthError path works
  const originalRemoveListener = process.removeListener.bind(process);
  const removeSpy = vi.spyOn(process, "removeListener").mockImplementation(((
    event: string,
    fn: (...args: unknown[]) => void
  ) => {
    if (event === "SIGINT" && fn === handler) {
      handler = null;
      return process;
    }
    return originalRemoveListener(event, fn);
  }) as typeof process.removeListener);

  return {
    /** Invoke the captured SIGINT handler (simulates Ctrl+C) */
    trigger() {
      if (handler) {
        const h = handler;
        handler = null;
        h();
      }
    },
    /** Restore original process.once and process.removeListener */
    restore() {
      spy.mockRestore();
      removeSpy.mockRestore();
      handler = null;
    },
  };
}

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd: "/tmp",
    },
    stdoutWrite,
    stderrWrite,
  };
}

/** No-op setMessage callback for withProgress mock */
function noop() {
  // no-op for test
}

/** Passthrough mock for `withProgress` — bypasses spinner, calls fn directly */
function mockWithProgress(
  _opts: unknown,
  fn: (setMessage: () => void) => unknown
) {
  return fn(noop);
}

/** Standard flags for non-follow batch mode (period omitted = use mode default) */
const BATCH_FLAGS = {
  json: true,
  limit: 100,
  sort: "newest",
} as const;

/** Human-mode flags for non-follow batch mode (period omitted = use mode default) */
const HUMAN_FLAGS = {
  json: false,
  limit: 100,
  sort: "newest",
} as const;

/** Sample project-scoped logs (SentryLog) */
const sampleLogs: SentryLog[] = [
  {
    "sentry.item_id": "item001",
    timestamp: "2025-01-30T14:32:15+00:00",
    timestamp_precise: 1_738_247_535_123_456_000,
    severity: "info",
    message: "Request received",
    trace: "aaaa1111bbbb2222cccc3333dddd4444",
  },
  {
    "sentry.item_id": "item002",
    timestamp: "2025-01-30T14:32:16+00:00",
    timestamp_precise: 1_738_247_536_456_789_000,
    severity: "warn",
    message: "Slow query detected",
    trace: "aaaa1111bbbb2222cccc3333dddd4444",
  },
  {
    "sentry.item_id": "item003",
    timestamp: "2025-01-30T14:32:17+00:00",
    timestamp_precise: 1_738_247_537_789_012_000,
    severity: "error",
    message: "Database connection failed",
    trace: "aaaa1111bbbb2222cccc3333dddd4444",
  },
];

/** Sample trace-scoped logs (TraceLog) */
const sampleTraceLogs: TraceLog[] = [
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

/** Newer trace logs for polling tests — uses far-future timestamp to always be "newer" */
const newerTraceLogs: TraceLog[] = [
  {
    id: "log004",
    "project.id": 1,
    trace: TRACE_ID,
    severity_number: 9,
    severity: "info",
    timestamp: "2099-01-30T14:32:20+00:00",
    timestamp_precise: 4_073_000_000_000_000_000,
    message: "New poll result",
  },
];

/** Newer project logs for polling tests — uses far-future timestamp */
const newerLogs: SentryLog[] = [
  {
    "sentry.item_id": "item004",
    timestamp: "2099-01-30T14:32:20+00:00",
    timestamp_precise: 4_073_000_000_000_000_000,
    severity: "info",
    message: "New poll result",
    trace: "aaaa1111bbbb2222cccc3333dddd4444",
  },
];

// ============================================================================
// Auth setup — mock getAuthConfig for all tests (auth guard added in #611)
// ============================================================================

let getAuthConfigSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  getAuthConfigSpy = vi.spyOn(dbAuth, "getAuthConfig").mockReturnValue({
    token: "sntrys_test",
    source: "oauth" as const,
  });
});

afterEach(() => {
  getAuthConfigSpy.mockRestore();
});

// ============================================================================
// Standard mode (project-scoped, no trace-id positional)
// ============================================================================

describe("listCommand.func — standard mode", () => {
  let listLogsSpy: ReturnType<typeof spyOn>;
  let resolveOrgProjectSpy: ReturnType<typeof spyOn>;
  let withProgressSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listLogsSpy = vi.spyOn(apiClient, "listLogs");
    resolveOrgProjectSpy = vi.spyOn(
      resolveTarget,
      "resolveProjectBoundFromArg"
    );
    vi.spyOn(resolveTarget, "resolveLogProjectId").mockResolvedValue(undefined);
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(mockWithProgress);
  });

  afterEach(() => {
    listLogsSpy.mockRestore();
    resolveOrgProjectSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  test("outputs JSON envelope with data and hasMore for --json", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("hasMore");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(3);
  });

  test("outputs JSON in newest-first order by default", async () => {
    // API returns newest first: item003, item002, item001
    const newestFirst = [...sampleLogs].reverse();
    listLogsSpy.mockResolvedValue(newestFirst);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    // Default sort=newest preserves API order (newest first)
    expect(parsed.data[0]["sentry.item_id"]).toBe("item003");
    expect(parsed.data[2]["sentry.item_id"]).toBe("item001");
  });

  test("passes sort=oldest to API when requested", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { ...BATCH_FLAGS, sort: "oldest" },
      `${ORG}/${PROJECT}`
    );

    // sort=oldest is passed to API for server-side sorting
    expect(listLogsSpy).toHaveBeenCalledWith(
      ORG,
      PROJECT,
      expect.objectContaining({ sort: "oldest" })
    );
  });

  test("shows 'No logs found' for empty result (human mode)", async () => {
    listLogsSpy.mockResolvedValue([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No logs found");
  });

  test("renders log messages in human output", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Request received");
    expect(output).toContain("Slow query detected");
    expect(output).toContain("Database connection failed");
  });

  test("shows count footer", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Showing 3 log");
  });

  test("shows --limit tip when results match limit", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    // limit equals number of returned logs → hasMore = true
    await func.call(context, { json: false, limit: 3 }, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Use --limit to show more");
  });

  test("does not show tip when fewer results than limit", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).not.toContain("Use --limit to show more");
  });

  test("passes query, limit, and period to listLogs", async () => {
    listLogsSpy.mockResolvedValue([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { json: false, limit: 50, query: "severity:error", sort: "newest" },
      `${ORG}/${PROJECT}`
    );

    expect(listLogsSpy).toHaveBeenCalledWith(ORG, PROJECT, {
      query: "severity:error",
      limit: 50,
      statsPeriod: "30d",
      sort: "newest",
    });
  });

  test("converts a search-query parse 400 to a ValidationError when --query is set (project single-fetch)", async () => {
    listLogsSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad field")
    );
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await expect(
      func.call(
        context,
        { json: false, limit: 50, query: "bad:::query", sort: "newest" },
        `${ORG}/${PROJECT}`
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("keeps a search-query parse 400 as a reported ApiError with no --query (project single-fetch)", async () => {
    listLogsSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad field")
    );
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await expect(
      func.call(
        context,
        { json: false, limit: 50, sort: "newest" },
        `${ORG}/${PROJECT}`
      )
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("hasMore is true when results match limit", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true, limit: 3 }, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(true);
  });

  test("hasMore is false when fewer results than limit", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(false);
  });
});

// ============================================================================
// Trace mode (positional trace-id)
// ============================================================================

describe("listCommand.func — trace mode", () => {
  let listTraceLogsSpy: ReturnType<typeof spyOn>;
  let resolveTraceOrgSpy: ReturnType<typeof spyOn>;
  let warnIfNormalizedSpy: ReturnType<typeof spyOn>;
  let withProgressSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listTraceLogsSpy = vi.spyOn(apiClient, "listTraceLogs");
    resolveTraceOrgSpy = vi.spyOn(traceTarget, "resolveTraceOrg");
    warnIfNormalizedSpy = vi
      .spyOn(traceTarget, "warnIfNormalized")
      .mockReturnValue(undefined);
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(mockWithProgress);
  });

  afterEach(() => {
    listTraceLogsSpy.mockRestore();
    resolveTraceOrgSpy.mockRestore();
    warnIfNormalizedSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  test("outputs JSON envelope with data and hasMore for --json", async () => {
    listTraceLogsSpy.mockResolvedValue(sampleTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("hasMore");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(3);
  });

  test("converts a search-query parse 400 to a ValidationError when --query is set (trace single-fetch)", async () => {
    // executeTraceSingleFetch must wrap listTraceLogs with toSearchQueryError
    // just like executeSingleFetch does for the project path.
    listTraceLogsSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad field")
    );
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await expect(
      func.call(context, { ...BATCH_FLAGS, query: "bad:::query" }, TRACE_ID)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("keeps a search-query parse 400 as a reported ApiError with no --query (trace single-fetch)", async () => {
    listTraceLogsSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad field")
    );
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await expect(
      func.call(context, BATCH_FLAGS, TRACE_ID)
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("outputs JSON in newest-first order by default (trace mode)", async () => {
    const newestFirst = [...sampleTraceLogs].reverse();
    listTraceLogsSpy.mockResolvedValue(newestFirst);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    // Default sort=newest preserves API order (newest first)
    expect(parsed.data[0].id).toBe("log003");
    expect(parsed.data[2].id).toBe("log001");
  });

  test("shows empty-trace message in human mode", async () => {
    listTraceLogsSpy.mockResolvedValue([]);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No logs found");
    expect(output).toContain(TRACE_ID);
  });

  test("renders trace log messages in human output", async () => {
    listTraceLogsSpy.mockResolvedValue(sampleTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Request received");
    expect(output).toContain("Slow query detected");
    expect(output).toContain("Database connection failed");
  });

  test("shows count footer with trace ID", async () => {
    listTraceLogsSpy.mockResolvedValue(sampleTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Showing 3 log");
    expect(output).toContain(TRACE_ID);
  });

  test("shows --limit tip when trace results match limit", async () => {
    listTraceLogsSpy.mockResolvedValue(sampleTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false, limit: 3 }, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Use --limit to show more.");
  });

  test("passes traceId, limit, and query to listTraceLogs with 14d default", async () => {
    listTraceLogsSpy.mockResolvedValue([]);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { json: false, limit: 50, query: "severity:error", sort: "newest" },
      TRACE_ID
    );

    expect(listTraceLogsSpy).toHaveBeenCalledWith(ORG, TRACE_ID, {
      query: "severity:error",
      limit: 50,
      statsPeriod: "14d",
      sort: "newest",
    });
  });

  test("uses positional org/trace-id to resolve trace org", async () => {
    listTraceLogsSpy.mockResolvedValue([]);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: "my-org" });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, `my-org/${TRACE_ID}`);

    // resolveTraceOrg receives the parsed ParsedTraceTarget
    expect(resolveTraceOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "org-scoped",
        org: "my-org",
        traceId: TRACE_ID,
      }),
      "/tmp",
      expect.any(String)
    );
  });
});

// ============================================================================
// Positional argument disambiguation
// ============================================================================

describe("listCommand.func — positional disambiguation", () => {
  let listLogsSpy: ReturnType<typeof spyOn>;
  let listTraceLogsSpy: ReturnType<typeof spyOn>;
  let resolveOrgProjectSpy: ReturnType<typeof spyOn>;
  let resolveTraceOrgSpy: ReturnType<typeof spyOn>;
  let warnIfNormalizedSpy: ReturnType<typeof spyOn>;
  let withProgressSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listLogsSpy = vi.spyOn(apiClient, "listLogs").mockResolvedValue([]);
    listTraceLogsSpy = vi
      .spyOn(apiClient, "listTraceLogs")
      .mockResolvedValue([]);
    resolveOrgProjectSpy = vi
      .spyOn(resolveTarget, "resolveProjectBoundFromArg")
      .mockResolvedValue({ org: ORG, project: PROJECT });
    resolveTraceOrgSpy = vi
      .spyOn(traceTarget, "resolveTraceOrg")
      .mockResolvedValue({
        traceId: TRACE_ID,
        org: ORG,
      });
    warnIfNormalizedSpy = vi
      .spyOn(traceTarget, "warnIfNormalized")
      .mockReturnValue(undefined);
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(mockWithProgress);
  });

  afterEach(() => {
    listLogsSpy.mockRestore();
    listTraceLogsSpy.mockRestore();
    resolveOrgProjectSpy.mockRestore();
    resolveTraceOrgSpy.mockRestore();
    warnIfNormalizedSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  test("32-char hex string triggers trace mode", async () => {
    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, TRACE_ID);

    expect(listTraceLogsSpy).toHaveBeenCalled();
    expect(listLogsSpy).not.toHaveBeenCalled();
  });

  test("non-hex string triggers project mode", async () => {
    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, `${ORG}/${PROJECT}`);

    expect(listLogsSpy).toHaveBeenCalled();
    expect(listTraceLogsSpy).not.toHaveBeenCalled();
  });

  test("org/trace-id triggers trace mode", async () => {
    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, `${ORG}/${TRACE_ID}`);

    expect(listTraceLogsSpy).toHaveBeenCalled();
    expect(listLogsSpy).not.toHaveBeenCalled();
  });

  test("org/project (non-hex) triggers project mode", async () => {
    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, BATCH_FLAGS, "my-org/my-project");

    expect(listLogsSpy).toHaveBeenCalled();
    expect(listTraceLogsSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Period flag behavior
// ============================================================================

describe("listCommand.func — period flag", () => {
  let listTraceLogsSpy: ReturnType<typeof spyOn>;
  let resolveTraceOrgSpy: ReturnType<typeof spyOn>;
  let warnIfNormalizedSpy: ReturnType<typeof spyOn>;
  let withProgressSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listTraceLogsSpy = vi
      .spyOn(apiClient, "listTraceLogs")
      .mockResolvedValue([]);
    resolveTraceOrgSpy = vi
      .spyOn(traceTarget, "resolveTraceOrg")
      .mockResolvedValue({
        traceId: TRACE_ID,
        org: ORG,
      });
    warnIfNormalizedSpy = vi
      .spyOn(traceTarget, "warnIfNormalized")
      .mockReturnValue(undefined);
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(mockWithProgress);
  });

  afterEach(() => {
    listTraceLogsSpy.mockRestore();
    resolveTraceOrgSpy.mockRestore();
    warnIfNormalizedSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  test("trace mode uses 14d default when period is omitted", async () => {
    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { json: true, limit: 100, sort: "newest" },
      TRACE_ID
    );

    expect(listTraceLogsSpy).toHaveBeenCalledWith(ORG, TRACE_ID, {
      query: undefined,
      limit: 100,
      statsPeriod: "14d",
      sort: "newest",
    });
  });

  test("trace mode uses explicit period when set to non-default", async () => {
    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { json: true, limit: 100, period: parsePeriod("30d"), sort: "newest" },
      TRACE_ID
    );

    expect(listTraceLogsSpy).toHaveBeenCalledWith(ORG, TRACE_ID, {
      query: undefined,
      limit: 100,
      statsPeriod: "30d",
      sort: "newest",
    });
  });
});

// ============================================================================
// Trace mode org resolution failure
// ============================================================================

describe("listCommand.func — trace mode org resolution failure", () => {
  let resolveTraceOrgSpy: ReturnType<typeof spyOn>;
  let warnIfNormalizedSpy: ReturnType<typeof spyOn>;
  let withProgressSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveTraceOrgSpy = vi.spyOn(traceTarget, "resolveTraceOrg");
    warnIfNormalizedSpy = vi
      .spyOn(traceTarget, "warnIfNormalized")
      .mockReturnValue(undefined);
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(mockWithProgress);
  });

  afterEach(() => {
    resolveTraceOrgSpy.mockRestore();
    warnIfNormalizedSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  test("throws ContextError when org cannot be resolved", async () => {
    resolveTraceOrgSpy.mockRejectedValue(
      new ContextError("Organization", "sentry log list [<org>/]<trace-id>")
    );

    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(func.call(context, HUMAN_FLAGS, TRACE_ID)).rejects.toThrow(
      ContextError
    );
  });

  test("ContextError mentions Organization", async () => {
    resolveTraceOrgSpy.mockRejectedValue(
      new ContextError("Organization", "sentry log list [<org>/]<trace-id>")
    );

    const { context } = createMockContext();
    const func = await listCommand.loader();

    try {
      await func.call(context, HUMAN_FLAGS, TRACE_ID);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      expect((error as ContextError).message).toContain("organization");
    }
  });
});

// ============================================================================
// Follow mode — standard (--follow, project-scoped)
//
// Strategy: SIGINT resolves the promise (normal termination). AuthError
// from fetch rejects the promise. Tests use interceptSigint() to capture
// the SIGINT handler and invoke it directly (process.emit("SIGINT")
// kills the Bun test runner).
//
// Follow mode does NOT use withProgress (it has its own streaming banner),
// so withProgress is NOT mocked here.
// ============================================================================

/**
 * Collect all output written to a `process.stderr.write` spy.
 * Handles both string and Buffer arguments from consola/logger.
 */
function collectProcessStderr(
  spy: ReturnType<typeof spyOn<typeof process.stderr, "write">>
): string {
  return spy.mock.calls
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

// ============================================================================
// Flag validation
// ============================================================================

describe("listCommand.func — flag validation", () => {
  test("rejects --sort oldest with --follow", async () => {
    const { context } = createMockContext();
    const func = await listCommand.loader();
    await expect(
      func.call(
        context,
        { json: false, limit: 100, follow: 2, sort: "oldest" },
        "my-org/my-project"
      )
    ).rejects.toThrow(ValidationError);
  });

  test("allows --sort newest with --follow", async () => {
    // Should not throw ValidationError — the error (if any) comes from
    // downstream resolution, not flag validation. Mock resolution to reject
    // with a non-ValidationError so we can verify flag validation passed.
    const resolveOrgProjectSpy = vi
      .spyOn(resolveTarget, "resolveProjectBoundFromArg")
      .mockRejectedValueOnce(
        new ContextError("Organization", "sentry log list")
      );
    const { context } = createMockContext();
    const func = await listCommand.loader();
    await expect(
      func.call(
        context,
        { json: false, limit: 100, follow: 2, sort: "newest" },
        "my-org/my-project"
      )
    ).rejects.not.toThrow(ValidationError);
    resolveOrgProjectSpy.mockRestore();
  });
});

// ============================================================================
// Follow mode — standard (project-scoped)
// ============================================================================

describe("listCommand.func — follow mode (standard)", () => {
  let listLogsSpy: ReturnType<typeof spyOn>;
  let resolveOrgProjectSpy: ReturnType<typeof spyOn>;
  let isPlainSpy: ReturnType<typeof spyOn>;
  let updateNotifSpy: ReturnType<typeof spyOn>;
  let sigint: ReturnType<typeof interceptSigint>;
  let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, "write">>;

  beforeEach(() => {
    sigint = interceptSigint();
    listLogsSpy = vi.spyOn(apiClient, "listLogs");
    resolveOrgProjectSpy = vi.spyOn(
      resolveTarget,
      "resolveProjectBoundFromArg"
    );
    vi.spyOn(resolveTarget, "resolveLogProjectId").mockResolvedValue(undefined);
    isPlainSpy = vi.spyOn(formatters, "isPlainOutput").mockReturnValue(true);
    updateNotifSpy = vi
      .spyOn(versionCheck, "getUpdateNotification")
      .mockReturnValue(null);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    listLogsSpy.mockRestore();
    resolveOrgProjectSpy.mockRestore();
    isPlainSpy.mockRestore();
    updateNotifSpy.mockRestore();
    stderrSpy.mockRestore();
    sigint.restore();
  });

  /** Follow flags with 1-second interval (minimum real-world value) */
  const followFlags = {
    json: false,
    limit: 100,
    follow: 1,
    sort: "newest",
  } as const;

  test("writes initial logs then resolves on SIGINT", async () => {
    listLogsSpy.mockResolvedValueOnce(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, followFlags, `${ORG}/${PROJECT}`);
    await sleep(50);
    sigint.trigger();
    await promise;

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Request received");
  });

  test("converts a bad --query 400 to a ValidationError in follow mode", async () => {
    // The follow-mode fetch closure wraps listLogs with toSearchQueryError, so
    // a bad user --query surfaces as a ValidationError on the initial fetch and
    // terminates the stream instead of being reported as a CLI bug.
    listLogsSpy.mockRejectedValueOnce(
      new ApiError("bad", 400, "Error parsing search query: bad field")
    );
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(
      func.call(
        context,
        { ...followFlags, query: "bad:::query" },
        `${ORG}/${PROJECT}`
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("SIGINT during initial fetch does not start poll loop", async () => {
    // fetchInitial will hang until we resolve it manually
    let resolveFetch!: (logs: typeof sampleLogs) => void;
    listLogsSpy.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, followFlags, `${ORG}/${PROJECT}`);
    await sleep(10);

    // SIGINT fires while fetchInitial is still pending
    sigint.trigger();
    await sleep(10);

    // Now resolve the fetch — the .then() should NOT schedule a poll
    resolveFetch(sampleLogs);
    await promise;

    // If the bug existed, a timer would be scheduled. Wait to confirm none fires.
    await sleep(50);

    // Only 1 call to listLogs (the initial fetch). No poll calls.
    expect(listLogsSpy).toHaveBeenCalledTimes(1);
  });

  test("writes stderr banner in human follow mode", async () => {
    listLogsSpy.mockResolvedValueOnce([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, followFlags, `${ORG}/${PROJECT}`);
    await sleep(50);
    sigint.trigger();
    await promise;

    // Banner now goes through logger → process.stderr
    const stderr = collectProcessStderr(stderrSpy);
    expect(stderr).toContain("Streaming logs");
    expect(stderr).toContain("Ctrl+C");
  });

  test("skips stderr banner in JSON follow mode", async () => {
    listLogsSpy.mockResolvedValueOnce([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(
      context,
      { ...followFlags, json: true },
      `${ORG}/${PROJECT}`
    );
    await sleep(50);
    sigint.trigger();
    await promise;

    // Banner now goes through logger → process.stderr
    const stderr = collectProcessStderr(stderrSpy);
    expect(stderr).not.toContain("Streaming logs");
  });

  test("writes new logs from poll iteration", async () => {
    // Initial: sampleLogs, first poll: newerLogs
    listLogsSpy
      .mockResolvedValueOnce(sampleLogs)
      .mockResolvedValueOnce(newerLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, followFlags, `${ORG}/${PROJECT}`);
    // Wait for initial fetch + poll timer (1s) + poll execution
    await sleep(1200);
    sigint.trigger();
    await promise;

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // Both initial and polled logs should appear
    expect(output).toContain("Request received");
    expect(output).toContain("New poll result");
  });

  test("streams JSON objects per-line in follow mode", async () => {
    listLogsSpy.mockResolvedValueOnce(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(
      context,
      { ...followFlags, json: true },
      `${ORG}/${PROJECT}`
    );
    await sleep(50);
    sigint.trigger();
    await promise;

    // Each log should be written as a separate JSON object (streaming NDJSON)
    const calls = stdoutWrite.mock.calls.map((c) => c[0]);
    const jsonObjects = calls.filter((s: string) => {
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonObjects.length).toBe(3);
  });

  test("rejects with AuthError from initial fetch", async () => {
    listLogsSpy.mockRejectedValueOnce(new AuthError("expired"));
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(
      func.call(context, followFlags, `${ORG}/${PROJECT}`)
    ).rejects.toThrow(AuthError);
  });

  test("rejects with AuthError from poll", async () => {
    listLogsSpy
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new AuthError("expired"));
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(
      func.call(context, followFlags, `${ORG}/${PROJECT}`)
    ).rejects.toThrow(AuthError);
  });

  test("continues polling after transient error (non-auth)", async () => {
    // Initial: empty, poll 1: transient error, then SIGINT
    listLogsSpy
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("network timeout"));
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, followFlags, `${ORG}/${PROJECT}`);
    // Wait for initial fetch + poll timer (1s) + poll execution
    await sleep(1200);
    sigint.trigger();
    await promise;

    // Transient error now goes through logger → process.stderr
    const stderr = collectProcessStderr(stderrSpy);
    expect(stderr).toContain("Error fetching logs");
    expect(stderr).toContain("network timeout");
  });

  test("uses 1m statsPeriod for initial follow fetch", async () => {
    listLogsSpy.mockResolvedValueOnce([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, followFlags, `${ORG}/${PROJECT}`);
    await sleep(50);
    sigint.trigger();
    await promise;

    // Initial fetch should use "1m" (short window for follow mode)
    expect(listLogsSpy.mock.calls[0]).toEqual([
      ORG,
      PROJECT,
      { query: undefined, limit: 100, statsPeriod: "1m" },
    ]);
  });

  test("passes afterTimestamp to poll calls", async () => {
    // maxTimestamp scans the entire batch for the highest timestamp_precise
    const maxTs = Math.max(...sampleLogs.map((l) => l.timestamp_precise));
    listLogsSpy.mockResolvedValueOnce(sampleLogs).mockResolvedValueOnce([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, followFlags, `${ORG}/${PROJECT}`);
    // Wait for initial fetch + poll timer (1s) + poll execution
    await sleep(1200);
    sigint.trigger();
    await promise;

    // Poll call (index 1) should include afterTimestamp from max in batch
    const pollCall = listLogsSpy.mock.calls[1];
    expect(pollCall).toBeDefined();
    expect(pollCall[2].afterTimestamp).toBe(maxTs);
    expect(pollCall[2].statsPeriod).toBe("10m");
  });

  test("shows update notification when available", async () => {
    updateNotifSpy.mockReturnValue("Update available: v2.0.0\n");
    listLogsSpy.mockResolvedValueOnce([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, followFlags, `${ORG}/${PROJECT}`);
    await sleep(50);
    sigint.trigger();
    await promise;

    // Update notification now goes through logger → process.stderr
    const stderr = collectProcessStderr(stderrSpy);
    expect(stderr).toContain("Update available: v2.0.0");
  });
});

// ============================================================================
// Follow mode — trace (--follow + positional trace-id)
// ============================================================================

describe("listCommand.func — follow mode (trace)", () => {
  let listTraceLogsSpy: ReturnType<typeof spyOn>;
  let resolveTraceOrgSpy: ReturnType<typeof spyOn>;
  let warnIfNormalizedSpy: ReturnType<typeof spyOn>;
  let isPlainSpy: ReturnType<typeof spyOn>;
  let updateNotifSpy: ReturnType<typeof spyOn>;
  let sigint: ReturnType<typeof interceptSigint>;
  let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, "write">>;

  beforeEach(() => {
    sigint = interceptSigint();
    listTraceLogsSpy = vi.spyOn(apiClient, "listTraceLogs");
    resolveTraceOrgSpy = vi.spyOn(traceTarget, "resolveTraceOrg");
    warnIfNormalizedSpy = vi
      .spyOn(traceTarget, "warnIfNormalized")
      .mockReturnValue(undefined);
    isPlainSpy = vi.spyOn(formatters, "isPlainOutput").mockReturnValue(true);
    updateNotifSpy = vi
      .spyOn(versionCheck, "getUpdateNotification")
      .mockReturnValue(null);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    listTraceLogsSpy.mockRestore();
    resolveTraceOrgSpy.mockRestore();
    warnIfNormalizedSpy.mockRestore();
    isPlainSpy.mockRestore();
    updateNotifSpy.mockRestore();
    stderrSpy.mockRestore();
    sigint.restore();
  });

  const traceFollowFlags = {
    json: false,
    limit: 100,
    follow: 1,
    sort: "newest",
  } as const;

  test("writes initial trace logs then resolves on SIGINT", async () => {
    listTraceLogsSpy.mockResolvedValueOnce(sampleTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, traceFollowFlags, TRACE_ID);
    await sleep(50);
    sigint.trigger();
    await promise;

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Request received");
  });

  test("writes stderr banner with trace ID in follow mode", async () => {
    listTraceLogsSpy.mockResolvedValueOnce([]);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, traceFollowFlags, TRACE_ID);
    await sleep(50);
    sigint.trigger();
    await promise;

    // Banner now goes through logger → process.stderr
    const stderr = collectProcessStderr(stderrSpy);
    expect(stderr).toContain("Streaming logs");
    expect(stderr).toContain(TRACE_ID);
    expect(stderr).toContain("Ctrl+C");
  });

  test("filters new logs by timestamp_precise (dedup)", async () => {
    // Initial fetch returns logs, poll returns mix of old+new
    const mixedLogs: TraceLog[] = [
      ...sampleTraceLogs, // old — should be filtered out
      ...newerTraceLogs, // new — should pass filter
    ];
    listTraceLogsSpy
      .mockResolvedValueOnce(sampleTraceLogs)
      .mockResolvedValueOnce(mixedLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, traceFollowFlags, TRACE_ID);
    // Wait for initial fetch + poll timer (1s) + poll execution
    await sleep(1200);
    sigint.trigger();
    await promise;

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // New log should appear
    expect(output).toContain("New poll result");
    // Count total log writes — initial 3 + 1 new from poll
    // (old logs from poll are filtered by timestamp_precise)
  });

  test("streams JSON in trace follow mode: first batch as array, then bare items", async () => {
    listTraceLogsSpy
      .mockResolvedValueOnce(sampleTraceLogs)
      .mockResolvedValueOnce(newerTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(
      context,
      { ...traceFollowFlags, json: true },
      TRACE_ID
    );
    // Wait for initial fetch + poll timer (1s) + poll execution
    await sleep(1200);
    sigint.trigger();
    await promise;

    const calls = stdoutWrite.mock.calls.map((c) => c[0]);
    const jsonLines = calls.filter((s: string) => {
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    });
    // First batch: 1 JSON line (envelope with data array from LogListResult)
    // Poll batch: 1 JSON line per item (bare JSONL)
    expect(jsonLines.length).toBe(2);
    // First line is an envelope with data array (the initial trace batch)
    const firstBatch = JSON.parse(jsonLines[0]);
    expect(firstBatch).toHaveProperty("data");
    expect(Array.isArray(firstBatch.data)).toBe(true);
    expect(firstBatch.data).toHaveLength(3);
    // Second line is a bare object (polled item)
    const pollItem = JSON.parse(jsonLines[1]);
    expect(pollItem.message).toBe("New poll result");
  });

  test("rejects with AuthError from poll", async () => {
    listTraceLogsSpy
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new AuthError("expired"));
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(
      func.call(context, traceFollowFlags, TRACE_ID)
    ).rejects.toThrow(AuthError);
  });

  test("continues polling after transient error (trace mode)", async () => {
    listTraceLogsSpy
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("server error"));
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, traceFollowFlags, TRACE_ID);
    // Wait for initial fetch + poll timer (1s) + poll execution
    await sleep(1200);
    sigint.trigger();
    await promise;

    // Transient error now goes through logger → process.stderr
    const stderr = collectProcessStderr(stderrSpy);
    expect(stderr).toContain("Error fetching logs");
    expect(stderr).toContain("server error");
  });

  test("uses 1m statsPeriod for initial trace follow fetch", async () => {
    listTraceLogsSpy.mockResolvedValueOnce([]);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, traceFollowFlags, TRACE_ID);
    await sleep(50);
    sigint.trigger();
    await promise;

    expect(listTraceLogsSpy.mock.calls[0]).toEqual([
      ORG,
      TRACE_ID,
      { query: undefined, limit: 100, statsPeriod: "1m" },
    ]);
  });

  test("does not pass afterTimestamp to trace poll calls (dedup via filter)", async () => {
    listTraceLogsSpy
      .mockResolvedValueOnce(sampleTraceLogs)
      .mockResolvedValueOnce([]);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, traceFollowFlags, TRACE_ID);
    // Wait for initial fetch + poll timer (1s) + poll execution
    await sleep(1200);
    sigint.trigger();
    await promise;

    // Poll call (index 1) should NOT have afterTimestamp
    // (trace-logs endpoint doesn't support it)
    const pollCall = listTraceLogsSpy.mock.calls[1];
    expect(pollCall).toBeDefined();
    expect(pollCall[2].afterTimestamp).toBeUndefined();
    expect(pollCall[2].statsPeriod).toBe("10m");
  });

  test("handles empty initial fetch then new logs in poll", async () => {
    // Initial: empty, poll: new logs
    listTraceLogsSpy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(newerTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();

    const promise = func.call(context, traceFollowFlags, TRACE_ID);
    // Wait for initial fetch + poll timer (1s) + poll execution
    await sleep(1200);
    sigint.trigger();
    await promise;

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("New poll result");
  });
});
