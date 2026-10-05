/**
 * Hex ID Validation Tests
 *
 * Property-based and unit tests for the shared hex ID validation
 * in src/lib/hex-id.ts.
 *
 * Regex patterns (HEX_ID_RE, UUID_DASH_RE) are covered by the property tests
 * at the bottom of this file which generate random valid/invalid hex strings.
 * The unit tests here focus on `validateHexId` behavior: error messages,
 * whitespace handling, UUID normalization, and edge cases.
 */

import { array, constantFrom, assert as fcAssert, property } from "fast-check";
import { describe, expect, test } from "vitest";
import { ValidationError } from "../../src/lib/errors.js";
import {
  ageInDaysFromUuidV7,
  decodeUuidV7Timestamp,
  validateHexId,
  validateSpanId,
} from "../../src/lib/hex-id.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const HEX_CHARS = "0123456789abcdefABCDEF".split("");
const VALID_ID = "aaaa1111bbbb2222cccc3333dddd4444";

/** Arbitrary for valid 32-char hex strings */
const validIdArb = array(constantFrom(...HEX_CHARS), {
  minLength: 32,
  maxLength: 32,
}).map((chars) => chars.join(""));

describe("validateHexId", () => {
  test("returns the ID for valid input", () => {
    expect(validateHexId(VALID_ID, "test ID")).toBe(VALID_ID);
  });

  test("trims leading and trailing whitespace", () => {
    expect(validateHexId(`  ${VALID_ID}  `, "test ID")).toBe(VALID_ID);
  });

  test("trims trailing newline", () => {
    expect(validateHexId(`${VALID_ID}\n`, "test ID")).toBe(VALID_ID);
  });

  test("normalizes to lowercase", () => {
    const mixedCase = "AAAA1111bbbb2222CCCC3333dddd4444";
    expect(validateHexId(mixedCase, "test ID")).toBe(
      "aaaa1111bbbb2222cccc3333dddd4444"
    );
  });

  test("throws ValidationError for empty string", () => {
    expect(() => validateHexId("", "test ID")).toThrow(ValidationError);
  });

  test("throws ValidationError for short hex", () => {
    expect(() => validateHexId("abc123", "test ID")).toThrow(ValidationError);
  });

  test("throws ValidationError for non-hex chars", () => {
    expect(() =>
      validateHexId("zzzz1111bbbb2222cccc3333dddd4444", "test ID")
    ).toThrow(ValidationError);
  });

  test("throws ValidationError for 33-char hex", () => {
    expect(() => validateHexId(`${VALID_ID}a`, "test ID")).toThrow(
      ValidationError
    );
  });

  test("error message includes the label", () => {
    try {
      validateHexId("bad", "log ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain("log ID");
    }
  });

  test("error message includes the invalid value", () => {
    try {
      validateHexId("bad-id", "test ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain("bad-id");
    }
  });

  test("error message truncates long invalid values", () => {
    const longId = "a".repeat(100);
    try {
      validateHexId(longId, "test ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("...");
      // Should not contain the full 100-char string
      expect(msg).not.toContain(longId);
    }
  });

  test("error message includes format hint", () => {
    try {
      validateHexId("short", "test ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain(
        "32-character hexadecimal"
      );
    }
  });

  test("error hints span ID when 16-char hex is passed as trace ID", () => {
    try {
      validateHexId("a1b2c3d4e5f67890", "trace ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("trace ID");
      expect(msg).toContain("looks like a span ID");
      expect(msg).toContain("sentry span view");
    }
  });

  test("error hints non-hex input when slug is passed as trace ID", () => {
    try {
      validateHexId("my-project", "trace ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("doesn't look like a hex ID");
      expect(msg).toContain("project");
    }
  });

  test("error hints help flag for --h input", () => {
    try {
      validateHexId("--h", "event ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("looks like a help flag");
      expect(msg).toContain("--help or -h");
    }
  });

  test("error hints help flag for -help input", () => {
    try {
      validateHexId("-help", "trace ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("looks like a help flag");
    }
  });

  test("error hints generic flag for --verbose input", () => {
    try {
      validateHexId("--verbose", "log ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("looks like a CLI flag");
      expect(msg).toContain("--help");
    }
  });

  test("flag-like detection takes precedence over slug hint", () => {
    try {
      validateHexId("--my-flag", "event ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("looks like a CLI flag");
      // Should NOT suggest project slug
      expect(msg).not.toContain("doesn't look like a hex ID");
    }
  });

  test("no extra hint for random-length hex (not a span ID)", () => {
    try {
      validateHexId("abc123", "log ID");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).not.toContain("span ID");
      expect(msg).not.toContain("project");
    }
  });

  test("throws for newline-separated IDs (not a single valid ID)", () => {
    const multiLine = `${VALID_ID}\n${"bbbb1111cccc2222dddd3333eeee4444"}`;
    expect(() => validateHexId(multiLine, "test ID")).toThrow(ValidationError);
  });

  test("strips dashes from UUID format and returns 32-char hex", () => {
    expect(
      validateHexId("aaaa1111-bbbb-2222-cccc-3333dddd4444", "test ID")
    ).toBe(VALID_ID);
  });

  test("strips dashes from real user UUID (CLI-7Z)", () => {
    expect(
      validateHexId("ed29abc8-71c4-475b-9675-4655ef1a02d0", "test ID")
    ).toBe("ed29abc871c4475b96754655ef1a02d0");
  });

  test("strips dashes from uppercase UUID and normalizes to lowercase", () => {
    expect(
      validateHexId("AAAA1111-BBBB-2222-CCCC-3333DDDD4444", "test ID")
    ).toBe(VALID_ID);
  });

  test("strips dashes from UUID with whitespace padding", () => {
    expect(
      validateHexId("  aaaa1111-bbbb-2222-cccc-3333dddd4444  ", "test ID")
    ).toBe(VALID_ID);
  });

  test("UUID validation is idempotent — validated UUID validates again unchanged", () => {
    const first = validateHexId(
      "aaaa1111-bbbb-2222-cccc-3333dddd4444",
      "test ID"
    );
    const second = validateHexId(first, "test ID");
    expect(second).toBe(first);
  });

  test("rejects non-UUID dash patterns (random dashes)", () => {
    expect(() => validateHexId("abc-def", "test ID")).toThrow(ValidationError);
  });

  test("rejects dashes in wrong positions (not 8-4-4-4-12)", () => {
    expect(() =>
      validateHexId("aaaa-1111bbbb-2222cccc-3333dddd-4444", "test ID")
    ).toThrow(ValidationError);
  });
});

describe("validateSpanId", () => {
  test("returns the span ID for valid input", () => {
    expect(validateSpanId("a1b2c3d4e5f67890")).toBe("a1b2c3d4e5f67890");
  });

  test("normalizes to lowercase", () => {
    expect(validateSpanId("A1B2C3D4E5F67890")).toBe("a1b2c3d4e5f67890");
  });

  test("throws for 32-char hex with trace ID hint", () => {
    try {
      validateSpanId("aaaa1111bbbb2222cccc3333dddd4444");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("span ID");
      expect(msg).toContain("looks like a trace ID");
    }
  });

  test("throws for short hex without trace ID hint", () => {
    try {
      validateSpanId("abc123");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("span ID");
      expect(msg).not.toContain("trace ID");
    }
  });
});

describe("property: validateHexId", () => {
  test("accepts any 32-char hex string and normalizes to lowercase", () => {
    fcAssert(
      property(validIdArb, (id) => {
        expect(validateHexId(id, "test ID")).toBe(id.toLowerCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is idempotent — validating twice returns the same value", () => {
    fcAssert(
      property(validIdArb, (id) => {
        const first = validateHexId(id, "test ID");
        const second = validateHexId(first, "test ID");
        expect(second).toBe(first);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("accepts whitespace-padded valid IDs after trim", () => {
    fcAssert(
      property(validIdArb, (id) => {
        const expected = id.toLowerCase();
        expect(validateHexId(`  ${id}  `, "test ID")).toBe(expected);
        expect(validateHexId(`\t${id}\n`, "test ID")).toBe(expected);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  /** Arbitrary for hex strings that are NOT exactly 32 chars */
  const wrongLengthHexArb = array(constantFrom(...HEX_CHARS), {
    minLength: 0,
    maxLength: 64,
  })
    .filter((chars) => chars.length !== 32)
    .map((chars) => chars.join(""));

  test("rejects hex strings with wrong length", () => {
    fcAssert(
      property(wrongLengthHexArb, (id) => {
        expect(() => validateHexId(id, "test ID")).toThrow(ValidationError);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  /**
   * Insert dashes at UUID positions (8-4-4-4-12) into a 32-char hex string.
   */
  function toUuidFormat(hex: string): string {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  test("UUID format with dashes produces same result as plain hex", () => {
    fcAssert(
      property(validIdArb, (id) => {
        const expected = id.toLowerCase();
        const uuid = toUuidFormat(id);
        expect(validateHexId(uuid, "test ID")).toBe(expected);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("UUID validation round-trips: validateHexId(uuid) === validateHexId(plain)", () => {
    fcAssert(
      property(validIdArb, (id) => {
        const fromPlain = validateHexId(id, "test ID");
        const fromUuid = validateHexId(toUuidFormat(id), "test ID");
        expect(fromUuid).toBe(fromPlain);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("decodeUuidV7Timestamp", () => {
  // Real Sentry log IDs observed in CLI project telemetry.
  // First 12 hex chars = milliseconds since Unix epoch.
  test("decodes real Sentry log ID (April 2026)", () => {
    const result = decodeUuidV7Timestamp("019da223817478d8a98508aaedbafdc1");
    expect(result).not.toBeNull();
    expect(result?.createdAt.toISOString().slice(0, 10)).toBe("2026-04-18");
  });

  test("decodes real Sentry log ID (February 2026)", () => {
    const result = decodeUuidV7Timestamp("019c6d2ca9ec7cc5bd02f9190d77debe");
    expect(result).not.toBeNull();
    expect(result?.createdAt.toISOString().slice(0, 10)).toBe("2026-02-17");
  });

  test("accepts dash-separated UUIDv7", () => {
    const dashed = "019da223-8174-78d8-a985-08aaedbafdc1";
    const result = decodeUuidV7Timestamp(dashed);
    expect(result).not.toBeNull();
    expect(result?.createdAt.toISOString().slice(0, 10)).toBe("2026-04-18");
  });

  test("returns null for non-v7 (v4) UUID", () => {
    // Random UUID v4 — version char at position 12 is "4"
    const result = decodeUuidV7Timestamp("c0a5a9d4dce44358ab4231fc3bead7e9");
    expect(result).toBeNull();
  });

  test("returns null for invalid hex input", () => {
    expect(decodeUuidV7Timestamp("not-a-uuid")).toBeNull();
    expect(decodeUuidV7Timestamp("")).toBeNull();
    expect(decodeUuidV7Timestamp("019d")).toBeNull();
  });

  test("returns null for 32-char hex with version char outside v7", () => {
    // Swap position 12 to "8" → not v7
    expect(
      decodeUuidV7Timestamp("019da22381848d8a98508aaedbafdc11")
    ).toBeNull();
  });
});

describe("ageInDaysFromUuidV7", () => {
  /** Build a 32-char UUIDv7 where the embedded timestamp is `date`. */
  function buildUuidV7(date: Date): string {
    const ts = date.getTime().toString(16).padStart(12, "0");
    // 12 time + 1 version + 19 rand/variant = 32 total
    return `${ts}70008000000000000000`;
  }

  test("returns age in days relative to `now`", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const past = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    const age = ageInDaysFromUuidV7(buildUuidV7(past), now);
    expect(age).toBeCloseTo(100, 5);
  });

  test("returns null for non-v7 input", () => {
    expect(ageInDaysFromUuidV7("c0a5a9d4dce44358ab4231fc3bead7e9")).toBeNull();
  });

  test("returns negative age for future timestamps (no clamping)", () => {
    const now = new Date("2020-01-01T00:00:00Z");
    const future = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    const age = ageInDaysFromUuidV7(buildUuidV7(future), now);
    expect(age).toBeCloseTo(-10, 5);
  });
});
