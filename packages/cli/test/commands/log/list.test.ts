/**
 * Log List Command Tests
 *
 * Tests for the `sentry log list` command func() body, covering:
 * - Standard project-scoped mode (positional org/project)
 * - Trace-filtered mode (positional 32-char hex trace-id)
 * - Positional argument disambiguation (trace vs project)
 * - Period flag behavior
 * - The removed --follow flag pointing at `sentry log tail`
 *
 * Uses spyOn mocking to avoid real HTTP calls or database access.
 * Tests mock `withProgress` from `polling.ts` to bypass the spinner.
 * Streaming lives in `sentry log tail`, tested in tail.test.ts.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { listCommand } from "../../../src/commands/log/list.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  const { mockFunctionExports } = await import("../../mock-exports.js");
  return mockFunctionExports(actual);
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/auth.js")>();
  const { mockFunctionExports } = await import("../../mock-exports.js");
  return mockFunctionExports(actual);
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";
import {
  ApiError,
  ContextError,
  ValidationError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/polling.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/polling.js")>();
  const { mockFunctionExports } = await import("../../mock-exports.js");
  return mockFunctionExports(actual);
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as polling from "../../../src/lib/polling.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  const { mockFunctionExports } = await import("../../mock-exports.js");
  return mockFunctionExports(actual);
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { parsePeriod } from "../../../src/lib/time-range.js";

vi.mock("../../../src/lib/trace-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/trace-target.js")>();
  const { mockFunctionExports } = await import("../../mock-exports.js");
  return mockFunctionExports(actual);
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as traceTarget from "../../../src/lib/trace-target.js";

import type { SentryLog, TraceLog } from "../../../src/types/sentry.js";
import { loadCommand, passthroughWithProgress } from "../../helpers.js";
import type { Writer } from "../../../src/types/index.js";

// ============================================================================
// Helpers
// ============================================================================

const TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";
const ORG = "test-org";
const PROJECT = "test-project";

function createMockContext() {
  const stdoutWrite = vi.fn<Writer["write"]>(() => true);
  const stderrWrite = vi.fn<Writer["write"]>(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd: "/tmp",
      process: {},
    },
    stdoutWrite,
    stderrWrite,
  };
}

/** Standard flags for batch mode (period omitted = use mode default) */
const BATCH_FLAGS = {
  json: true,
  limit: 100,
  sort: "newest",
} as const;

/** Human-mode flags for batch mode (period omitted = use mode default) */
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

// ============================================================================
// Auth setup — mock getAuthConfig for all tests (auth guard added in #611)
// ============================================================================

let getAuthConfigSpy: MockInstance<(typeof dbAuth)["getAuthConfig"]>;

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
  let listLogsSpy: MockInstance<(typeof apiClient)["listLogs"]>;
  let resolveOrgProjectSpy: MockInstance<
    (typeof resolveTarget)["resolveProjectBoundTarget"]
  >;
  let withProgressSpy: MockInstance<(typeof polling)["withProgress"]>;

  beforeEach(() => {
    listLogsSpy = vi.spyOn(apiClient, "listLogs");
    resolveOrgProjectSpy = vi.spyOn(resolveTarget, "resolveProjectBoundTarget");
    vi.spyOn(resolveTarget, "resolveLogProjectId").mockResolvedValue(undefined);
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(passthroughWithProgress);
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
    const func = await loadCommand(listCommand);
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
    const func = await loadCommand(listCommand);
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
    const func = await loadCommand(listCommand);
    await func.call(
      context,
      { ...BATCH_FLAGS, sort: "oldest" },
      `${ORG}/${PROJECT}`,
    );

    // sort=oldest is passed to API for server-side sorting
    expect(listLogsSpy).toHaveBeenCalledWith(
      ORG,
      PROJECT,
      expect.objectContaining({ sort: "oldest" }),
    );
  });

  test("shows 'No logs found' for empty result (human mode)", async () => {
    listLogsSpy.mockResolvedValue([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(context, HUMAN_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No logs found");
  });

  test("renders log messages in human output", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
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
    const func = await loadCommand(listCommand);
    await func.call(context, HUMAN_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Showing 3 log");
  });

  test("shows --limit tip when results match limit", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
    // limit equals number of returned logs → hasMore = true
    await func.call(context, { json: false, limit: 3 }, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Use --limit to show more");
  });

  test("does not show tip when fewer results than limit", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(context, HUMAN_FLAGS, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).not.toContain("Use --limit to show more");
  });

  test("passes query, limit, and period to listLogs", async () => {
    listLogsSpy.mockResolvedValue([]);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(
      context,
      { json: false, limit: 50, query: "severity:error", sort: "newest" },
      `${ORG}/${PROJECT}`,
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
      new ApiError("bad", 400, "Error parsing search query: bad field"),
    );
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await expect(
      func.call(
        context,
        { json: false, limit: 50, query: "bad:::query", sort: "newest" },
        `${ORG}/${PROJECT}`,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("keeps a search-query parse 400 as a reported ApiError with no --query (project single-fetch)", async () => {
    listLogsSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad field"),
    );
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await expect(
      func.call(
        context,
        { json: false, limit: 50, sort: "newest" },
        `${ORG}/${PROJECT}`,
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("hasMore is true when results match limit", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(context, { json: true, limit: 3 }, `${ORG}/${PROJECT}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(true);
  });

  test("hasMore is false when fewer results than limit", async () => {
    listLogsSpy.mockResolvedValue(sampleLogs);
    resolveOrgProjectSpy.mockResolvedValue({ org: ORG, project: PROJECT });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
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
  let listTraceLogsSpy: MockInstance<(typeof apiClient)["listTraceLogs"]>;
  let resolveTraceOrgSpy: MockInstance<(typeof traceTarget)["resolveTraceOrg"]>;
  let warnIfNormalizedSpy: MockInstance<
    (typeof traceTarget)["warnIfNormalized"]
  >;
  let withProgressSpy: MockInstance<(typeof polling)["withProgress"]>;

  beforeEach(() => {
    listTraceLogsSpy = vi.spyOn(apiClient, "listTraceLogs");
    resolveTraceOrgSpy = vi.spyOn(traceTarget, "resolveTraceOrg");
    warnIfNormalizedSpy = vi
      .spyOn(traceTarget, "warnIfNormalized")
      .mockReturnValue(undefined);
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(passthroughWithProgress);
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
    const func = await loadCommand(listCommand);
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
      new ApiError("bad", 400, "Error parsing search query: bad field"),
    );
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await expect(
      func.call(context, { ...BATCH_FLAGS, query: "bad:::query" }, TRACE_ID),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("keeps a search-query parse 400 as a reported ApiError with no --query (trace single-fetch)", async () => {
    listTraceLogsSpy.mockRejectedValue(
      new ApiError("bad", 400, "Error parsing search query: bad field"),
    );
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await expect(
      func.call(context, BATCH_FLAGS, TRACE_ID),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("outputs JSON in newest-first order by default (trace mode)", async () => {
    const newestFirst = [...sampleTraceLogs].reverse();
    listTraceLogsSpy.mockResolvedValue(newestFirst);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
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
    const func = await loadCommand(listCommand);
    await func.call(context, HUMAN_FLAGS, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No logs found");
    expect(output).toContain(TRACE_ID);
  });

  test("renders trace log messages in human output", async () => {
    listTraceLogsSpy.mockResolvedValue(sampleTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
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
    const func = await loadCommand(listCommand);
    await func.call(context, HUMAN_FLAGS, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Showing 3 log");
    expect(output).toContain(TRACE_ID);
  });

  test("shows --limit tip when trace results match limit", async () => {
    listTraceLogsSpy.mockResolvedValue(sampleTraceLogs);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context, stdoutWrite } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(context, { json: false, limit: 3 }, TRACE_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Use --limit to show more.");
  });

  test("passes traceId, limit, and query to listTraceLogs with 14d default", async () => {
    listTraceLogsSpy.mockResolvedValue([]);
    resolveTraceOrgSpy.mockResolvedValue({ traceId: TRACE_ID, org: ORG });

    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(
      context,
      { json: false, limit: 50, query: "severity:error", sort: "newest" },
      TRACE_ID,
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
    const func = await loadCommand(listCommand);
    await func.call(context, BATCH_FLAGS, `my-org/${TRACE_ID}`);

    // resolveTraceOrg receives the parsed ParsedTraceTarget
    expect(resolveTraceOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "org-scoped",
        org: "my-org",
        traceId: TRACE_ID,
      }),
      "/tmp",
      "log list",
      expect.any(String),
    );
  });
});

// ============================================================================
// Positional argument disambiguation
// ============================================================================

describe("listCommand.func — positional disambiguation", () => {
  let listLogsSpy: MockInstance<(typeof apiClient)["listLogs"]>;
  let listTraceLogsSpy: MockInstance<(typeof apiClient)["listTraceLogs"]>;
  let resolveOrgProjectSpy: MockInstance<
    (typeof resolveTarget)["resolveProjectBoundTarget"]
  >;
  let resolveTraceOrgSpy: MockInstance<(typeof traceTarget)["resolveTraceOrg"]>;
  let warnIfNormalizedSpy: MockInstance<
    (typeof traceTarget)["warnIfNormalized"]
  >;
  let withProgressSpy: MockInstance<(typeof polling)["withProgress"]>;

  beforeEach(() => {
    listLogsSpy = vi.spyOn(apiClient, "listLogs").mockResolvedValue([]);
    listTraceLogsSpy = vi
      .spyOn(apiClient, "listTraceLogs")
      .mockResolvedValue([]);
    resolveOrgProjectSpy = vi
      .spyOn(resolveTarget, "resolveProjectBoundTarget")
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
      .mockImplementation(passthroughWithProgress);
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
    const func = await loadCommand(listCommand);
    await func.call(context, BATCH_FLAGS, TRACE_ID);

    expect(listTraceLogsSpy).toHaveBeenCalled();
    expect(listLogsSpy).not.toHaveBeenCalled();
  });

  test("non-hex string triggers project mode", async () => {
    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(context, BATCH_FLAGS, `${ORG}/${PROJECT}`);

    expect(listLogsSpy).toHaveBeenCalled();
    expect(listTraceLogsSpy).not.toHaveBeenCalled();
  });

  test("org/trace-id triggers trace mode", async () => {
    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(context, BATCH_FLAGS, `${ORG}/${TRACE_ID}`);

    expect(listTraceLogsSpy).toHaveBeenCalled();
    expect(listLogsSpy).not.toHaveBeenCalled();
  });

  test("org/project (non-hex) triggers project mode", async () => {
    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(context, BATCH_FLAGS, "my-org/my-project");

    expect(listLogsSpy).toHaveBeenCalled();
    expect(listTraceLogsSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Period flag behavior
// ============================================================================

describe("listCommand.func — period flag", () => {
  let listTraceLogsSpy: MockInstance<(typeof apiClient)["listTraceLogs"]>;
  let resolveTraceOrgSpy: MockInstance<(typeof traceTarget)["resolveTraceOrg"]>;
  let warnIfNormalizedSpy: MockInstance<
    (typeof traceTarget)["warnIfNormalized"]
  >;
  let withProgressSpy: MockInstance<(typeof polling)["withProgress"]>;

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
      .mockImplementation(passthroughWithProgress);
  });

  afterEach(() => {
    listTraceLogsSpy.mockRestore();
    resolveTraceOrgSpy.mockRestore();
    warnIfNormalizedSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  test("trace mode uses 14d default when period is omitted", async () => {
    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    await func.call(
      context,
      { json: true, limit: 100, sort: "newest" },
      TRACE_ID,
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
    const func = await loadCommand(listCommand);
    await func.call(
      context,
      { json: true, limit: 100, period: parsePeriod("30d"), sort: "newest" },
      TRACE_ID,
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
  let resolveTraceOrgSpy: MockInstance<(typeof traceTarget)["resolveTraceOrg"]>;
  let warnIfNormalizedSpy: MockInstance<
    (typeof traceTarget)["warnIfNormalized"]
  >;
  let withProgressSpy: MockInstance<(typeof polling)["withProgress"]>;

  beforeEach(() => {
    resolveTraceOrgSpy = vi.spyOn(traceTarget, "resolveTraceOrg");
    warnIfNormalizedSpy = vi
      .spyOn(traceTarget, "warnIfNormalized")
      .mockReturnValue(undefined);
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(passthroughWithProgress);
  });

  afterEach(() => {
    resolveTraceOrgSpy.mockRestore();
    warnIfNormalizedSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  test("throws ContextError when org cannot be resolved", async () => {
    resolveTraceOrgSpy.mockRejectedValue(
      new ContextError("Organization", "sentry log list [<org>/]<trace-id>"),
    );

    const { context } = createMockContext();
    const func = await loadCommand(listCommand);

    await expect(func.call(context, HUMAN_FLAGS, TRACE_ID)).rejects.toThrow(
      ContextError,
    );
  });

  test("ContextError mentions Organization", async () => {
    resolveTraceOrgSpy.mockRejectedValue(
      new ContextError("Organization", "sentry log list [<org>/]<trace-id>"),
    );

    const { context } = createMockContext();
    const func = await loadCommand(listCommand);

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
// Removed --follow flag
// ============================================================================

describe("listCommand.func — removed --follow", () => {
  test("points at sentry log tail before resolving anything", async () => {
    const resolveSpy = vi.spyOn(resolveTarget, "resolveProjectBoundTarget");
    const { context } = createMockContext();
    const func = await loadCommand(listCommand);
    const error = await func
      .call(context, { ...HUMAN_FLAGS, follow: "" }, `${ORG}/${PROJECT}`)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain("log tail");
    expect(resolveSpy).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
  });
});
