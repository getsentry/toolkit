import { describe, expect, test } from "vitest";
import {
  formatAxisTimestamp,
  formatLocalDateTime,
} from "../../../src/lib/formatters/time-utils.js";

describe("formatLocalDateTime", () => {
  // 2025-11-16T12:00:00Z in epoch milliseconds.
  const epochMilliseconds = 1_763_294_400_000;

  test("treats numbers as epoch milliseconds", () => {
    expect(formatLocalDateTime(epochMilliseconds)).toBe(
      new Date(epochMilliseconds).toLocaleString(),
    );
  });

  test("formats ISO date strings", () => {
    const iso = new Date(epochMilliseconds).toISOString();
    expect(formatLocalDateTime(iso)).toBe(
      new Date(epochMilliseconds).toLocaleString(),
    );
  });

  test("returns a dash for missing or invalid input", () => {
    expect(formatLocalDateTime(undefined)).toBe("—");
    expect(formatLocalDateTime(null)).toBe("—");
    expect(formatLocalDateTime("")).toBe("—");
    expect(formatLocalDateTime("not-a-date")).toBe("—");
    expect(formatLocalDateTime(Number.NaN)).toBe("—");
  });
});

describe("formatAxisTimestamp", () => {
  const timestamp = Date.UTC(2024, 0, 15, 10, 30) / 1000;
  const date = new Date(timestamp * 1000);

  test("uses clock time for periods shorter than two days", () => {
    expect(formatAxisTimestamp(timestamp, 1)).toBe(
      `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
    );
  });

  test("formats the Unix epoch instead of treating it as missing", () => {
    const epoch = new Date(0);
    expect(formatAxisTimestamp(0, 1)).toBe(
      `${String(epoch.getHours()).padStart(2, "0")}:${String(epoch.getMinutes()).padStart(2, "0")}`,
    );
    expect(formatAxisTimestamp(0, 7)).toBe(
      `${String(epoch.getMonth() + 1).padStart(2, "0")}/${String(epoch.getDate()).padStart(2, "0")}`,
    );
  });

  test("uses calendar dates for multi-day periods", () => {
    expect(formatAxisTimestamp(timestamp, 7)).toBe(
      `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`,
    );
    expect(formatAxisTimestamp(timestamp, 31)).toBe(`Jan ${date.getDate()}`);
  });
});
