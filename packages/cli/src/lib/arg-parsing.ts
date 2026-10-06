/**
 * Shared Argument Parsing Utilities
 *
 * Common parsing logic for CLI positional arguments that follow the
 * `<org>/<target>` pattern. Used by both listing commands (issue list,
 * project list) and single-item commands (issue view, explain, plan).
 */

import type { LogSortDirection } from "./api/logs.js";
import { ContextError, ValidationError, validationError } from "./errors.js";
import { validateResourceId } from "./input-validation.js";

import type { ParsedSentryUrl } from "./sentry-url-parser.js";
import { applySentryUrlContext, parseSentryUrl } from "./sentry-url-parser.js";
import { isAllDigits } from "./utils.js";

// ---------------------------------------------------------------------------
// Slug normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a Sentry slug from user input.
 *
 * After the removal of underscore normalization (#771) and the move to
 * display-name matching for space-containing inputs (#772), this function
 * is effectively a no-op — valid slug characters pass through unchanged.
 * It remains as a stable call-site for future normalization rules.
 *
 * Spaces are handled separately: {@link looksLikeDisplayName} detects them
 * and the parsing layer routes to a display-name search path that skips
 * slug validation and API lookup entirely.
 *
 * @param slug - Raw slug string from CLI input
 * @returns The slug unchanged with `normalized: false`
 */
export function normalizeSlug(slug: string): {
  slug: string;
  normalized: boolean;
} {
  return { slug, normalized: false };
}

/**
 * Check if a string looks like a display name rather than a slug.
 * Display names contain spaces, which are never valid in slugs.
 */
function looksLikeDisplayName(input: string): boolean {
  return input.includes(" ");
}

// ---------------------------------------------------------------------------
// Issue short ID detection
// ---------------------------------------------------------------------------

/**
 * Pattern for issue short IDs: one or more segments of letters/digits
 * separated by dashes, where the last segment is the alphanumeric suffix.
 *
 * Examples that match: `CAM-82X`, `CLI-G`, `SPOTLIGHT-ELECTRON-4Y`
 * Examples that don't: `my-project` (suffix is all lowercase),
 * `a9b4ad2c` (no dash), `org/project` (has slash)
 *
 * The key distinguishing feature vs. a project slug: the suffix after the
 * last dash contains at least one uppercase letter or digit that looks like
 * a base-36 short ID, and the prefix is all-uppercase.
 */
const ISSUE_SHORT_ID_PATTERN = /^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[A-Z0-9]+$/;

/** Detects any uppercase ASCII letter — used for mixed-case short ID recovery. */
const HAS_UPPERCASE_ASCII_RE = /[A-Z]/;

/** Detects at least one digit — used to distinguish short ID suffixes from slugs. */
const HAS_DIGIT_RE = /\d/;

/** Detects at least one ASCII letter — used for short ID suffix shape checks. */
const HAS_LETTER_ASCII_RE = /[a-zA-Z]/;

/**
 * Matches a strict "Title Case" word: one leading uppercase letter plus at
 * least one lowercase letter (e.g. `My`). Excludes single-letter prefixes
 * like `P` in `P-1`, all-uppercase prefixes like `CLI`, and mixed-case
 * prefixes like `CaM`.
 */
const TITLE_CASE_WORD_RE = /^[A-Z][a-z]+$/;

/** Minimum parts for a dash-separated string to be considered "2-part" for the title-case guard. */
const TWO_SEGMENT_PARTS = 2;

/**
 * Minimum dash-separated parts for ignoreCase recovery when the input has no
 * uppercase letters (e.g. `javascript-react-mr-1b` has four parts).
 */
const ISSUE_SHORT_ID_MULTI_SEGMENT_PARTS = 3;

/** Splits a string into lines on LF or CRLF boundaries. */
const LINE_SPLIT_PATTERN = /\r?\n/;

/** Splits a string on any run of whitespace. */
const WHITESPACE_SPLIT_PATTERN = /\s+/;

/**
 * Check if a string looks like a Sentry issue short ID.
 *
 * Used to detect when a user passes an issue short ID where a target
 * (org/project) is expected — e.g., `sentry event view CAM-82X 95fd7f5a`.
 *
 * @param str - String to check
 * @param opts.ignoreCase - When true, also match mixed-case and multi-segment
 *   lowercase inputs whose final segment is alphanumeric (e.g.
 *   `javascript-react-mr-1b`). Two-part slugs like `my-project`, letter-only
 *   multi-segment slugs like `my-frontend-app`, and versioned project slugs
 *   like `my-app-2` are rejected.
 * @returns true if the string matches the issue short ID pattern
 *
 * @example
 * looksLikeIssueShortId("CAM-82X")              // true
 * looksLikeIssueShortId("CLI-G")                // true
 * looksLikeIssueShortId("SPOTLIGHT-ELECTRON-4Y") // true
 * looksLikeIssueShortId("my-project")            // false (lowercase)
 * looksLikeIssueShortId("a9b4ad2c")             // false (no dash)
 * looksLikeIssueShortId("javascript-react-mr-1b", { ignoreCase: true }) // true
 * looksLikeIssueShortId("my-project", { ignoreCase: true })            // false
 * looksLikeIssueShortId("my-frontend-app", { ignoreCase: true })       // false
 * looksLikeIssueShortId("my-app-2", { ignoreCase: true })              // false
 * looksLikeIssueShortId("My-2", { ignoreCase: true })                  // false
 */
export function looksLikeIssueShortId(
  str: string,
  opts?: { ignoreCase?: boolean }
): boolean {
  if (opts?.ignoreCase) {
    return matchesIssueShortIdIgnoreCase(str);
  }
  return ISSUE_SHORT_ID_PATTERN.test(str);
}

/** Matches purely numeric issue suffixes (e.g. `1` in `issue-1`). */
const NUMERIC_SUFFIX_RE = /^\d+$/;

/** Issue command tokens agents often mistake for project slugs in dash args. */
const CLI_COMMAND_TOKEN_NOUNS = new Set(["issue", "issues"]);

/**
 * Check if a slug is an issue command token (e.g. "issue", "issues").
 *
 * Used to detect when agents pass command-like tokens as project prefixes in
 * dash-separated issue args (`issue-1` → project `issue`, suffix `1`). Only
 * combined with a purely numeric suffix — alphanumeric suffixes like `api-G`
 * are valid issue short IDs, and other CLI nouns like `api` or `release` may
 * be real project slugs even with numeric suffixes (`api-1`, `release-123`).
 *
 * Matching is case-sensitive on the slug: uppercase prefixes like `ISSUE` in
 * `ISSUE-1` are valid short IDs, not mistaken lowercase command tokens.
 */
export function isIssueCommandToken(slug: string): boolean {
  return CLI_COMMAND_TOKEN_NOUNS.has(slug);
}

/**
 * Reject dash-parsed args where the project segment is an issue command token
 * and the suffix is purely numeric (e.g. `issue-1`, `my-org/issue-1`).
 *
 * @throws {ValidationError} When the project segment is `issue`/`issues` and the
 *   suffix is purely numeric
 */
function rejectIssueCommandTokenWithNumericSuffix(
  arg: string,
  projectSlug: string,
  suffix: string
): void {
  if (!(isIssueCommandToken(projectSlug) && NUMERIC_SUFFIX_RE.test(suffix))) {
    return;
  }
  const normalizedProject = projectSlug.toLowerCase();
  throw validationError(
    `"${arg}" looks like a command token plus a suffix, not an issue short ID.\n` +
      `  Parsed as project '${normalizedProject}' + suffix '${suffix}', but '${normalizedProject}' is an issue command name.`,
    [
      "sentry issue view PROJECT-1",
      "sentry issue explain PROJECT-1",
      "sentry issue explain 123456789",
      "sentry issue explain my-org/project/PROJECT-G",
    ],
    "issue"
  );
}

/**
 * Reject org/project list targets that look like `issue-1` command tokens.
 *
 * `parseOrgProjectArg` treats bare `issue-1` as a single project slug; this
 * applies the same guard as `parseIssueArg` for bare and `org/issue-1` forms.
 *
 * @throws {ValidationError} When the target matches an issue command token with
 *   a purely numeric suffix
 */
export function rejectIssueCommandTokenListTarget(target: string): void {
  const trimmed = target.trim();
  const dashIdx = trimmed.lastIndexOf("-");
  if (dashIdx === -1) {
    return;
  }
  const suffix = trimmed.slice(dashIdx + 1);
  if (!NUMERIC_SUFFIX_RE.test(suffix)) {
    return;
  }
  const prefix = trimmed.slice(0, dashIdx);
  const slashIdx = prefix.lastIndexOf("/");
  const projectSegment = slashIdx === -1 ? prefix : prefix.slice(slashIdx + 1);
  rejectIssueCommandTokenWithNumericSuffix(trimmed, projectSegment, suffix);
}

/**
 * Case-insensitive short ID match with guardrails against project-slug false positives.
 *
 * A fully-lowercase input is only recovered when it can't be told apart from a
 * project slug by anything but its final segment, so the rule keys off that
 * segment. This keeps the classification consistent for the whole class rather
 * than carving out length-based special cases (which flipped `my-app-2b` vs
 * `my-apps-2b` on a one-character difference).
 *
 * Guard tiers:
 * 1. Two-part all-lowercase slugs (e.g. `my-project`) — rejected as project names
 * 2. Multi-segment all-lowercase with a letter-only or digit-only final
 *    (e.g. `my-frontend-app`, `my-app-2`) — rejected. A short-ID suffix mixes a
 *    letter and a digit (`1b`, `4y`), so a pure-word or pure-number final marks
 *    a project slug.
 * 3. Title-case first segment (e.g. `My` in `My-Project`, `My-2b`, `My-App-2`) —
 *    rejected. Real short-ID prefixes are fully uppercase or fully lowercase,
 *    not "someone capitalized a project name" title case.
 *
 * All-uppercase multi-segment short IDs (e.g. `SPOTLIGHT-ELECTRON-5`) pass tier 2
 * because Sentry project slugs are always lowercase. Mixed-case short IDs
 * (e.g. `CaM-82x`) and lowercase multi-segment with alphanumeric finals
 * (e.g. `javascript-react-mr-1b`, `my-app-2b`) match when uppercased.
 *
 * @example
 * matchesIssueShortIdIgnoreCase("my-app-2")               // false
 * matchesIssueShortIdIgnoreCase("my-app-2b")              // true
 * matchesIssueShortIdIgnoreCase("My-Project")             // false
 * matchesIssueShortIdIgnoreCase("My-2b")                  // false
 * matchesIssueShortIdIgnoreCase("CLI-5")                  // true
 * matchesIssueShortIdIgnoreCase("SPOTLIGHT-ELECTRON-5")   // true
 * matchesIssueShortIdIgnoreCase("javascript-react-mr-1b") // true
 */
function matchesIssueShortIdIgnoreCase(str: string): boolean {
  const parts = str.split("-");
  const hasUppercase = HAS_UPPERCASE_ASCII_RE.test(str);
  const multiSegment = parts.length >= ISSUE_SHORT_ID_MULTI_SEGMENT_PARTS;
  if (!(hasUppercase || multiSegment)) {
    return false;
  }
  const lastPartLower = (parts.at(-1) ?? "").toLowerCase();
  if (multiSegment && !hasUppercase && !isAlphanumericSegment(lastPartLower)) {
    return false;
  }
  if (
    parts.length >= TWO_SEGMENT_PARTS &&
    TITLE_CASE_WORD_RE.test(parts[0] ?? "")
  ) {
    return false;
  }
  return ISSUE_SHORT_ID_PATTERN.test(str.toUpperCase());
}

/** True when a segment contains at least one letter and one digit (e.g. `1b`, not `2` or `app`). */
function isAlphanumericSegment(segment: string): boolean {
  return HAS_DIGIT_RE.test(segment) && HAS_LETTER_ASCII_RE.test(segment);
}

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

/**
 * Check if a string looks like a filesystem path rather than a slug/identifier.
 *
 * Uses purely syntactic checks — no filesystem I/O. Detects:
 * - `.` (current directory)
 * - `./foo`, `../foo` (relative paths)
 * - `/foo` (absolute paths)
 * - `~` or `~/foo` (home directory paths)
 *
 * Bare names like `my-org` or `my-project` never match, which is what makes
 * this useful for disambiguating positional arguments that could be either
 * a filesystem path or an org/project target.
 *
 * Note: `~` is only matched as `~` alone or `~/...`, not `~foo`. This avoids
 * false positives on slugs that happen to start with tilde (valid in Sentry slugs).
 * Shell expansion of `~/foo` happens before the CLI sees the argument, so a literal
 * `~/foo` reaching this function means the shell didn't expand it (e.g., it was quoted).
 *
 * @param arg - CLI argument string to check
 * @returns true if the string looks like a filesystem path
 *
 * @example
 * looksLikePath(".")           // true
 * looksLikePath("./subdir")    // true
 * looksLikePath("../parent")   // true
 * looksLikePath("/absolute")   // true
 * looksLikePath("~/home")      // true
 * looksLikePath("~")           // true
 * looksLikePath("~foo")        // false (could be a slug)
 * looksLikePath("my-project")  // false
 * looksLikePath("acme/app")    // false
 */
export function looksLikePath(arg: string): boolean {
  return (
    arg === "." ||
    arg === "~" ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    arg.startsWith("~/")
  );
}

// Argument swap detection for view commands
// ---------------------------------------------------------------------------

/**
 * Detect when two positional args to a `* view` command appear to be in
 * the wrong order.
 *
 * View commands expect `<target> <id>` where:
 * - `target` is an `org/project` specifier (contains `/`) or a bare project slug
 * - `id` is a hex string (event ID, trace ID, log ID)
 *
 * Returns a warning message if args appear swapped, or `null` if order
 * looks correct.
 *
 * **Heuristic**: If `second` contains `/` but `first` does not, the user
 * likely passed `<id> <target>` instead of `<target> <id>`.
 *
 * @param first - First positional argument
 * @param second - Second positional argument
 * @returns Warning message string if swapped, `null` otherwise
 *
 * @example
 * detectSwappedViewArgs("a9b4ad2c", "mv-software/mvsoftware")
 * // → "Arguments appear reversed. Interpreting as: mv-software/mvsoftware a9b4ad2c"
 *
 * detectSwappedViewArgs("mv-software/mvsoftware", "a9b4ad2c")
 * // → null (correct order)
 */
export function detectSwappedViewArgs(
  first: string,
  second: string
): string | null {
  if (second.includes("/") && !first.includes("/")) {
    return `Arguments appear reversed. Interpreting as: ${second} ${first}`;
  }
  return null;
}

/**
 * Detect when `trial start` args are swapped: `sentry trial start my-org seer`
 * instead of `sentry trial start seer my-org`.
 *
 * Since trial names are a known finite set, we can unambiguously determine
 * which arg is the trial name and which is the org slug by checking against
 * the valid trial names list.
 *
 * @param first - First positional argument
 * @param second - Second positional argument
 * @param isKnownName - Predicate to check if a string is a valid trial name
 * @returns Object with resolved `name` and `org` if swapped, or `null` if order is correct
 *
 * @example
 * detectSwappedTrialArgs("my-org", "seer", isTrialName)
 * // → { name: "seer", org: "my-org", warning: "Arguments appear reversed..." }
 *
 * detectSwappedTrialArgs("seer", "my-org", isTrialName)
 * // → null (correct order)
 */
export function detectSwappedTrialArgs(
  first: string,
  second: string,
  isKnownName: (value: string) => boolean
): { name: string; org: string; warning: string } | null {
  // If first is already a known name, order is correct
  if (isKnownName(first)) {
    return null;
  }

  // If second is a known name but first isn't, they're swapped
  if (isKnownName(second)) {
    return {
      name: second,
      org: first,
      warning: `Arguments appear reversed. Interpreting as: ${second} ${first}`,
    };
  }

  return null;
}

/**
 * Validate that a CLI --limit flag value is within an allowed range.
 *
 * Used by commands that need API-side limiting (trace list, log list) where
 * the value is passed directly to the API as `per_page`.
 *
 * Defaults match the shared constants {@link LIST_MIN_LIMIT} (1) and
 * {@link LIST_MAX_LIMIT} (1000) from `list-command.ts`.
 *
 * @param value - Raw string input from CLI flag
 * @param min - Minimum allowed value (inclusive, default: 1)
 * @param max - Maximum allowed value (inclusive, default: 1000)
 * @returns Parsed integer
 * @throws {Error} If value is NaN or outside [min, max]
 *
 * @example
 * validateLimit("50")           // 50  (uses defaults 1–1000)
 * validateLimit("50", 1, 1000)  // 50
 * validateLimit("0", 1, 1000)   // throws
 * validateLimit("abc", 1, 1000) // throws
 */
export function validateLimit(value: string, min = 1, max = 1000): number {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num) || num < min || num > max) {
    throw new ValidationError(
      `--limit must be between ${min} and ${max}`,
      "limit"
    );
  }
  return num;
}

// ---------------------------------------------------------------------------
// Log sort direction parsing (shared by log list, trace logs)
// ---------------------------------------------------------------------------

const VALID_LOG_SORT_DIRECTIONS: readonly LogSortDirection[] = [
  "newest",
  "oldest",
];

/**
 * Parse --sort flag value for log commands.
 * @throws Error if value is not "newest" or "oldest"
 */
export function parseLogSort(value: string): LogSortDirection {
  if (!VALID_LOG_SORT_DIRECTIONS.includes(value as LogSortDirection)) {
    throw new ValidationError(
      `Invalid sort value. Must be one of: ${VALID_LOG_SORT_DIRECTIONS.join(", ")}`,
      "sort"
    );
  }
  return value as LogSortDirection;
}

/** Default span depth when no value is provided */
const DEFAULT_SPAN_DEPTH = 3;

/**
 * Parse span depth flag value.
 *
 * Supports:
 * - Numeric values (e.g., "3", "5") - depth limit
 * - "all" for unlimited depth (returns Infinity)
 * - "no" or "0" to disable span tree (returns 0)
 * - Invalid values fall back to default depth (3)
 *
 * @param input - Raw input string from CLI flag
 * @returns Parsed depth as number (0 = disabled, Infinity = unlimited)
 *
 * @example
 * parseSpanDepth("3")    // 3
 * parseSpanDepth("all")  // Infinity
 * parseSpanDepth("no")   // 0
 * parseSpanDepth("0")    // 0
 * parseSpanDepth("foo")  // 3 (default)
 */
export function parseSpanDepth(input: string): number {
  const lower = input.toLowerCase();
  if (lower === "all") {
    return Number.POSITIVE_INFINITY;
  }
  if (lower === "no") {
    return 0;
  }
  const n = Number(input);
  if (Number.isNaN(n)) {
    return DEFAULT_SPAN_DEPTH;
  }
  return n;
}

/**
 * Shared --spans flag definition for Stricli commands.
 * Use this in command parameters to avoid duplication.
 *
 * @example
 * parameters: {
 *   flags: {
 *     ...spansFlag,
 *     // other flags
 *   }
 * }
 */
export const spansFlag = {
  spans: {
    kind: "parsed" as const,
    parse: parseSpanDepth,
    brief:
      'Span tree depth limit (number, "all" for unlimited, "no" to disable)',
    default: String(DEFAULT_SPAN_DEPTH),
  },
};

/**
 * Type constants for project specification patterns.
 * Use these constants instead of string literals for type safety.
 */
export const ProjectSpecificationType = {
  /** Explicit org/project provided (e.g., "sentry/cli") */
  Explicit: "explicit",
  /** Org with trailing slash for all projects (e.g., "sentry/") */
  OrgAll: "org-all",
  /** Project slug only, search across all orgs (e.g., "cli") */
  ProjectSearch: "project-search",
  /** No input, auto-detect from DSN/config */
  AutoDetect: "auto-detect",
} as const;

/**
 * Parsed result from an org/project positional argument.
 * Discriminated union based on the `type` field.
 *
 * When `normalized` is true, the slug was auto-corrected from display-name
 * form (spaces → dashes with lowercasing). Underscores are preserved — Sentry
 * allows underscored project slugs and the CLI must not rewrite them.
 */
export type ParsedOrgProject =
  | {
      type: typeof ProjectSpecificationType.Explicit;
      org: string;
      project: string;
      /** True if any slug was normalized */
      normalized?: boolean;
    }
  | {
      type: typeof ProjectSpecificationType.OrgAll;
      org: string;
      /** True if org slug was normalized */
      normalized?: boolean;
    }
  | {
      type: typeof ProjectSpecificationType.ProjectSearch;
      projectSlug: string;
      /** True if project slug was normalized */
      normalized?: boolean;
      /**
       * Organization slug to scope the search to, when the caller provided
       * one (e.g. "org/My Project"). When unset the search spans all
       * accessible organizations.
       */
      org?: string;
      /**
       * Pre-normalization input when {@link normalized} is `true`.
       * Used by the resolution layer to produce user-friendly messages
       * that reference what the user actually typed rather than the
       * intermediate normalized form.
       */
      originalSlug?: string;
    }
  | { type: typeof ProjectSpecificationType.AutoDetect };

/**
 * Map a parsed Sentry URL to a ParsedOrgProject.
 * If the URL contains a project slug, returns explicit; otherwise org-all.
 * Share URLs without org context fall back to auto-detect.
 */
function orgProjectFromUrl(parsed: ParsedSentryUrl): ParsedOrgProject {
  if (!parsed.org) {
    return { type: "auto-detect" };
  }
  if (parsed.project) {
    return { type: "explicit", org: parsed.org, project: parsed.project };
  }
  return { type: "org-all", org: parsed.org };
}

/**
 * Map a parsed Sentry URL to a ParsedIssueArg.
 * Handles share URLs, numeric group IDs, and short IDs (e.g., "CLI-G") from the URL path.
 */
function issueArgFromUrl(parsed: ParsedSentryUrl): ParsedIssueArg | null {
  // Share URL → resolve via public share API
  if (parsed.shareId) {
    return {
      type: "share",
      shareId: parsed.shareId,
      org: parsed.org,
      baseUrl: parsed.baseUrl,
    };
  }

  const { issueId } = parsed;
  if (!issueId) {
    return null;
  }

  // Non-share URLs always have org from their matchers; guard narrows the type
  const { org } = parsed;
  if (!org) {
    return null;
  }

  // Numeric group ID (e.g., /issues/32886/)
  if (isAllDigits(issueId)) {
    return {
      type: "explicit-org-numeric",
      org,
      numericId: issueId,
    };
  }

  // Short ID with dash (e.g., /issues/CLI-G/ or /issues/SPOTLIGHT-ELECTRON-4Y/)
  const dashIdx = issueId.lastIndexOf("-");
  if (dashIdx > 0) {
    const project = issueId.slice(0, dashIdx);
    const suffix = issueId.slice(dashIdx + 1).toUpperCase();
    if (project && suffix) {
      // Lowercase project slug — Sentry slugs are always lowercase.
      return {
        type: "explicit",
        org,
        project: project.toLowerCase(),
        suffix,
      };
    }
  }

  // No dash — treat as suffix-only with org context
  return {
    type: "explicit-org-suffix",
    org,
    suffix: issueId.toUpperCase(),
  };
}

/**
 * Reject `@`-prefixed values in org/project positions.
 *
 * `@latest` and `@most_frequent` are issue selectors supported by
 * `parseIssueArg()` (for `issue view`, `explain`, `plan`). They are not
 * valid project slugs. This guard provides a helpful redirect instead of
 * the confusing "Project '@latest' not found" resolution error.
 *
 * Unknown `@`-prefixed values are also rejected — `@` is never valid in
 * Sentry slugs.
 */
function rejectAtSelector(value: string, label: string): void {
  if (!value.startsWith("@")) {
    return;
  }

  const selector = parseSelector(value);
  if (selector) {
    const article = "aeiouAEIOU".includes(label.charAt(0)) ? "an" : "a";
    throw new ValidationError(
      `'${value}' is an issue selector, not ${article} ${label}.\n` +
        `  Use: sentry issue view ${value}`,
      label
    );
  }

  throw new ValidationError(
    `Invalid ${label}: '${value}' starts with '@'.\n` +
      "  Slugs contain only letters, numbers, hyphens, and underscores.",
    label
  );
}

/**
 * Parse a slash-delimited `org/project` string into a {@link ParsedOrgProject}.
 * Applies {@link normalizeSlug} to both components and validates against
 * URL injection characters.
 */
function parseSlashOrgProject(input: string): ParsedOrgProject {
  const slashIndex = input.indexOf("/");
  const rawOrg = input.slice(0, slashIndex);
  const rawProject = input.slice(slashIndex + 1);

  if (!rawOrg) {
    // "/cli" → search for project across all orgs
    if (!rawProject) {
      throw new ValidationError(
        'Invalid format: "/" requires a project slug (e.g., "/cli")'
      );
    }
    rejectAtSelector(rawProject, "project slug");
    if (looksLikeDisplayName(rawProject)) {
      // Spaces → display name, not a slug. Skip slug validation and let
      // the resolution layer do a fuzzy name-based search.
      return {
        type: "project-search",
        projectSlug: rawProject,
        originalSlug: rawProject,
      };
    }
    const np = normalizeSlug(rawProject);
    validateResourceId(np.slug, "project slug");
    return {
      type: "project-search",
      projectSlug: np.slug,
    };
  }

  rejectAtSelector(rawOrg, "organization slug");
  const no = normalizeSlug(rawOrg);
  validateResourceId(no.slug, "organization slug");

  if (!rawProject) {
    // "sentry/" → list all projects in org
    return {
      type: "org-all",
      org: no.slug,
      ...(no.normalized && { normalized: true }),
    };
  }

  // "sentry/cli" → explicit org and project
  rejectAtSelector(rawProject, "project slug");
  if (looksLikeDisplayName(rawProject)) {
    // Spaces → display name, not a slug. Skip slug validation and let the
    // resolution layer do a fuzzy name-based search (mirrors the bare-slug
    // and leading-slash paths). Prevents a hard ValidationError when callers
    // pass a project display name in "org/project" form (CLI-1RA).
    return {
      type: "project-search",
      projectSlug: rawProject,
      originalSlug: rawProject,
      org: no.slug,
    };
  }
  const np = normalizeSlug(rawProject);
  validateResourceId(np.slug, "project slug");
  const normalized = no.normalized || np.normalized;
  return {
    type: "explicit",
    org: no.slug,
    project: np.slug,
    ...(normalized && { normalized: true }),
  };
}

/**
 * Parse an org/project positional argument string.
 *
 * Supports the following patterns:
 * - `undefined` or empty → auto-detect from DSN/config
 * - `https://sentry.io/organizations/org/...` → extract from Sentry URL
 * - `sentry/cli` → explicit org and project
 * - `sentry/` → org with all projects
 * - `/cli` → search for project across all orgs (leading slash)
 * - `cli` → search for project across all orgs
 *
 * @param arg - Input string from CLI positional argument
 * @returns Parsed result with type discrimination
 *
 * @example
 * parseOrgProjectArg(undefined)     // { type: "auto-detect" }
 * parseOrgProjectArg("sentry/cli")  // { type: "explicit", org: "sentry", project: "cli" }
 * parseOrgProjectArg("sentry/")     // { type: "org-all", org: "sentry" }
 * parseOrgProjectArg("/cli")        // { type: "project-search", projectSlug: "cli" }
 * parseOrgProjectArg("cli")         // { type: "project-search", projectSlug: "cli" }
 */
export function parseOrgProjectArg(arg: string | undefined): ParsedOrgProject {
  if (!arg || arg.trim() === "") {
    return { type: "auto-detect" };
  }

  const trimmed = arg.trim();

  // URL detection — extract org/project from Sentry web URLs
  const urlParsed = parseSentryUrl(trimmed);
  if (urlParsed) {
    applySentryUrlContext(urlParsed.baseUrl);
    return orgProjectFromUrl(urlParsed);
  }

  let parsed: ParsedOrgProject;
  if (trimmed.includes("/")) {
    parsed = parseSlashOrgProject(trimmed);
  } else {
    // No slash → search for project across all orgs
    rejectAtSelector(trimmed, "project slug");
    if (looksLikeDisplayName(trimmed)) {
      // Spaces → display name, not a slug. Skip slug validation and let
      // the resolution layer do a fuzzy name-based search.
      parsed = {
        type: "project-search",
        projectSlug: trimmed,
        originalSlug: trimmed,
      };
    } else {
      const np = normalizeSlug(trimmed);
      validateResourceId(np.slug, "project slug");
      parsed = {
        type: "project-search",
        projectSlug: np.slug,
      };
    }
  }

  return parsed;
}

/**
 * Parsed issue argument types - flattened for ergonomics.
 *
 * Supports:
 * - `numeric`: Pure numeric ID (e.g., "123456789")
 * - `explicit`: Org + project + suffix (e.g., "sentry/cli-G")
 * - `explicit-org-suffix`: Org + suffix only (e.g., "sentry/G")
 * - `explicit-org-numeric`: Org + numeric ID (e.g., "sentry/123456789")
 * - `project-search`: Project slug + suffix (e.g., "cli-G")
 * - `suffix-only`: Just suffix (e.g., "G")
 */
/**
 * Magic `@` selectors that resolve to issues dynamically.
 *
 * `@latest` resolves to the issue with the most recent event (`lastSeen`).
 * `@most_frequent` resolves to the issue with the highest event frequency.
 *
 * Can be combined with an explicit org: `sentry/@latest`.
 */
export type IssueSelector = "@latest" | "@most_frequent";

/**
 * Set of recognized magic selectors (lowercase for case-insensitive matching).
 * Maps normalized selector names to their canonical form.
 */
const SELECTOR_MAP = new Map<string, IssueSelector>([
  ["@latest", "@latest"],
  ["@most_frequent", "@most_frequent"],
  ["@mostfrequent", "@most_frequent"],
  ["@most-frequent", "@most_frequent"],
]);

/**
 * Check if a string is a recognized magic selector.
 * Case-insensitive and accepts common variations (e.g., `@mostFrequent`).
 *
 * @param value - String to check (without org/ prefix)
 * @returns The canonical selector or undefined if not a selector
 */
export function parseSelector(value: string): IssueSelector | undefined {
  return SELECTOR_MAP.get(value.toLowerCase());
}

export type ParsedIssueArg =
  | { type: "numeric"; id: string }
  | { type: "explicit"; org: string; project: string; suffix: string }
  | { type: "explicit-org-suffix"; org: string; suffix: string }
  | { type: "explicit-org-numeric"; org: string; numericId: string }
  | { type: "project-search"; projectSlug: string; suffix: string }
  | { type: "suffix-only"; suffix: string }
  | { type: "selector"; selector: IssueSelector; org?: string }
  | { type: "share"; shareId: string; org?: string; baseUrl: string };

/**
 * Parse a CLI issue argument into its component parts.
 *
 * Uses `parseOrgProjectArg` internally for the left part of dash-separated
 * inputs, providing consistent org/project parsing across commands.
 *
 * Flow:
 * 1. Pure numeric → { type: "numeric" }
 * 1b. Contains "#" → GitHub-style separator (org/project#SHORTID) → parseWithHash
 * 2. Has dash → split on last "-", parse left with parseOrgProjectArg
 *    - "explicit" → { type: "explicit", org, project, suffix }
 *    - "project-search" → { type: "project-search", projectSlug, suffix }
 *    - "org-all" or "auto-detect" → rejected as invalid
 * 3. Has slash but no dash → explicit org + suffix/numeric
 * 4. Otherwise → suffix-only
 *
 * @param arg - Raw CLI argument
 * @returns Parsed issue argument with type discrimination
 * @throws {Error} If input has invalid format (e.g., "sentry/-G")
 *
 * @example
 * parseIssueArg("123456789")          // { type: "numeric", id: "123456789" }
 * parseIssueArg("sentry/cli-G")       // { type: "explicit", org: "sentry", project: "cli", suffix: "G" }
 * parseIssueArg("cli-G")              // { type: "project-search", projectSlug: "cli", suffix: "G" }
 * parseIssueArg("sentry/G")           // { type: "explicit-org-suffix", org: "sentry", suffix: "G" }
 * parseIssueArg("G")                  // { type: "suffix-only", suffix: "G" }
 * parseIssueArg("sentry/cli#CLI-G")   // { type: "explicit", org: "sentry", project: "cli", suffix: "G" }
 * parseIssueArg("cli#CLI-G")          // { type: "project-search", projectSlug: "cli", suffix: "G" }
 * parseIssueArg("#CLI-G")             // { type: "project-search", projectSlug: "cli", suffix: "G" }
 */
/**
 * Handle multi-slash issue args like "org/project/suffix" or "org/project/123".
 *
 * Splits `rest` on its first `/` to extract the project slug and a remainder
 * that is treated as the issue reference (suffix, numeric ID, or short ID).
 *
 * Handles three remainder formats:
 * - Pure digits → numeric issue ID (project context is redundant)
 * - Full short ID whose prefix matches the project → extract just the suffix
 * - Anything else → treat entire remainder as the suffix
 */
function parseMultiSlashIssueArg(
  arg: string,
  org: string,
  rest: string
): ParsedIssueArg {
  const slashIdx = rest.indexOf("/");
  const project = rest.slice(0, slashIdx);
  const remainder = rest.slice(slashIdx + 1);

  if (!(project && remainder)) {
    throw new ValidationError(
      `Invalid issue format: "${arg}". Missing project or issue ID segment.`,
      "issue"
    );
  }

  // Lowercase project slug — Sentry slugs are always lowercase.
  const normalizedProject = project.toLowerCase();

  // Pure numeric remainder: "org/project/123456789" → org + numeric ID.
  // Project context is redundant for numeric IDs — Sentry resolves them globally.
  if (isAllDigits(remainder)) {
    return { type: "explicit-org-numeric", org, numericId: remainder };
  }

  // Remainder with dash: could be a full short ID like "CLI-A1" or "SPOTLIGHT-ELECTRON-4Y"
  if (remainder.includes("-")) {
    const lastDash = remainder.lastIndexOf("-");
    const prefix = remainder.slice(0, lastDash);
    const suffix = remainder.slice(lastDash + 1).toUpperCase();

    if (prefix && suffix) {
      // Check if the prefix matches the project slug (case-insensitive).
      // If so, the remainder is already a full short ID — use only the suffix.
      // e.g., "sentry/cli/CLI-A1" → prefix "CLI" matches project "cli" → suffix "A1"
      // e.g., "org/spotlight-electron/SPOTLIGHT-ELECTRON-4Y" → prefix matches → suffix "4Y"
      if (prefix.toLowerCase() === normalizedProject) {
        return {
          type: "explicit",
          org,
          project: normalizedProject,
          suffix,
        };
      }

      // Prefix doesn't match project — treat entire remainder as the suffix.
      // e.g., "org/project/SUBPROJ-G" where SUBPROJ ≠ project
      return {
        type: "explicit",
        org,
        project: normalizedProject,
        suffix: `${prefix}-${suffix}`.toUpperCase(),
      };
    }
  }

  // No dash: "org/project/G" — treat remainder as suffix
  return {
    type: "explicit",
    org,
    project: normalizedProject,
    suffix: remainder.toUpperCase(),
  };
}

function parseAfterSlash(
  arg: string,
  org: string,
  rest: string
): ParsedIssueArg {
  if (isAllDigits(rest)) {
    // "my-org/123456789" → explicit org + numeric ID
    return { type: "explicit-org-numeric", org, numericId: rest };
  }

  // Multi-slash: "org/project/suffix" or "org/project/123"
  if (rest.includes("/")) {
    return parseMultiSlashIssueArg(arg, org, rest);
  }

  // Check if rest contains a dash (project-suffix pattern)
  if (rest.includes("-")) {
    const lastDash = rest.lastIndexOf("-");
    const project = rest.slice(0, lastDash);
    const suffix = rest.slice(lastDash + 1).toUpperCase();

    if (!project) {
      throw new ValidationError(
        `Invalid issue format: "${arg}". Cannot use trailing slash before suffix.`,
        "issue"
      );
    }

    if (!suffix) {
      throw new ValidationError(
        `Invalid issue format: "${arg}". Missing suffix after dash.`,
        "issue"
      );
    }

    rejectIssueCommandTokenWithNumericSuffix(arg, project, suffix);

    // "my-org/cli-G" or "sentry/spotlight-electron-4Y"
    // Lowercase the project slug — Sentry slugs are always lowercase.
    return { type: "explicit", org, project: project.toLowerCase(), suffix };
  }

  // "my-org/G" → explicit org + suffix only (no dash in rest)
  return { type: "explicit-org-suffix", org, suffix: rest.toUpperCase() };
}

/**
 * Parse issue arg with slash (org/...).
 */
function parseWithSlash(arg: string): ParsedIssueArg {
  const slashIdx = arg.indexOf("/");
  const org = arg.slice(0, slashIdx);
  const rest = arg.slice(slashIdx + 1);

  if (!rest) {
    throw new ValidationError(
      `Invalid issue format: "${arg}". Missing issue ID after slash.`,
      "issue"
    );
  }

  if (!org) {
    // Leading slash with dash → project-search (e.g., "/cli-G")
    if (rest.includes("-")) {
      return parseWithDash(rest);
    }
    // "/G" → treat as suffix-only (unusual but valid)
    return { type: "suffix-only", suffix: rest.toUpperCase() };
  }

  return parseAfterSlash(arg, org, rest);
}

/**
 * Resolve a `project` + `identifier` pair into a project-scoped issue lookup.
 *
 * Shared by the colon (`PROJECT:SHORTID`) and GitHub-style hash
 * (`project#SHORTID`) parsers. The caller is responsible for validating the
 * project slug and identifier against injection characters first.
 *
 * Handles the identifier in three forms:
 * - Pure digits → numeric lookup (project context is redundant)
 * - Full short ID (`PROJECT-SUFFIX`) → extract just the suffix from the last dash
 * - Anything else → treat the whole identifier as the suffix
 *
 * @param project - Project slug (will be lowercased)
 * @param id - Issue identifier portion
 * @returns Parsed issue argument (`numeric` or `project-search`)
 */
function parseProjectIdentifier(project: string, id: string): ParsedIssueArg {
  const projectSlug = project.toLowerCase();

  // Numeric ID part → direct numeric lookup (project context not needed)
  if (isAllDigits(id)) {
    return { type: "numeric", id };
  }

  // ID part contains a dash → likely a full short ID like "PROJECT-SUFFIX".
  // Extract just the suffix from the last dash.
  if (id.includes("-")) {
    const suffix = id.slice(id.lastIndexOf("-") + 1).toUpperCase();
    if (suffix) {
      return { type: "project-search", projectSlug, suffix };
    }
  }

  // Plain suffix (no dash, or empty trailing suffix) → use as-is.
  return { type: "project-search", projectSlug, suffix: id.toUpperCase() };
}

/**
 * Parse issue arg containing a colon as a project:identifier separator.
 *
 * Handles formats like:
 * - `PROJECT:SUFFIX` → project-search with suffix
 * - `PROJECT:PROJECT-SUFFIX` → project-search, extracts suffix from last dash
 * - `PROJECT:NUMERICID` → numeric lookup (project context ignored)
 *
 * Returns null if the colon is not a valid separator (e.g., empty parts).
 */
function parseWithColon(arg: string): ParsedIssueArg | null {
  const colonIdx = arg.indexOf(":");
  const projectPart = arg.slice(0, colonIdx);
  const idPart = arg.slice(colonIdx + 1);

  // Both parts must be non-empty. Neither part should contain a slash —
  // slashes indicate org/project notation which should be handled by parseWithSlash.
  if (
    !(projectPart && idPart) ||
    projectPart.includes("/") ||
    idPart.includes("/")
  ) {
    return null;
  }

  return parseProjectIdentifier(projectPart, idPart);
}

/**
 * Parse a GitHub-style `#`-separated issue identifier (CLI-1G1).
 *
 * AI agents (claude-code, codex) frequently pass GitHub-style references where
 * `#` separates the project from the issue short ID. Supported forms:
 * - `org/project#SHORTID` → explicit (delegates to the slash path, reusing the
 *   full-short-ID prefix-match logic in {@link parseMultiSlashIssueArg})
 * - `project#SHORTID`     → project-search (project context, org auto-detected)
 * - `#SHORTID`            → bare identifier (numeric / project-search / suffix-only)
 *
 * IMPORTANT: this runs BEFORE parseIssueArg's main `validateResourceId` guard
 * (which rejects `#`), so it must validate BOTH the project prefix and the
 * fragment itself. `validateResourceId` permits `:`, so a `:` mixed with `#`
 * is rejected explicitly to avoid silently swallowing the colon into a suffix
 * (cf. the `sentry/CLI:W9` precedent).
 *
 * @param arg - Raw issue argument containing at least one `#`
 * @returns Parsed issue argument
 * @throws {ValidationError} If the fragment is empty, contains a second `#`, a
 *   `:`, or any forbidden character, or if the project prefix is invalid.
 */
function parseWithHash(arg: string): ParsedIssueArg {
  const firstHash = arg.indexOf("#");
  const prefix = arg.slice(0, firstHash);
  const fragment = arg.slice(firstHash + 1);

  if (fragment.includes("#") || fragment === "") {
    throw new ValidationError(
      `Invalid issue identifier: "${arg}".\n` +
        "  Use a single '#' separating the project from the short ID, e.g. `org/project#PROJ-123`.\n" +
        "  Or use a slash: `org/project/PROJ-123`.",
      "issue identifier"
    );
  }
  if (fragment.includes(":")) {
    throw new ValidationError(
      `Invalid issue identifier: "${arg}". Do not mix '#' and ':' separators.\n` +
        "  Use `org/project#PROJ-123` or `project:PROJ-123`.",
      "issue identifier"
    );
  }
  // Validate the fragment on its own — it must not contain forbidden characters
  // (?, %, whitespace, control chars). The main guard at the call site is
  // skipped for `#` inputs, so this validation happens here instead.
  validateResourceId(fragment, "issue identifier");

  // Bare `#SHORTID` → parse the fragment exactly like a standalone identifier.
  if (prefix === "") {
    return parseBareIssueIdentifier(fragment);
  }

  // `org/project#SHORTID` → equivalent to `org/project/SHORTID`. Validate the
  // org/project prefix components first — the `#` path skips the main
  // validateResourceId guard, and parseWithSlash doesn't re-validate.
  if (prefix.includes("/")) {
    validateResourceId(prefix.replace(/\//g, ""), "issue identifier");
    return parseWithSlash(`${prefix}/${fragment}`);
  }

  // `project#SHORTID` → project-scoped lookup. The `#` path skips the main
  // validateResourceId guard, so validate the project slug here.
  validateResourceId(prefix, "project slug");
  return parseProjectIdentifier(prefix, fragment);
}

/**
 * Parse issue arg with dash but no slash (project-suffix).
 */
function parseWithDash(arg: string): ParsedIssueArg {
  const lastDash = arg.lastIndexOf("-");
  const projectSlug = arg.slice(0, lastDash);
  const suffix = arg.slice(lastDash + 1).toUpperCase();

  if (!projectSlug) {
    throw new ValidationError(
      `Invalid issue format: "${arg}". Missing project before suffix.`,
      "issue"
    );
  }

  if (!suffix) {
    throw new ValidationError(
      `Invalid issue format: "${arg}". Missing suffix after dash.`,
      "issue"
    );
  }

  rejectIssueCommandTokenWithNumericSuffix(arg, projectSlug, suffix);

  // "cli-G" or "spotlight-electron-4Y"
  // Lowercase the project slug since Sentry slugs are always lowercase.
  // Users often type short IDs in uppercase (e.g., "EASI-API-3Y4") which
  // produces an uppercase project slug that would fail API lookups (CLI-C8).
  return {
    type: "project-search",
    projectSlug: projectSlug.toLowerCase(),
    suffix,
  };
}

/**
 * Parse a single positional arg that may be a plain hex ID or a slash-separated
 * `org/project/id` pattern.
 *
 * Used by commands whose IDs are hex strings that never contain `/`
 * (event, trace, log), making the pattern unambiguous:
 * - No slashes → plain ID, no target
 * - Exactly one slash → `org/project` without ID → throws {@link ContextError}
 * - Two or more slashes → splits on last `/` → `targetArg` + `id`
 *
 * @param arg - The raw single positional argument
 * @param idLabel - Human-readable ID label for error messages (e.g. `"Event ID"`)
 * @param usageHint - Usage example shown in error messages
 * @returns Parsed `{ id, targetArg }` — `targetArg` is `undefined` for plain IDs
 * @throws {ContextError} When the arg contains exactly one slash (missing ID)
 *   or ends with a trailing slash (empty ID segment)
 */
export function parseSlashSeparatedArg(
  arg: string,
  idLabel: string,
  usageHint: string
): { id: string; targetArg: string | undefined } {
  // Trim whitespace — agents may pass trailing newlines
  const trimmed = arg.trim();

  if (!trimmed) {
    throw new ContextError(idLabel, usageHint, []);
  }

  const slashIdx = trimmed.indexOf("/");

  if (slashIdx === -1) {
    // No slashes — plain ID. Skip validation here because callers may
    // do further processing (e.g., splitting newline-separated IDs).
    // Downstream validators like validateHexId or validateTraceId provide
    // format-specific validation.
    return { id: trimmed, targetArg: undefined };
  }

  // IDs are hex and never contain "/" — this must be a structured
  // "org/project/id" or "org/project" (missing ID)
  const lastSlashIdx = trimmed.lastIndexOf("/");

  if (slashIdx === lastSlashIdx) {
    // Exactly one slash: "org/project" without ID
    throw new ContextError(idLabel, usageHint, []);
  }

  // Two+ slashes: split on last "/" → target + id
  const targetArg = trimmed.slice(0, lastSlashIdx);
  const id = trimmed.slice(lastSlashIdx + 1);

  if (!id) {
    throw new ContextError(idLabel, usageHint, []);
  }

  // Validate the extracted ID against injection characters.
  // The targetArg flows through parseOrgProjectArg which has its own validation.
  validateResourceId(id, idLabel);

  return { id, targetArg };
}

export function parseIssueArg(arg: string): ParsedIssueArg {
  // Take the first non-blank line. A bare `.trim()` only strips leading and
  // trailing whitespace, so multi-line input (command substitution that
  // captured extra output, an identifier with an appended note, or several
  // newline-separated IDs) left an *internal* newline that reached
  // validateResourceId and threw a cryptic "contains a newline" error
  // (CLI-1G1, 116+ users). An issue identifier is always a single line, so the
  // first non-blank line is the intended value. Unlike `sentry api`, which
  // rejoins wrapped URLs (CLI-FR), identifiers are atomic tokens — joining
  // lines would produce garbage, so we keep only the first line.
  // Splitting on `\n` (a control char) never breaks project display names with
  // spaces (#1116), since those are rejected as control chars anyway.
  const input =
    arg
      .split(LINE_SPLIT_PATTERN)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  if (!input) {
    throw new ValidationError(
      "Issue identifier is empty after trimming whitespace.",
      "issue identifier"
    );
  }

  // 0. URL detection — extract issue ID from Sentry web URLs
  const urlParsed = parseSentryUrl(input);
  if (urlParsed) {
    applySentryUrlContext(urlParsed.baseUrl);
    const result = issueArgFromUrl(urlParsed);
    if (result) {
      return result;
    }
    // URL recognized but no issue ID (e.g., trace or project settings URL)
    throw new ValidationError(
      "This Sentry URL does not contain an issue ID. Use an issue URL like:\n" +
        "  https://sentry.io/organizations/{org}/issues/{id}/"
    );
  }

  // 1. Magic @ selectors — detect before any other parsing.
  // Supports bare `@latest` and org-prefixed `sentry/@latest`.
  if (input.includes("@")) {
    const slashIdx = input.indexOf("/");
    const selectorPart = slashIdx === -1 ? input : input.slice(slashIdx + 1);
    const selector = parseSelector(selectorPart);
    if (selector) {
      if (slashIdx !== -1) {
        const org = normalizeSlug(input.slice(0, slashIdx)).slug;
        validateResourceId(org, "organization slug");
        return { type: "selector", selector, org };
      }
      return { type: "selector", selector };
    }
    // Not a recognized selector — fall through to normal parsing.
    // The @ character will be caught by validateResourceId below.
  }

  // 1b. GitHub-style "#" separator (CLI-1G1): org/project#SHORTID, project#SHORTID,
  // or bare #SHORTID. AI agents frequently pass this form. Handle it before the
  // validateResourceId guard below rejects "#" as a forbidden URL fragment.
  if (input.includes("#")) {
    return parseWithHash(input);
  }

  // Validate raw input against injection characters before parsing.
  // Slashes are allowed (they're structural separators), but ?, #, %, whitespace,
  // and control characters are never valid in issue identifiers.
  validateResourceId(input.replace(/\//g, ""), "issue identifier");

  return parseBareIssueIdentifier(input);
}

/**
 * Parse a bare issue identifier (no Sentry URL, `@` selector, or `#` fragment)
 * into its component parts. This is steps 2–5 of {@link parseIssueArg}.
 *
 * Callers MUST validate the input against injection characters before calling
 * this function — it performs no validation of its own.
 *
 * Flow:
 * - Pure numeric → `numeric`
 * - Colon separator → `parseWithColon` (project:identifier)
 * - Slash → `parseWithSlash` (org/...)
 * - Dash → `parseWithDash` (project-suffix)
 * - Otherwise → `suffix-only`
 *
 * @param input - Trimmed, validated issue identifier
 * @returns Parsed issue argument with type discrimination
 */
function parseBareIssueIdentifier(input: string): ParsedIssueArg {
  // 2. Pure numeric → direct fetch by ID
  if (isAllDigits(input)) {
    return { type: "numeric", id: input };
  }

  // 2b. Colon separator — treat as project:identifier notation.
  // Users sometimes type "PROJECT:SHORTID" or "PROJECT:NUMERICID" where
  // the colon separates the project slug from the issue identifier.
  // e.g., "CHATEX:CHATEX-W9" → project=chatex, suffix=W9
  //       "MYAH-FRONTEND:115562020" → numeric ID 115562020
  //       "CHATEX:W9" → project=chatex, suffix=W9
  if (input.includes(":")) {
    const colonResult = parseWithColon(input);
    if (colonResult) {
      return colonResult;
    }
    // Colon not parseable as project:id — fall through to normal parsing
  }

  // 3. Has slash → check slash FIRST (takes precedence over dashes)
  // This ensures "my-org/123" parses as org="my-org", not project="my"
  if (input.includes("/")) {
    return parseWithSlash(input);
  }

  // 4. Has dash but no slash → split on last "-" for project-suffix
  if (input.includes("-")) {
    return parseWithDash(input);
  }

  // 5. No dash, no slash → suffix only (needs DSN context)
  return { type: "suffix-only", suffix: input.toUpperCase() };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Prepend `project:{slug}` to a query string when a project filter is specified.
 * Returns the original query unchanged when no project is given.
 *
 * Used by trace-scoped commands (`trace logs`, `log list` trace mode) to apply
 * the project from `org/project/trace-id` positional syntax as an API filter.
 */
export function buildProjectQuery(
  query: string | undefined,
  projectFilter: string | undefined
): string | undefined {
  if (!projectFilter) {
    return query;
  }
  const pf = `project:${projectFilter}`;
  return query ? `${pf} ${query}` : pf;
}

/**
 * Split a single argument on whitespace into individual entries.
 *
 * Agents sometimes paste multiple IDs as a single whitespace-separated
 * argument (newlines or spaces). This utility splits on any whitespace,
 * trims each token, and discards empty ones.
 *
 * @param arg - Raw argument string, possibly containing whitespace-separated IDs
 * @returns Non-empty trimmed tokens
 */
export function splitNewlineArg(arg: string): string[] {
  return arg
    .split(WHITESPACE_SPLIT_PATTERN)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
