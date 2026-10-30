/**
 * The syntax of an issue identifier: the issue ID, short ID, selector, or
 * URL in one argument of `issue view`, `issue explain`, and every other
 * issue command.
 *
 * Issue identifiers carry their own org and project (`<org>/<project>-<suffix>`,
 * `<project>:<id>`, an issue URL), so `ID_KINDS.issue` (`id-arguments.ts`)
 * takes them as whole tokens, and this module takes them apart: which part
 * is the org, the project, and the issue is decided by
 * `grammar/issue-argument.pegjs`, which also lists the forms. This module
 * validates the parts the grammar found and normalizes them into a
 * {@link ParsedIssueArg}.
 */

import {
  type IssueSyntax,
  type IssueSyntaxError,
  parse,
} from "../generated/issue-argument-grammar.js";
import {
  type IssueSelector,
  normalizeSlug,
  parseSelector,
  rejectIssueCommandTokenWithNumericSuffix,
} from "./arg-parsing.js";
import { ValidationError } from "./errors.js";
import { validateResourceId } from "./input-validation.js";
import { type ParsedSentryUrl, parseSentryUrl } from "./sentry-url-parser.js";
import { isAllDigits } from "./utils.js";

export type ParsedIssueArg =
  | { type: "numeric"; id: string }
  | { type: "explicit"; org: string; project: string; suffix: string }
  | { type: "explicit-org-suffix"; org: string; suffix: string }
  | { type: "explicit-org-numeric"; org: string; numericId: string }
  | { type: "project-search"; projectSlug: string; suffix: string }
  | { type: "suffix-only"; suffix: string }
  | { type: "selector"; selector: IssueSelector; org?: string }
  | { type: "share"; shareId: string; org?: string; baseUrl: string }
  /** Not an identifier: text to search issues for */
  | { type: "search"; query: string };

/** An issue identifier, taken apart. */
export type IssueIdentifier = {
  readonly parsed: Exclude<ParsedIssueArg, { type: "search" }>;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
};

/**
 * Take an issue identifier apart, without side effects: the server of a
 * pasted Sentry URL is returned as `baseUrl` instead of applied.
 *
 * @param input - One line, trimmed and not empty
 * @throws {ValidationError} When the identifier is malformed, or a Sentry
 *   URL has no issue in it
 *
 * @example
 * parseIssueIdentifier("123456789").parsed     // { type: "numeric", id: "123456789" }
 * parseIssueIdentifier("sentry/cli-G").parsed  // { type: "explicit", org: "sentry", project: "cli", suffix: "G" }
 * parseIssueIdentifier("cli-G").parsed         // { type: "project-search", projectSlug: "cli", suffix: "G" }
 * parseIssueIdentifier("sentry/G").parsed      // { type: "explicit-org-suffix", org: "sentry", suffix: "G" }
 * parseIssueIdentifier("G").parsed             // { type: "suffix-only", suffix: "G" }
 * parseIssueIdentifier("sentry/cli#CLI-G").parsed // { type: "explicit", org: "sentry", project: "cli", suffix: "G" }
 * parseIssueIdentifier("#CLI-G").parsed        // { type: "project-search", projectSlug: "cli", suffix: "G" }
 */
export function parseIssueIdentifier(input: string): IssueIdentifier {
  const url = parseSentryUrl(input);
  if (url) {
    const parsed = issueArgFromUrl(url);
    if (!parsed) {
      // A Sentry URL without an issue (a trace or settings URL)
      throw new ValidationError(
        "This Sentry URL does not contain an issue ID. Use an issue URL like:\n" +
          "  https://sentry.io/organizations/{org}/issues/{id}/",
      );
    }
    return { parsed, baseUrl: url.baseUrl };
  }

  const syntax = parse(input, {
    isSelector: (value) => parseSelector(value) !== undefined,
  });
  if (syntax.form === "selector") {
    return { parsed: selectorArg(syntax) };
  }
  if (syntax.form === "hash") {
    return { parsed: hashArg(input, syntax) };
  }
  // Slashes separate the parts; `?`, `#`, `%`, whitespace, and control
  // characters are never valid in an issue identifier
  validateResourceId(input.replace(/\//g, ""), "issue identifier");
  return { parsed: issueArgFromSyntax(input, syntax) };
}

/** Whether {@link parseIssueIdentifier} takes `input` apart. */
export function isIssueIdentifier(input: string): boolean {
  try {
    parseIssueIdentifier(input);
    return true;
  } catch (error) {
    if (error instanceof ValidationError) {
      return false;
    }
    throw error;
  }
}

/** What an identifier names: anything but a search. */
type IdentifierArg = IssueIdentifier["parsed"];

/**
 * The issue in a Sentry URL: a share link, a numeric group ID, or a short ID
 * (`CLI-G`) from the path; `null` when the URL names no issue.
 */
function issueArgFromUrl(url: ParsedSentryUrl): IdentifierArg | null {
  if (url.shareId) {
    return {
      type: "share",
      shareId: url.shareId,
      org: url.org,
      baseUrl: url.baseUrl,
    };
  }
  // Every non-share issue URL has an org
  const { issueId, org } = url;
  if (!(issueId && org)) {
    return null;
  }
  if (isAllDigits(issueId)) {
    return { type: "explicit-org-numeric", org, numericId: issueId };
  }
  const dash = issueId.lastIndexOf("-");
  const project = issueId.slice(0, dash);
  const suffix = issueId.slice(dash + 1).toUpperCase();
  if (dash > 0 && suffix) {
    return { type: "explicit", org, project: project.toLowerCase(), suffix };
  }
  return { type: "explicit-org-suffix", org, suffix: issueId.toUpperCase() };
}

function selectorArg(
  syntax: Extract<IssueSyntax, { form: "selector" }>,
): IdentifierArg {
  // The grammar only matches recognized selectors
  const selector = parseSelector(syntax.selector) as IssueSelector;
  if (syntax.org === undefined) {
    return { type: "selector", selector };
  }
  const org = normalizeSlug(syntax.org).slug;
  validateResourceId(org, "organization slug");
  return { type: "selector", selector, org };
}

/**
 * A GitHub-style `#` reference, which AI agents often pass (CLI-1G1):
 * `org/project#SHORTID` (like `org/project/SHORTID`), `project#SHORTID`, or
 * `#SHORTID`.
 *
 * It skips the check of the whole argument, which rejects `#`, so it checks
 * both parts itself. `validateResourceId` permits `:`, so a `:` next to a
 * `#` is rejected here rather than swallowed into the suffix.
 *
 * @throws {ValidationError} When the fragment is empty or has a second `#`,
 *   a `:`, or a forbidden character, or the prefix is invalid
 */
function hashArg(
  input: string,
  syntax: Extract<IssueSyntax, { form: "hash" }>,
): IdentifierArg {
  const { prefix, fragment } = syntax;
  if (fragment.includes("#") || fragment === "") {
    throw new ValidationError(
      `Invalid issue identifier: "${input}".\n` +
        "  Use a single '#' separating the project from the short ID, e.g. `org/project#PROJ-123`.\n" +
        "  Or use a slash: `org/project/PROJ-123`.",
      "issue identifier",
    );
  }
  if (fragment.includes(":")) {
    throw new ValidationError(
      `Invalid issue identifier: "${input}". Do not mix '#' and ':' separators.\n` +
        "  Use `org/project#PROJ-123` or `project:PROJ-123`.",
      "issue identifier",
    );
  }
  validateResourceId(fragment, "issue identifier");

  if (prefix === "") {
    return issueArgFromSyntax(fragment, reparse(fragment));
  }
  if (prefix.includes("/")) {
    validateResourceId(prefix.replace(/\//g, ""), "issue identifier");
    const path = `${prefix}/${fragment}`;
    return issueArgFromSyntax(path, reparse(path));
  }
  validateResourceId(prefix, "project slug");
  return projectIdentifier(prefix, fragment);
}

/** Parse a part of a `#` reference, which has neither `#` nor a selector. */
function reparse(input: string): IssueSyntax {
  return parse(input, { isSelector: () => false });
}

/** The messages of malformed issue arguments. */
const SYNTAX_ERRORS: Record<IssueSyntaxError, string> = {
  "missing-id": "Missing issue ID after slash.",
  "missing-project-or-id": "Missing project or issue ID segment.",
  "slash-before-suffix": "Cannot use trailing slash before suffix.",
  "missing-project": "Missing project before suffix.",
  "missing-suffix": "Missing suffix after dash.",
};

/**
 * Normalize the parts of an argument: Sentry slugs are lowercase, so a short
 * ID typed in uppercase (`EASI-API-3Y4`) still finds its project (CLI-C8),
 * and suffixes are uppercase.
 *
 * @throws {ValidationError} When the argument is malformed, or names an
 *   issue command and a number (`issue-1`)
 */
function issueArgFromSyntax(input: string, syntax: IssueSyntax): IdentifierArg {
  switch (syntax.form) {
    case "numeric":
      return { type: "numeric", id: syntax.id };
    case "project-id":
      return projectIdentifier(syntax.project, syntax.id);
    case "short-id": {
      const suffix = syntax.suffix.toUpperCase();
      rejectIssueCommandTokenWithNumericSuffix(input, syntax.project, suffix);
      return {
        type: "project-search",
        projectSlug: syntax.project.toLowerCase(),
        suffix,
      };
    }
    case "suffix":
      return { type: "suffix-only", suffix: syntax.suffix.toUpperCase() };
    case "org-numeric":
      return {
        type: "explicit-org-numeric",
        org: syntax.org,
        numericId: syntax.id,
      };
    case "org-project-id":
      return orgProjectIdentifier(syntax.org, syntax.project, syntax.id);
    case "org-short-id": {
      const suffix = syntax.suffix.toUpperCase();
      rejectIssueCommandTokenWithNumericSuffix(input, syntax.project, suffix);
      return {
        type: "explicit",
        org: syntax.org,
        project: syntax.project.toLowerCase(),
        suffix,
      };
    }
    case "org-suffix":
      return {
        type: "explicit-org-suffix",
        org: syntax.org,
        suffix: syntax.suffix.toUpperCase(),
      };
    case "invalid":
      throw new ValidationError(
        `Invalid issue format: "${input}". ${SYNTAX_ERRORS[syntax.reason]}`,
        "issue",
      );
    default:
      // A selector or `#` reference only comes from the whole argument
      throw new ValidationError(
        `Invalid issue identifier: "${input}".`,
        "issue identifier",
      );
  }
}

/**
 * `<project>:<id>` or `<project>#<id>`. A numeric ID needs no project; a
 * full short ID (`PROJECT-SUFFIX`) gives its suffix; anything else is the
 * suffix.
 */
function projectIdentifier(project: string, id: string): IdentifierArg {
  if (isAllDigits(id)) {
    return { type: "numeric", id };
  }
  const projectSlug = project.toLowerCase();
  const suffix = id.slice(id.lastIndexOf("-") + 1).toUpperCase();
  return {
    type: "project-search",
    projectSlug,
    suffix: suffix || id.toUpperCase(),
  };
}

/**
 * `<org>/<project>/<id>`: a full short ID whose prefix is the project
 * (`sentry/cli/CLI-A1`) gives its suffix; anything else is the suffix
 * (`org/project/SUBPROJ-G` → `SUBPROJ-G`).
 */
function orgProjectIdentifier(
  org: string,
  project: string,
  id: string,
): IdentifierArg {
  const projectSlug = project.toLowerCase();
  const dash = id.lastIndexOf("-");
  const prefix = id.slice(0, dash);
  const suffix = id.slice(dash + 1).toUpperCase();
  if (dash !== -1 && prefix && suffix) {
    return {
      type: "explicit",
      org,
      project: projectSlug,
      suffix:
        prefix.toLowerCase() === projectSlug
          ? suffix
          : `${prefix}-${suffix}`.toUpperCase(),
    };
  }
  return {
    type: "explicit",
    org,
    project: projectSlug,
    suffix: id.toUpperCase(),
  };
}
