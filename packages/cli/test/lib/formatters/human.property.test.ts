/**
 * Property-Based Tests for Human Formatters
 *
 * Uses fast-check to verify invariants of formatting functions
 * that are difficult to exhaustively test with example-based tests.
 */

import {
  constant,
  double,
  assert as fcAssert,
  oneof,
  property,
  stringMatching,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  formatFixability,
  formatFixabilityDetail,
  formatShortId,
  formatUserIdentity,
  getSeerFixabilityLabel,
} from "../../../src/lib/formatters/human.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

// Helper to strip ANSI codes for content testing
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes use control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Strip ANSI escape codes and color tags for content testing. */
function stripFormatting(s: string): string {
  return stripAnsi(s).replace(/<\/?[a-z]+>/g, "");
}

// Arbitraries

/** Project slug (lowercase, alphanumeric with hyphens) */
const projectSlugArb = stringMatching(/^[a-z][a-z0-9-]{1,20}[a-z0-9]$/);

/** Issue suffix (1-10 alphanumeric chars) */
const suffixArb = stringMatching(/^[a-zA-Z0-9]{1,10}$/);

/** Full short ID like "PROJECT-A3" */
const shortIdArb = tuple(projectSlugArb, suffixArb).map(
  ([project, suffix]) => `${project}-${suffix}`
);

/** User name (non-empty string with letters and spaces) */
const nameArb = stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/);

/** Username (alphanumeric with underscores) */
const usernameArb = stringMatching(/^[a-z][a-z0-9_]{2,15}$/);

/** Email address */
const emailArb = stringMatching(/^[a-z][a-z0-9]{2,10}@[a-z]{3,8}\.[a-z]{2,4}$/);

/** User ID */
const userIdArb = stringMatching(/^[1-9][0-9]{0,8}$/);

describe("formatShortId properties", () => {
  test("output (stripped of ANSI) always equals input uppercased", async () => {
    await fcAssert(
      property(shortIdArb, (shortId) => {
        const result = formatShortId(shortId);
        expect(stripFormatting(result)).toBe(shortId.toUpperCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output length (stripped) always equals input length", async () => {
    await fcAssert(
      property(shortIdArb, (shortId) => {
        const result = formatShortId(shortId);
        expect(stripFormatting(result).length).toBe(shortId.length);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("with projectSlug option, output still equals input uppercased", async () => {
    await fcAssert(
      property(tuple(projectSlugArb, suffixArb), ([project, suffix]) => {
        const shortId = `${project}-${suffix}`;
        const result = formatShortId(shortId, { projectSlug: project });
        expect(stripFormatting(result)).toBe(shortId.toUpperCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("with projectSlug and projectAlias, output still equals input uppercased", async () => {
    await fcAssert(
      property(tuple(projectSlugArb, suffixArb), ([project, suffix]) => {
        const shortId = `${project}-${suffix}`;
        const alias = project.charAt(0); // Use first char as alias
        const result = formatShortId(shortId, {
          projectSlug: project,
          projectAlias: alias,
        });
        expect(stripFormatting(result)).toBe(shortId.toUpperCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result is always uppercase", async () => {
    await fcAssert(
      property(shortIdArb, (shortId) => {
        const result = stripAnsi(formatShortId(shortId));
        expect(result).toBe(result.toUpperCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("deterministic: same input produces same output", async () => {
    await fcAssert(
      property(shortIdArb, (shortId) => {
        const result1 = formatShortId(shortId);
        const result2 = formatShortId(shortId);
        expect(result1).toBe(result2);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("handles case variations consistently", async () => {
    await fcAssert(
      property(tuple(projectSlugArb, suffixArb), ([project, suffix]) => {
        const lowerShortId = `${project.toLowerCase()}-${suffix.toLowerCase()}`;
        const upperShortId = `${project.toUpperCase()}-${suffix.toUpperCase()}`;
        const mixedShortId = `${project}-${suffix}`;

        // All should produce the same stripped result
        const lowerResult = stripAnsi(formatShortId(lowerShortId));
        const upperResult = stripAnsi(formatShortId(upperShortId));
        const mixedResult = stripAnsi(formatShortId(mixedShortId));

        expect(lowerResult).toBe(upperResult);
        expect(upperResult).toBe(mixedResult);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("formatUserIdentity properties", () => {
  test("name + email formats as 'name <email>'", async () => {
    await fcAssert(
      property(tuple(nameArb, emailArb), ([name, email]) => {
        const result = formatUserIdentity({ id: "1", name, email });
        expect(result).toBe(`${name} <${email}>`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("username + email (no name) formats as 'username <email>'", async () => {
    await fcAssert(
      property(tuple(usernameArb, emailArb), ([username, email]) => {
        const result = formatUserIdentity({ id: "1", username, email });
        expect(result).toBe(`${username} <${email}>`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("name takes precedence over username", async () => {
    await fcAssert(
      property(
        tuple(nameArb, usernameArb, emailArb),
        ([name, username, email]) => {
          const result = formatUserIdentity({ id: "1", name, username, email });
          // If this passes, name is used (proving username is ignored when name exists)
          expect(result).toBe(`${name} <${email}>`);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("only name returns just name", async () => {
    await fcAssert(
      property(nameArb, (name) => {
        const result = formatUserIdentity({ id: "1", name });
        expect(result).toBe(name);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("only username returns just username", async () => {
    await fcAssert(
      property(usernameArb, (username) => {
        const result = formatUserIdentity({ id: "1", username });
        expect(result).toBe(username);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("only email returns just email", async () => {
    await fcAssert(
      property(emailArb, (email) => {
        const result = formatUserIdentity({ id: "1", email });
        expect(result).toBe(email);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("only id returns 'user {id}'", async () => {
    await fcAssert(
      property(userIdArb, (id) => {
        const result = formatUserIdentity({ id });
        expect(result).toBe(`user ${id}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("only userId returns 'user {userId}'", async () => {
    await fcAssert(
      property(userIdArb, (userId) => {
        const result = formatUserIdentity({ userId });
        expect(result).toBe(`user ${userId}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("id takes precedence over userId for fallback", async () => {
    await fcAssert(
      property(tuple(userIdArb, userIdArb), ([id, userId]) => {
        const result = formatUserIdentity({ id, userId });
        expect(result).toBe(`user ${id}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Fixability Formatting Properties

/** Score in valid API range [0, 1] */
const scoreArb = double({ min: 0, max: 1, noNaN: true });

/** Score or null/undefined (full input space for formatFixability) */
const nullableScoreArb = oneof(
  scoreArb,
  constant(null as null),
  constant(undefined as undefined)
);

describe("property: getSeerFixabilityLabel", () => {
  test("always returns one of the three valid tiers", () => {
    fcAssert(
      property(scoreArb, (score) => {
        const label = getSeerFixabilityLabel(score);
        expect(["high", "med", "low"]).toContain(label);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is monotonic: higher scores never produce lower tiers", () => {
    const tierRank = { low: 0, med: 1, high: 2 };
    fcAssert(
      property(scoreArb, scoreArb, (a, b) => {
        if (a <= b) {
          const rankA =
            tierRank[getSeerFixabilityLabel(a) as keyof typeof tierRank];
          const rankB =
            tierRank[getSeerFixabilityLabel(b) as keyof typeof tierRank];
          expect(rankA).toBeLessThanOrEqual(rankB);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: formatFixability", () => {
  test("matches expected pattern for valid scores", () => {
    fcAssert(
      property(scoreArb, (score) => {
        const result = formatFixability(score);
        expect(result).toMatch(/^(high|med|low)\(\d+%\)$/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output never exceeds column width (10 chars)", () => {
    fcAssert(
      property(scoreArb, (score) => {
        expect(formatFixability(score).length).toBeLessThanOrEqual(10);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns empty string for null or undefined", () => {
    fcAssert(
      property(nullableScoreArb, (score) => {
        if (score === null || score === undefined) {
          expect(formatFixability(score)).toBe("");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: formatFixabilityDetail", () => {
  test("matches expected pattern for valid scores", () => {
    fcAssert(
      property(scoreArb, (score) => {
        const result = formatFixabilityDetail(score);
        expect(result).toMatch(/^(High|Med|Low) \(\d+%\)$/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns empty string for null or undefined", () => {
    fcAssert(
      property(nullableScoreArb, (score) => {
        if (score === null || score === undefined) {
          expect(formatFixabilityDetail(score)).toBe("");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
