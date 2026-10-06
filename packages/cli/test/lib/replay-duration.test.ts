import { describe, expect, test } from "vitest";

import {
  formatDurationCompact,
  formatDurationCompactMs,
  formatDurationVerbose,
} from "../../src/lib/formatters/time-utils.js";

describe("formatDurationCompact", () => {
  test("formats short durations", () => {
    expect(formatDurationCompact(59)).toBe("59s");
    expect(formatDurationCompact(60)).toBe("1m");
    expect(formatDurationCompact(125)).toBe("2m 5s");
  });

  test("formats long durations", () => {
    expect(formatDurationCompact(3600)).toBe("1h");
    expect(formatDurationCompact(3665)).toBe("1h 1m");
    expect(formatDurationCompact(90_061)).toBe("1d 1h");
  });

  test("handles missing durations", () => {
    expect(formatDurationCompact(null)).toBe("—");
    expect(formatDurationCompact(undefined)).toBe("—");
  });
});

describe("formatDurationCompactMs", () => {
  test("converts ms to seconds and formats compactly", () => {
    expect(formatDurationCompactMs(5000)).toBe("5s");
    expect(formatDurationCompactMs(125_000)).toBe("2m 5s");
    expect(formatDurationCompactMs(3_665_000)).toBe("1h 1m");
  });

  test("handles sub-second durations", () => {
    expect(formatDurationCompactMs(0)).toBe("0s");
    expect(formatDurationCompactMs(499)).toBe("0s");
    expect(formatDurationCompactMs(500)).toBe("1s");
  });
});

describe("formatDurationVerbose", () => {
  test("formats short durations", () => {
    expect(formatDurationVerbose(1)).toBe("1 second");
    expect(formatDurationVerbose(125)).toBe("2 minutes and 5 seconds");
  });

  test("formats long durations", () => {
    expect(formatDurationVerbose(3600)).toBe("1 hour");
    expect(formatDurationVerbose(3665)).toBe("1 hour and 1 minute");
    expect(formatDurationVerbose(90_061)).toBe("1 day and 1 hour");
  });
});
