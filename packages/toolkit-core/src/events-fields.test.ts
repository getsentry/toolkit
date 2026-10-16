import { describe, expect, it } from "vitest";
import {
  isAggregateEquation,
  isAggregateField,
  isAggregateFieldOrEquation,
  isEquation,
  parseFunction,
} from "./events-fields.js";

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
