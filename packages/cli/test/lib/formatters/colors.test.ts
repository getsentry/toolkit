/**
 * Tests for terminal color utilities.
 *
 * Covers: statusColor, levelColor, fixabilityColor, terminalLink,
 * and the base color functions.
 */

import chalk from "chalk";
import { describe, expect, test } from "vitest";
import {
  fixabilityColor,
  levelColor,
  statusColor,
  terminalLink,
} from "../../../src/lib/formatters/colors.js";

// Force chalk colors even in test environment
chalk.level = 3;

/** Strip ANSI escape codes for content assertions */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes use control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("statusColor", () => {
  test("resolved → green-styled text", () => {
    const result = statusColor("text", "resolved");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("unresolved → yellow-styled text", () => {
    const result = statusColor("text", "unresolved");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("ignored → muted-styled text", () => {
    const result = statusColor("text", "ignored");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("undefined defaults to unresolved styling", () => {
    const result = statusColor("text", undefined);
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("RESOLVED works case-insensitively", () => {
    const result = statusColor("text", "RESOLVED");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("resolvedInNextRelease → green-styled text", () => {
    const result = statusColor("text", "resolvedInNextRelease");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("muted → muted-styled text", () => {
    const result = statusColor("text", "muted");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("unknown status defaults to unresolved styling", () => {
    const result = statusColor("text", "somethingNew");
    expect(stripAnsi(result)).toBe("text");
  });
});

describe("levelColor", () => {
  test("fatal → colored text", () => {
    const result = levelColor("text", "fatal");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("error → colored text", () => {
    const result = levelColor("text", "error");
    expect(result).toContain("\x1b[");
  });

  test("warning → colored text", () => {
    const result = levelColor("text", "warning");
    expect(result).toContain("\x1b[");
  });

  test("info → colored text", () => {
    const result = levelColor("text", "info");
    expect(result).toContain("\x1b[");
  });

  test("debug → colored text", () => {
    const result = levelColor("text", "debug");
    expect(result).toContain("\x1b[");
  });

  test("unknown level returns uncolored text", () => {
    const result = levelColor("text", "unknown");
    expect(result).toBe("text");
  });

  test("undefined returns uncolored text", () => {
    const result = levelColor("text", undefined);
    expect(result).toBe("text");
  });
});

describe("fixabilityColor", () => {
  test("high → green-styled text", () => {
    const result = fixabilityColor("text", "high");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("med → yellow-styled text", () => {
    const result = fixabilityColor("text", "med");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });

  test("low → red-styled text", () => {
    const result = fixabilityColor("text", "low");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("text");
  });
});

describe("terminalLink", () => {
  function restoreEnv(key: string, saved: string | undefined): void {
    if (saved !== undefined) {
      process.env[key] = saved;
    } else {
      delete process.env[key];
    }
  }

  /**
   * Save/restore isTTY and ALL plain-output env vars around TTY-specific tests.
   * `isPlainOutput()` precedence is SENTRY_PLAIN_OUTPUT > NO_COLOR > FORCE_COLOR
   * > !isTTY — so in CI (where NO_COLOR=1) failing to clear NO_COLOR/FORCE_COLOR
   * makes terminalLink return plain text even with isTTY forced true.
   */
  function withTTY(fn: () => void): void {
    const savedTTY = process.stdout.isTTY;
    const savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    const savedNoColor = process.env.NO_COLOR;
    const savedForceColor = process.env.FORCE_COLOR;
    process.stdout.isTTY = true;
    delete process.env.SENTRY_PLAIN_OUTPUT;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    try {
      fn();
    } finally {
      process.stdout.isTTY = savedTTY;
      restoreEnv("SENTRY_PLAIN_OUTPUT", savedPlain);
      restoreEnv("NO_COLOR", savedNoColor);
      restoreEnv("FORCE_COLOR", savedForceColor);
    }
  }

  test("wraps text in OSC 8 escape sequences on TTY", () => {
    withTTY(() => {
      const result = terminalLink("click me", "https://example.com");
      expect(result).toContain("]8;;https://example.com");
      expect(result).toContain("click me");
      expect(result).toContain("]8;;");
    });
  });

  test("preserves display text on TTY", () => {
    withTTY(() => {
      const result = terminalLink("display", "https://url.com");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 uses control chars
      const stripped = result.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
      expect(stripped).toBe("display");
    });
  });

  test("uses text as URL when url is omitted (TTY)", () => {
    withTTY(() => {
      const result = terminalLink("https://example.com");
      expect(result).toContain("]8;;https://example.com");
      expect(result).toContain("https://example.com");
      expect(result).toBe(
        terminalLink("https://example.com", "https://example.com")
      );
    });
  });

  test("returns plain text without OSC 8 when piped", () => {
    const savedTTY = process.stdout.isTTY;
    const savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.stdout.isTTY = false as unknown as boolean;
    delete process.env.SENTRY_PLAIN_OUTPUT;
    try {
      const result = terminalLink("click me", "https://example.com");
      expect(result).toBe("click me");
      expect(result).not.toContain("]8;;");
    } finally {
      process.stdout.isTTY = savedTTY;
      if (savedPlain !== undefined) {
        process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
      } else {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      }
    }
  });

  test("returns plain text when SENTRY_PLAIN_OUTPUT=1", () => {
    const savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "1";
    try {
      const result = terminalLink("display", "https://url.com");
      expect(result).toBe("display");
    } finally {
      if (savedPlain !== undefined) {
        process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
      } else {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      }
    }
  });
});
