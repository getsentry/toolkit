/**
 * Property-Based Tests for Input Validation
 *
 * Uses fast-check to verify that input validation correctly rejects
 * dangerous inputs while allowing all valid ones. These tests defend
 * against agent hallucinations: query injection, path traversal,
 * double-encoding, and control character injection.
 *
 * @see https://github.com/getsentry/cli/issues/350
 */

import {
  constantFrom,
  assert as fcAssert,
  oneof,
  property,
  stringMatching,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  rejectControlChars,
  rejectPreEncoded,
  validateEndpoint,
  validateResourceId,
} from "../../src/lib/input-validation.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Arbitraries

/** Valid Sentry slug characters: lowercase alphanumeric + hyphens */
const validSlugArb = stringMatching(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/);

/** Valid issue suffixes: alphanumeric base-36 strings */
const validSuffixArb = stringMatching(/^[A-Z0-9]{1,10}$/);

/** Valid API endpoint paths: segments of alphanum + hyphens separated by slashes */
const validEndpointArb = stringMatching(
  /^\/?(api\/0\/)?[a-z][a-z0-9-]{0,30}(\/[a-z][a-z0-9-]{0,30}){0,5}\/?$/
);

/** Characters that should be rejected in resource IDs */
const injectionCharArb = constantFrom("?", "#", "%20", " ", "\t", "\n");

/** Pre-encoded sequences that should be rejected */
const preEncodedArb = constantFrom(
  "%2F",
  "%20",
  "%3A",
  "%3F",
  "%23",
  "%00",
  "%0A",
  "%7E",
  "%41"
);

/** Control characters (ASCII 0x00-0x1F) as strings */
const controlCharArb = constantFrom(
  "\x00",
  "\x01",
  "\x02",
  "\x07",
  "\x08",
  "\x0b",
  "\x0c",
  "\x0d",
  "\x0e",
  "\x0f",
  "\x1b",
  "\x1f"
);

describe("rejectControlChars properties", () => {
  test("valid slugs never contain control characters and always pass", async () => {
    await fcAssert(
      property(validSlugArb, (input) => {
        // Should not throw
        rejectControlChars(input, "test");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("any string with an embedded control character always throws", async () => {
    await fcAssert(
      property(
        tuple(validSlugArb, controlCharArb, validSlugArb),
        ([prefix, ctrl, suffix]) => {
          const input = `${prefix}${ctrl}${suffix}`;
          expect(() => rejectControlChars(input, "test")).toThrow(/Invalid/);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("error message includes the label", async () => {
    await fcAssert(
      property(controlCharArb, (ctrl) => {
        try {
          rejectControlChars(`abc${ctrl}def`, "organization slug");
          // Should not reach here
          expect(true).toBe(false);
        } catch (e) {
          expect((e as Error).message).toContain("organization slug");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("carriage return produces specific error description", () => {
    expect(() => rejectControlChars("abc\rdef", "test")).toThrow(
      /carriage return/
    );
  });

  test("printable ASCII strings always pass", async () => {
    // Generate strings of printable ASCII (0x20-0x7E)
    const printableArb = stringMatching(/^[\x20-\x7e]{1,50}$/);
    await fcAssert(
      property(printableArb, (input) => {
        // Should not throw — all printable ASCII is valid
        rejectControlChars(input, "test");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("rejectPreEncoded properties", () => {
  test("valid slugs without percent signs always pass", async () => {
    await fcAssert(
      property(validSlugArb, (input) => {
        rejectPreEncoded(input, "test");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("any string with %XX hex pattern always throws", async () => {
    await fcAssert(
      property(tuple(validSlugArb, preEncodedArb), ([prefix, encoded]) => {
        const input = `${prefix}${encoded}`;
        expect(() => rejectPreEncoded(input, "test")).toThrow(
          /URL-encoded sequence/
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("percent sign followed by non-hex does not throw", () => {
    // "%ZZ" is not a valid encoding — we only reject real %XX patterns
    rejectPreEncoded("my-org%ZZstuff", "test");
    rejectPreEncoded("my-org%Gxstuff", "test");
  });
});

describe("validateResourceId properties", () => {
  test("valid slugs always pass", async () => {
    await fcAssert(
      property(validSlugArb, (input) => {
        validateResourceId(input, "test");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("valid issue suffixes always pass", async () => {
    await fcAssert(
      property(validSuffixArb, (input) => {
        validateResourceId(input, "test");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("slug with injection character always throws", async () => {
    await fcAssert(
      property(tuple(validSlugArb, injectionCharArb), ([slug, injection]) => {
        const input = `${slug}${injection}`;
        expect(() => validateResourceId(input, "test")).toThrow(/Invalid/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("slug with control character always throws", async () => {
    await fcAssert(
      property(tuple(validSlugArb, controlCharArb), ([slug, ctrl]) => {
        const input = `${slug}${ctrl}`;
        expect(() => validateResourceId(input, "test")).toThrow(/Invalid/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("specific hallucination patterns are caught", () => {
    // Query injection
    expect(() =>
      validateResourceId("my-org?query=foo", "organization slug")
    ).toThrow(/\?/);

    // Fragment injection
    expect(() =>
      validateResourceId("my-project#anchor", "project slug")
    ).toThrow(/#/);

    // Pre-encoded space
    expect(() =>
      validateResourceId("CLI-G%20extra", "issue identifier")
    ).toThrow(/%/);

    // Tab injection
    expect(() =>
      validateResourceId("my-org\tother", "organization slug")
    ).toThrow(/tab/);

    // Non-breaking space (U+00A0) — exotic whitespace matched by \s
    expect(() =>
      validateResourceId("my-org\u00a0other", "organization slug")
    ).toThrow(/whitespace/);
  });
});

describe("validateEndpoint properties", () => {
  test("valid endpoints always pass", async () => {
    await fcAssert(
      property(validEndpointArb, (input) => {
        validateEndpoint(input);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("endpoints with .. path traversal always throw", async () => {
    // Generate valid path segments and inject ".." in various positions
    const traversalArb = oneof(
      validSlugArb.map((s) => `../${s}/`),
      validSlugArb.map((s) => `${s}/../admin/`),
      validSlugArb.map((s) => `${s}/../../admin/`),
      constantFrom("..", "../admin", "../../admin/settings/")
    );

    await fcAssert(
      property(traversalArb, (input) => {
        expect(() => validateEndpoint(input)).toThrow(/path traversal/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("endpoints with control characters always throw", async () => {
    await fcAssert(
      property(tuple(validEndpointArb, controlCharArb), ([endpoint, ctrl]) => {
        const input = `${endpoint}${ctrl}`;
        expect(() => validateEndpoint(input)).toThrow(/Invalid/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single dots in paths are allowed (not traversal)", () => {
    // Single dots are valid path segments
    validateEndpoint("organizations/my-org/.well-known/");
    validateEndpoint("api/0/organizations/my-org/");
  });

  test("double dots inside a segment name are allowed", () => {
    // ".." is only traversal when it's a complete segment
    validateEndpoint("organizations/my..org/issues/");
  });
});

describe("cross-validator consistency", () => {
  test("validateResourceId catches everything rejectControlChars catches", async () => {
    await fcAssert(
      property(tuple(validSlugArb, controlCharArb), ([slug, ctrl]) => {
        const input = `${slug}${ctrl}`;
        // Both should throw
        expect(() => rejectControlChars(input, "test")).toThrow();
        expect(() => validateResourceId(input, "test")).toThrow();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("validateResourceId is stricter than rejectControlChars", () => {
    // These pass rejectControlChars but fail validateResourceId
    const inputsPassingControlButFailingResource = [
      "my-org?query=foo",
      "my-project#anchor",
      "my org",
    ];

    for (const input of inputsPassingControlButFailingResource) {
      rejectControlChars(input, "test"); // Should not throw
      expect(() => validateResourceId(input, "test")).toThrow(); // Should throw
    }
  });
});
