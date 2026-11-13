import { createCspEvent } from "@sentry/mcp-server-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Issue } from "../../api-client/types";
import {
  getMetricAlertContext,
  getMetricAlertFollowUpCalls,
} from "../../internal/formatting";
import {
  EventBuilder,
  createExceptionValue,
  createFrame,
  createStackTrace,
} from "../../internal/test-fixtures";
import {
  buildIssueEventPayload,
  issueEventSchema,
} from "./issue-event-payload";

function payload(event: Event) {
  return issueEventSchema.parse(buildIssueEventPayload({ event }));
}

/**
 * Mirrors a real metric issue event from `GET /issues/{id}/events/{id}/`: the
 * event serializer camelCases the occurrence payload, including nested
 * workflow-engine evidence and the serialized data source.
 */
function createMetricIssueEvent(evidenceData: Record<string, unknown>): Event {
  return {
    id: "4d6e1b607c564714a7de102a835fae54",
    type: "generic",
    title: "Error logs above 4000 over past 1 hour",
    message: null,
    platform: "python",
    dateCreated: "2026-10-28T11:39:52.000Z",
    entries: [],
    tags: [{ key: "level", value: "error" }],
    contexts: {
      trace: {
        trace_id: "bfa06a9c589f4d4f89236378d2194adc",
        span_id: "bfa06a9c589f4d4f",
        type: "trace",
      },
    },
    occurrence: {
      id: "occ-1",
      projectId: 1,
      eventId: "4d6e1b607c564714a7de102a835fae54",
      fingerprint: ["abc"],
      issueTitle: "Error logs above 4000 over past 1 hour",
      subtitle: "Critical: Number of error logs in the last hour above 4000",
      type: 8001,
      culprit: "",
      evidenceData,
      evidenceDisplay: [],
    },
  } as unknown as Event;
}

function createLogsMonitorEvidence(
  snubaQuery: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    value: 4988,
    detectorId: 1234567,
    dataPacketSourceId: "998877",
    conditions: [{ id: 1, type: "gt", comparison: 4000, conditionResult: 75 }],
    config: { detectionType: "static", thresholdPeriod: 1 },
    dataSources: [
      {
        id: "55",
        organizationId: "1",
        type: "snuba_query_subscription",
        sourceId: "998877",
        queryObj: {
          id: "998877",
          status: 0,
          subscription: "sub-1",
          snubaQuery: {
            id: "77",
            dataset: "events_analytics_platform",
            query: "severity:error",
            aggregate: "count(message)",
            timeWindow: 3600,
            environment: "prod",
            eventTypes: ["trace_item_log"],
            extrapolationMode: "unknown",
            ...snubaQuery,
          },
        },
      },
    ],
  };
}

describe("buildIssueEventPayload", () => {
  it("lists a chained exception's raised exception first", () => {
    const event = new EventBuilder("python")
      .withChainedExceptions([
        createExceptionValue({
          type: "ConnectionError",
          value: "connection refused",
          stacktrace: createStackTrace([
            createFrame({ filename: "db.py", function: "connect", lineNo: 9 }),
          ]),
        }),
        createExceptionValue({
          type: "RuntimeError",
          value: "could not load the cart",
          stacktrace: createStackTrace([
            createFrame({ filename: "cart.py", function: "load", lineNo: 30 }),
          ]),
        }),
      ])
      .build();

    expect(
      payload(event).exceptions?.map(({ type, value }) => ({ type, value })),
    ).toEqual([
      { type: "RuntimeError", value: "could not load the cart" },
      { type: "ConnectionError", value: "connection refused" },
    ]);
  });

  it("maps a CSP report", () => {
    expect(payload(createCspEvent() as unknown as Event).csp).toMatchObject({
      blockedUri: "blob",
      effectiveDirective: "img-src",
      documentUri: expect.stringContaining("https://blog.sentry.io/"),
    });
  });

  it("keeps only the evidence Sentry marks important", () => {
    const event = {
      id: "regression-event-1",
      type: "generic",
      title: "Endpoint Regression",
      message: null,
      platform: "python",
      dateCreated: "2025-11-18T06:01:20.000Z",
      entries: [],
      occurrence: {
        id: "occ-2",
        projectId: 1,
        eventId: "regression-event-1",
        fingerprint: ["def"],
        issueTitle: "Endpoint Regression",
        type: 1018,
        culprit: "POST /oauth/token",
        evidenceData: {
          change: "regression",
          transaction: "POST /oauth/token",
        },
        evidenceDisplay: [
          {
            name: "Regression",
            value:
              "POST /oauth/token duration increased from 909.77ms to 1711.36ms (P95)",
            important: true,
          },
          { name: "Transaction", value: "POST /oauth/token", important: false },
        ],
      },
    } as unknown as Event;

    const result = payload(event);

    expect(result.evidence).toEqual([
      {
        name: "Regression",
        value:
          "POST /oauth/token duration increased from 909.77ms to 1711.36ms (P95)",
      },
    ]);
    expect(result.metricAlert).toBeNull();
  });

  describe("metric alert", () => {
    it("maps the monitor query from camelCased evidence", () => {
      expect(
        payload(createMetricIssueEvent(createLogsMonitorEvidence()))
          .metricAlert,
      ).toEqual({
        monitorId: "1234567",
        alertRuleId: null,
        dataset: "logs",
        aggregate: "count(message)",
        query: "severity:error",
        intervalSeconds: 3600,
        environment: "prod",
        evaluatedWindow: {
          start: "2026-10-28T10:39:52.000Z",
          end: "2026-10-28T11:39:52.000Z",
        },
        value: "4988",
        thresholds: ["above 4000"],
      });
    });

    it("names the dataset the monitor's search tool reads, or the raw one", () => {
      const dataset = (snubaQuery: Record<string, unknown>) =>
        payload(createMetricIssueEvent(createLogsMonitorEvidence(snubaQuery)))
          .metricAlert?.dataset;

      expect(dataset({ dataset: "events", eventTypes: ["error"] })).toBe(
        "errors",
      );
      expect(dataset({ eventTypes: ["trace_item_span"] })).toBe("spans");
      expect(dataset({ eventTypes: ["trace_item_metric"] })).toBe("metrics");
      expect(
        dataset({ dataset: "transactions", eventTypes: ["transaction"] }),
      ).toBe("transactions");
    });

    it("maps the value, thresholds and legacy alert rule without data sources", () => {
      expect(
        payload(
          createMetricIssueEvent({
            value: 42,
            alertId: 7,
            conditions: [
              { type: "gte", comparison: 40 },
              { type: "lte", comparison: 50 },
            ],
          }),
        ).metricAlert,
      ).toMatchObject({
        alertRuleId: "7",
        dataset: null,
        evaluatedWindow: null,
        value: "42",
        thresholds: ["at or above 40", "at or below 50"],
      });
    });

    it("formats a dynamic alert value and skips an anomaly threshold", () => {
      const evidenceData = createLogsMonitorEvidence();
      evidenceData.value = {
        value: 12.5,
        source_id: "123",
        timestamp: 1780272000,
      };
      evidenceData.conditions = [
        {
          type: "anomaly_detection",
          comparison: {
            sensitivity: "medium",
            seasonality: "auto",
            thresholdType: 0,
          },
        },
      ];

      expect(
        payload(createMetricIssueEvent(evidenceData)).metricAlert,
      ).toMatchObject({ value: "12.5", thresholds: [] });
    });
  });
});

describe("getMetricAlertFollowUpCalls", () => {
  const issue = { project: { slug: "seer" } } as Issue;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-29T02:30:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function followUpCalls(evidenceData: Record<string, unknown>) {
    const event = createMetricIssueEvent(evidenceData);
    const context = getMetricAlertContext(event);
    if (!context) {
      throw new Error("expected a metric alert context");
    }
    return getMetricAlertFollowUpCalls({
      organizationSlug: "sentry",
      issue,
      event,
      context,
    });
  }

  it("points at the monitor and the data that breached it", () => {
    const calls = followUpCalls(createLogsMonitorEvidence());

    expect(calls.monitor).toEqual({
      toolName: "get_metric_monitor_details",
      arguments: { organizationSlug: "sentry", monitorId: "1234567" },
    });
    expect(calls.search).toMatchObject({
      toolName: "search_logs",
      arguments: {
        organizationSlug: "sentry",
        projectSlug: "seer",
        query: "severity:error environment:prod",
        period: "16h",
      },
    });
  });

  it("groups an OR monitor query before adding the environment filter", () => {
    expect(
      followUpCalls(
        createLogsMonitorEvidence({
          query: "severity:error OR severity:fatal",
        }),
      ).search?.arguments.query,
    ).toBe("(severity:error OR severity:fatal) environment:prod");
  });

  it("uses the dataset-specific search tool", () => {
    const errors = followUpCalls(
      createLogsMonitorEvidence({
        dataset: "events",
        query: "",
        environment: "my env",
        eventTypes: ["error", "default"],
      }),
    ).search;
    expect(errors?.toolName).toBe("search_errors");
    expect(errors?.arguments.query).toBe('environment:"my env"');
    expect(
      followUpCalls(
        createLogsMonitorEvidence({ eventTypes: ["trace_item_span"] }),
      ).search?.toolName,
    ).toBe("search_traces");
  });

  it("omits the search call when the dataset has no matching search tool", () => {
    const calls = followUpCalls(
      createLogsMonitorEvidence({ dataset: "metrics", eventTypes: [] }),
    );

    expect(calls.monitor).toBeDefined();
    expect(calls.search).toBeUndefined();
  });
});
