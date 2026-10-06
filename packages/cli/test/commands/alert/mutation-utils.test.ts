import { describe, expect, test } from "vitest";
import {
  matchToLogicType,
  normalizeMetricDataset,
  normalizeProjectList,
  parseJsonObjectList,
  parseMatchMode,
  parseStatusFlag,
  resolveMetricDataset,
  statusToMetricValue,
  triggerLogicType,
  validateIssueRuleArrays,
  validateMetricDataset,
  validateMetricTimeWindow,
  validateMetricTriggers,
} from "../../../src/commands/alert/mutation-utils.js";
import { ValidationError } from "../../../src/lib/errors.js";

describe("parseMatchMode", () => {
  test("returns undefined for undefined", () => {
    expect(parseMatchMode(undefined, "action-match")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parseMatchMode("", "action-match")).toBeUndefined();
  });

  test('returns "all" for case-insensitive input', () => {
    expect(parseMatchMode("ALL", "action-match")).toBe("all");
    expect(parseMatchMode("all", "action-match")).toBe("all");
    expect(parseMatchMode("All", "filter-match")).toBe("all");
  });

  test('returns "any" for "any"', () => {
    expect(parseMatchMode("any", "action-match")).toBe("any");
  });

  test("throws ValidationError for invalid value", () => {
    try {
      parseMatchMode("both", "action-match");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });
});

describe("matchToLogicType", () => {
  test('maps "any" to "any-short"', () => {
    expect(matchToLogicType("any")).toBe("any-short");
  });

  test('maps "all" to "all"', () => {
    expect(matchToLogicType("all")).toBe("all");
  });

  test('defaults undefined to "all"', () => {
    expect(matchToLogicType(undefined)).toBe("all");
  });
});

describe("triggerLogicType", () => {
  test("is always any-short (workflows endpoint rejects other logic types for issue triggers)", () => {
    expect(triggerLogicType()).toBe("any-short");
  });
});

describe("parseStatusFlag", () => {
  test("returns undefined for undefined", () => {
    expect(parseStatusFlag(undefined)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parseStatusFlag("")).toBeUndefined();
  });

  test('returns "active" for case-insensitive input', () => {
    expect(parseStatusFlag("Active")).toBe("active");
  });

  test('returns "disabled" for case-insensitive input', () => {
    expect(parseStatusFlag("DISABLED")).toBe("disabled");
  });

  test("throws ValidationError for invalid value", () => {
    try {
      parseStatusFlag("paused");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });
});

describe("parseJsonObjectList", () => {
  test("returns undefined for undefined", () => {
    expect(parseJsonObjectList(undefined, "test")).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    expect(parseJsonObjectList([], "test")).toBeUndefined();
  });

  test("parses a single JSON object string", () => {
    expect(parseJsonObjectList(['{"a":1}'], "test")).toEqual([{ a: 1 }]);
  });

  test("parses a JSON array in a single string", () => {
    expect(parseJsonObjectList(['[{"a":1},{"b":2}]'], "test")).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  test("parses multiple JSON strings", () => {
    expect(parseJsonObjectList(['{"a":1}', '{"b":2}'], "test")).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  test("throws ValidationError for invalid JSON", () => {
    try {
      parseJsonObjectList(["not-json"], "test");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws ValidationError for non-object JSON values", () => {
    try {
      parseJsonObjectList(['"just a string"'], "test");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });
});

describe("validateIssueRuleArrays", () => {
  test("throws for undefined conditions", () => {
    try {
      validateIssueRuleArrays(undefined, [{ id: "a" }], "conditions");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for empty conditions", () => {
    try {
      validateIssueRuleArrays([], [{ id: "a" }], "conditions");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for undefined actions", () => {
    try {
      validateIssueRuleArrays([{ id: "a" }], undefined, "actions");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for empty actions", () => {
    try {
      validateIssueRuleArrays([{ id: "a" }], [], "actions");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("passes for non-empty conditions", () => {
    expect(() =>
      validateIssueRuleArrays([{ id: "a" }], undefined, "conditions")
    ).not.toThrow();
  });

  test("passes for non-empty actions", () => {
    expect(() =>
      validateIssueRuleArrays(undefined, [{ id: "a" }], "actions")
    ).not.toThrow();
  });
});

describe("normalizeProjectList", () => {
  test("returns undefined for undefined", () => {
    expect(normalizeProjectList(undefined)).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    expect(normalizeProjectList([])).toBeUndefined();
  });

  test("splits comma-separated values", () => {
    expect(normalizeProjectList(["a,b,c"])).toEqual(["a", "b", "c"]);
  });

  test("trims whitespace", () => {
    expect(normalizeProjectList([" a , b "])).toEqual(["a", "b"]);
  });

  test("filters empty strings", () => {
    expect(normalizeProjectList(["a,,b"])).toEqual(["a", "b"]);
  });
});

describe("normalizeMetricDataset", () => {
  test.each([
    ["error", "errors"],
    ["session", "sessions"],
    ["metric", "metrics"],
    ["span", "spans"],
    ["error-events", "errors"],
  ])('maps alias "%s" to "%s"', (input, expected) => {
    expect(normalizeMetricDataset(input)).toBe(expected);
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(normalizeMetricDataset("ERROR-EVENTS")).toBe("errors");
    expect(normalizeMetricDataset("  Error-Events  ")).toBe("errors");
  });

  test.each([
    "errors",
    "sessions",
    "events",
    "spans",
    "metrics",
  ])('passes canonical value "%s" through unchanged', (value) => {
    expect(normalizeMetricDataset(value)).toBe(value);
  });

  test("lowercases unknown values but leaves them otherwise unchanged", () => {
    expect(normalizeMetricDataset("Unknown")).toBe("unknown");
  });

  test.each([
    "tracemetrics",
    "metricsenhanced",
    "eap",
    "events_analytics_platform",
  ])('does not rewrite distinct dataset "%s" onto another dataset', (value) => {
    // These denote different datasets in the metric-alert path; aliasing them
    // would silently ship the wrong dataset. They should not be rewritten.
    expect(normalizeMetricDataset(value)).toBe(value);
  });
});

describe("resolveMetricDataset", () => {
  test("passes canonical datasets through with the query untouched", () => {
    expect(resolveMetricDataset("spans", "environment:prod")).toEqual({
      dataset: "spans",
      query: "environment:prod",
    });
  });

  test("resolves aliases without a notice", () => {
    expect(resolveMetricDataset("span", "environment:prod")).toEqual({
      dataset: "spans",
      query: "environment:prod",
    });
  });

  test.each([
    "transaction",
    "transactions",
    "Transactions",
    "  TRANSACTION ",
  ])('routes "%s" to spans and adds is_transaction:true with a notice', (input) => {
    const result = resolveMetricDataset(input, "environment:prod");
    expect(result.dataset).toBe("spans");
    expect(result.query).toBe("environment:prod is_transaction:true");
    expect(result.notice).toContain("spans");
    expect(result.notice).toContain("is_transaction:true");
  });

  test("adds the filter to an empty query", () => {
    const result = resolveMetricDataset("transactions", "");
    expect(result.dataset).toBe("spans");
    expect(result.query).toBe("is_transaction:true");
  });

  test("does not duplicate an existing is_transaction:true filter", () => {
    const result = resolveMetricDataset(
      "transactions",
      "environment:prod is_transaction:true"
    );
    expect(result.query).toBe("environment:prod is_transaction:true");
  });
});

describe("validateMetricDataset", () => {
  const valid = ["errors", "sessions", "events", "spans", "metrics"];

  for (const dataset of valid) {
    test(`passes for "${dataset}"`, () => {
      expect(() => validateMetricDataset(dataset)).not.toThrow();
    });
  }

  test.each([
    "error",
    "error-events",
    "METRIC",
    "span",
  ])('passes for alias "%s"', (dataset) => {
    expect(() => validateMetricDataset(dataset)).not.toThrow();
  });

  test.each([
    "tracemetrics",
    "eap",
    "events_analytics_platform",
    "transactions",
    "transaction-like",
  ])('throws for obsolete or non-aliased dataset "%s"', (dataset) => {
    expect(() => validateMetricDataset(dataset)).toThrow(ValidationError);
  });

  test("throws for unknown dataset", () => {
    try {
      validateMetricDataset("unknown");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });
});

describe("validateMetricTimeWindow", () => {
  const valid = [1, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];

  for (const window of valid) {
    test(`passes for ${window}`, () => {
      expect(() => validateMetricTimeWindow(window)).not.toThrow();
    });
  }

  test.each([0, 2, 7, -1])("throws for %d", (window) => {
    try {
      validateMetricTimeWindow(window);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });
});

describe("validateMetricTriggers", () => {
  test("throws for undefined triggers", () => {
    try {
      validateMetricTriggers(undefined);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for empty triggers", () => {
    try {
      validateMetricTriggers([]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for missing alertThreshold", () => {
    try {
      validateMetricTriggers([{ actions: [{ id: "a" }] }]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for missing actions array", () => {
    try {
      validateMetricTriggers([{ alertThreshold: 100 }]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for empty actions array", () => {
    try {
      validateMetricTriggers([{ alertThreshold: 100, actions: [] }]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("passes for valid trigger", () => {
    expect(() =>
      validateMetricTriggers([
        { alertThreshold: 100, actions: [{ type: "email" }] },
      ])
    ).not.toThrow();
  });
});

describe("statusToMetricValue", () => {
  test('returns 0 for "active"', () => {
    expect(statusToMetricValue("active")).toBe(0);
  });

  test('returns 1 for "disabled"', () => {
    expect(statusToMetricValue("disabled")).toBe(1);
  });
});
