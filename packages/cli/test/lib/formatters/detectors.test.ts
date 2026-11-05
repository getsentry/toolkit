import { describe, expect, test } from "vitest";
import {
  formatMetricMonitorList,
  formatMetricMonitorView,
  type MetricMonitorView,
} from "../../../src/lib/formatters/detectors.js";
import type { MetricMonitor } from "../../../src/lib/api/detectors.js";
import { metricMonitor } from "../../fixtures/metric-monitors.js";

describe("native metric monitor formatting", () => {
  test("reads the source-exact query envelope and labels seconds as minutes only for display", () => {
    const monitor = {
      ...metricMonitor(),
      org: "test-org",
      workflows: [],
      workflowErrors: [{ id: "42", status: 403 }],
    } as MetricMonitorView;
    const output = formatMetricMonitorView(monitor);
    expect(output).toContain("Error volume");
    expect(output).toContain("5m");
    expect(output).toContain("production");
    expect(output).toContain("percent");
    expect(output).toContain("comparisonDelta");
    expect(output).toContain("conditionResult");
    expect(output).toContain("HTTP 403");
    expect(output).toContain("notification configuration is unverified");
  });

  test("list displays native project and enabled state without a legacy status mapping", () => {
    const output = formatMetricMonitorList([
      {
        ...metricMonitor(),
        enabled: false,
        orgSlug: "test-org",
      } as MetricMonitor & { orgSlug: string },
    ]);
    expect(output).toContain("ENABLED");
    expect(output).toContain("false");
    expect(output).toContain("count()");
    expect(output).toContain("events");
  });
});
