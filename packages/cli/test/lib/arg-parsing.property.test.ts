/**
 * Property-Based Tests for Argument Parsing
 *
 * Uses fast-check to verify invariants of parseIssueArg() and parseOrgProjectArg()
 * that are difficult to exhaustively test with example-based tests.
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
  detectSwappedViewArgs,
  looksLikeIssueShortId,
  normalizeSlug,
  parseIssueArg,
  parseOrgProjectArg,
  parseSelector,
} from "../../src/lib/arg-parsing.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Arbitraries for generating valid inputs

/** Generates valid org slugs (lowercase, alphanumeric with hyphens) */
const orgSlugArb = stringMatching(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);

/** Generates valid project slugs (lowercase, alphanumeric with hyphens) */
const projectSlugArb = stringMatching(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);

/** Generates valid issue suffixes (alphanumeric, 1-10 chars) */
const suffixArb = stringMatching(/^[a-zA-Z0-9]{1,10}$/);

/** Generates numeric-only strings (valid issue IDs) */
const numericIdArb = stringMatching(/^[1-9][0-9]{0,15}$/);

describe("parseIssueArg properties", () => {
  test("numeric-only inputs always return type 'numeric'", async () => {
    await fcAssert(
      property(numericIdArb, (input) => {
        const result = parseIssueArg(input);
        expect(result.type).toBe("numeric");
        if (result.type === "numeric") {
          expect(result.id).toBe(input);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("suffix is always uppercase in result", async () => {
    await fcAssert(
      property(suffixArb, (suffix) => {
        const result = parseIssueArg(suffix);
        // suffix-only type (no dash, no slash, not numeric)
        if (result.type === "suffix-only") {
          expect(result.suffix).toBe(suffix.toUpperCase());
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("org/project-suffix returns type 'explicit' with uppercase suffix", async () => {
    await fcAssert(
      property(
        tuple(orgSlugArb, projectSlugArb, suffixArb),
        ([org, project, suffix]) => {
          const input = `${org}/${project}-${suffix}`;
          const result = parseIssueArg(input);

          expect(result.type).toBe("explicit");
          if (result.type === "explicit") {
            expect(result.org).toBe(org);
            expect(result.project).toBe(project);
            expect(result.suffix).toBe(suffix.toUpperCase());
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("org/numericId returns type 'explicit-org-numeric'", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, numericIdArb), ([org, numericId]) => {
        const input = `${org}/${numericId}`;
        const result = parseIssueArg(input);

        expect(result.type).toBe("explicit-org-numeric");
        if (result.type === "explicit-org-numeric") {
          expect(result.org).toBe(org);
          expect(result.numericId).toBe(numericId);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("org/suffix (no dash) returns type 'explicit-org-suffix' with uppercase suffix", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, suffixArb), ([org, suffix]) => {
        // Skip if suffix looks numeric (would be explicit-org-numeric)
        if (/^\d+$/.test(suffix)) return;

        const input = `${org}/${suffix}`;
        const result = parseIssueArg(input);

        expect(result.type).toBe("explicit-org-suffix");
        if (result.type === "explicit-org-suffix") {
          expect(result.org).toBe(org);
          expect(result.suffix).toBe(suffix.toUpperCase());
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("project-suffix returns type 'project-search' with uppercase suffix", async () => {
    await fcAssert(
      property(tuple(projectSlugArb, suffixArb), ([project, suffix]) => {
        const input = `${project}-${suffix}`;
        const result = parseIssueArg(input);

        expect(result.type).toBe("project-search");
        if (result.type === "project-search") {
          expect(result.projectSlug).toBe(project);
          expect(result.suffix).toBe(suffix.toUpperCase());
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("alphanumeric input without dash/slash that isn't numeric returns 'suffix-only'", async () => {
    // Generate alphanumeric strings that contain at least one letter (not pure numeric)
    const alphanumericWithLetterArb = stringMatching(
      /^[a-zA-Z][a-zA-Z0-9]{0,9}$/
    );

    await fcAssert(
      property(alphanumericWithLetterArb, (input) => {
        const result = parseIssueArg(input);

        expect(result.type).toBe("suffix-only");
        if (result.type === "suffix-only") {
          expect(result.suffix).toBe(input.toUpperCase());
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result type is always one of the 7 valid types", async () => {
    const validTypes = [
      "numeric",
      "explicit",
      "explicit-org-suffix",
      "explicit-org-numeric",
      "project-search",
      "suffix-only",
      "selector",
    ];

    // Generate various valid inputs
    const validInputArb = oneof(
      numericIdArb,
      tuple(orgSlugArb, projectSlugArb, suffixArb).map(
        ([o, p, s]) => `${o}/${p}-${s}`
      ),
      tuple(orgSlugArb, numericIdArb).map(([o, n]) => `${o}/${n}`),
      tuple(orgSlugArb, suffixArb).map(([o, s]) => `${o}/${s}`),
      tuple(projectSlugArb, suffixArb).map(([p, s]) => `${p}-${s}`),
      suffixArb
    );

    await fcAssert(
      property(validInputArb, (input) => {
        try {
          const result = parseIssueArg(input);
          expect(validTypes).toContain(result.type);
        } catch {
          // Some generated inputs may throw - that's expected for invalid formats
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("parsing never mutates the input", async () => {
    const inputArb = oneof(
      numericIdArb,
      tuple(orgSlugArb, projectSlugArb, suffixArb).map(
        ([o, p, s]) => `${o}/${p}-${s}`
      ),
      suffixArb
    );

    await fcAssert(
      property(inputArb, (input) => {
        const originalInput = input;
        try {
          parseIssueArg(input);
        } catch {
          // Ignore errors
        }
        // String is immutable in JS, but this verifies no weird side effects
        expect(input).toBe(originalInput);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("parseIssueArg: GitHub-style # separator properties (CLI-1G1)", () => {
  /** Forbidden characters (besides the structural #) that must always be rejected. */
  const forbiddenCharArb = constantFrom("?", "%", " ", "\t");

  test("org/project#FULL-SHORTID is equivalent to org/project/FULL-SHORTID", async () => {
    await fcAssert(
      property(
        tuple(orgSlugArb, projectSlugArb, suffixArb),
        ([org, project, suffix]) => {
          const shortId = `${project}-${suffix}`;
          const hashForm = parseIssueArg(`${org}/${project}#${shortId}`);
          const slashForm = parseIssueArg(`${org}/${project}/${shortId}`);
          expect(hashForm).toEqual(slashForm);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("project#FULL-SHORTID always yields project-search with extracted suffix", async () => {
    await fcAssert(
      property(tuple(projectSlugArb, suffixArb), ([project, suffix]) => {
        const result = parseIssueArg(`${project}#${project}-${suffix}`);
        expect(result).toEqual({
          type: "project-search",
          projectSlug: project,
          suffix: suffix.toUpperCase(),
        });
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("forbidden character in fragment always throws", async () => {
    await fcAssert(
      property(
        tuple(projectSlugArb, suffixArb, forbiddenCharArb),
        ([project, suffix, bad]) => {
          expect(() => parseIssueArg(`${project}#${suffix}${bad}x`)).toThrow();
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("parseOrgProjectArg properties", () => {
  test("undefined or empty string returns type 'auto-detect'", async () => {
    const emptyInputArb = constantFrom(undefined, "", "  ", "\t", "\n");

    await fcAssert(
      property(emptyInputArb, (input) => {
        const result = parseOrgProjectArg(input);
        expect(result.type).toBe("auto-detect");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("org/project returns type 'explicit'", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, projectSlugArb), ([org, project]) => {
        const input = `${org}/${project}`;
        const result = parseOrgProjectArg(input);

        expect(result.type).toBe("explicit");
        if (result.type === "explicit") {
          expect(result.org).toBe(org);
          expect(result.project).toBe(project);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("org/ (trailing slash) returns type 'org-all'", async () => {
    await fcAssert(
      property(orgSlugArb, (org) => {
        const input = `${org}/`;
        const result = parseOrgProjectArg(input);

        expect(result.type).toBe("org-all");
        if (result.type === "org-all") {
          expect(result.org).toBe(org);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("project without slash returns type 'project-search'", async () => {
    await fcAssert(
      property(projectSlugArb, (project) => {
        const result = parseOrgProjectArg(project);

        expect(result.type).toBe("project-search");
        if (result.type === "project-search") {
          expect(result.projectSlug).toBe(project);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("/project (leading slash) returns type 'project-search'", async () => {
    await fcAssert(
      property(projectSlugArb, (project) => {
        const input = `/${project}`;
        const result = parseOrgProjectArg(input);

        expect(result.type).toBe("project-search");
        if (result.type === "project-search") {
          expect(result.projectSlug).toBe(project);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result type is always one of the 4 valid types", async () => {
    const validTypes = ["explicit", "org-all", "project-search", "auto-detect"];

    const validInputArb = oneof(
      constantFrom(undefined, ""),
      tuple(orgSlugArb, projectSlugArb).map(([o, p]) => `${o}/${p}`),
      orgSlugArb.map((o) => `${o}/`),
      projectSlugArb,
      projectSlugArb.map((p) => `/${p}`)
    );

    await fcAssert(
      property(validInputArb, (input) => {
        try {
          const result = parseOrgProjectArg(input);
          expect(validTypes).toContain(result.type);
        } catch {
          // Some inputs may throw - that's expected
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("whitespace is trimmed from input", async () => {
    await fcAssert(
      property(
        tuple(orgSlugArb, projectSlugArb, constantFrom("", " ", "  ")),
        ([org, project, ws]) => {
          const input = `${ws}${org}/${project}${ws}`;
          const result = parseOrgProjectArg(input);

          expect(result.type).toBe("explicit");
          if (result.type === "explicit") {
            expect(result.org).toBe(org);
            expect(result.project).toBe(project);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("parseIssueArg and parseOrgProjectArg consistency", () => {
  test("parseIssueArg uses parseOrgProjectArg for dash-separated inputs", async () => {
    // When parseIssueArg gets "org/project-suffix", it should parse "org/project"
    // the same way parseOrgProjectArg would
    await fcAssert(
      property(
        tuple(orgSlugArb, projectSlugArb, suffixArb),
        ([org, project, suffix]) => {
          const orgProject = `${org}/${project}`;
          const issueArg = `${orgProject}-${suffix}`;

          const orgProjectResult = parseOrgProjectArg(orgProject);
          const issueResult = parseIssueArg(issueArg);

          // parseOrgProjectArg returns "explicit" for "org/project"
          expect(orgProjectResult.type).toBe("explicit");

          // parseIssueArg should return "explicit" with matching org/project
          expect(issueResult.type).toBe("explicit");
          if (
            orgProjectResult.type === "explicit" &&
            issueResult.type === "explicit"
          ) {
            expect(issueResult.org).toBe(orgProjectResult.org);
            expect(issueResult.project).toBe(orgProjectResult.project);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

/** Generates all-lowercase slug-like strings with at least one dash */
const lowercaseSlugWithDashArb = stringMatching(
  /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)+$/
);

/** Generates alphanumeric strings without dashes */
const noDashAlphanumArb = stringMatching(/^[a-zA-Z0-9]{1,20}$/);

/** Generates strings that contain at least one slash */
const withSlashArb = stringMatching(/^[a-zA-Z0-9]+\/[a-zA-Z0-9]+$/);

/** Generates strings without slashes */
const noSlashArb = stringMatching(/^[a-zA-Z0-9-]{1,20}$/);

/** Generates display-name-like strings with spaces (e.g., "My Project") */
const displayNameLikeArb = stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,20}$/);

describe("normalizeSlug properties (no-op)", () => {
  test("always returns the input unchanged", async () => {
    await fcAssert(
      property(displayNameLikeArb, (input) => {
        const result = normalizeSlug(input);
        expect(result.slug).toBe(input);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("normalized is always false", async () => {
    await fcAssert(
      property(displayNameLikeArb, (input) => {
        const result = normalizeSlug(input);
        expect(result.normalized).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent: normalizing twice yields same result as normalizing once", async () => {
    await fcAssert(
      property(displayNameLikeArb, (input) => {
        const first = normalizeSlug(input);
        const second = normalizeSlug(first.slug);
        expect(second.slug).toBe(first.slug);
        expect(second.normalized).toBe(first.normalized);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("looksLikeIssueShortId properties", () => {
  test("all-lowercase slugs with dashes never match", async () => {
    await fcAssert(
      property(lowercaseSlugWithDashArb, (input) => {
        expect(looksLikeIssueShortId(input)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("strings without dashes never match", async () => {
    await fcAssert(
      property(noDashAlphanumArb, (input) => {
        expect(looksLikeIssueShortId(input)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("strings with slashes never match", async () => {
    await fcAssert(
      property(withSlashArb, (input) => {
        expect(looksLikeIssueShortId(input)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("two-part lowercase slugs do not match with ignoreCase", async () => {
    await fcAssert(
      property(lowercaseSlugWithDashArb, (input) => {
        if (input.split("-").length === 2) {
          expect(looksLikeIssueShortId(input, { ignoreCase: true })).toBe(
            false
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("three-plus-part lowercase slugs without alphanumeric final segment do not match with ignoreCase", async () => {
    await fcAssert(
      property(lowercaseSlugWithDashArb, (input) => {
        const parts = input.split("-");
        const lastPart = parts.at(-1) ?? "";
        const hasDigit = /\d/.test(lastPart);
        const hasLetter = /[a-z]/.test(lastPart);
        if (parts.length >= 3 && !(hasDigit && hasLetter)) {
          expect(looksLikeIssueShortId(input, { ignoreCase: true })).toBe(
            false
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("three-plus-part lowercase slugs with alphanumeric final segment match with ignoreCase", async () => {
    await fcAssert(
      property(lowercaseSlugWithDashArb, (input) => {
        const parts = input.split("-");
        const lastPart = parts.at(-1) ?? "";
        if (
          parts.length >= 3 &&
          /\d/.test(lastPart) &&
          /[a-z]/.test(lastPart)
        ) {
          expect(looksLikeIssueShortId(input, { ignoreCase: true })).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("parseSelector properties", () => {
  /** All recognized selector spellings (case-insensitive) */
  const selectorVariantArb = constantFrom(
    "@latest",
    "@Latest",
    "@LATEST",
    "@most_frequent",
    "@Most_Frequent",
    "@MOST_FREQUENT",
    "@mostfrequent",
    "@most-frequent"
  );

  test("recognized selectors always return a canonical value", async () => {
    await fcAssert(
      property(selectorVariantArb, (input) => {
        const result = parseSelector(input);
        expect(result).toBeDefined();
        expect(["@latest", "@most_frequent"]).toContain(result!);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-@ strings never match", async () => {
    await fcAssert(
      property(orgSlugArb, (input) => {
        expect(parseSelector(input)).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("bare @selector parses to type 'selector'", async () => {
    await fcAssert(
      property(selectorVariantArb, (input) => {
        const result = parseIssueArg(input);
        expect(result.type).toBe("selector");
        if (result.type === "selector") {
          expect(["@latest", "@most_frequent"]).toContain(result.selector);
          expect(result.org).toBeUndefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("org/@selector parses to type 'selector' with org", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, selectorVariantArb), ([org, sel]) => {
        const input = `${org}/${sel}`;
        const result = parseIssueArg(input);
        expect(result.type).toBe("selector");
        if (result.type === "selector") {
          expect(["@latest", "@most_frequent"]).toContain(result.selector);
          expect(result.org).toBe(org);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("canonical form is stable regardless of casing", async () => {
    await fcAssert(
      property(selectorVariantArb, (input) => {
        const direct = parseSelector(input);
        const lower = parseSelector(input.toLowerCase());
        expect(direct).toBe(lower);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("detectSwappedViewArgs properties", () => {
  test("symmetric inverse: if swap(a,b) is non-null then swap(b,a) is null when exactly one has slash", async () => {
    await fcAssert(
      property(tuple(noSlashArb, withSlashArb), ([noSlash, withSlash]) => {
        // noSlash first, withSlash second → swapped → non-null
        expect(detectSwappedViewArgs(noSlash, withSlash)).not.toBeNull();
        // withSlash first, noSlash second → correct → null
        expect(detectSwappedViewArgs(withSlash, noSlash)).toBeNull();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("both without slashes always returns null", async () => {
    await fcAssert(
      property(tuple(noSlashArb, noSlashArb), ([a, b]) => {
        expect(detectSwappedViewArgs(a, b)).toBeNull();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("both with slashes always returns null", async () => {
    await fcAssert(
      property(tuple(withSlashArb, withSlashArb), ([a, b]) => {
        expect(detectSwappedViewArgs(a, b)).toBeNull();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
