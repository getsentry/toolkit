/**
 * Dashboard Widget Add Command Tests
 *
 * Tests for the widget add command in src/commands/dashboard/widget/add.ts.
 * Uses spyOn pattern to mock API client and resolve-target.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { addCommand } from "../../../../src/commands/dashboard/widget/add.js";

vi.mock("../../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
import { ValidationError } from "../../../../src/lib/errors.js";

vi.mock("../../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/lib/resolve-target.js")
    >();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../../src/lib/resolve-target.js";
import type { DashboardDetail } from "../../../../src/types/dashboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(cwd = "/tmp") {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd,
    },
    stdoutWrite,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const sampleDashboard: DashboardDetail = {
  id: "123",
  title: "My Dashboard",
  widgets: [
    {
      title: "Error Count",
      displayType: "big_number",
      widgetType: "spans",
      queries: [
        {
          name: "",
          conditions: "",
          columns: [],
          aggregates: ["count()"],
          fields: ["count()"],
        },
      ],
      layout: { x: 0, y: 0, w: 2, h: 1 },
    },
    {
      title: "Slow Spans",
      displayType: "table",
      widgetType: "spans",
      queries: [
        {
          name: "",
          conditions: "",
          columns: ["span.description"],
          aggregates: ["p95(span.duration)", "count()"],
          fields: ["span.description", "p95(span.duration)", "count()"],
        },
      ],
      layout: { x: 2, y: 0, w: 4, h: 2 },
    },
  ],
  dateCreated: "2026-03-01T10:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboard widget add", () => {
  let getDashboardSpy: ReturnType<typeof spyOn>;
  let updateDashboardSpy: ReturnType<typeof spyOn>;
  let resolveOrgOnlyTargetSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getDashboardSpy = vi.spyOn(apiClient, "getDashboard");
    updateDashboardSpy = vi.spyOn(apiClient, "updateDashboard");
    resolveOrgOnlyTargetSpy = vi.spyOn(resolveTarget, "resolveOrgOnlyTarget");

    // Default mocks
    resolveOrgOnlyTargetSpy.mockResolvedValue("acme-corp");
    getDashboardSpy.mockResolvedValue(sampleDashboard);
    updateDashboardSpy.mockImplementation(async (_org, _id, body) => ({
      ...sampleDashboard,
      widgets: body.widgets,
    }));
  });

  afterEach(() => {
    getDashboardSpy.mockRestore();
    updateDashboardSpy.mockRestore();
    resolveOrgOnlyTargetSpy.mockRestore();
  });

  test("adds widget with correct API args (getDashboard then updateDashboard)", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      { json: false, display: "line", query: ["count"] },
      "123",
      "New Widget"
    );

    expect(getDashboardSpy).toHaveBeenCalledWith("acme-corp", "123");
    expect(updateDashboardSpy).toHaveBeenCalledWith(
      "acme-corp",
      "123",
      expect.objectContaining({
        title: "My Dashboard",
        widgets: expect.arrayContaining([
          expect.objectContaining({ title: "New Widget", displayType: "line" }),
        ]),
      })
    );
    // Original widgets should be preserved plus the new one
    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets.length).toBe(3);
  });

  test("JSON output contains dashboard, widget, and url", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      { json: true, display: "big_number", query: ["count"] },
      "123",
      "My Counter"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.dashboard).toBeDefined();
    expect(parsed.widget).toBeDefined();
    expect(parsed.widget.title).toBe("My Counter");
    expect(parsed.url).toContain("dashboard/123");
  });

  test("human output contains 'Added widget' and title", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      { json: false, display: "line", query: ["count"] },
      "123",
      "Error Rate"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Added widget");
    expect(output).toContain("Error Rate");
  });

  test("throws ValidationError when title is missing (less than 2 positional args)", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();

    const err = await func
      .call(context, { json: false, display: "line" }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Widget title is required");
  });

  test("throws ValidationError for invalid display type", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();

    const err = await func
      .call(
        context,
        { json: false, display: "invalid_type" },
        "123",
        "Bad Widget"
      )
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Invalid --display");
  });

  test("throws ValidationError for invalid aggregate function", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();

    const err = await func
      .call(
        context,
        { json: false, display: "line", query: ["not_a_function"] },
        "123",
        "Bad Widget"
      )
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Unknown aggregate function");
  });

  test("issue line dataset does not default columns", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      { json: false, display: "line", dataset: "issue" },
      "123",
      "Issues Over Time"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.queries[0].columns).toEqual([]);
  });

  test("issue dataset defaults columns to ['issue'] and orderby to -count()", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      { json: false, display: "table", dataset: "issue" },
      "123",
      "Top Issues"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.queries[0].columns).toEqual(["issue"]);
    expect(addedWidget.queries[0].fields).toContain("issue");
    expect(addedWidget.queries[0].orderby).toBe("-count()");
  });

  test("resolves dataset alias 'errors' to 'error-events' in PUT body", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "big_number",
        dataset: "errors",
        query: ["count"],
      },
      "123",
      "Error Count"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.widgetType).toBe("error-events");
  });

  test("resolves dataset alias 'metricsEnhanced' to 'tracemetrics'", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "line",
        dataset: "metricsEnhanced",
        query: ["p50(value,completion.duration_ms,distribution,none)"],
      },
      "123",
      "Latency"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.widgetType).toBe("tracemetrics");
  });

  test("dataset alias is resolved BEFORE dataset-aware aggregate validation", async () => {
    // last_seen is only valid for error-events. With the alias
    // "errors", dataset-aware validation must see "error-events" (canonical)
    // before deciding whether to accept the aggregate.
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "big_number",
        dataset: "errors",
        query: ["last_seen"],
      },
      "123",
      "Last Seen"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.widgetType).toBe("error-events");
    expect(addedWidget.queries[0].aggregates).toEqual(["last_seen()"]);
  });

  test("case-insensitive dataset values are accepted", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "big_number",
        dataset: "ERRORS",
        query: ["count"],
      },
      "123",
      "Errors"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.widgetType).toBe("error-events");
  });

  test("rejects unknown --dataset with canonical list", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();

    const err = await func
      .call(
        context,
        {
          json: false,
          display: "big_number",
          dataset: "bogus-dataset",
          query: ["count"],
        },
        "123",
        "Bad"
      )
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(ValidationError);
    // Error message surfaces the normalized (lowercased) value.
    expect(err.message).toContain("bogus-dataset");
    expect(err.message).toContain("Valid datasets:");
  });

  test("issue dataset respects explicit --group-by over default", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "table",
        dataset: "issue",
        "group-by": ["project"],
        limit: 5,
      },
      "123",
      "Issues by Project"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.queries[0].columns).toEqual(["project"]);
  });

  // -------------------------------------------------------------------------
  // Layout flag tests
  // -------------------------------------------------------------------------

  test("uses explicit layout when --col --row --width --height provided", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "line",
        query: ["count"],
        col: 0,
        row: 5,
        width: 6,
        height: 3,
      },
      "123",
      "Full Width Widget"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.layout.x).toBe(0);
    expect(addedWidget.layout.y).toBe(5);
    expect(addedWidget.layout.w).toBe(6);
    expect(addedWidget.layout.h).toBe(3);
  });

  test("partial layout flags override auto-layout defaults", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "big_number",
        query: ["count"],
        col: 4,
      },
      "123",
      "Positioned Counter"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    // x overridden, other values from auto-layout defaults for big_number (w:2, h:1)
    expect(addedWidget.layout.x).toBe(4);
    expect(addedWidget.layout.w).toBe(2);
    expect(addedWidget.layout.h).toBe(1);
  });

  test("throws ValidationError for width > 6", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    const err = await func
      .call(
        context,
        { json: false, display: "line", query: ["count"], width: 7 },
        "123",
        "Too Wide"
      )
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("--width");
  });

  test("throws ValidationError when --col overflows with auto-layout default width", async () => {
    // table display defaults to w=6, so --col 1 would produce x=1 + w=6 = 7 > 6
    const { context } = createMockContext();
    const func = await addCommand.loader();
    const err = await func
      .call(
        context,
        { json: false, display: "table", query: ["count"], col: 1 },
        "123",
        "Wide Table"
      )
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("overflows the grid");
  });

  test("throws ValidationError for negative row", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    const err = await func
      .call(
        context,
        { json: false, display: "line", query: ["count"], row: -1 },
        "123",
        "Bad Y"
      )
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("--row");
  });

  test("auto-defaults orderby when group-by + limit provided", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "bar",
        query: ["count"],
        "group-by": ["browser.name"],
        limit: 5,
      },
      "123",
      "Top Browsers"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.queries[0].orderby).toBe("-count()");
  });

  test("auto-defaults --limit to 5 when --group-by is used without --limit", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "line",
        query: ["count"],
        "group-by": ["browser.name"],
      },
      "123",
      "Top Browsers"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.limit).toBe(5);
    expect(addedWidget.queries[0].columns).toEqual(["browser.name"]);
    expect(addedWidget.queries[0].orderby).toBe("-count()");
  });

  test("explicit --limit wins over auto-default for grouped widgets", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "bar",
        query: ["count"],
        "group-by": ["browser.name"],
        limit: 10,
      },
      "123",
      "Top Browsers"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.limit).toBe(10);
  });

  test("ungrouped widget does not get an auto-default limit", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      { json: false, display: "big_number", query: ["count"] },
      "123",
      "Total Count"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.limit).toBeUndefined();
  });

  test("issue-dataset table default columns do NOT trigger auto-default limit", async () => {
    // Regression guard: the issue/table combo auto-defaults columns to
    // ["issue"] but should not auto-default a limit — existing widgets of
    // this shape may legitimately have no limit.
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      { json: false, display: "table", dataset: "issue" },
      "123",
      "Top Issues"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    expect(addedWidget.limit).toBeUndefined();
  });

  // -- Layout mode flag tests -----------------------------------------------

  test("--layout dense passes dense mode to auto-placer", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      { json: false, display: "big_number", query: ["count"], layout: "dense" },
      "123",
      "Dense Widget"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    // Existing widgets: big_number at (0,0,2,1) and table at (2,0,4,2).
    // Dense mode finds the first gap. The gap at (0,1) fits a 2x1 big_number.
    expect(addedWidget.layout.x).toBe(0);
    expect(addedWidget.layout.y).toBe(1);
  });

  test("--layout sequential (default) uses sequential placement", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    await func.call(
      context,
      {
        json: false,
        display: "big_number",
        query: ["count"],
        layout: "sequential",
      },
      "123",
      "Sequential Widget"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const addedWidget = body.widgets.at(-1);
    // Existing widgets: big_number at (0,0,2,1) and table at (2,0,4,2).
    // Last widget is table at x=2,w=4 → cursor=(6,0) → 6+2=8 > 6 → wrap to (0,2).
    expect(addedWidget.layout.x).toBe(0);
    expect(addedWidget.layout.y).toBe(2);
  });

  test("--layout invalid rejects with ValidationError", async () => {
    const { context } = createMockContext();
    const func = await addCommand.loader();
    const err = await func
      .call(
        context,
        {
          json: false,
          display: "big_number",
          query: ["count"],
          layout: "invalid",
        },
        "123",
        "Bad Layout"
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain("--layout");
  });
});
