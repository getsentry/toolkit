/**
 * Cache-hint formatting tests.
 *
 * Tests for the human-readable cache-age hint shown in command footers.
 * Core invariants (round-trips, validation) are tested here since the
 * module is small and the formatting has specific boundary values.
 */

import { describe, expect, test } from "vitest";
import {
  appendCacheHint,
  formatAge,
  formatCacheHint,
} from "../../src/lib/cache-hint.js";
import {
  clearLastCacheHitAge,
  getLastCacheHitAge,
  setLastCacheHitAgeForTesting,
} from "../../src/lib/response-cache.js";

describe("formatAge", () => {
  test("returns 'just now' for ages under 5 seconds", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(1000)).toBe("just now");
    expect(formatAge(4999)).toBe("just now");
  });

  test("returns seconds for ages 5s–59s", () => {
    expect(formatAge(5000)).toBe("5s ago");
    expect(formatAge(30_000)).toBe("30s ago");
    expect(formatAge(59_999)).toBe("59s ago");
  });

  test("returns minutes for ages 1m–59m", () => {
    expect(formatAge(60_000)).toBe("1m ago");
    expect(formatAge(180_000)).toBe("3m ago");
    expect(formatAge(59 * 60_000 + 59_999)).toBe("59m ago");
  });

  test("returns hours for ages 1h–23h", () => {
    expect(formatAge(60 * 60_000)).toBe("1h ago");
    expect(formatAge(3 * 60 * 60_000)).toBe("3h ago");
    expect(formatAge(23 * 60 * 60_000 + 59 * 60_000)).toBe("23h ago");
  });

  test("returns days for ages >= 24h", () => {
    expect(formatAge(24 * 60 * 60_000)).toBe("1d ago");
    expect(formatAge(48 * 60 * 60_000)).toBe("2d ago");
    expect(formatAge(7 * 24 * 60 * 60_000)).toBe("7d ago");
  });
});

describe("formatCacheHint", () => {
  test("returns undefined when no cache hit recorded", () => {
    clearLastCacheHitAge();
    expect(formatCacheHint()).toBeUndefined();
  });

  test("returns undefined when getLastCacheHitAge is undefined", () => {
    clearLastCacheHitAge();
    expect(getLastCacheHitAge()).toBeUndefined();
    expect(formatCacheHint()).toBeUndefined();
  });

  test("returns formatted hint when cache hit recorded (3m)", () => {
    setLastCacheHitAgeForTesting(180_000);
    expect(formatCacheHint()).toBe("cached · 3m ago · use -f to refresh");
    clearLastCacheHitAge();
  });

  test("returns formatted hint when cache hit recorded (just now)", () => {
    setLastCacheHitAgeForTesting(0);
    expect(formatCacheHint()).toBe("cached · just now · use -f to refresh");
    clearLastCacheHitAge();
  });

  test("returns formatted hint when cache hit recorded (2h)", () => {
    setLastCacheHitAgeForTesting(2 * 60 * 60_000);
    expect(formatCacheHint()).toBe("cached · 2h ago · use -f to refresh");
    clearLastCacheHitAge();
  });
});

describe("appendCacheHint", () => {
  test("returns undefined when no existing hint and no cache hit", () => {
    clearLastCacheHitAge();
    expect(appendCacheHint(undefined)).toBeUndefined();
  });

  test("returns existing hint unchanged when no cache hit", () => {
    clearLastCacheHitAge();
    expect(appendCacheHint("Tip: use -v")).toBe("Tip: use -v");
  });

  test("returns just the cache hint when no existing hint", () => {
    setLastCacheHitAgeForTesting(180_000);
    expect(appendCacheHint(undefined)).toBe(
      "cached · 3m ago · use -f to refresh"
    );
    clearLastCacheHitAge();
  });

  test("joins existing and cache hints with ' | ' separator", () => {
    setLastCacheHitAgeForTesting(180_000);
    expect(appendCacheHint("Showing 5 issues")).toBe(
      "Showing 5 issues | cached · 3m ago · use -f to refresh"
    );
    clearLastCacheHitAge();
  });

  test("treats empty existing hint as falsy (no separator)", () => {
    setLastCacheHitAgeForTesting(180_000);
    // Empty string is falsy — appendCacheHint returns just the cache hint.
    expect(appendCacheHint("")).toBe("cached · 3m ago · use -f to refresh");
    clearLastCacheHitAge();
  });
});
