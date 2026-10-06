/**
 * Tests for cron monitor types.
 *
 * Validates that `SentryMonitorSchema` accepts a representative
 * `/organizations/{org}/monitors/` API response, including crontab and
 * interval schedule shapes and nullable threshold fields.
 */

import { safeParse } from "valibot";
import { describe, expect, test } from "vitest";
import { SentryMonitorSchema } from "../../../src/types/sentry.js";

const crontabMonitor = {
  id: "12345",
  slug: "nightly-job",
  name: "Nightly Job",
  status: "active",
  isMuted: false,
  isUpserting: false,
  config: {
    schedule_type: "crontab",
    schedule: "0 0 * * *",
    checkin_margin: null,
    max_runtime: 30,
    timezone: "UTC",
    failure_issue_threshold: null,
    recovery_threshold: null,
    alert_rule_id: null,
  },
  dateCreated: "2024-01-01T00:00:00Z",
  project: {
    id: "1",
    slug: "my-project",
    name: "My Project",
    platform: "python",
  },
};

const intervalMonitor = {
  id: "67890",
  slug: "hourly-job",
  name: "Hourly Job",
  status: "disabled",
  config: {
    schedule_type: "interval",
    schedule: [1, "hour"],
    checkin_margin: 5,
    max_runtime: null,
    timezone: null,
  },
};

describe("SentryMonitorSchema", () => {
  test("accepts a crontab monitor response", () => {
    const result = safeParse(SentryMonitorSchema, crontabMonitor);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.slug).toBe("nightly-job");
      expect(result.output.config?.schedule).toBe("0 0 * * *");
      // unknown fields are preserved via passthrough
      expect((result.output as Record<string, unknown>).isUpserting).toBe(
        false
      );
    }
  });

  test("accepts an interval monitor with tuple schedule", () => {
    const result = safeParse(SentryMonitorSchema, intervalMonitor);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.config?.schedule).toEqual([1, "hour"]);
    }
  });

  test("rejects a monitor missing required core identifiers", () => {
    const result = safeParse(SentryMonitorSchema, {
      slug: "no-id",
      name: "No ID",
      status: "active",
    });
    expect(result.success).toBe(false);
  });
});
