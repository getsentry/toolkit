/**
 * Tests for src/lib/timezone.ts
 *
 * Covers the pure helper `fixedOffsetZone` and the decision logic of
 * `initTimezone`. The bug being guarded against: SEA
 * binaries fall back to UTC when they cannot resolve the OS zone, so log
 * timestamps appear hours off from the user's local clock.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  detectOsTimezone,
  fixedOffsetZone,
  initTimezone,
  runtimeTimezone,
} from "../../src/lib/timezone.js";

describe("fixedOffsetZone", () => {
  test("west of UTC (positive offset) → Etc/GMT+N", () => {
    // US/Pacific standard is +480 min behind UTC → UTC-8.
    expect(fixedOffsetZone(480)).toBe("Etc/GMT+8");
  });

  test("east of UTC (negative offset) → Etc/GMT-N", () => {
    // Berlin winter is -60 min → UTC+1.
    expect(fixedOffsetZone(-60)).toBe("Etc/GMT-1");
  });

  test("returns null for UTC / sub-hour / invalid offsets", () => {
    expect(fixedOffsetZone(0)).toBeNull();
    expect(fixedOffsetZone(30)).toBeNull();
    expect(fixedOffsetZone(Number.NaN)).toBeNull();
  });
});

describe("runtimeTimezone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns a non-empty IANA-ish string", () => {
    const tz = runtimeTimezone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });

  test("falls back to UTC when Intl resolves an empty zone", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "" }),
    } as unknown as Intl.DateTimeFormat);
    expect(runtimeTimezone()).toBe("UTC");
  });

  test("falls back to UTC when Intl throws", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("ICU data missing");
    });
    expect(runtimeTimezone()).toBe("UTC");
  });
});

describe("detectOsTimezone", () => {
  test("never throws and returns string or null", () => {
    const result = detectOsTimezone();
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("initTimezone", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  test("respects an already-set TZ and makes no change", () => {
    process.env.TZ = "America/New_York";
    expect(initTimezone()).toBeNull();
    expect(process.env.TZ).toBe("America/New_York");
  });

  test("does nothing when the runtime already resolved a real zone", () => {
    delete process.env.TZ;
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "America/Los_Angeles" }),
    } as unknown as Intl.DateTimeFormat);

    expect(initTimezone()).toBeNull();
    expect(process.env.TZ).toBeUndefined();
  });

  test("leaves genuine UTC machines untouched", () => {
    delete process.env.TZ;
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "UTC" }),
    } as unknown as Intl.DateTimeFormat);
    // OS offset 0 → machine really is UTC.
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);

    expect(initTimezone()).toBeNull();
    expect(process.env.TZ).toBeUndefined();
  });

  test("repairs the UTC fallback using the OS offset", () => {
    delete process.env.TZ;
    // Runtime fell back to UTC ...
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "UTC" }),
    } as unknown as Intl.DateTimeFormat);
    // ... but the OS clock is 8h behind UTC (US/Pacific standard).
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(480);

    const applied = initTimezone();
    expect(applied).not.toBeNull();
    expect(process.env.TZ).toBe(applied ?? "");
    // Either a detected IANA name or the fixed-offset fallback.
    expect(process.env.TZ?.length).toBeGreaterThan(0);
  });
});
