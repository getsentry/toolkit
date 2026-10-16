import { describe, expect, it } from "vitest";
import {
  getColumnsAndAggregates,
  isAggregateEquation,
  isAggregateField,
  isAggregateFieldOrEquation,
  isEquation,
  isTracemetricsAggregate,
  parseFunction,
} from "./events-fields.js";

/** Every string up to `maxLength` over `alphabet`. */
function* allStrings(alphabet: string, maxLength: number): Generator<string> {
  let level = [""];
  yield "";
  for (let length = 1; length <= maxLength; length += 1) {
    const next: string[] = [];
    for (const prefix of level) {
      for (const char of alphabet) {
        next.push(prefix + char);
      }
    }
    yield* next;
    level = next;
  }
}

describe("parseFunction", () => {
  it("parses calls with no, one, and many arguments", () => {
    expect(parseFunction("count()")).toEqual({ name: "count", arguments: [] });
    expect(parseFunction("p95(span.duration)")).toEqual({
      name: "p95",
      arguments: ["span.duration"],
    });
    expect(
      parseFunction("sum(value,llm.token_usage,distribution,none)"),
    ).toEqual({
      name: "sum",
      arguments: ["value", "llm.token_usage", "distribution", "none"],
    });
  });

  it("keeps commas inside quoted strings and tags together", () => {
    expect(parseFunction('count_if(message,equals,"a, b")')).toEqual({
      name: "count_if",
      arguments: ["message", "equals", '"a, b"'],
    });
    expect(parseFunction("count_unique(tags[a,b])")).toEqual({
      name: "count_unique",
      arguments: ["tags[a,b]"],
    });
  });

  it("extracts the search filter of an _if aggregate", () => {
    expect(parseFunction("avg_if(`span.op:db,http`,span.duration)")).toEqual({
      name: "avg_if",
      arguments: ["`span.op:db,http`", "span.duration"],
      filter: "span.op:db,http",
    });
  });

  it("returns null for columns and equations", () => {
    expect(parseFunction("title")).toBeNull();
    expect(parseFunction("tags[foo(bar)]")).toBeNull();
    expect(parseFunction("equation|count() / 60")).toBeNull();
  });
});

describe("aggregate classification", () => {
  it("separates aggregates, equations, and plain columns", () => {
    expect(isAggregateField("count()")).toBe(true);
    expect(isAggregateField("failure.node")).toBe(false);

    expect(isEquation("equation|count() / 60")).toBe(true);
    expect(isAggregateEquation("equation|count() / 60")).toBe(true);
    expect(isAggregateEquation("equation|1 + 1")).toBe(false);

    expect(isAggregateFieldOrEquation("count()")).toBe(true);
    expect(isAggregateFieldOrEquation("equation|count() / 60")).toBe(true);
    expect(isAggregateFieldOrEquation("timestamp")).toBe(false);
  });
});

describe("frontend regex parity", () => {
  // The frontend's patterns, used here only as a reference oracle on short,
  // bounded inputs. The implementation scans linearly instead.
  const FRONTEND_AGGREGATE_PATTERN = /^(\w+)\((.*)\)$/;
  const FRONTEND_AGGREGATE_BASE = /(\w+)\((.*)\)/;

  it("matches the frontend on every short field", () => {
    for (const field of allStrings("a(),|\n ", 5)) {
      expect(isAggregateField(field), JSON.stringify(field)).toBe(
        FRONTEND_AGGREGATE_PATTERN.test(field),
      );
      const equation = `equation|${field}`;
      expect(isAggregateEquation(equation), JSON.stringify(equation)).toBe(
        FRONTEND_AGGREGATE_BASE.test(equation),
      );
    }
  });

  it("stays fast on adversarial input", () => {
    const started = performance.now();
    isAggregateEquation(`equation|${"0(a".repeat(50_000)}`);
    isAggregateField(`0(${"0".repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("getColumnsAndAggregates", () => {
  it("splits group-by columns from aggregates and equations", () => {
    expect(
      getColumnsAndAggregates([
        "project",
        "count()",
        "tags[foo(bar)]",
        "equation|count() / 60",
      ]),
    ).toEqual({
      columns: ["project", "tags[foo(bar)]"],
      aggregates: ["count()", "equation|count() / 60"],
    });
  });
});

describe("isTracemetricsAggregate", () => {
  it("requires the four-argument value form", () => {
    expect(
      isTracemetricsAggregate(
        "p50(value,completion.duration_ms,distribution,none)",
      ),
    ).toBe(true);
    expect(isTracemetricsAggregate("count()")).toBe(false);
    expect(isTracemetricsAggregate("p50(span.duration)")).toBe(false);
    expect(isTracemetricsAggregate("equation|count()")).toBe(false);
  });
});
