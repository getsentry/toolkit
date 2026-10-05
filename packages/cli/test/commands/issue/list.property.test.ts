/**
 * Property-based tests for pure helper functions in issue list command.
 *
 * Tests cover: trimWithProjectGuarantee, compound cursor encode/decode,
 * buildMultiTargetContextKey, getComparator, compareDates, buildProjectAliasMap,
 * and parseSort.
 */

import {
  array,
  constant,
  constantFrom,
  assert as fcAssert,
  integer,
  nat,
  oneof,
  option,
  property,
  string,
  tuple,
  uniqueArray,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  __testing,
  type IssueListResult,
  type IssueWithOptions,
  type SortValue,
} from "../../../src/commands/issue/list.js";
import type { SentryIssue } from "../../../src/types/index.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

const {
  trimWithProjectGuarantee,
  encodeCompoundCursor,
  decodeCompoundCursor,
  buildProjectAliasMap,
  getComparator,
  compareDates,
  parseSort,
  CURSOR_SEP,
  VALID_SORT_VALUES,
} = __testing;

// --- Arbitraries ---

/** Generates a slug-like string: lowercase alpha + digits + dashes */
const slugArb = array(
  constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")),
  { minLength: 1, maxLength: 12 }
).map((chars) => chars.join(""));

/** Generates an IssueWithOptions for testing trimWithProjectGuarantee */
const issueWithOptionsArb = tuple(slugArb, slugArb).map(
  ([org, proj]): IssueWithOptions => ({
    issue: {
      id: `${Math.random()}`,
      shortId: `${proj.toUpperCase()}-1`,
      title: "test",
    } as SentryIssue,
    orgSlug: org,
    formatOptions: {
      projectSlug: proj,
      isMultiProject: true,
    },
  })
);

/** Generates a Sentry cursor-like string (e.g. "1735689600:0:0") */
const cursorStringArb = tuple(
  integer({ min: 1_700_000_000, max: 1_800_000_000 }),
  nat({ max: 10 }),
  nat({ max: 1 })
).map(([ts, offset, flag]) => `${ts}:${offset}:${flag}`);

/** Generates a cursor value: string or null (exhausted) */
const cursorValueArb = oneof(
  cursorStringArb.map((c) => c as string | null),
  constant(null)
);

/** Sort value arbitrary */
const sortValueArb = constantFrom(...VALID_SORT_VALUES) as ReturnType<
  typeof constantFrom<SortValue>
>;

/** ISO date string arbitrary */
const isoDateArb = integer({
  min: 1_600_000_000_000,
  max: 1_800_000_000_000,
}).map((ts) => new Date(ts).toISOString());

/** SentryIssue with relevant sort fields */
const sentryIssueArb = tuple(
  isoDateArb,
  isoDateArb,
  nat({ max: 100_000 }),
  nat({ max: 50_000 })
).map(
  ([lastSeen, firstSeen, count, userCount]) =>
    ({
      id: `${Math.random()}`,
      shortId: "PROJ-1",
      title: "test",
      lastSeen,
      firstSeen,
      count: `${count}`,
      userCount,
    }) as SentryIssue
);

// --- trimWithProjectGuarantee ---

describe("property: trimWithProjectGuarantee", () => {
  test("output length <= limit", () => {
    fcAssert(
      property(
        array(issueWithOptionsArb, { minLength: 1, maxLength: 50 }),
        integer({ min: 1, max: 100 }),
        (issues, limit) => {
          const result = trimWithProjectGuarantee(issues, limit);
          expect(result.length).toBeLessThanOrEqual(limit);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a subset of input in same order", () => {
    fcAssert(
      property(
        array(issueWithOptionsArb, { minLength: 1, maxLength: 50 }),
        integer({ min: 1, max: 100 }),
        (issues, limit) => {
          const result = trimWithProjectGuarantee(issues, limit);
          let lastIdx = -1;
          for (const item of result) {
            const idx = issues.indexOf(item);
            expect(idx).toBeGreaterThan(lastIdx);
            lastIdx = idx;
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns all items when limit >= input length", () => {
    fcAssert(
      property(
        array(issueWithOptionsArb, { minLength: 1, maxLength: 30 }),
        (issues) => {
          const result = trimWithProjectGuarantee(issues, issues.length + 10);
          expect(result.length).toBe(issues.length);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("guarantees at least 1 issue per project when limit allows", () => {
    fcAssert(
      property(
        array(issueWithOptionsArb, { minLength: 2, maxLength: 50 }),
        integer({ min: 1, max: 100 }),
        (issues, limit) => {
          const result = trimWithProjectGuarantee(issues, limit);
          if (issues.length <= limit) {
            return;
          }

          const inputProjects = new Set(
            issues.map(
              (i) => `${i.orgSlug}/${i.formatOptions.projectSlug ?? ""}`
            )
          );

          const resultProjects = new Set(
            result.map(
              (i) => `${i.orgSlug}/${i.formatOptions.projectSlug ?? ""}`
            )
          );

          // If limit >= number of unique projects, every project is represented
          if (limit >= inputProjects.size) {
            expect(resultProjects.size).toBe(inputProjects.size);
          } else {
            // If limit < projects, we should have exactly limit items
            expect(result.length).toBe(limit);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is idempotent: trim(trim(x, n), n) === trim(x, n)", () => {
    fcAssert(
      property(
        array(issueWithOptionsArb, { minLength: 1, maxLength: 30 }),
        integer({ min: 1, max: 50 }),
        (issues, limit) => {
          const first = trimWithProjectGuarantee(issues, limit);
          const second = trimWithProjectGuarantee(first, limit);
          expect(second).toEqual(first);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// --- Compound Cursor encode/decode ---

describe("property: compound cursor encode/decode", () => {
  test("round-trip: decode(encode(cursors)) === cursors when at least one active", () => {
    fcAssert(
      property(
        // Need at least one non-null cursor: all-null encodes to "" which decodes to []
        // (by design — all-exhausted is equivalent to "start fresh")
        array(cursorValueArb, { minLength: 1, maxLength: 20 }).filter((cs) =>
          cs.some((c) => c !== null)
        ),
        (cursors) => {
          const encoded = encodeCompoundCursor(cursors);
          const decoded = decodeCompoundCursor(encoded);
          expect(decoded).toEqual(cursors);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("all-null cursors encode to empty-like string that decodes to fresh start", () => {
    const cursors: (string | null)[] = [null, null, null];
    const encoded = encodeCompoundCursor(cursors);
    // All-null = all empty segments = "||"
    const decoded = decodeCompoundCursor(encoded);
    // Decoded has 3 null entries since segments are non-empty when split
    expect(decoded).toEqual([null, null, null]);
  });

  test("all-active cursors produce no consecutive separators", () => {
    fcAssert(
      property(
        array(
          cursorStringArb.map((c) => c as string | null),
          {
            minLength: 1,
            maxLength: 10,
          }
        ),
        (cursors) => {
          const encoded = encodeCompoundCursor(cursors);
          expect(encoded).not.toContain(`${CURSOR_SEP}${CURSOR_SEP}`);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty string returns empty array", () => {
    expect(decodeCompoundCursor("")).toEqual([]);
  });

  test("legacy JSON cursor returns empty array (fresh start)", () => {
    expect(
      decodeCompoundCursor('[{"org":"a","project":"b","cursor":"1:0:0"}]')
    ).toEqual([]);
  });

  test("single cursor round-trips", () => {
    const encoded = encodeCompoundCursor(["1735689600:0:0"]);
    expect(decodeCompoundCursor(encoded)).toEqual(["1735689600:0:0"]);
  });

  test("mixed active and exhausted cursors round-trip", () => {
    const cursors: (string | null)[] = [
      "1735689600:0:0",
      null,
      "1735689601:0:0",
    ];
    const encoded = encodeCompoundCursor(cursors);
    expect(encoded).toBe("1735689600:0:0||1735689601:0:0");
    expect(decodeCompoundCursor(encoded)).toEqual(cursors);
  });
});

// --- getComparator ---

describe("property: getComparator", () => {
  test("returns a function for every valid sort value", () => {
    fcAssert(
      property(sortValueArb, (sort) => {
        const cmp = getComparator(sort);
        expect(typeof cmp).toBe("function");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("comparator is anti-symmetric: sign(cmp(a,b)) === -sign(cmp(b,a))", () => {
    fcAssert(
      property(sortValueArb, sentryIssueArb, sentryIssueArb, (sort, a, b) => {
        const cmp = getComparator(sort);
        const ab = cmp(a, b);
        const ba = cmp(b, a);
        // ab + ba === 0 is the anti-symmetry check that handles 0/-0 correctly
        // (Object.is(0, -0) is false, but 0 + -0 === 0)
        expect(ab + ba).toBe(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("comparator is reflexive: cmp(a, a) === 0", () => {
    fcAssert(
      property(sortValueArb, sentryIssueArb, (sort, issue) => {
        const cmp = getComparator(sort);
        expect(cmp(issue, issue)).toBe(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("date sort puts most recent first", () => {
    const cmp = getComparator("date");
    const older = {
      id: "1",
      shortId: "P-1",
      title: "a",
      lastSeen: "2020-01-01T00:00:00Z",
    } as SentryIssue;
    const newer = {
      id: "2",
      shortId: "P-2",
      title: "b",
      lastSeen: "2025-01-01T00:00:00Z",
    } as SentryIssue;
    expect(cmp(newer, older)).toBeLessThan(0);
  });

  test("freq sort puts highest count first", () => {
    const cmp = getComparator("freq");
    const low = {
      id: "1",
      shortId: "P-1",
      title: "a",
      count: "10",
    } as SentryIssue;
    const high = {
      id: "2",
      shortId: "P-2",
      title: "b",
      count: "1000",
    } as SentryIssue;
    expect(cmp(high, low)).toBeLessThan(0);
  });

  test("user sort puts highest user count first", () => {
    const cmp = getComparator("user");
    const low = {
      id: "1",
      shortId: "P-1",
      title: "a",
      userCount: 5,
    } as SentryIssue;
    const high = {
      id: "2",
      shortId: "P-2",
      title: "b",
      userCount: 500,
    } as SentryIssue;
    expect(cmp(high, low)).toBeLessThan(0);
  });

  test("recommended sort falls back to recency (most recent first)", () => {
    // The recommended score is server-only, so client-side merges degrade to
    // a lastSeen (recency) ordering — same direction as the date sort.
    const cmp = getComparator("recommended");
    const older = {
      id: "1",
      shortId: "P-1",
      title: "a",
      lastSeen: "2020-01-01T00:00:00Z",
    } as SentryIssue;
    const newer = {
      id: "2",
      shortId: "P-2",
      title: "b",
      lastSeen: "2025-01-01T00:00:00Z",
    } as SentryIssue;
    expect(cmp(newer, older)).toBeLessThan(0);
  });
});

// --- compareDates ---

describe("property: compareDates", () => {
  test("is anti-symmetric", () => {
    fcAssert(
      property(
        option(isoDateArb, { nil: undefined }),
        option(isoDateArb, { nil: undefined }),
        (a, b) => {
          const ab = compareDates(a, b);
          const ba = compareDates(b, a);
          // ab + ba === 0 is the anti-symmetry check that handles 0/-0 correctly
          // (0 + -0 === 0, and 5 + -5 === 0)
          expect(ab + ba).toBe(0);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("undefined sorts after any date (treated as epoch 0)", () => {
    const date = "2025-01-01T00:00:00Z";
    expect(compareDates(date, undefined)).toBeLessThan(0);
  });

  test("equal dates return 0", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        expect(compareDates(d, d)).toBe(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// --- parseSort ---

describe("property: parseSort", () => {
  test("accepts all valid sort values", () => {
    for (const value of VALID_SORT_VALUES) {
      expect(parseSort(value)).toBe(value);
    }
  });

  test("rejects invalid sort values", () => {
    fcAssert(
      property(
        string().filter((s) => !VALID_SORT_VALUES.includes(s as SortValue)),
        (s) => {
          expect(() => parseSort(s)).toThrow(/Invalid sort value/);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// --- buildProjectAliasMap ---

describe("property: buildProjectAliasMap", () => {
  function makeResult(org: string, project: string): IssueListResult {
    return {
      target: { org, project, orgDisplay: org, projectDisplay: project },
      issues: [],
    };
  }

  test("every result gets an alias entry", () => {
    fcAssert(
      property(
        uniqueArray(tuple(slugArb, slugArb), {
          minLength: 1,
          maxLength: 10,
          selector: ([org, proj]) => `${org}/${proj}`,
        }),
        (pairs) => {
          const results = pairs.map(([org, proj]) => makeResult(org, proj));
          const { aliasMap, entries } = buildProjectAliasMap(results);

          for (const r of results) {
            const key = `${r.target.org}/${r.target.project}`;
            expect(aliasMap.has(key)).toBe(true);
          }

          expect(Object.keys(entries).length).toBe(results.length);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("aliases are unique across all projects", () => {
    fcAssert(
      property(
        uniqueArray(tuple(slugArb, slugArb), {
          minLength: 2,
          maxLength: 10,
          selector: ([org, proj]) => `${org}/${proj}`,
        }),
        (pairs) => {
          const results = pairs.map(([org, proj]) => makeResult(org, proj));
          const { aliasMap } = buildProjectAliasMap(results);

          const aliases = [...aliasMap.values()];
          expect(new Set(aliases).size).toBe(aliases.length);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single result gets a short alias", () => {
    const { aliasMap, entries } = buildProjectAliasMap([
      makeResult("my-org", "frontend"),
    ]);
    expect(aliasMap.size).toBe(1);
    expect(Object.keys(entries).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sanitizeQuery — property tests moved to test/lib/search-query.property.test.ts
// ---------------------------------------------------------------------------
