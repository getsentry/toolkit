/**
 * Dashboard Widget Edit Command Tests
 *
 * Tests for the widget edit command in src/commands/dashboard/widget/edit.ts.
 * Uses spyOn pattern to mock API client and resolve-target.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { editCommand } from "../../../../src/commands/dashboard/widget/edit.js";

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

describe("dashboard widget edit", () => {
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

  test("edits widget by index with new display type", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(context, { json: false, index: 0, display: "line" }, "123");

    expect(getDashboardSpy).toHaveBeenCalledWith("acme-corp", "123");
    expect(updateDashboardSpy).toHaveBeenCalledWith(
      "acme-corp",
      "123",
      expect.objectContaining({
        widgets: expect.arrayContaining([
          expect.objectContaining({
            title: "Error Count",
            displayType: "line",
          }),
        ]),
      })
    );
  });

  test("edits widget by title (case-insensitive)", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(
      context,
      { json: false, title: "error count", display: "bar" },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].displayType).toBe("bar");
    expect(body.widgets[0].title).toBe("Error Count");
  });

  test("throws ValidationError when neither --index nor --title provided", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();

    const err = await func
      .call(context, { json: false, display: "line" }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("--index or --title");
  });

  test("throws ValidationError for invalid aggregate", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();

    const err = await func
      .call(context, { json: false, index: 0, query: ["bogus_func"] }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Unknown aggregate function");
  });

  test("preserves existing fields when no query flags provided", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(context, { json: false, index: 1, display: "bar" }, "123");

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const edited = body.widgets[1];
    // Display changed but queries preserved from original
    expect(edited.displayType).toBe("bar");
    expect(edited.queries[0].aggregates).toEqual([
      "p95(span.duration)",
      "count()",
    ]);
    expect(edited.queries[0].columns).toEqual(["span.description"]);
  });

  // The backend validates displayType and widgetType as independent enums —
  // any valid display type is accepted with any valid dataset.

  test("allows --dataset change to issue on big_number widget", async () => {
    getDashboardSpy.mockResolvedValueOnce({
      ...sampleDashboard,
      widgets: [
        {
          title: "Count",
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
      ],
    });
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(
      context,
      { json: false, index: 0, dataset: "issue" },
      "123"
    );
    expect(updateDashboardSpy).toHaveBeenCalledTimes(1);
    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].displayType).toBe("big_number");
    expect(body.widgets[0].widgetType).toBe("issue");
  });

  test("allows --display change to table on preprod-app-size widget", async () => {
    getDashboardSpy.mockResolvedValueOnce({
      ...sampleDashboard,
      widgets: [
        {
          title: "App Size",
          displayType: "line",
          widgetType: "preprod-app-size",
          queries: [
            {
              name: "",
              conditions: "",
              columns: [],
              aggregates: ["max(install_size)"],
              fields: ["max(install_size)"],
            },
          ],
          layout: { x: 0, y: 0, w: 4, h: 2 },
        },
      ],
    });
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(
      context,
      { json: false, index: 0, display: "table" },
      "123"
    );
    expect(updateDashboardSpy).toHaveBeenCalledTimes(1);
    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].displayType).toBe("table");
    expect(body.widgets[0].widgetType).toBe("preprod-app-size");
  });

  test("allows --dataset change on widget with text display type", async () => {
    getDashboardSpy.mockResolvedValueOnce({
      ...sampleDashboard,
      widgets: [
        {
          title: "Notes",
          displayType: "text",
          widgetType: "spans",
          queries: [],
          layout: { x: 0, y: 0, w: 3, h: 2 },
        },
      ],
    });
    const { context } = createMockContext();
    const func = await editCommand.loader();
    // Should not throw — "text" is untracked, no dataset constraint applies
    await func.call(context, { json: false, index: 0, dataset: "logs" }, "123");
    expect(updateDashboardSpy).toHaveBeenCalled();
  });

  test("allows --display change to untracked display type (text)", async () => {
    // Changing --display to an untracked type should also skip cross-validation.
    const { context } = createMockContext();
    const func = await editCommand.loader();
    // sampleDashboard widget[0] is displayType: "big_number", widgetType: "spans"
    // Changing to "text" should not throw even though "text" isn't in spans' supported types.
    await func.call(context, { json: false, index: 0, display: "text" }, "123");
    expect(updateDashboardSpy).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Layout flag tests
  // -------------------------------------------------------------------------

  test("applies --col and --row layout flags to existing widget", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(context, { json: false, index: 0, col: 4, row: 3 }, "123");

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const edited = body.widgets[0];
    expect(edited.layout.x).toBe(4);
    expect(edited.layout.y).toBe(3);
    // Width and height preserved from original
    expect(edited.layout.w).toBe(2);
    expect(edited.layout.h).toBe(1);
  });

  test("applies --width and --height layout flags", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(
      context,
      { json: false, index: 1, col: 0, width: 6, height: 4 },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const edited = body.widgets[1];
    expect(edited.layout.w).toBe(6);
    expect(edited.layout.h).toBe(4);
    expect(edited.layout.x).toBe(0);
    expect(edited.layout.y).toBe(0);
  });

  test("preserves existing layout when no layout flags provided", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(context, { json: false, index: 0, display: "line" }, "123");

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    const edited = body.widgets[0];
    expect(edited.layout).toEqual({ x: 0, y: 0, w: 2, h: 1 });
  });

  test("throws ValidationError for col out of range", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    const err = await func
      .call(context, { json: false, index: 0, col: 6 }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("--col");
  });

  test("throws ValidationError for negative width", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    const err = await func
      .call(context, { json: false, index: 0, width: 0 }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("--width");
  });

  test("throws ValidationError when --col overflows with fallback width on layoutless widget", async () => {
    // Widget without layout uses FALLBACK_LAYOUT (w=3), so --col 4 → 4+3=7 > 6
    getDashboardSpy.mockResolvedValueOnce({
      ...sampleDashboard,
      widgets: [
        {
          title: "No Layout Widget",
          displayType: "line",
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
          // no layout field
        },
      ],
    });
    const { context } = createMockContext();
    const func = await editCommand.loader();
    const err = await func
      .call(context, { json: false, index: 0, col: 4 }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("overflows the grid");
  });

  test("throws ValidationError when col + width overflows grid", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    const err = await func
      .call(context, { json: false, index: 0, col: 4, width: 4 }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("overflows the grid");
  });

  test("validates aggregates against new dataset when --dataset changes", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();

    // "last_seen" is valid for error-events but not spans.
    // Here we change the existing spans widget to error-events dataset while
    // also setting a last_seen aggregate. This should succeed.
    await func.call(
      context,
      {
        json: false,
        index: 0,
        dataset: "error-events",
        query: ["last_seen"],
      },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].widgetType).toBe("error-events");
    expect(body.widgets[0].queries[0].aggregates).toEqual(["last_seen()"]);
  });

  test("resolves --dataset alias 'errors' to 'error-events' in PUT body", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(
      context,
      { json: false, index: 0, dataset: "errors" },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].widgetType).toBe("error-events");
  });

  test("dataset alias is resolved BEFORE dataset-aware aggregate validation", async () => {
    // Regression test for the "aliases resolve too late" bug: last_seen
    // is valid for error-events, so passing --dataset errors --query
    // last_seen must succeed. If the alias is not applied before
    // validateAggregateNames runs, "errors" falls through the canonical
    // branch and "Unknown aggregate function" is thrown.
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(
      context,
      {
        json: false,
        index: 0,
        dataset: "errors",
        query: ["last_seen"],
      },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].widgetType).toBe("error-events");
    expect(body.widgets[0].queries[0].aggregates).toEqual(["last_seen()"]);
  });

  test("case-insensitive --dataset values are accepted", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(context, { json: false, index: 0, dataset: "LOGS" }, "123");

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].widgetType).toBe("logs");
  });

  test("auto-defaults --limit to 5 when adding --group-by without --limit", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();

    // Widget 0 (Error Count) has no existing limit or group-by.
    await func.call(
      context,
      {
        json: false,
        index: 0,
        display: "line",
        "group-by": ["browser.name"],
      },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].limit).toBe(5);
    expect(body.widgets[0].queries[0].columns).toEqual(["browser.name"]);
  });

  test("explicit --limit wins over auto-default when adding --group-by", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();

    // line widgets have no row cap; bar/table cap at 10, which would mask the
    // explicit-limit signal we want to assert.
    await func.call(
      context,
      {
        json: false,
        index: 0,
        display: "line",
        "group-by": ["browser.name"],
        limit: 25,
      },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].limit).toBe(25);
  });

  test("preserves existing limit when adding --group-by to a widget that has one", async () => {
    // Seed an existing widget that already has a limit below any display
    // cap so clamping doesn't hide the preservation signal.
    getDashboardSpy.mockResolvedValueOnce({
      ...sampleDashboard,
      widgets: [
        {
          ...sampleDashboard.widgets[0],
          limit: 8,
        },
        ...sampleDashboard.widgets.slice(1),
      ],
    });

    const { context } = createMockContext();
    const func = await editCommand.loader();
    await func.call(
      context,
      {
        json: false,
        index: 0,
        display: "line",
        "group-by": ["browser.name"],
      },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].limit).toBe(8);
  });

  test("does not auto-default limit when only changing --query on an ungrouped widget", async () => {
    const { context } = createMockContext();
    const func = await editCommand.loader();

    await func.call(
      context,
      { json: false, index: 0, query: ["p95:span.duration"] },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets[0].limit).toBeUndefined();
  });
});
