/**
 * Dashboard Widget Delete Command Tests
 *
 * Tests for the widget delete command in src/commands/dashboard/widget/delete.ts.
 * Uses spyOn pattern to mock API client and resolve-target.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { deleteCommand } from "../../../../src/commands/dashboard/widget/delete.js";

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

describe("dashboard widget delete", () => {
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

  test("deletes widget by index", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, { json: false, yes: true, index: 0 }, "123");

    expect(getDashboardSpy).toHaveBeenCalledWith("acme-corp", "123");
    expect(updateDashboardSpy).toHaveBeenCalledWith(
      "acme-corp",
      "123",
      expect.objectContaining({
        widgets: expect.not.arrayContaining([
          expect.objectContaining({ title: "Error Count" }),
        ]),
      })
    );
    // Only one widget should remain after deleting index 0
    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets.length).toBe(1);
    expect(body.widgets[0].title).toBe("Slow Spans");
  });

  test("deletes widget by title", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { json: false, yes: true, title: "Slow Spans" },
      "123"
    );

    const body = updateDashboardSpy.mock.calls[0]?.[2];
    expect(body.widgets.length).toBe(1);
    expect(body.widgets[0].title).toBe("Error Count");
  });

  test("throws ValidationError when neither --index nor --title provided", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    const err = await func
      .call(context, { json: false, yes: true }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("--index or --title");
  });

  test("throws ValidationError when index is out of range", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    const err = await func
      .call(context, { json: false, yes: true, index: 99 }, "123")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("out of range");
  });

  test("human output contains 'Removed widget' and title", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, { json: false, yes: true, index: 0 }, "123");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Removed widget");
    expect(output).toContain("Error Count");
  });
});
