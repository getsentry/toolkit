/**
 * Tests for human formatter utility functions
 *
 * These tests cover pure utility functions that don't depend on external state.
 * Functions tested: formatStatusIcon, formatStatusLabel,
 * formatRelativeTime, maskToken, formatDuration, formatExpiration
 */

import {
  assert as fcAssert,
  integer,
  nat,
  property,
  stringMatching,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  formatDuration,
  formatExpiration,
  formatStatusIcon,
  formatStatusLabel,
  maskToken,
} from "../../../src/lib/formatters/human.js";
import { formatRelativeTime } from "../../../src/lib/formatters/time-utils.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

// Helper to strip ANSI codes and markdown color tags for content testing.
// Strips color tags first to avoid incomplete multi-character sanitization
// (ANSI removal could otherwise join fragments into tag-like sequences).
function stripAnsi(str: string): string {
  let result = str.replace(/<\/?[a-z]+>/g, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes use control chars
  result = result.replace(/\x1b\[[0-9;]*m/g, "");
  return result;
}

// Status Formatting

describe("formatStatusIcon", () => {
  test("returns checkmark for resolved status", () => {
    const result = stripAnsi(formatStatusIcon("resolved"));
    expect(result).toBe("✓");
  });

  test("returns bullet for unresolved status", () => {
    const result = stripAnsi(formatStatusIcon("unresolved"));
    expect(result).toBe("●");
  });

  test("returns dash for ignored status", () => {
    const result = stripAnsi(formatStatusIcon("ignored"));
    expect(result).toBe("−");
  });

  test("returns bullet for undefined status", () => {
    const result = stripAnsi(formatStatusIcon(undefined));
    expect(result).toBe("●");
  });

  test("returns bullet for unknown status", () => {
    const result = stripAnsi(formatStatusIcon("unknown-status"));
    expect(result).toBe("●");
  });
});

describe("formatStatusLabel", () => {
  test("returns full label for resolved status", () => {
    const result = stripAnsi(formatStatusLabel("resolved"));
    expect(result).toBe("✓ Resolved");
  });

  test("returns full label for unresolved status", () => {
    const result = stripAnsi(formatStatusLabel("unresolved"));
    expect(result).toBe("● Unresolved");
  });

  test("returns full label for ignored status", () => {
    const result = stripAnsi(formatStatusLabel("ignored"));
    expect(result).toBe("− Ignored");
  });

  test("returns Unknown for undefined status", () => {
    const result = stripAnsi(formatStatusLabel(undefined));
    expect(result).toBe("● Unknown");
  });

  test("returns Unknown for unrecognized status", () => {
    const result = stripAnsi(formatStatusLabel("something-else"));
    expect(result).toBe("● Unknown");
  });
});

// Relative Time Formatting

describe("formatRelativeTime", () => {
  test("returns em-dash for undefined input", () => {
    const result = formatRelativeTime(undefined);
    // Verify the content is an em-dash (with optional padding)
    // Note: padEnd(10) only pads correctly when ANSI colors are disabled.
    // With colors enabled, the ANSI-wrapped string is already >10 chars,
    // so no padding is added. We only verify content, not length.
    expect(stripAnsi(result).trim()).toBe("—");
  });

  test("formats minutes ago for recent times", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = stripAnsi(formatRelativeTime(fiveMinutesAgo));
    expect(result.trim()).toMatch(/^\d+m ago$/);
  });

  test("formats hours ago for times within 24 hours", () => {
    const threeHoursAgo = new Date(
      Date.now() - 3 * 60 * 60 * 1000
    ).toISOString();
    const result = stripAnsi(formatRelativeTime(threeHoursAgo));
    expect(result.trim()).toMatch(/^\d+h ago$/);
  });

  test("formats days ago for times within 3 days", () => {
    const twoDaysAgo = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const result = stripAnsi(formatRelativeTime(twoDaysAgo));
    expect(result.trim()).toMatch(/^\d+d ago$/);
  });

  test("formats short date for times older than 3 days", () => {
    const tenDaysAgo = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000
    ).toISOString();
    const result = stripAnsi(formatRelativeTime(tenDaysAgo));
    // Should be like "Jan 18" or "Dec 5"
    expect(result.trim()).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  test("result contains valid relative time format", () => {
    const now = new Date().toISOString();
    const result = stripAnsi(formatRelativeTime(now));
    // Should be "0m ago" or similar for very recent times
    expect(result.trim()).toMatch(/^\d+[mhd] ago$|^[A-Z][a-z]{2} \d{1,2}$/);
  });

  test("clamps future timestamps to '0m ago' instead of negative", () => {
    // Clock skew / scheduled timestamps can be in the future; diffMs is clamped
    // to >= 0 so we never render "-5m ago".
    const fiveMinutesAhead = new Date(Date.now() + 5 * 60_000).toISOString();
    const result = stripAnsi(formatRelativeTime(fiveMinutesAhead));
    expect(result.trim()).toBe("0m ago");
    expect(result).not.toContain("-");
  });
});

// Token Masking

describe("maskToken", () => {
  test("masks short tokens completely", () => {
    expect(maskToken("abc")).toBe("****");
    expect(maskToken("123456789012")).toBe("****"); // Exactly 12 chars
  });

  test("shows first 8 and last 4 chars for longer tokens", () => {
    const token = "sntrys_1234567890abcdef";
    const result = maskToken(token);
    expect(result).toBe("sntrys_1...cdef");
  });

  test("property: masked token never reveals middle characters", async () => {
    const longTokenArb = stringMatching(/^[a-zA-Z0-9_]{13,50}$/);

    await fcAssert(
      property(longTokenArb, (token) => {
        const masked = maskToken(token);
        // Should show first 8, then ..., then last 4
        expect(masked).toBe(
          `${token.substring(0, 8)}...${token.substring(token.length - 4)}`
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("property: short tokens are completely masked", async () => {
    const shortTokenArb = stringMatching(/^[a-zA-Z0-9]{1,12}$/);

    await fcAssert(
      property(shortTokenArb, (token) => {
        expect(maskToken(token)).toBe("****");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Duration Formatting

describe("formatDuration", () => {
  test("formats singular minute", () => {
    expect(formatDuration(60)).toBe("1 minute");
  });

  test("formats plural minutes", () => {
    expect(formatDuration(300)).toBe("5 minutes");
  });

  test("formats singular hour", () => {
    expect(formatDuration(3600)).toBe("1 hour");
  });

  test("formats plural hours", () => {
    expect(formatDuration(7200)).toBe("2 hours");
  });

  test("formats hours and minutes combined", () => {
    expect(formatDuration(5400)).toBe("1 hour and 30 minutes");
  });

  test("formats multiple hours and singular minute", () => {
    expect(formatDuration(7260)).toBe("2 hours and 1 minute");
  });

  test("formats zero minutes", () => {
    expect(formatDuration(0)).toBe("0 minutes");
  });

  test("formats less than a minute as 0 minutes", () => {
    expect(formatDuration(30)).toBe("0 minutes");
  });

  test("formats singular day", () => {
    expect(formatDuration(86_400)).toBe("1 day");
  });

  test("formats plural days", () => {
    expect(formatDuration(3 * 86_400)).toBe("3 days");
  });

  test("formats days and hours combined", () => {
    expect(formatDuration(86_400 + 4 * 3600)).toBe("1 day and 4 hours");
  });

  test("formats days and singular hour", () => {
    expect(formatDuration(2 * 86_400 + 3600)).toBe("2 days and 1 hour");
  });

  test("formats singular week", () => {
    expect(formatDuration(7 * 86_400)).toBe("1 week");
  });

  test("formats plural weeks", () => {
    expect(formatDuration(14 * 86_400)).toBe("2 weeks");
  });

  test("formats weeks and days combined", () => {
    expect(formatDuration(25 * 86_400)).toBe("3 weeks and 4 days");
  });

  test("formats weeks and singular day", () => {
    expect(formatDuration(8 * 86_400)).toBe("1 week and 1 day");
  });

  test("formats ~580 hours as days", () => {
    // 580 hours = 24 days and 4 hours → 3 weeks and 3 days
    expect(formatDuration(580 * 3600)).toBe("3 weeks and 3 days");
  });

  test("property: duration formatting always contains a time unit", async () => {
    await fcAssert(
      property(nat({ max: 86_400 * 60 }), (seconds) => {
        const result = formatDuration(seconds);
        expect(result).toMatch(/minute|hour|day|week/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Expiration Formatting

describe("formatExpiration", () => {
  test("returns Expired for past timestamps", () => {
    const pastTime = Date.now() - 1000;
    expect(formatExpiration(pastTime)).toBe("Expired");
  });

  test("includes remaining time for future timestamps", () => {
    // 2 hours from now
    const futureTime = Date.now() + 2 * 60 * 60 * 1000;
    const result = formatExpiration(futureTime);
    expect(result).toContain("remaining");
    expect(result).toContain("hour");
  });

  test("includes date string for future timestamps", () => {
    const futureTime = Date.now() + 60 * 60 * 1000; // 1 hour from now
    const result = formatExpiration(futureTime);
    // Should include a date/time string
    expect(result).toMatch(/\d/);
    expect(result).toContain("(");
    expect(result).toContain(")");
  });

  test("property: expired times always return 'Expired'", async () => {
    await fcAssert(
      property(integer({ min: 1, max: 1_000_000 }), (msAgo) => {
        const pastTime = Date.now() - msAgo;
        expect(formatExpiration(pastTime)).toBe("Expired");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("property: future times always include 'remaining'", async () => {
    await fcAssert(
      property(integer({ min: 60_000, max: 86_400_000 }), (msAhead) => {
        const futureTime = Date.now() + msAhead;
        const result = formatExpiration(futureTime);
        expect(result).toContain("remaining");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
