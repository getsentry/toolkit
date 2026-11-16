import { describe, expect, test } from "vitest";
import {
  parseQuerySeries,
  parseSeriesExpression,
} from "../../../src/commands/dashboard/transformations.js";
import {
  formatSeriesExpression,
  seriesTargets,
} from "../../../src/lib/dashboard-series.js";
import { ValidationError } from "../../../src/lib/errors.js";

describe("parseSeriesExpression", () => {
  test.each([
    ["count", "count", []],
    ["p95:span.duration", "p95:span.duration", []],
    ["fill(count, zero)", "count", ["fill(zero)"]],
    ["fill(count,linear)", "count", ["fill(linear)"]],
    [" fill ( count , locf ) ", "count", ["fill(locf)"]],
    ["smooth(count, sma, 1)", "count", ["smooth(sma,1)"]],
    ["smooth(count, ema, 07)", "count", ["smooth(ema,7)"]],
    ["smooth(count, ema, 7, .25)", "count", ["smooth(ema,7,0.25)"]],
    ["smooth(count, ema, 7, 2.5e-1)", "count", ["smooth(ema,7,0.25)"]],
    ["smooth(count, ema, 7, 1.)", "count", ["smooth(ema,7,1)"]],
    ["smooth(count, asap)", "count", ["smooth(asap)"]],
    ["smooth(count, asap, 7)", "count", ["smooth(asap,7)"]],
    [
      "smooth(fill(p95:span.duration, linear), ema, 7)",
      "p95:span.duration",
      ["fill(linear)", "smooth(ema,7)"],
    ],
    [
      "fill(smooth(count, asap), zero)",
      "count",
      ["smooth(asap)", "fill(zero)"],
    ],
    [
      "smooth(p50(value,latency,distribution,none), sma, 5)",
      "p50(value,latency,distribution,none)",
      ["smooth(sma,5)"],
    ],
    [
      'fill(count_if(span.op,equals,"a,b"), zero)',
      'count_if(span.op,equals,"a,b")',
      ["fill(zero)"],
    ],
    [
      "smooth(equation|count() / 60, sma, 3)",
      "equation|count() / 60",
      ["smooth(sma,3)"],
    ],
    ["fill_rate(span.duration)", "fill_rate(span.duration)", []],
  ])("%s", (input, aggregate, transformations) => {
    expect(parseSeriesExpression(input, "query")).toEqual({
      aggregate,
      transformations,
    });
  });

  test("#<n> names one of several equal aggregates", () => {
    expect(
      parseSeriesExpression("smooth(count#2, sma, 5)", "transform"),
    ).toEqual({
      aggregate: "count",
      transformations: ["smooth(sma,5)"],
      occurrence: 2,
    });
  });

  test.each([
    ["fill(count)", 'Expected "#" or "," but ")" found.'],
    [
      "fill(count, unknown)",
      'Expected "linear", "locf", or "zero" but "u" found.',
    ],
    ["fill(count, zero, 1)", 'Expected ")"'],
    ["fill(, zero)", 'Expected "fill", "smooth", or aggregate but "," found.'],
    ["smooth(count, sma)", 'Expected ","'],
    ["smooth(count, sma, 1, 0.5)", 'Expected ")"'],
    ["smooth(count, ema, 7, 0)", "Smoothing factor 0 must be greater than 0"],
    ["smooth(count, asap, 0)", "Window size 0 must be a positive integer"],
    [
      "smooth(smooth(count, asap), sma, 3)",
      "at most one smooth transformation",
    ],
    ["count, p95", 'but "," found'],
    ["count#0", "Expected occurrence number"],
  ])("rejects %s", (input, message) => {
    expect(() => parseSeriesExpression(input, "transform")).toThrow(message);
    expect(() => parseSeriesExpression(input, "transform")).toThrow(
      ValidationError,
    );
  });

  test("--query does not take #<n>", () => {
    expect(() => parseQuerySeries(["count#2"])).toThrow(
      "--query lists every series in order",
    );
    expect(parseQuerySeries(undefined)).toBeUndefined();
  });
});

describe("formatSeriesExpression", () => {
  test("nests transformations in the order they run", () => {
    expect(
      formatSeriesExpression("count()", ["fill(linear)", "smooth(ema,7)"]),
    ).toBe("smooth(fill(count(),linear),ema,7)");
    expect(formatSeriesExpression("count()", [])).toBe("count()");
    expect(formatSeriesExpression("count()", ["future()"])).toBe(
      "future(count())",
    );
  });

  test("round-trips through the parser", () => {
    const transformations = ["smooth(asap,7)", "fill(zero)"];
    expect(
      parseSeriesExpression(
        formatSeriesExpression("count()", transformations),
        "query",
      ).transformations,
    ).toEqual(transformations);
  });
});

test("seriesTargets numbers only repeated aggregates", () => {
  expect(seriesTargets(["count()", "p95()", "count()"])).toEqual([
    "count()#1",
    "p95()",
    "count()#2",
  ]);
});
