/**
 * Tests for monitor list schedule formatting.
 */

import { describe, expect, test } from "vitest";
import { formatSchedule } from "../../../src/commands/monitor/list.js";
import type { SentryMonitor } from "../../../src/types/index.js";

function monitor(config: SentryMonitor["config"]): SentryMonitor {
  return {
    id: "1",
    slug: "m",
    name: "Monitor",
    status: "active",
    config,
  };
}

describe("formatSchedule", () => {
  test("returns an empty string when no schedule is configured", () => {
    expect(formatSchedule(monitor(undefined))).toBe("");
    expect(formatSchedule(monitor({}))).toBe("");
  });

  test("renders a crontab schedule verbatim", () => {
    expect(formatSchedule(monitor({ schedule: "0 * * * *" }))).toBe(
      "0 * * * *",
    );
  });

  test("renders a well-formed interval schedule", () => {
    expect(formatSchedule(monitor({ schedule: [1, "hour"] }))).toBe(
      "every 1 hour",
    );
  });

  test("falls back to the first element for a single-element interval", () => {
    expect(formatSchedule(monitor({ schedule: [5] }))).toBe("5");
  });

  test("returns an empty string for an empty interval array", () => {
    expect(formatSchedule(monitor({ schedule: [] }))).toBe("");
  });
});
