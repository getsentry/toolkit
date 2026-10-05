/**
 * Unit tests for issue view helpers: newline expansion, JSON shape, and
 * human formatting. Command-body coverage lives in view.func.test.ts.
 */

import { describe, expect, test } from "vitest";
import { collectIssueArgs } from "../../../src/commands/issue/utils.js";
import {
  formatIssueView,
  jsonTransformIssueView,
} from "../../../src/lib/formatters/issue.js";
import type { SentryIssue } from "../../../src/types/index.js";

function sampleIssue(overrides: Partial<SentryIssue> = {}): SentryIssue {
  return {
    id: "12345",
    shortId: "CLI-123",
    title: "Replay-linked issue",
    permalink: "https://sentry.io/organizations/test-org/issues/12345/",
    ...overrides,
  };
}

function sampleView(overrides: Partial<SentryIssue> = {}) {
  return {
    org: "test-org",
    issue: sampleIssue(overrides),
    event: null,
    replayIds: [] as string[],
    trace: null,
  };
}

describe("collectIssueArgs", () => {
  test("expands newline-separated args", () => {
    expect(collectIssueArgs(["IOS-1\nIOS-2\nIOS-3"])).toEqual([
      "IOS-1",
      "IOS-2",
      "IOS-3",
    ]);
  });

  test("handles mixed arguments and removes duplicates", () => {
    expect(collectIssueArgs(["IOS-1", "IOS-2\nIOS-3", "IOS-2"])).toEqual([
      "IOS-1",
      "IOS-2",
      "IOS-3",
    ]);
  });

  test("does not split on commas", () => {
    expect(collectIssueArgs(["IOS-1,IOS-2"])).toEqual(["IOS-1,IOS-2"]);
  });

  test("handles empty array", () => {
    expect(collectIssueArgs([])).toEqual([]);
  });
});

describe("formatIssueView", () => {
  test("renders a single issue without a separator", () => {
    const result = formatIssueView({
      issues: [sampleView()],
      requestedCount: 1,
    });
    expect(result).toContain("CLI-123");
    expect(result).not.toContain("---");
  });

  test("renders multiple issues separated by a horizontal rule", () => {
    const result = formatIssueView({
      issues: [
        sampleView({ shortId: "IOS-1", title: "First" }),
        sampleView({ id: "2", shortId: "IOS-2", title: "Second" }),
      ],
      requestedCount: 2,
    });
    expect(result).toContain("IOS-1");
    expect(result).toContain("---");
    expect(result).toContain("IOS-2");
  });
});

describe("jsonTransformIssueView", () => {
  test("returns a flat object for a single issue", () => {
    const result = jsonTransformIssueView({
      issues: [sampleView()],
      requestedCount: 1,
    });
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual(
      expect.objectContaining({
        shortId: "CLI-123",
        org: "test-org",
        event: null,
        replayIds: [],
        trace: null,
      })
    );
  });

  test("returns an array for multiple issues", () => {
    const result = jsonTransformIssueView({
      issues: [
        sampleView({ shortId: "IOS-1" }),
        sampleView({ id: "2", shortId: "IOS-2" }),
      ],
      requestedCount: 2,
    });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Record<string, unknown>[];
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual(expect.objectContaining({ shortId: "IOS-1" }));
    expect(arr[1]).toEqual(expect.objectContaining({ shortId: "IOS-2" }));
  });

  test("returns an array when multiple were requested but some failed", () => {
    const result = jsonTransformIssueView({
      issues: [sampleView({ shortId: "IOS-1" })],
      requestedCount: 3,
    });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Record<string, unknown>[];
    expect(arr).toHaveLength(1);
    expect(arr[0]).toEqual(expect.objectContaining({ shortId: "IOS-1" }));
  });

  test("applies field filtering for a single issue", () => {
    const result = jsonTransformIssueView(
      {
        issues: [sampleView()],
        requestedCount: 1,
      },
      ["shortId"]
    );
    expect(result).toEqual({ shortId: "CLI-123" });
  });

  test("applies field filtering for multiple issues", () => {
    const result = jsonTransformIssueView(
      {
        issues: [
          sampleView({ shortId: "IOS-1" }),
          sampleView({ id: "2", shortId: "IOS-2" }),
        ],
        requestedCount: 2,
      },
      ["shortId"]
    );
    expect(result).toEqual([{ shortId: "IOS-1" }, { shortId: "IOS-2" }]);
  });
});
