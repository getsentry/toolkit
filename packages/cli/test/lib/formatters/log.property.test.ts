/**
 * Property-Based Tests for Log Formatters
 *
 * Uses fast-check to verify invariants of formatLogDetails()
 * that should hold for any valid input.
 */

import {
  constant,
  assert as fcAssert,
  oneof,
  option,
  property,
  record,
  stringMatching,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { formatLogDetails } from "../../../src/lib/formatters/log.js";
import type { DetailedSentryLog } from "../../../src/types/index.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** Valid log IDs (32-char hex) */
const logIdArb = stringMatching(/^[a-f0-9]{32}$/);

/** Valid org slugs */
const orgSlugArb = stringMatching(/^[a-z][a-z0-9-]{1,20}[a-z0-9]$/);

/** Valid trace IDs (32-char hex) */
const traceIdArb = stringMatching(/^[a-f0-9]{32}$/);

/** ISO timestamp */
const timestampArb = constant("2025-01-30T14:32:15Z");

/** Timestamp precise (nanoseconds) */
const timestampPreciseArb = constant(1_770_060_419_044_800_300);

/** Log severity levels */
const severityArb = oneof(
  constant("info"),
  constant("warning"),
  constant("error"),
  constant("debug"),
  constant("fatal")
);

/** Optional string (string or null) */
const optionalStringArb = option(stringMatching(/^[a-zA-Z0-9_.-]{1,50}$/), {
  nil: null,
});

/** Generate DetailedSentryLog objects with various field combinations */
function createDetailedLogArb() {
  return record({
    "sentry.item_id": logIdArb,
    timestamp: timestampArb,
    timestamp_precise: timestampPreciseArb,
    message: optionalStringArb,
    severity: option(severityArb, { nil: null }),
    trace: option(traceIdArb, { nil: null }),
    project: optionalStringArb,
    environment: optionalStringArb,
    release: optionalStringArb,
    "sdk.name": optionalStringArb,
    "sdk.version": optionalStringArb,
    span_id: optionalStringArb,
    "code.function": optionalStringArb,
    "code.file.path": optionalStringArb,
    "code.line.number": optionalStringArb,
    "sentry.otel.kind": optionalStringArb,
    "sentry.otel.status_code": optionalStringArb,
    "sentry.otel.instrumentation_scope.name": optionalStringArb,
  });
}

const detailedLogArb = createDetailedLogArb();

/** Strip ANSI escape codes */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatLogDetails properties", () => {
  test("always returns a non-empty string", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result = formatLogDetails(log, orgSlug);
          expect(typeof result).toBe("string");
          expect(result.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always contains the log ID", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result = stripAnsi(formatLogDetails(log, orgSlug));
          expect(result).toContain(log["sentry.item_id"]);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always contains timestamp info", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result = stripAnsi(formatLogDetails(log, orgSlug));
          expect(result).toContain("Timestamp");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always contains severity info", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result = stripAnsi(formatLogDetails(log, orgSlug));
          expect(result).toContain("Severity");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("trace URL only appears when trace ID is present", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result = stripAnsi(formatLogDetails(log, orgSlug));
          if (log.trace) {
            expect(result).toContain("/traces/");
            expect(result).toContain(log.trace);
          } else {
            expect(result).not.toContain("/traces/");
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("SDK section only appears when sdk.name is present", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result = stripAnsi(formatLogDetails(log, orgSlug));
          if (log["sdk.name"]) {
            expect(result).toContain("SDK");
            expect(result).toContain(log["sdk.name"]);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("Source Location section only appears when code fields are present", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result = stripAnsi(formatLogDetails(log, orgSlug));
          const hasCodeFields = log["code.function"] || log["code.file.path"];
          if (hasCodeFields) {
            expect(result).toContain("Source Location");
          } else {
            expect(result).not.toContain("Source Location");
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("formatting is deterministic: same input always produces same output", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result1 = formatLogDetails(log, orgSlug);
          const result2 = formatLogDetails(log, orgSlug);
          expect(result1).toEqual(result2);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a string (not array)", async () => {
    await fcAssert(
      property(
        detailedLogArb,
        orgSlugArb,
        (log: DetailedSentryLog, orgSlug: string) => {
          const result = formatLogDetails(log, orgSlug);
          expect(typeof result).toBe("string");
          expect(Array.isArray(result)).toBe(false);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
