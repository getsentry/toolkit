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
  parseIssueConditions,
  triggerLogicType,
  validateIssueActions,
  validateIssueTriggers,
  validateMetricDataset,
  validateMetricTimeWindow,
  parseWorkflowIds,
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

  test("reads comma-joined objects as an array", () => {
    expect(parseJsonObjectList(['{"a":1},{"b":2}'], "test")).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    expect(parseJsonObjectList(['{"a":1},{"b":2}', '{"c":3}'], "test")).toEqual(
      [{ a: 1 }, { b: 2 }, { c: 3 }],
    );
  });

  test("hints at stripped quotes without guessing the value", () => {
    // From CLI-1ZD: `targetIdentifier` may have been the string "5096157".
    const error = validationError(() =>
      parseJsonObjectList(
        [
          "{type:email,data:{},config:{targetType:user,targetIdentifier:5096157}}",
        ],
        "action",
      ),
    );
    expect(error.field).toBe("action");
    expect(error.message).toContain("stripped the double quotes");
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

/** A trigger condition as the workflows API takes it. */
function trigger(type: string) {
  return { type, comparison: true, conditionResult: true };
}

/** The ValidationError a call throws, or fails the test. */
function validationError(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  return expect.unreachable("should have thrown");
}

// Inputs below are real `--condition` values from CLI-1ZD.
describe("parseIssueConditions", () => {
  test("passes JSON through unchanged", () => {
    expect(
      parseIssueConditions([
        '{"type":"first_seen_event","comparison":true,"conditionResult":true}',
      ]),
    ).toEqual([trigger("first_seen_event")]);
    expect(parseIssueConditions(["[]"])).toEqual([]);
    expect(parseIssueConditions(undefined)).toBeUndefined();
  });

  test.each([
    ["first-seen", ["first_seen_event"]],
    ["first_seen_event", ["first_seen_event"]],
    ["Regression", ["regression_event"]],
    ["resolved", ["issue_resolved_trigger"]],
    ["new-high-priority", ["new_high_priority_issue"]],
    ["every-event", ["every_event"]],
    ["first-seen, regression", ["first_seen_event", "regression_event"]],
  ])("expands trigger name %j", (raw, types) => {
    expect(parseIssueConditions([raw])).toEqual(types.map(trigger));
  });

  test("expands repeated trigger names", () => {
    expect(parseIssueConditions(["first-seen", "reappeared"])).toEqual([
      trigger("first_seen_event"),
      trigger("reappeared_event"),
    ]);
  });

  test("restores trigger JSON whose quotes the shell stripped", () => {
    expect(
      parseIssueConditions([
        "{type:first_seen_event,comparison:true,conditionResult:true}",
      ]),
    ).toEqual([trigger("first_seen_event")]);
    expect(
      parseIssueConditions([
        "{type:first_seen_event,comparison:true,conditionResult:true},{type:regression_event,comparison:true,conditionResult:true}",
      ]),
    ).toEqual([trigger("first_seen_event"), trigger("regression_event")]);
    expect(parseIssueConditions(["[{type: reappeared_event}]"])).toEqual([
      trigger("reappeared_event"),
    ]);
  });

  test.each([
    // Not a boolean trigger: its other fields could have been strings.
    "{type:event_frequency_count,comparison:{value:50,interval:1d}}",
    // A false comparison is not what the name alone means.
    "{type:first_seen_event,comparison:false}",
    // Unknown keys may carry meaning the canonical object drops.
    "{type:first_seen_event,extra:1}",
    "{type:first_seen}",
  ])("refuses quote-stripped JSON it cannot restore exactly: %s", (raw) => {
    const error = validationError(() => parseIssueConditions([raw]));
    expect(error.field).toBe("condition");
    expect(error.message).toContain("stripped the double quotes");
    expect(error.message).toContain("first-seen, regression");
  });

  test("lists trigger names for an unknown name", () => {
    const error = validationError(() => parseIssueConditions(["first-sen"]));
    expect(error.message).toContain(
      'condition must be valid JSON (got "first-sen")',
    );
    expect(error.message).not.toContain("stripped");
    expect(error.message).toContain("first-seen, regression");
  });
});

describe("validateIssueTriggers", () => {
  test("passes with triggers", () => {
    expect(() =>
      validateIssueTriggers([trigger("first_seen_event")], undefined),
    ).not.toThrow();
  });

  test.each([undefined, []])(
    "passes without triggers (%j) when filters are given",
    (conditions) => {
      expect(() =>
        validateIssueTriggers(conditions, [{ type: "event_frequency_count" }]),
      ).not.toThrow();
    },
  );

  test.each([
    [undefined, undefined],
    [[], []],
  ])("throws without triggers or filters (%j, %j)", (conditions, filters) => {
    const error = validationError(() =>
      validateIssueTriggers(conditions, filters),
    );
    expect(error.field).toBe("condition");
    expect(error.message).toContain("--filter");
    expect(error.message).toContain("first-seen");
  });
});

describe("validateIssueActions", () => {
  test.each([undefined, []])("throws for %j actions", (actions) => {
    expect(validationError(() => validateIssueActions(actions)).field).toBe(
      "action",
    );
  });

  test("passes for non-empty actions", () => {
    expect(() => validateIssueActions([{ id: "a" }])).not.toThrow();
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

  test.each(["errors", "sessions", "events", "spans", "metrics"])(
    'passes canonical value "%s" through unchanged',
    (value) => {
      expect(normalizeMetricDataset(value)).toBe(value);
    },
  );

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

  test.each(["transaction", "transactions", "Transactions", "  TRANSACTION "])(
    'routes "%s" to spans and adds is_transaction:true with a notice',
    (input) => {
      const result = resolveMetricDataset(input, "environment:prod");
      expect(result.dataset).toBe("spans");
      expect(result.query).toBe("environment:prod is_transaction:true");
      expect(result.notice).toContain("spans");
      expect(result.notice).toContain("is_transaction:true");
    },
  );

  test("adds the filter to an empty query", () => {
    const result = resolveMetricDataset("transactions", "");
    expect(result.dataset).toBe("spans");
    expect(result.query).toBe("is_transaction:true");
  });

  test("does not duplicate an existing is_transaction:true filter", () => {
    const result = resolveMetricDataset(
      "transactions",
      "environment:prod is_transaction:true",
    );
    expect(result.query).toBe("environment:prod is_transaction:true");
  });
});

describe("validateMetricDataset", () => {
  const valid = ["errors", "sessions", "events", "spans", "logs", "metrics"];

  for (const dataset of valid) {
    test(`passes for "${dataset}"`, () => {
      expect(() => validateMetricDataset(dataset)).not.toThrow();
    });
  }

  test.each(["error", "error-events", "METRIC", "span", "log"])(
    'passes for alias "%s"',
    (dataset) => {
      expect(() => validateMetricDataset(dataset)).not.toThrow();
    },
  );

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

describe("parseWorkflowIds", () => {
  test("returns undefined when absent", () => {
    expect(parseWorkflowIds(undefined)).toBeUndefined();
  });

  test("splits repeatable and comma-separated ids", () => {
    expect(parseWorkflowIds(["12,34", "56"])).toEqual([12, 34, 56]);
  });

  test("rejects non-numeric ids", () => {
    expect(() => parseWorkflowIds(["abc"])).toThrow(ValidationError);
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
