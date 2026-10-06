/**
 * Dashboard API helper tests
 *
 * Tests for periodToSeconds, computeOptimalInterval, and queryAllWidgets
 * from src/lib/api/dashboards.ts.
 */

import { describe, expect, test, vi } from "vitest";
import {
  computeOptimalInterval,
  periodToSeconds,
  queryAllWidgets,
  restoreDashboardRevision,
} from "../../../src/lib/api/dashboards.js";
import type {
  DashboardDetail,
  DashboardWidget,
} from "../../../src/types/dashboard.js";

const { apiRequestToRegionMock, resolveOrgRegionMock } = vi.hoisted(() => ({
  apiRequestToRegionMock: vi.fn(),
  resolveOrgRegionMock: vi.fn(),
}));

vi.mock("../../../src/lib/region.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/region.js")>();
  return { ...actual, resolveOrgRegion: resolveOrgRegionMock };
});

vi.mock("../../../src/lib/api/infrastructure.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/api/infrastructure.js")
    >();
  return { ...actual, apiRequestToRegion: apiRequestToRegionMock };
});

// ---------------------------------------------------------------------------
// restoreDashboardRevision
// ---------------------------------------------------------------------------

describe("restoreDashboardRevision", () => {
  test("posts to the revision restore endpoint", async () => {
    const dashboard = {
      id: "123",
      title: "Restored Dashboard",
      widgets: [],
    } as DashboardDetail;
    resolveOrgRegionMock.mockResolvedValue("https://us.sentry.io");
    apiRequestToRegionMock.mockResolvedValue({ data: dashboard });

    await expect(
      restoreDashboardRevision("test-org", "123", "42")
    ).resolves.toBe(dashboard);

    expect(apiRequestToRegionMock).toHaveBeenCalledWith(
      "https://us.sentry.io",
      "/organizations/test-org/dashboards/123/revisions/42/restore/",
      expect.objectContaining({ method: "POST" })
    );
  });
});

// ---------------------------------------------------------------------------
// periodToSeconds
// ---------------------------------------------------------------------------

describe("periodToSeconds", () => {
  test("parses seconds", () => {
    expect(periodToSeconds("30s")).toBe(30);
    expect(periodToSeconds("1s")).toBe(1);
  });

  test("parses minutes", () => {
    expect(periodToSeconds("1m")).toBe(60);
    expect(periodToSeconds("5m")).toBe(300);
    expect(periodToSeconds("30m")).toBe(1800);
  });

  test("parses hours", () => {
    expect(periodToSeconds("1h")).toBe(3600);
    expect(periodToSeconds("24h")).toBe(86_400);
    expect(periodToSeconds("4h")).toBe(14_400);
  });

  test("parses days", () => {
    expect(periodToSeconds("1d")).toBe(86_400);
    expect(periodToSeconds("7d")).toBe(604_800);
    expect(periodToSeconds("14d")).toBe(1_209_600);
    expect(periodToSeconds("90d")).toBe(7_776_000);
  });

  test("parses weeks", () => {
    expect(periodToSeconds("1w")).toBe(604_800);
    expect(periodToSeconds("2w")).toBe(1_209_600);
  });

  test("returns undefined for invalid input", () => {
    expect(periodToSeconds("")).toBeUndefined();
    expect(periodToSeconds("abc")).toBeUndefined();
    expect(periodToSeconds("24")).toBeUndefined();
    expect(periodToSeconds("h")).toBeUndefined();
    expect(periodToSeconds("24x")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeOptimalInterval
// ---------------------------------------------------------------------------

/** Build a minimal widget with optional layout width. */
function makeWidget(layoutW?: number, interval?: string): DashboardWidget {
  return {
    title: "Test Widget",
    displayType: "line",
    layout:
      layoutW !== undefined ? { x: 0, y: 0, w: layoutW, h: 2 } : undefined,
    interval,
  } as DashboardWidget;
}

describe("computeOptimalInterval", () => {
  test("returns a valid Sentry interval string", () => {
    const validIntervals = new Set([
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
      "4h",
      "12h",
      "1d",
    ]);
    const result = computeOptimalInterval("24h", makeWidget(2));
    expect(result).toBeDefined();
    expect(validIntervals.has(result!)).toBe(true);
  });

  test("shorter periods produce finer intervals", () => {
    const interval24h = computeOptimalInterval("24h", makeWidget(2));
    const interval7d = computeOptimalInterval("7d", makeWidget(2));
    const interval90d = computeOptimalInterval("90d", makeWidget(2));

    // Convert back to seconds for comparison
    const sec24h = periodToSeconds(interval24h!) ?? 0;
    const sec7d = periodToSeconds(interval7d!) ?? 0;
    const sec90d = periodToSeconds(interval90d!) ?? 0;

    expect(sec24h).toBeLessThanOrEqual(sec7d);
    expect(sec7d).toBeLessThanOrEqual(sec90d);
  });

  test("wider widgets produce finer intervals", () => {
    const narrow = computeOptimalInterval("24h", makeWidget(1));
    const wide = computeOptimalInterval("24h", makeWidget(6));

    const secNarrow = periodToSeconds(narrow!) ?? 0;
    const secWide = periodToSeconds(wide!) ?? 0;

    // Wider widget has more columns → finer interval
    expect(secWide).toBeLessThanOrEqual(secNarrow);
  });

  test("falls back to widget interval for invalid period", () => {
    const widget = makeWidget(2, "5m");
    expect(computeOptimalInterval("invalid", widget)).toBe("5m");
  });

  test("falls back to widget interval when no layout", () => {
    const widget = makeWidget(undefined, "15m");
    // Without layout, uses default GRID_COLS (full width) — still computes
    const result = computeOptimalInterval("24h", widget);
    expect(result).toBeDefined();
  });

  test("never returns undefined for valid periods", () => {
    const periods = ["1h", "24h", "7d", "14d", "90d"];
    for (const period of periods) {
      const result = computeOptimalInterval(period, makeWidget(2));
      expect(result).toBeDefined();
    }
  });

  test("returns 1m as floor for very short periods", () => {
    // 1h / ~40 cols ≈ 90s → should pick "1m" (finest available)
    const result = computeOptimalInterval("1h", makeWidget(2));
    expect(result).toBe("1m");
  });
});

// ---------------------------------------------------------------------------
// queryAllWidgets — text widget handling
// ---------------------------------------------------------------------------

/**
 * Build a minimal DashboardDetail with the given widgets.
 *
 * Text widgets carry markdown in `description` (a passthrough field not in
 * the typed schema), so widgets are cast via `as any`.
 */
function makeDashboard(widgets: Record<string, unknown>[]): DashboardDetail {
  return { id: "1", title: "Test Dashboard", widgets } as DashboardDetail;
}

describe("queryAllWidgets", () => {
  // Text widgets return immediately — no API call, no mocking needed.
  // regionUrl and orgSlug are unused for text widgets.
  const UNUSED_URL = "https://unused.example.com";
  const UNUSED_ORG = "unused-org";

  test("returns TextResult for text widget with description", async () => {
    const dashboard = makeDashboard([
      { title: "Notes", displayType: "text", description: "# Hello\n**bold**" },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.size).toBe(1);
    expect(results.get(0)).toEqual({
      type: "text",
      content: "# Hello\n**bold**",
    });
  });

  test("returns TextResult with empty content when description is missing", async () => {
    const dashboard = makeDashboard([
      { title: "Empty Notes", displayType: "text" },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.get(0)).toEqual({ type: "text", content: "" });
  });

  test("returns TextResult with empty content for non-string description", async () => {
    const dashboard = makeDashboard([
      { title: "Bad Description", displayType: "text", description: 42 },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.get(0)).toEqual({ type: "text", content: "" });
  });

  test("handles multiple text widgets in a single dashboard", async () => {
    const dashboard = makeDashboard([
      { title: "Notes 1", displayType: "text", description: "First" },
      { title: "Notes 2", displayType: "text", description: "Second" },
      { title: "Notes 3", displayType: "text", description: "Third" },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.size).toBe(3);
    expect(results.get(0)).toEqual({ type: "text", content: "First" });
    expect(results.get(1)).toEqual({ type: "text", content: "Second" });
    expect(results.get(2)).toEqual({ type: "text", content: "Third" });
  });
});
