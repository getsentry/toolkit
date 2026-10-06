/**
 * Property-Based Tests for Release Notes Parser
 *
 * Uses fast-check to verify properties that should always hold true
 * for the release notes extraction and commit parsing, regardless of input.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  nat,
  property,
  record,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  type ChangeCategory,
  extractNightlyTimestamp,
  extractSections,
  parseCommitMessages,
} from "../../src/lib/release-notes.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// ─────────────────────────── Arbitraries ───────────────────────────────────

const VALID_CATEGORIES: readonly ChangeCategory[] = [
  "features",
  "fixes",
  "performance",
];

/** Section headers that should be kept */
const KEPT_HEADERS = [
  "### New Features ✨",
  "### Bug Fixes 🐛",
  "### Performance",
];

/** Section headers that should be filtered out */
const FILTERED_HEADERS = [
  "### Internal Changes 🔧",
  "### Documentation 📚",
  "### Refactoring",
  "### Tests",
  "### Chores",
];

/** Simple description text */
const descriptionArb = array(
  constantFrom(..."abcdefghijklmnopqrstuvwxyz ".split("")),
  { minLength: 3, maxLength: 30 }
).map((chars) => chars.join("").trim() || "change");

/** Generate a section body with list items */
const sectionBodyArb = array(descriptionArb, {
  minLength: 1,
  maxLength: 5,
}).map((items) => items.map((item) => `- ${item}`).join("\n"));

/** Generate a full release body with mixed kept and filtered sections.
 * Sections are concatenated in arbitrary order — extractSections splits
 * on ### headings regardless of ordering. */
const releaseBodyArb = tuple(
  array(tuple(constantFrom(...KEPT_HEADERS), sectionBodyArb), {
    minLength: 0,
    maxLength: 3,
  }),
  array(tuple(constantFrom(...FILTERED_HEADERS), sectionBodyArb), {
    minLength: 0,
    maxLength: 2,
  })
).map(([kept, filtered]) => {
  // Interleave kept and filtered sections
  const all = [...kept, ...filtered];
  return all.map(([header, body]) => `${header}\n\n${body}`).join("\n\n");
});

/** Conventional commit message arbitrary */
const commitPrefixArb = constantFrom(
  "feat",
  "fix",
  "perf",
  "docs",
  "refactor",
  "chore",
  "test",
  "ci",
  "meta"
);
const commitScopeArb = constantFrom("", "(dashboard)", "(issue)", "(api)");
const commitMessageArb = tuple(
  commitPrefixArb,
  commitScopeArb,
  descriptionArb
).map(([prefix, scope, desc]) => `${prefix}${scope}: ${desc}`);

// ─────────────────────────── Tests ─────────────────────────────────────────

describe("property: extractSections", () => {
  test("output categories are always valid", () => {
    fcAssert(
      property(releaseBodyArb, (body) => {
        const sections = extractSections(body);
        for (const section of sections) {
          expect(VALID_CATEGORIES).toContain(section.category);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("internal changes / docs sections never appear in output", () => {
    fcAssert(
      property(releaseBodyArb, (body) => {
        const sections = extractSections(body);
        for (const section of sections) {
          // Should never contain Internal Changes or Documentation categories
          expect(section.category).not.toBe("internal");
          expect(section.category).not.toBe("docs");
          expect(section.category).not.toBe("documentation");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty body returns empty array", () => {
    expect(extractSections("")).toEqual([]);
    expect(extractSections("   ")).toEqual([]);
  });

  test("body with only filtered sections returns empty array", () => {
    fcAssert(
      property(
        array(tuple(constantFrom(...FILTERED_HEADERS), sectionBodyArb), {
          minLength: 1,
          maxLength: 3,
        }),
        (sections) => {
          const body = sections
            .map(([header, items]) => `${header}\n\n${items}`)
            .join("\n\n");
          expect(extractSections(body)).toEqual([]);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: parseCommitMessages", () => {
  test("only feat/fix/perf commits pass through", () => {
    fcAssert(
      property(
        array(record({ commit: record({ message: commitMessageArb }) }), {
          minLength: 1,
          maxLength: 20,
        }),
        (commits) => {
          const sections = parseCommitMessages(commits);
          for (const section of sections) {
            expect(VALID_CATEGORIES).toContain(section.category);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("#skip-changelog commits are always filtered", () => {
    fcAssert(
      property(descriptionArb, (desc) => {
        const commits = [
          { commit: { message: `feat: ${desc}\n\n#skip-changelog` } },
          { commit: { message: `fix: ${desc}\n\n#skip-changelog` } },
          { commit: { message: `perf: ${desc}\n\n#skip-changelog` } },
        ];
        const sections = parseCommitMessages(commits);
        // All commits have #skip-changelog, so no sections should be produced
        expect(sections).toEqual([]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-conventional commits produce no output", () => {
    const sections = parseCommitMessages([
      { commit: { message: "random commit message" } },
      { commit: { message: "another one without prefix" } },
      { commit: { message: "Merge pull request #123" } },
    ]);
    expect(sections).toEqual([]);
  });
});

describe("property: extractNightlyTimestamp", () => {
  test("round-trip: valid nightly versions extract correct timestamp", () => {
    fcAssert(
      property(
        tuple(nat(30), nat(100), nat(100)),
        nat({ max: 2_000_000_000 }),
        ([major, minor, patch], ts) => {
          const version = `${major}.${minor}.${patch}-dev.${ts}`;
          expect(extractNightlyTimestamp(version)).toBe(ts);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("stable versions return null", () => {
    expect(extractNightlyTimestamp("0.21.0")).toBeNull();
    expect(extractNightlyTimestamp("1.0.0")).toBeNull();
    expect(extractNightlyTimestamp("0.0.1")).toBeNull();
  });
});
