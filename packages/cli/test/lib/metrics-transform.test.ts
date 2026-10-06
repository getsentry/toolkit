import { describe, expect, test } from "vitest";
import type { MetricMeta } from "../../src/lib/api/explore.js";
import { ResolutionError } from "../../src/lib/errors.js";
import {
  makeTracemetricsAggregate,
  resolveMetricField,
} from "../../src/lib/metrics-transform.js";

const SAMPLE_METRICS: MetricMeta[] = [
  { name: "llm.token_usage", type: "distribution", unit: "none" },
  { name: "cache.hit_rate", type: "distribution", unit: "none" },
  { name: "http.response_time", type: "distribution", unit: "millisecond" },
  { name: "request.count", type: "counter", unit: "none" },
];

describe("makeTracemetricsAggregate", () => {
  test("builds standard format", () => {
    expect(
      makeTracemetricsAggregate(
        "sum",
        "llm.token_usage",
        "distribution",
        "none"
      )
    ).toBe("sum(value,llm.token_usage,distribution,none)");
  });

  test("preserves unit", () => {
    expect(
      makeTracemetricsAggregate(
        "avg",
        "http.response_time",
        "distribution",
        "millisecond"
      )
    ).toBe("avg(value,http.response_time,distribution,millisecond)");
  });

  test("works with p50 aggregation", () => {
    expect(
      makeTracemetricsAggregate("p50", "cache.hit_rate", "distribution", "none")
    ).toBe("p50(value,cache.hit_rate,distribution,none)");
  });
});

describe("resolveMetricField", () => {
  test("resolves known metric with default agg", () => {
    expect(resolveMetricField("llm.token_usage", "sum", SAMPLE_METRICS)).toBe(
      "sum(value,llm.token_usage,distribution,none)"
    );
  });

  test("resolves with custom agg", () => {
    expect(resolveMetricField("cache.hit_rate", "avg", SAMPLE_METRICS)).toBe(
      "avg(value,cache.hit_rate,distribution,none)"
    );
  });

  test("preserves metric unit from metadata", () => {
    expect(
      resolveMetricField("http.response_time", "p95", SAMPLE_METRICS)
    ).toBe("p95(value,http.response_time,distribution,millisecond)");
  });

  test("throws ResolutionError for unknown metric", () => {
    expect(() =>
      resolveMetricField("nonexistent.metric", "sum", SAMPLE_METRICS)
    ).toThrow(ResolutionError);
  });

  test("suggests similar metrics when not found", () => {
    try {
      resolveMetricField("llm.token", "sum", SAMPLE_METRICS);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).message).toContain("llm.token_usage");
    }
  });

  test("deduplicates suggestions when metrics list has duplicate names", () => {
    // The API can return the same metric name multiple times (e.g. one entry
    // per tag combination). Suggestions must not repeat the same name.
    const metricsWithDuplicates: MetricMeta[] = [
      { name: "llm.token_usage", type: "distribution", unit: "none" },
      { name: "llm.token_usage", type: "distribution", unit: "none" },
      { name: "llm.token_usage", type: "distribution", unit: "none" },
    ];
    try {
      resolveMetricField("llm.token", "sum", metricsWithDuplicates);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      const suggestionLine = (err as ResolutionError).message;
      const occurrences = suggestionLine.split("llm.token_usage").length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("throws ResolutionError for invalid aggregation", () => {
    expect(() =>
      resolveMetricField("llm.token_usage", "invalid_agg", SAMPLE_METRICS)
    ).toThrow(ResolutionError);
  });

  test("resolves counter-type metric", () => {
    expect(resolveMetricField("request.count", "sum", SAMPLE_METRICS)).toBe(
      "sum(value,request.count,counter,none)"
    );
  });
});
