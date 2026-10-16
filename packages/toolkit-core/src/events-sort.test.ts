import { describe, expect, it } from "vitest";
import {
  ensureSortInFields,
  getSortField,
  resolveEventsSort,
} from "./events-sort.js";

describe("getSortField", () => {
  it("strips the descending prefix", () => {
    expect(getSortField("-count()")).toBe("count()");
    expect(getSortField("timestamp")).toBe("timestamp");
  });
});

describe("ensureSortInFields", () => {
  it("adds a missing aggregate sort column to an aggregate query", () => {
    expect(
      ensureSortInFields(["severity", "count()"], "-p95(duration)"),
    ).toEqual(["severity", "count()", "p95(duration)"]);
  });

  it("adds a missing column to a non-aggregate query", () => {
    expect(ensureSortInFields(["message"], "-timestamp")).toEqual([
      "message",
      "timestamp",
    ]);
  });

  it("does not regroup an aggregate query by a non-aggregate sort column", () => {
    expect(ensureSortInFields(["severity", "count()"], "-timestamp")).toEqual([
      "severity",
      "count()",
    ]);
  });

  it("leaves fields alone when the sort column is selected or absent", () => {
    expect(ensureSortInFields(["title", "count()"], "-count()")).toEqual([
      "title",
      "count()",
    ]);
    expect(ensureSortInFields(["title"], undefined)).toEqual(["title"]);
  });
});

describe("resolveEventsSort", () => {
  it("keeps an explicit sort and selects its column", () => {
    expect(
      resolveEventsSort({
        fields: ["failure.node", "count()"],
        sort: "-count_unique(user)",
      }),
    ).toEqual({
      fields: ["failure.node", "count()", "count_unique(user)"],
      sort: "-count_unique(user)",
    });
  });

  it("defaults grouped aggregates to the first aggregate descending", () => {
    expect(
      resolveEventsSort({
        fields: ["metric.name", "sum(value,llm.token_usage,distribution,none)"],
      }),
    ).toEqual({
      fields: ["metric.name", "sum(value,llm.token_usage,distribution,none)"],
      sort: "-sum(value,llm.token_usage,distribution,none)",
    });
  });

  it("keeps the endpoint default for non-aggregate queries", () => {
    expect(resolveEventsSort({ fields: ["message"], sort: " " })).toEqual({
      fields: ["message"],
      sort: undefined,
    });
  });
});
