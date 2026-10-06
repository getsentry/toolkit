/**
 * Property-Based Tests for cron monitor check-in builders.
 *
 * Verifies invariants of `buildMonitorConfig` and `buildCheckIn` that should
 * hold for any input: dependent-flag validation, schedule round-tripping,
 * and which fields appear on open vs. close check-ins.
 */

import {
  constantFrom,
  assert as fcAssert,
  integer,
  option,
  property,
  record,
  string,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  buildCheckIn,
  buildMonitorConfig,
  type CheckInConfigFlags,
} from "../../src/lib/envelope/checkin-builder.js";
import { ValidationError } from "../../src/lib/errors.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const crontabArb = constantFrom(
  "0 * * * *",
  "*/5 * * * *",
  "0 0 * * *",
  "30 2 * * 1"
);

const positiveIntArb = integer({ min: 1, max: 1440 });

describe("property: buildMonitorConfig", () => {
  test("returns undefined when --schedule is absent and no dependent flags", () => {
    fcAssert(
      property(option(string(), { nil: undefined }), (timezone) => {
        // Only timezone might be set; if it is, expect a throw, else undefined
        const flags: CheckInConfigFlags = {};
        if (timezone !== undefined) {
          flags.timezone = timezone;
          expect(() => buildMonitorConfig(flags)).toThrow(ValidationError);
        } else {
          expect(buildMonitorConfig(flags)).toBeUndefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("throws when any dependent flag is set without --schedule", () => {
    const dependentFlagSetters: Array<(f: CheckInConfigFlags) => void> = [
      (f) => {
        f["check-in-margin"] = 5;
      },
      (f) => {
        f["max-runtime"] = 30;
      },
      (f) => {
        f.timezone = "UTC";
      },
      (f) => {
        f["failure-issue-threshold"] = 2;
      },
      (f) => {
        f["recovery-threshold"] = 3;
      },
    ];
    for (const setter of dependentFlagSetters) {
      const flags: CheckInConfigFlags = {};
      setter(flags);
      expect(() => buildMonitorConfig(flags)).toThrow(ValidationError);
    }
  });

  const thresholdsArb = record({
    margin: option(positiveIntArb, { nil: undefined }),
    maxRuntime: option(positiveIntArb, { nil: undefined }),
    failure: option(positiveIntArb, { nil: undefined }),
    recovery: option(positiveIntArb, { nil: undefined }),
  });

  test("round-trips schedule and thresholds when --schedule is set", () => {
    fcAssert(
      property(crontabArb, thresholdsArb, (schedule, thresholds) => {
        const flags: CheckInConfigFlags = { schedule };
        if (thresholds.margin !== undefined) {
          flags["check-in-margin"] = thresholds.margin;
        }
        if (thresholds.maxRuntime !== undefined) {
          flags["max-runtime"] = thresholds.maxRuntime;
        }
        if (thresholds.failure !== undefined) {
          flags["failure-issue-threshold"] = thresholds.failure;
        }
        if (thresholds.recovery !== undefined) {
          flags["recovery-threshold"] = thresholds.recovery;
        }

        const config = buildMonitorConfig(flags);
        expect(config).toBeDefined();
        expect(config?.schedule).toEqual({ type: "crontab", value: schedule });
        expect(config?.checkin_margin).toBe(thresholds.margin);
        expect(config?.max_runtime).toBe(thresholds.maxRuntime);
        expect(config?.failure_issue_threshold).toBe(thresholds.failure);
        expect(config?.recovery_threshold).toBe(thresholds.recovery);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: buildCheckIn", () => {
  const slugArb = string({ minLength: 1, maxLength: 40 });
  const statusArb = constantFrom("in_progress", "ok", "error" as const);

  test("always carries the provided check_in_id, slug, and status", () => {
    fcAssert(
      property(
        slugArb,
        slugArb,
        statusArb,
        (checkInId, monitorSlug, status) => {
          const checkIn = buildCheckIn({
            checkInId,
            monitorSlug,
            status: status as "in_progress" | "ok" | "error",
          });
          expect(checkIn.check_in_id).toBe(checkInId);
          expect(checkIn.monitor_slug).toBe(monitorSlug);
          expect(checkIn.status).toBe(status);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("duration is only present when explicitly provided", () => {
    const open = buildCheckIn({
      checkInId: "a",
      monitorSlug: "job",
      status: "in_progress",
    });
    expect(open.duration).toBeUndefined();

    const close = buildCheckIn({
      checkInId: "a",
      monitorSlug: "job",
      status: "ok",
      duration: 12.5,
    });
    expect(close.duration).toBe(12.5);
  });

  test("monitor_config is only present when explicitly provided", () => {
    const withConfig = buildCheckIn({
      checkInId: "a",
      monitorSlug: "job",
      status: "in_progress",
      monitorConfig: { schedule: { type: "crontab", value: "0 * * * *" } },
    });
    expect(withConfig.monitor_config).toBeDefined();

    const withoutConfig = buildCheckIn({
      checkInId: "a",
      monitorSlug: "job",
      status: "ok",
      duration: 1,
    });
    expect(withoutConfig.monitor_config).toBeUndefined();
  });
});
