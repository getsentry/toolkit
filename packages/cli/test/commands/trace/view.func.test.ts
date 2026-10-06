/**
 * Trace View Command Func Tests
 *
 * Tests for the viewCommand func() body and formatTraceView
 * in src/commands/trace/view.ts.
 *
 * Uses spyOn to mock api-client and resolve-target to test
 * the func() body without real HTTP calls or database access.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  flattenSpanTree,
  formatTraceView,
  viewCommand,
} from "../../../src/commands/trace/view.js";

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

vi.mock("../../../src/lib/browser.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/browser.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../src/lib/browser.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";

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
import type { TraceSpan } from "../../../src/types/sentry.js";

// ============================================================================
// formatTraceView
// ============================================================================

describe("formatTraceView", () => {
  const mockSummary = {
    traceId: "abc123",
    duration: 245,
    spanCount: 1,
    projects: ["test-project"],
    startTimestamp: 1_700_000_000,
  };

  test("formats summary and span tree lines", () => {
    const result = formatTraceView({
      summary: mockSummary,
      spans: [],
      spanTreeLines: ["  └─ GET /api/users [245ms]"],
    });

    expect(result).toContain("abc123");
    expect(result).toContain("GET /api/users");
  });

  test("returns only summary when spanTreeLines is undefined", () => {
    const result = formatTraceView({
      summary: mockSummary,
      spans: [],
      spanTreeLines: undefined,
    });

    expect(result).toContain("abc123");
    expect(result).not.toContain("└─");
  });

  test("returns only summary when spanTreeLines is empty", () => {
    const result = formatTraceView({
      summary: mockSummary,
      spans: [],
      spanTreeLines: [],
    });

    expect(result).toContain("abc123");
    expect(result).not.toContain("└─");
  });
});

// ============================================================================
// viewCommand.func()
// ============================================================================

describe("viewCommand.func", () => {
  let getDetailedTraceSpy: ReturnType<typeof spyOn>;
  let fetchMultiSpanDetailsSpy: ReturnType<typeof spyOn>;
  let getIssueByShortIdSpy: ReturnType<typeof spyOn>;
  let getLatestEventSpy: ReturnType<typeof spyOn>;
  let getProjectSpy: ReturnType<typeof spyOn>;
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;
  let openInBrowserSpy: ReturnType<typeof spyOn>;

  const sampleSpans: TraceSpan[] = [
    {
      span_id: "span-root-001",
      op: "http.server",
      description: "GET /api/users",
      transaction: "GET /api/users",
      "transaction.op": "http.server",
      start_timestamp: 1_706_621_535.0,
      end_timestamp: 1_706_621_535.245,
      project_slug: "test-project",
      event_id: "evt001",
      children: [
        {
          span_id: "span-child-001",
          op: "db.query",
          description: "SELECT * FROM users",
          start_timestamp: 1_706_621_535.01,
          end_timestamp: 1_706_621_535.08,
          project_slug: "test-project",
          children: [],
        },
      ],
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

  beforeEach(async () => {
    getDetailedTraceSpy = vi.spyOn(apiClient, "getDetailedTrace");
    fetchMultiSpanDetailsSpy = vi
      .spyOn(apiClient, "fetchMultiSpanDetails")
      .mockResolvedValue(new Map());
    getIssueByShortIdSpy = vi.spyOn(apiClient, "getIssueByShortId");
    getLatestEventSpy = vi.spyOn(apiClient, "getLatestEvent");
    getProjectSpy = vi.spyOn(apiClient, "getProject");
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    resolveOrgAndProjectSpy = vi.spyOn(resolveTarget, "resolveOrgAndProject");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);

    // Mock getProject for explicit org/project/trace-id targets
    getProjectSpy.mockResolvedValue({
      id: "42",
      slug: "test-project",
      name: "Test Project",
    });
  });

  afterEach(() => {
    getDetailedTraceSpy.mockRestore();
    fetchMultiSpanDetailsSpy.mockRestore();
    getIssueByShortIdSpy.mockRestore();
    getLatestEventSpy.mockRestore();
    getProjectSpy.mockRestore();
    findProjectsBySlugSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    openInBrowserSpy.mockRestore();
  });

  test("outputs JSON with summary and spans when --json flag is set", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 100 },
      "test-org/test-project",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("traceId");
    expect(parsed).toHaveProperty("spans");
    expect(parsed.traceId).toBe("aaaa1111bbbb2222cccc3333dddd4444");
    expect(parsed.spans).toHaveLength(1);
  });

  test("writes human output with summary and span tree", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: false, spans: 100 },
      "test-org/test-project",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("aaaa1111bbbb2222cccc3333dddd4444");
    // Explicit org/project triggers project-filtered hint
    expect(output).toContain("Filtered to project");
  });

  test("throws ResolutionError when no spans found", async () => {
    getDetailedTraceSpy.mockResolvedValue([]);

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(
        context,
        { json: false, web: false, spans: 100 },
        "test-org/test-project",
        "00000000000000000000000000000000"
      )
    ).rejects.toThrow(ResolutionError);
  });

  test("error message contains trace ID when not found", async () => {
    getDetailedTraceSpy.mockResolvedValue([]);

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    try {
      await func.call(
        context,
        { json: false, web: false, spans: 100 },
        "test-org/test-project",
        "deadbeef12345678deadbeef12345678"
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).message).toContain(
        "deadbeef12345678deadbeef12345678"
      );
    }
  });

  test("opens browser when --web flag is set", async () => {
    openInBrowserSpy.mockResolvedValue(undefined);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: true, spans: 100 },
      "test-org/test-project",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    expect(openInBrowserSpy).toHaveBeenCalled();
    // Should NOT call getDetailedTrace when using --web
    expect(getDetailedTraceSpy).not.toHaveBeenCalled();
  });

  test("omits span tree when --spans 0", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: false, spans: 0 },
      "test-org/test-project",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // Summary should be present
    expect(output).toContain("aaaa1111bbbb2222cccc3333dddd4444");
    // Span tree details should not appear (no span_id rendered)
    // The footer should still be present (project-filtered hint for explicit target)
    expect(output).toContain("Filtered to project");
  });

  test("calls getDetailedTrace without project for org-scoped target", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await func.call(
      context,
      { json: false, web: false, spans: 100 },
      "my-org/",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    expect(getDetailedTraceSpy).toHaveBeenCalledWith(
      "my-org",
      "aaaa1111bbbb2222cccc3333dddd4444",
      expect.objectContaining({ projectId: undefined })
    );
    expect(getDetailedTraceSpy.mock.calls[0]?.[2]).not.toHaveProperty(
      "timestamp"
    );
  });

  test("throws ContextError when auto-detect cannot resolve a target", async () => {
    // Auto-detect returns null, then guideOrgProjectFailure (picker/enriched
    // error) also cannot resolve a target.
    resolveOrgAndProjectSpy.mockResolvedValue(null);
    vi.spyOn(resolveTarget, "guideOrgProjectFailure").mockRejectedValue(
      new ContextError("Organization and project", "sentry trace view <id>")
    );

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(
        context,
        { json: false, web: false, spans: 100 },
        "aaaa1111bbbb2222cccc3333dddd4444"
      )
    ).rejects.toThrow(ContextError);
  });

  test("resolves project search target", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { slug: "frontend", orgSlug: "acme", id: "1", name: "Frontend" },
      ],
      orgs: [],
    });
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 100 },
      "frontend",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    expect(findProjectsBySlugSpy).toHaveBeenCalledWith("frontend");
  });

  test("logs warning when args appear swapped", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    // Trace ID first (no slash), target second (has slash) → swap detected (line 168-169)
    await func.call(
      context,
      { json: true, web: false, spans: 100 },
      "aaaa1111bbbb2222cccc3333dddd4444",
      "test-org/test-project"
    );

    // Command should complete (warning goes to consola, not stdout)
    expect(getDetailedTraceSpy).toHaveBeenCalled();
  });

  test("logs suggestion when first arg looks like issue short ID", async () => {
    // "CAM-82X" as first arg matches issue short ID pattern.
    // parseOrgProjectArg("CAM-82X") → project-search, so we mock findProjectsBySlug.
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [{ slug: "cam-82x", orgSlug: "cam-org", id: "1", name: "Cam" }],
      orgs: [],
    });
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);
    setOrgRegion("cam-org", DEFAULT_SENTRY_URL);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 100 },
      "CAM-82X",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    // The suggestion path fires (looksLikeIssueShortId("CAM-82X") → true)
    expect(getDetailedTraceSpy).toHaveBeenCalled();
  });

  test("auto-recovers single-arg issue short ID to trace view", async () => {
    const traceIdFromEvent = "eeee1111ffff2222aaaa3333bbbb4444";
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getIssueByShortIdSpy.mockResolvedValue({
      id: "12345",
      shortId: "CLI-G5",
      title: "Test issue",
      project: { slug: "test-project" },
    });
    getLatestEventSpy.mockResolvedValue({
      eventID: "event-abc123",
      contexts: { trace: { trace_id: traceIdFromEvent } },
    });
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { json: true, web: false, spans: 100 }, "CLI-G5");

    expect(resolveOrgSpy).toHaveBeenCalled();
    expect(getIssueByShortIdSpy).toHaveBeenCalledWith("test-org", "CLI-G5");
    expect(getLatestEventSpy).toHaveBeenCalledWith("test-org", "12345");
    expect(getDetailedTraceSpy).toHaveBeenCalledWith(
      "test-org",
      traceIdFromEvent,
      { additionalAttributes: undefined, projectId: undefined }
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("traceId");
  });

  test("auto-recovery throws ValidationError when event has no trace context", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getIssueByShortIdSpy.mockResolvedValue({
      id: "12345",
      shortId: "CLI-G5",
      title: "Test issue",
      project: { slug: "test-project" },
    });
    getLatestEventSpy.mockResolvedValue({
      eventID: "event-abc123",
      contexts: {},
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false, spans: 100 }, "CLI-G5")
    ).rejects.toThrow(ValidationError);
  });

  test("auto-recovery throws ContextError when no org resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false, spans: 100 }, "CLI-G5")
    ).rejects.toThrow(ContextError);
  });

  test("--json auto-enables detail fetching", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 100 },
      "test-org/test-project",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    expect(fetchMultiSpanDetailsSpy).toHaveBeenCalled();
  });

  test("--full flag enables detail fetching in human mode", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, full: true, web: false, spans: 100 },
      "test-org/test-project",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    expect(fetchMultiSpanDetailsSpy).toHaveBeenCalled();
  });

  test("human mode without --full does not fetch details", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: false, spans: 100 },
      "test-org/test-project",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    expect(fetchMultiSpanDetailsSpy).not.toHaveBeenCalled();
  });

  test("--json output includes data dict when details are available", async () => {
    getDetailedTraceSpy.mockResolvedValue(sampleSpans);
    fetchMultiSpanDetailsSpy.mockResolvedValue(
      new Map([
        [
          "span-root-001",
          {
            itemId: "span-root-001",
            timestamp: "2024-01-30T13:32:15Z",
            attributes: [
              { name: "http.url", type: "str", value: "https://example.com" },
              { name: "span.op", type: "str", value: "http.server" },
            ],
            meta: {},
            links: null,
          },
        ],
      ])
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 100 },
      "test-org/test-project",
      "aaaa1111bbbb2222cccc3333dddd4444"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    // Root span should have a data dict with filtered attributes
    const rootSpan = parsed.spans[0];
    expect(rootSpan.data).toBeDefined();
    // http.url should be included (not in REDUNDANT_DETAIL_ATTRS)
    expect(rootSpan.data["http.url"]).toBe("https://example.com");
    // span.op should be filtered out (in REDUNDANT_DETAIL_ATTRS)
    expect(rootSpan.data["span.op"]).toBeUndefined();
  });
});

// ============================================================================
// flattenSpanTree
// ============================================================================

describe("flattenSpanTree", () => {
  test("returns empty array for empty input", () => {
    expect(flattenSpanTree([])).toEqual([]);
  });

  test("returns single span for single root", () => {
    const span: TraceSpan = {
      span_id: "a",
      start_timestamp: 1,
    };
    const result = flattenSpanTree([span]);
    expect(result).toHaveLength(1);
    expect(result[0]?.span_id).toBe("a");
  });

  test("returns all spans in depth-first order", () => {
    const tree: TraceSpan[] = [
      {
        span_id: "root",
        start_timestamp: 1,
        children: [
          {
            span_id: "child-1",
            start_timestamp: 2,
            children: [{ span_id: "grandchild-1", start_timestamp: 3 }],
          },
          { span_id: "child-2", start_timestamp: 4 },
        ],
      },
    ];
    const result = flattenSpanTree(tree);
    const ids = result.map((s) => s.span_id);
    expect(ids).toEqual(["root", "child-1", "grandchild-1", "child-2"]);
  });

  test("handles multiple roots", () => {
    const tree: TraceSpan[] = [
      { span_id: "root-1", start_timestamp: 1 },
      { span_id: "root-2", start_timestamp: 2 },
    ];
    const result = flattenSpanTree(tree);
    expect(result).toHaveLength(2);
    expect(result[0]?.span_id).toBe("root-1");
    expect(result[1]?.span_id).toBe("root-2");
  });

  test("handles spans with empty children array", () => {
    const tree: TraceSpan[] = [
      { span_id: "root", start_timestamp: 1, children: [] },
    ];
    const result = flattenSpanTree(tree);
    expect(result).toHaveLength(1);
  });
});
