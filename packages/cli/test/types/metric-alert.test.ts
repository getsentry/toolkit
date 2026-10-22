import { describe, expect, test } from "vitest";
import { ValidationError } from "../../src/lib/errors.js";
import {
  METRIC_ALERT_DATASET_BRIEF,
  METRIC_ALERT_DATASET_NAMES,
  metricAlertDatasetName,
  metricAlertSource,
  parseMetricTriggers,
} from "../../src/types/metric-alert.js";

describe("metric alert datasets", () => {
  test("help text lists every dataset name", () => {
    for (const name of METRIC_ALERT_DATASET_NAMES) {
      expect(METRIC_ALERT_DATASET_BRIEF).toContain(name);
    }
  });

  test("every dataset name reads back as a dataset name", () => {
    for (const name of METRIC_ALERT_DATASET_NAMES) {
      const source = metricAlertSource(name);
      expect(source).toBeDefined();
      const readBack = metricAlertDatasetName(
        source!.dataset,
        source!.eventTypes,
      );
      expect(metricAlertSource(readBack)).toEqual(source);
    }
  });

  test("keeps EAP native when event types are missing or empty", () => {
    expect(metricAlertDatasetName("events_analytics_platform", [])).toBe(
      "events_analytics_platform",
    );
  });

  test("resolves unambiguous datasets without event types", () => {
    expect(metricAlertDatasetName("events", [])).toBe("errors");
    expect(metricAlertDatasetName("metrics", [])).toBe("metrics");
  });

  test("keeps unmodelled EAP event types native", () => {
    expect(
      metricAlertDatasetName("events_analytics_platform", [
        "trace_item_metric",
      ]),
    ).toBe("events_analytics_platform");
  });

  test("ignores prototype keys", () => {
    expect(metricAlertSource("constructor")).toBeUndefined();
  });
});

describe("parseMetricTriggers", () => {
  test("throws for undefined triggers", () => {
    try {
      parseMetricTriggers(undefined);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for empty triggers", () => {
    try {
      parseMetricTriggers([]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("throws for missing alertThreshold", () => {
    try {
      parseMetricTriggers([{ actions: [{ id: "a" }] }]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  test("passes for a threshold trigger without actions", () => {
    expect(() =>
      parseMetricTriggers([
        { alertThreshold: 100, label: "warning", resolveThreshold: 50 },
      ]),
    ).not.toThrow();
  });

  test("rejects trigger actions, pointing at --workflow", () => {
    expect(() =>
      parseMetricTriggers([
        { alertThreshold: 100, actions: [{ type: "email" }] },
      ]),
    ).toThrow(/--workflow/);
  });

  test("rejects an unknown label", () => {
    expect(() =>
      parseMetricTriggers([{ alertThreshold: 100, label: "info" }]),
    ).toThrow(ValidationError);
  });

  test("passes native detector conditions", () => {
    expect(() =>
      parseMetricTriggers([
        { type: "gt", comparison: 0, conditionResult: 75 },
        { type: "lte", comparison: 0, conditionResult: 0 },
      ]),
    ).not.toThrow();
  });

  test("rejects native conditions missing comparison", () => {
    expect(() =>
      parseMetricTriggers([{ type: "gt", conditionResult: 75 }]),
    ).toThrow(ValidationError);
  });

  test("rejects mixing native conditions and threshold triggers", () => {
    expect(() =>
      parseMetricTriggers([
        { alertThreshold: 100 },
        { type: "lte", comparison: 0, conditionResult: 0 },
      ]),
    ).toThrow(ValidationError);
  });
});

describe("parseMetricTriggers output", () => {
  test("coerces numeric-string thresholds", () => {
    expect(
      parseMetricTriggers([{ alertThreshold: "10", resolveThreshold: "5" }]),
    ).toEqual([{ alertThreshold: 10, resolveThreshold: 5 }]);
  });

  test("rejects non-numeric thresholds", () => {
    expect(() => parseMetricTriggers([{ alertThreshold: "high" }])).toThrow(
      ValidationError,
    );
  });

  test("rejects unknown condition results", () => {
    expect(() =>
      parseMetricTriggers([{ type: "gt", comparison: 1, conditionResult: 99 }]),
    ).toThrow(ValidationError);
  });
});
