/**
 * What shell completion suggests for each argument, read from its parser.
 *
 * A positional or flag completes a kind when its `parse` function is tagged
 * with {@link withCompletionTarget}, or is one of the shared value parsers
 * in {@link PARSER_TARGETS}. `script/generate-completion-targets.ts`
 * collects the kind of every argument at build time, because the
 * `__complete` fast path cannot boot Stricli to walk the route tree, and
 * `src/lib/complete.ts` maps each kind to its completer; the kinds are the
 * keys of that map.
 *
 * Commands get the tag from the bound parsers in `target-positional.ts`
 * and `positional-parse.ts`, which parse the value too, or, for arguments
 * that are not Sentry targets, from the pre-tagged parsers here
 * ({@link parseFilePath}, {@link parseText}, {@link choiceParser}, …).
 * A command's own validating parser keeps its checks when wrapped:
 * `choiceParser(VALUES, parseSort)`, `textParser(parsePort)`.
 */

import { ISSUE_IS_VALUES } from "@sentry/toolkit-core/search-query";
import { numberParser } from "@stricli/core";
import { getAllEndpoints } from "./api-schema.js";
import type { CompletionTarget } from "./complete.js";
import { ISSUE_LEVELS } from "../types/sentry.js";
import {
  CURSOR_NAVIGATION,
  parseCursorFlag,
  parseLogSort,
  parseSpanDepth,
  SPAN_DEPTH_KEYWORDS,
  VALID_LOG_SORT_DIRECTIONS,
} from "./arg-parsing.js";
import { INSTALLATION_METHODS, parseInstallationMethod } from "./binary.js";
import { parseLoginEmail } from "./db/accounts.js";
import { parseReleaseChannel, RELEASE_CHANNELS } from "./db/release-channel.js";
import { sanitizeIssueQuery, sanitizeQuery } from "./search-query.js";
import { parsePeriod, UNIT_SECONDS } from "./time-range.js";

/** What shell completion suggests for an argument: a key of the completer map. */
export type { CompletionTarget };

// Names for the kinds, each checked against the keys of `COMPLETERS` in
// `complete.ts`, which documents what each one completes.

/** Organization slugs. */
export const ORG_TARGET = "org" satisfies CompletionTarget;

/** `org/` prefixes, `org/project` pairs, and project aliases. */
export const ORG_PROJECT_TARGET = "org/project" satisfies CompletionTarget;

/** {@link ORG_PROJECT_TARGET} plus cached issue short IDs. */
export const ISSUE_TARGET = "issue" satisfies CompletionTarget;

/** `org/` prefixes and cached dashboards, in the first positional. */
export const DASHBOARD_TARGET = "dashboard" satisfies CompletionTarget;

/** The term at the end of an issue search query. */
export const ISSUE_QUERY_TARGET = "issue-query" satisfies CompletionTarget;

/** Relative `--period` values. */
export const PERIOD_TARGET = "period" satisfies CompletionTarget;

/** `project create` `name:platform` specs. */
export const PROJECT_SPEC_TARGET = "project-spec" satisfies CompletionTarget;

/** Stored accounts. */
export const ACCOUNT_TARGET = "account" satisfies CompletionTarget;

/** File and directory paths. */
export const FILE_TARGET = "file" satisfies CompletionTarget;

/** Directory paths only. */
export const DIRECTORY_TARGET = "directory" satisfies CompletionTarget;

/** `sentry init`'s `[<target>] [<directory>]`. */
export const ORG_PROJECT_OR_DIRECTORY_TARGET =
  "org-project-or-directory" satisfies CompletionTarget;

/** A CLI command path, one route segment per word. */
export const COMMAND_PATH_TARGET = "command-path" satisfies CompletionTarget;

/** The values its parser was made with by {@link choiceParser}. */
export const CHOICE_TARGET = "choice" satisfies CompletionTarget;

/** Comma-separated values its parser was made with by {@link choiceListParser}. */
export const CHOICE_LIST_TARGET = "choice-list" satisfies CompletionTarget;

/** Platform identifiers (`javascript-react`, `python-django`, …). */
export const PLATFORM_TARGET = "platform" satisfies CompletionTarget;

/** Free text with nothing to suggest. */
export const TEXT_TARGET = "text" satisfies CompletionTarget;

/** Cached environment names. */
export const ENVIRONMENT_TARGET = "environment" satisfies CompletionTarget;

/** Comma-separated cached environment names. */
export const ENVIRONMENT_LIST_TARGET =
  "environment-list" satisfies CompletionTarget;

/** Cached release versions. */
export const RELEASE_TARGET = "release" satisfies CompletionTarget;

/** Cached team slugs. */
export const TEAM_TARGET = "team" satisfies CompletionTarget;

/** Cached teams as `team:<id>` owner actors. */
export const OWNER_TARGET = "owner" satisfies CompletionTarget;

/** Cached project slugs. */
export const PROJECT_TARGET = "project" satisfies CompletionTarget;

/** Comma-separated project slugs. */
export const PROJECT_LIST_TARGET = "project-list" satisfies CompletionTarget;

/** Comma-separated cached alert (workflow) IDs. */
export const WORKFLOW_LIST_TARGET = "workflow-list" satisfies CompletionTarget;

/** `monitor run`'s cached monitor slug, then the command to run. */
export const MONITOR_COMMAND_TARGET =
  "monitor-command" satisfies CompletionTarget;

/** Cached native integration IDs. */
export const INTEGRATION_TARGET = "integration" satisfies CompletionTarget;

/** Cached installed Sentry App slugs. */
export const SENTRY_APP_TARGET = "sentry-app" satisfies CompletionTarget;

/** Cached Sentry App issue-link form fields, as `name=value`. */
export const APP_LINK_FIELD_TARGET =
  "app-link-field" satisfies CompletionTarget;

/** Cached public DSNs. */
export const DSN_TARGET = "dsn" satisfies CompletionTarget;

/** Cached tag keys of issues. */
export const TAG_KEY_TARGET = "tag-key" satisfies CompletionTarget;

/** Servers of stored accounts. */
export const ACCOUNT_SERVER_TARGET =
  "account-server" satisfies CompletionTarget;

/** `issue archive --until` conditions. */
export const ARCHIVE_UNTIL_TARGET = "archive-until" satisfies CompletionTarget;

/** API paths relative to `/api/0/`, from the API schema. */
export const API_ENDPOINT_TARGET = "api-endpoint" satisfies CompletionTarget;

/** Refs git resolves locally (`main`, `v1.0.0`, `origin/main`). */
export const GIT_REF_TARGET = "git-ref" satisfies CompletionTarget;

/** Branch and tag names as the git remote knows them. */
export const VCS_REF_TARGET = "vcs-ref" satisfies CompletionTarget;

/** Full SHAs of recent commits. */
export const GIT_COMMIT_TARGET = "git-commit" satisfies CompletionTarget;

/** `owner/repo` names of the git remotes. */
export const GIT_REPO_TARGET = "git-repo" satisfies CompletionTarget;

/** Comma-separated `REPO@SHA` / `REPO@PREV..SHA` commits. */
export const REPO_COMMIT_LIST_TARGET =
  "repo-commit-list" satisfies CompletionTarget;

const COMPLETION_TARGET_KEY = Symbol("completionTarget");

const COMPLETION_CHOICES_KEY = Symbol("completionChoices");

/**
 * Tag a positional or flag parser with the completion kind it accepts.
 *
 * @returns `parse` itself, so the tag travels with the function
 */
export function withCompletionTarget<P extends (input: string) => unknown>(
  kind: CompletionTarget,
  parse: P,
): P {
  Object.defineProperty(parse, COMPLETION_TARGET_KEY, { value: kind });
  return parse;
}

/**
 * A new parser that calls `parse`, tagged with `kind` and the `values` it
 * completes. A new function, so tagging never touches a shared parser.
 */
function taggedParser<T>(
  kind: CompletionTarget,
  parse: (input: string) => T,
  values?: readonly string[],
): (input: string) => T {
  const tagged = withCompletionTarget(kind, (input: string) => parse(input));
  if (values) {
    Object.defineProperty(tagged, COMPLETION_CHOICES_KEY, {
      value: [...values],
    });
  }
  return tagged;
}

/** A parser that returns its input unchanged, tagged with `kind`. */
function identityParser(kind: CompletionTarget): (input: string) => string {
  return taggedParser(kind, (input) => input);
}

/** Parses a file or directory path; completes paths. */
export const parseFilePath = identityParser(FILE_TARGET);

/** Parses a directory path; completes directories. */
export const parseDirectoryPath = identityParser(DIRECTORY_TARGET);

/** Parses free text; completes nothing. */
export const parseText = identityParser(TEXT_TARGET);

/**
 * Parses a URL; completes nothing. The command validates it, so each one
 * keeps its own error for a URL it cannot use.
 */
export const parseUrl = identityParser(TEXT_TARGET);

/** Parses one segment of a CLI command path; completes route names. */
export const parseCommandPath = identityParser(COMMAND_PATH_TARGET);

/** Parses a stored-account selector; completes stored accounts. */
export const parseAccountSelector = identityParser(ACCOUNT_TARGET);

/** Parses a platform identifier; completes platforms. */
export const parsePlatform = identityParser(PLATFORM_TARGET);

// Parsers of values that name something the user does not make up. Each
// returns its input unchanged: the command (or the API) validates it.

/** Parses an organization slug; completes cached organizations. */
export const parseOrgSlug = identityParser(ORG_TARGET);

/** Parses an issue reference the command resolves; completes issues. */
export const parseIssueReference = identityParser(ISSUE_TARGET);

/** Parses a relative period the API validates; completes periods. */
export const parseRelativePeriod = identityParser(PERIOD_TARGET);

/** Parses an environment name; completes cached environments. */
export const parseEnvironment = identityParser(ENVIRONMENT_TARGET);

/** Parses comma-separated environment names; completes cached ones. */
export const parseEnvironmentList = identityParser(ENVIRONMENT_LIST_TARGET);

/** Parses a release version; completes cached releases. */
export const parseRelease = identityParser(RELEASE_TARGET);

/** Parses a team slug; completes cached teams. */
export const parseTeam = identityParser(TEAM_TARGET);

/** Parses an owner actor (`team:<id>`, `user:<id>`); completes cached teams. */
export const parseOwner = identityParser(OWNER_TARGET);

/** Parses a project slug; completes cached projects. */
export const parseProjectSlug = identityParser(PROJECT_TARGET);

/** Parses comma-separated project slugs; completes cached projects. */
export const parseProjectList = identityParser(PROJECT_LIST_TARGET);

/** Parses comma-separated alert (workflow) IDs; completes cached ones. */
export const parseWorkflowList = identityParser(WORKFLOW_LIST_TARGET);

/** Parses `monitor run`'s words; completes a cached monitor slug first. */
export const parseMonitorCommand = identityParser(MONITOR_COMMAND_TARGET);

/** Parses a native integration ID; completes cached integrations. */
export const parseIntegration = identityParser(INTEGRATION_TARGET);

/** Parses an installed Sentry App slug; completes cached installations. */
export const parseSentryApp = identityParser(SENTRY_APP_TARGET);

/** Parses a Sentry App link form `name=value`; completes cached fields. */
export const parseAppLinkField = identityParser(APP_LINK_FIELD_TARGET);

/** Parses a DSN; completes cached client-key DSNs. */
export const parseDsn = identityParser(DSN_TARGET);

/** Parses an issue tag key; completes cached tag keys. */
export const parseTagKey = identityParser(TAG_KEY_TARGET);

/** Parses an `issue archive --until` condition; completes its grammar. */
export const parseArchiveUntil = identityParser(ARCHIVE_UNTIL_TARGET);

/** Parses an `api` endpoint; completes API schema paths. */
export const parseApiEndpoint = identityParser(API_ENDPOINT_TARGET);

/** Parses a local git ref; completes branches, tags, and remote branches. */
export const parseGitRef = identityParser(GIT_REF_TARGET);

/** Parses a branch or tag name sent to Sentry; completes them from git. */
export const parseVcsRef = identityParser(VCS_REF_TARGET);

/** Parses a commit SHA; completes recent commits. */
export const parseGitCommit = identityParser(GIT_COMMIT_TARGET);

/** Parses an `owner/repo` name; completes those of the git remotes. */
export const parseGitRepo = identityParser(GIT_REPO_TARGET);

/** Parses `REPO@SHA` commits; completes remotes, then recent commits. */
export const parseRepoCommitList = identityParser(REPO_COMMIT_LIST_TARGET);

/**
 * Wrap a command's own parser of free text or numbers; completes nothing.
 * The value is still parsed and validated by `parse`.
 */
export function textParser<T>(
  parse: (input: string) => T,
): (input: string) => T {
  return taggedParser(TEXT_TARGET, parse);
}

/**
 * Wrap a command's own parser of a value that completes `kind`, such as a
 * validating URL parser whose values are stored accounts' servers. The
 * value is still parsed and validated by `parse`.
 */
export function completingParser<T>(
  kind: CompletionTarget,
  parse: (input: string) => T,
): (input: string) => T {
  return taggedParser(kind, parse);
}

/**
 * Build a parser that completes `values`. Without `parse` it returns its
 * input unchanged, so the command still validates it: the values are
 * suggestions, and a command may accept others (`cli upgrade 0.5.0` next
 * to `nightly`). With `parse`, the command's own parser validates it.
 */
export function choiceParser(
  values: readonly string[],
): (input: string) => string;
export function choiceParser<T>(
  values: readonly string[],
  parse: (input: string) => T,
): (input: string) => T;
export function choiceParser(
  values: readonly string[],
  parse: (input: string) => unknown = (input) => input,
): (input: string) => unknown {
  return taggedParser(CHOICE_TARGET, parse, values);
}

/**
 * Build a parser of a comma-separated list that completes `values`, one
 * list item at a time, leaving out the ones already in the list
 * (`--fields id,ti` → `id,title`). Like {@link choiceParser}, it returns
 * its input unless given the command's own `parse`.
 */
export function choiceListParser(
  values: readonly string[],
): (input: string) => string;
export function choiceListParser<T>(
  values: readonly string[],
  parse: (input: string) => T,
): (input: string) => T;
export function choiceListParser(
  values: readonly string[],
  parse: (input: string) => unknown = (input) => input,
): (input: string) => unknown {
  return taggedParser(CHOICE_LIST_TARGET, parse, values);
}

/**
 * Shared value parsers and what their arguments complete: a kind, or the
 * fixed values they accept, completed as {@link CHOICE_TARGET}. Listed
 * here, not tagged where they are defined, so those modules know nothing
 * about completion: every flag that parses with one completes the same way.
 */
const PARSER_TARGETS: ReadonlyMap<
  unknown,
  CompletionTarget | readonly string[]
> = new Map<unknown, CompletionTarget | readonly string[]>([
  [sanitizeIssueQuery, ISSUE_QUERY_TARGET],
  [sanitizeQuery, TEXT_TARGET],
  [parsePeriod, PERIOD_TARGET],
  [parseLoginEmail, ACCOUNT_TARGET],
  [numberParser, TEXT_TARGET],
  [parseCursorFlag, CURSOR_NAVIGATION],
  [parseLogSort, VALID_LOG_SORT_DIRECTIONS],
  [parseSpanDepth, SPAN_DEPTH_KEYWORDS],
  [parseInstallationMethod, INSTALLATION_METHODS],
  [parseReleaseChannel, RELEASE_CHANNELS],
]);

/**
 * Read the completion kind from a positional's or flag's `parse` function.
 *
 * @returns The kind a parser was tagged with by {@link withCompletionTarget}
 *   or is listed with in {@link PARSER_TARGETS}, or `undefined` for any
 *   other parser
 */
export function getCompletionTarget(
  parse: unknown,
): CompletionTarget | undefined {
  if (typeof parse !== "function") {
    return;
  }
  const listed = PARSER_TARGETS.get(parse);
  return (
    (parse as { [COMPLETION_TARGET_KEY]?: CompletionTarget })[
      COMPLETION_TARGET_KEY
    ] ?? (typeof listed === "string" ? listed : listed && CHOICE_TARGET)
  );
}

/**
 * Read the values a parser completes: those of a {@link choiceParser} or
 * {@link choiceListParser} parser, or of a shared parser listed with its
 * values in {@link PARSER_TARGETS}.
 *
 * @returns The values, or `undefined` for any other parser
 */
export function getCompletionChoices(
  parse: unknown,
): readonly string[] | undefined {
  if (typeof parse !== "function") {
    return;
  }
  const listed = PARSER_TARGETS.get(parse);
  return (
    (parse as { [COMPLETION_CHOICES_KEY]?: readonly string[] })[
      COMPLETION_CHOICES_KEY
    ] ?? (typeof listed === "string" ? undefined : listed)
  );
}

/** The prefix `api` adds to an endpoint, left out of {@link COMPLETION_VALUES}. */
const API_PATH_PREFIX = /^\/api\/0\//;

/** Fixed values the completers offer (see {@link COMPLETION_VALUES}). */
export type CompletionValues = {
  /** Issue search keys with a fixed set of values, for {@link ISSUE_QUERY_TARGET} */
  issueSearch: Readonly<Record<string, readonly string[]>>;
  /** Units of a relative period, for {@link PERIOD_TARGET} (`7` → `7d`) */
  periodUnits: readonly string[];
  /** Relative periods offered for {@link PERIOD_TARGET}, with descriptions */
  periodPresets: Readonly<Record<string, string>>;
  /** API schema paths without `/api/0/`, for {@link API_ENDPOINT_TARGET} */
  apiPaths: readonly string[];
};

/**
 * Fixed values the completers offer, taken from the modules that define
 * them. The generator writes them next to the command metadata so the
 * `__complete` fast path gets them without loading those modules.
 */
export const COMPLETION_VALUES: CompletionValues = {
  issueSearch: { is: ISSUE_IS_VALUES, level: ISSUE_LEVELS },
  periodUnits: Object.keys(UNIT_SECONDS),
  // The presets of Sentry's time range selector (`DEFAULT_RELATIVE_PERIODS`
  // in getsentry/sentry).
  periodPresets: {
    "1h": "Last hour",
    "24h": "Last 24 hours",
    "7d": "Last 7 days",
    "14d": "Last 14 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
  },
  apiPaths: [
    ...new Set(
      getAllEndpoints().map(({ path }) => path.replace(API_PATH_PREFIX, "")),
    ),
  ],
};
