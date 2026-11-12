import { describe, expect, it } from "vitest";
import { listSavedAggregateTransformations } from "./dashboard-transformations.js";

describe("listSavedAggregateTransformations", () => {
  it("orders saved positions and keeps duplicate aggregates apart", () => {
    expect(
      listSavedAggregateTransformations(["count()", "count()"], {
        "1": ["smooth(asap,7)", "fill(zero)"],
        "0": ["fill(linear)"],
      }),
    ).toEqual([
      {
        aggregateIndex: 0,
        aggregate: "count()",
        transformations: ["fill(linear)"],
        description: "count() (aggregate 1): fill(linear)",
      },
      {
        aggregateIndex: 1,
        aggregate: "count()",
        transformations: ["smooth(asap,7)", "fill(zero)"],
        description: "count() (aggregate 2): smooth(asap,7) → fill(zero)",
      },
    ]);
  });

  it("orders positions numerically, not lexically", () => {
    const aggregates = Array.from({ length: 11 }, (_, i) => `p${i}()`);
    const entries = listSavedAggregateTransformations(aggregates, {
      "10": ["fill(zero)"],
      "2": ["fill(zero)"],
    });
    expect(entries?.map((entry) => entry.aggregateIndex)).toEqual([2, 10]);
  });

  it("keeps empty lists and positions without an aggregate", () => {
    expect(
      listSavedAggregateTransformations(["count()"], {
        "0": [],
        "1": ["fill(linear)"],
      }),
    ).toEqual([
      {
        aggregateIndex: 0,
        aggregate: "count()",
        transformations: [],
        description: "count() (aggregate 1): none",
      },
      {
        aggregateIndex: 1,
        aggregate: null,
        transformations: ["fill(linear)"],
        description: "aggregate 2 (no aggregate): fill(linear)",
      },
    ]);
  });

  it("distinguishes unreported from unsaved transformations", () => {
    expect(
      listSavedAggregateTransformations(["count()"], undefined),
    ).toBeNull();
    expect(listSavedAggregateTransformations(["count()"], {})).toBeUndefined();
  });
});
