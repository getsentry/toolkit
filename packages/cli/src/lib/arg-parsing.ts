/**
 * Shared Argument Parsing Utilities
 *
 * Common parsing logic for CLI positional arguments that follow the
 * `<org>/<target>` pattern. Used by both listing commands (issue list,
 * project list) and single-item commands (issue view, explain, plan).
 */

import { parse as parseTarget } from "../generated/org-project-target-grammar.js";
import type { LogSortDirection } from "./api/logs.js";
import { ContextError, ValidationError, validationError } from "./errors.js";
import { validateResourceId } from "./input-validation.js";
import { isGlobFilter } from "./list-filter.js";

import type { ParsedSentryUrl } from "./sentry-url-parser.js";
import { applySentryUrlContext, parseSentryUrl } from "./sentry-url-parser.js";

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
 * Spaces are handled separately: the target grammar
 * (`grammar/org-project-target.pegjs`) routes them to a display-name search
 * that skips slug validation.
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
 * Project slugs from an explicit `org/project` parse.
 *
 * A single slug stays on {@link ParsedOrgProject}'s `project` field. A
 * comma-separated list also sets `projects` (including the first slug).
 *
 * @param parsed - Explicit project target returned by {@link parseOrgProjectArg}
 * @returns A non-empty list containing the selected project slugs
 */
export function explicitProjectSlugs(
  parsed: Extract<ParsedOrgProject, { type: "explicit" }>,
): [string, ...string[]] {
  return parsed.projects ?? [parsed.project];
}

/**
 * Format an explicit target back into its positional form.
 *
 * Used for titles, pagination hints, and cursor context keys so every
 * surface renders `org/web,api` (or `org/` for org-wide) identically.
 *
 * @param org - Organization slug
 * @param projects - Project slugs; omit or pass an empty list for `org/`
 * @returns `org/a,b` for a project list, or `org/` without projects
 */
export function formatProjectTarget(
  org: string,
  projects?: readonly string[],
): string {
  return projects && projects.length > 0
    ? `${org}/${projects.join(",")}`
    : `${org}/`;
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

/**
 * Return the first non-blank line of `arg`, trimmed, or `""` if every line is
 * blank.
 *
 * A bare `.trim()` only strips leading/trailing whitespace, so multi-line input
 * (command substitution that captured extra output, a value with an appended
 * note, or several newline-separated values — common from AI agents) keeps an
 * internal newline that later fails `validateResourceId` with a cryptic
 * "contains a newline" error (CLI-1G1, CLI-1RA). Slugs and identifiers are
 * always single-line tokens, so the first non-blank line is the intended value.
 */
export function firstNonBlankLine(arg: string): string {
  return (
    arg
      .split(LINE_SPLIT_PATTERN)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

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
  opts?: { ignoreCase?: boolean },
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
export function rejectIssueCommandTokenWithNumericSuffix(
  arg: string,
  projectSlug: string,
  suffix: string,
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
    "issue",
  );
}

/**
 * Reject org/project list targets that look like `issue-1` command tokens.
 *
 * `parseOrgProjectArg` treats bare `issue-1` as a single project slug; this
 * applies the same guard as `parseIssueArgument` for bare and `org/issue-1`
 * forms.
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
  second: string,
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
  isKnownName: (value: string) => boolean,
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
      "limit",
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
      "sort",
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
      /**
       * All project slugs when the user passed a comma-separated list
       * (`org/web,api`). Includes {@link project} as the first element and
       * always holds at least two slugs. Absent for a single slug so existing
       * equality checks stay stable.
       */
      projects?: [string, string, ...string[]];
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
 * A list target that filters names (`<org>/web-*`, `web-*`), from the
 * target grammar when {@link parseListTargetInput} passes its
 * `isNameFilter` hook.
 */
export type ParsedNameFilter = {
  type: "name-filter";
  /** The glob, trimmed */
  filter: string;
  /** Organization slug, when the target had one */
  org?: string;
};

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
 * Reject `@`-prefixed values in org/project positions.
 *
 * `@latest` and `@most_frequent` are issue selectors supported by
 * `parseIssueArgument()` (for `issue view`, `explain`, `plan`). They are not
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
      label,
    );
  }

  throw new ValidationError(
    `Invalid ${label}: '${value}' starts with '@'.\n` +
      "  Slugs contain only letters, numbers, hyphens, and underscores.",
    label,
  );
}

/**
 * Parse an org/project positional argument string.
 *
 * Empty input auto-detects and Sentry web URLs are read here; every other
 * form is defined by `grammar/org-project-target.pegjs`, which also
 * documents them.
 *
 * @param arg - Input string from CLI positional argument
 * @param options.multi - Parse comma-separated project slugs after
 *   the org. Only commands that can query multiple projects together should
 *   enable it.
 * @returns Parsed result with type discrimination
 *
 * @example
 * parseOrgProjectArg(undefined)     // { type: "auto-detect" }
 * parseOrgProjectArg("sentry/cli")  // { type: "explicit", org: "sentry", project: "cli" }
 * parseOrgProjectArg("sentry/web,api", { multi: true })
 * // { type: "explicit", ..., projects: ["web","api"] }
 * parseOrgProjectArg("sentry/")     // { type: "org-all", org: "sentry" }
 * parseOrgProjectArg("/cli")        // { type: "project-search", projectSlug: "cli" }
 * parseOrgProjectArg("cli")         // { type: "project-search", projectSlug: "cli" }
 */
export function parseOrgProjectArg(
  arg: string | undefined,
  options: { multi?: boolean } = {},
): ParsedOrgProject {
  const { parsed, baseUrl } = parseOrgProjectInput(arg, options);
  if (baseUrl) {
    applySentryUrlContext(baseUrl);
  }
  return parsed;
}

/** A parsed org/project argument and the server of a pasted Sentry URL. */
export type OrgProjectInput = {
  readonly parsed: ParsedOrgProject;
  /** Base URL of a pasted Sentry web URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
};

/**
 * Parse an org/project argument like {@link parseOrgProjectArg}, without
 * side effects: the server of a pasted Sentry URL is returned as `baseUrl`
 * instead of applied, so the caller applies it with `applySentryUrlContext`
 * when it is safe to.
 */
export function parseOrgProjectInput(
  arg: string | undefined,
  options: { multi?: boolean } = {},
): OrgProjectInput {
  return parseTargetInput(arg, (text) =>
    parseTarget(text, targetHooks(options)),
  );
}

/** A parsed list target: what to list, and the name filter, if any. */
export type ListTarget = {
  readonly parsed: ParsedOrgProject;
  /** Name filter (a glob) from `[<org>/]<glob>` */
  readonly filter?: string;
};

/** Which target forms a list command accepts beyond `[<org>/][<project>]`. */
export type ListTargetOptions = {
  /** Read a glob as a name filter (`<org>/web-*`) */
  readonly names?: boolean;
  /** Accept comma-separated projects (`<org>/web,api`) */
  readonly multi?: boolean;
};

/** A parsed list target and the server of a pasted Sentry URL. */
export type ListTargetInput = {
  readonly target: ListTarget;
  /** Base URL of a pasted Sentry web URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
};

/**
 * Parse the target of a list command, without side effects: the server of a
 * pasted Sentry URL is returned as `baseUrl` instead of applied (see
 * {@link parseOrgProjectInput}).
 *
 * With `names`, a glob is a filter rather than a project (no slug contains
 * glob characters; the grammar decides): `<org>/web-*` lists that
 * organization's matches, and `web-*` or `/web-*` the auto-detected ones.
 * Every other form parses like {@link parseOrgProjectInput}.
 *
 * @example
 * parseListTargetInput("acme/web-*", { names: true }).target
 * // { parsed: { type: "org-all", org: "acme" }, filter: "web-*" }
 * parseListTargetInput("web-*", { names: true }).target
 * // { parsed: { type: "auto-detect" }, filter: "web-*" }
 * parseListTargetInput("acme/web").target
 * // { parsed: { type: "explicit", org: "acme", project: "web" } }
 */
export function parseListTargetInput(
  arg: string | undefined,
  options: ListTargetOptions = {},
): ListTargetInput {
  const hooks = targetHooks(options);
  const { parsed, baseUrl } = parseTargetInput(arg, (text) =>
    options.names
      ? parseTarget(text, { ...hooks, isNameFilter: isGlobFilter })
      : parseTarget(text, hooks),
  );
  if (parsed.type !== "name-filter") {
    return { target: { parsed }, baseUrl };
  }
  return {
    target: {
      parsed:
        parsed.org === undefined
          ? { type: "auto-detect" }
          : { type: "org-all", org: parsed.org },
      filter: parsed.filter,
    },
    baseUrl,
  };
}

/** The grammar options shared by every target parse. */
function targetHooks(options: { multi?: boolean }) {
  return {
    multi: options.multi === true,
    checkSlug: validateResourceId,
    rejectAt: rejectAtSelector,
    invalid: (message: string, field?: string): never => {
      throw new ValidationError(message, field);
    },
  };
}

/**
 * Handle the target forms the grammar never sees (omitted, URL), and hand
 * the rest to `parse`.
 */
function parseTargetInput<T>(
  arg: string | undefined,
  parse: (text: string) => T,
): { readonly parsed: T | ParsedOrgProject; readonly baseUrl?: string } {
  // Keep only the first non-blank line: agents often pass targets with
  // appended output or notes after a newline (CLI-1RA).
  const trimmed = arg ? firstNonBlankLine(arg) : "";
  if (!trimmed) {
    return { parsed: { type: "auto-detect" } };
  }

  // URL detection — extract org/project from Sentry web URLs
  const urlParsed = parseSentryUrl(trimmed);
  if (urlParsed) {
    return {
      parsed: orgProjectFromUrl(urlParsed),
      baseUrl: urlParsed.baseUrl,
    };
  }

  return { parsed: parse(trimmed) };
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
  usageHint: string,
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
  projectFilter: string | undefined,
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
