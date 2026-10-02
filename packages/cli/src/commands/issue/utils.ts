/**
 * Shared utilities for issue commands
 *
 * Common functionality used by explain, plan, view, and other issue commands.
 */

import pLimit from "p-limit";
import {
  findProjectsBySlug,
  getAutofixState,
  getIssue,
  getIssueByShortId,
  getIssueInOrg,
  getSharedIssue,
  ISSUE_DETAIL_COLLAPSE,
  type IssueSort,
  listIssuesPaginated,
  listOrganizations,
  ORG_FANOUT_CONCURRENCY,
  triggerRootCauseAnalysis,
  tryGetIssueByShortId,
} from "../../lib/api-client.js";
import {
  type IssueSelector,
  type ParsedIssueArg,
  parseIssueArg,
  splitNewlineArg,
} from "../../lib/arg-parsing.js";
import {
  clearCachedIssueOrg,
  getCachedIssueOrg,
  setCachedIssueOrg,
} from "../../lib/db/issue-org-cache.js";
import { getProjectByAlias } from "../../lib/db/project-aliases.js";
import { detectAllDsns } from "../../lib/dsn/index.js";
import {
  ApiError,
  type AuthGuardFailure,
  ContextError,
  ResolutionError,
  withAuthGuard,
} from "../../lib/errors.js";
import { getProgressMessage } from "../../lib/formatters/seer.js";
import { expandToFullShortId, isShortSuffix } from "../../lib/issue-id.js";
import { logger } from "../../lib/logger.js";
import { poll } from "../../lib/polling.js";
import { resolveEffectiveOrg } from "../../lib/region.js";
import {
  resolveFromDsn,
  resolveOrg,
  resolveOrgAndProject,
} from "../../lib/resolve-target.js";
import { parseSentryUrl } from "../../lib/sentry-url-parser.js";
import { buildIssueUrl } from "../../lib/sentry-urls.js";
import { setOrgProjectContext } from "../../lib/telemetry.js";
import { isAllDigits } from "../../lib/utils.js";
import type { SentryIssue } from "../../types/index.js";
import { type AutofixState, isTerminalStatus } from "../../types/seer.js";

const log = logger.withTag("issue.utils");

/** Shared positional parameter for issue ID */
export const issueIdPositional = {
  kind: "tuple",
  parameters: [
    {
      placeholder: "issue",
      brief:
        "Issue: @latest, @most_frequent, <org>/ID, <org>/<project>#ID, <project>-suffix, ID, or suffix",
      parse: String,
    },
  ],
} as const;

/** Variadic positional parameter for commands that accept multiple issues. */
export const issueIdsPositional = {
  kind: "array",
  parameter: {
    placeholder: "issue",
    brief: "One or more issue IDs",
    parse: String,
  },
} as const;

/**
 * Normalize variadic issue arguments.
 *
 * Newline-separated values are expanded for pasted or piped input. Duplicate
 * tokens are removed while preserving the first-seen order. Commas remain
 * part of the identifier, matching the CLI's positional-argument convention.
 *
 * @param args - Raw positional arguments
 * @returns Normalized issue identifiers
 */
export function collectIssueArgs(args: readonly string[]): string[] {
  return [...new Set(args.flatMap(splitNewlineArg))];
}

/**
 * Map issue identifiers with the standard organization fan-out concurrency.
 *
 * Successful values preserve input order. Partial failures invoke `onError`.
 * If every operation fails, the first error is rethrown without invoking
 * `onError`, avoiding duplicate warning and error output.
 *
 * @param issueArgs - Normalized issue identifiers
 * @param operation - Async work to perform for each identifier
 * @param onError - Called for each failed identifier
 * @returns Successful operation results in input order
 */
export async function mapIssueArgsConcurrently<T>(
  issueArgs: readonly string[],
  operation: (issueArg: string) => Promise<T>,
  onError: (issueArg: string, reason: unknown) => void
): Promise<T[]> {
  const limit = pLimit(ORG_FANOUT_CONCURRENCY);
  const settled = await Promise.allSettled(
    issueArgs.map((issueArg) => limit(() => operation(issueArg)))
  );

  const values: T[] = [];
  for (const result of settled) {
    if (result?.status === "fulfilled") {
      values.push(result.value);
    }
  }

  if (values.length === 0) {
    const first = settled[0];
    if (first?.status === "rejected") {
      throw first.reason;
    }
  }

  for (let index = 0; index < settled.length; index++) {
    const result = settled[index];
    const issueArg = issueArgs[index];
    if (result?.status === "rejected" && issueArg !== undefined) {
      onError(issueArg, result.reason);
    }
  }

  return values;
}

/**
 * Build a command hint string for error messages.
 *
 * Returns context-aware hints based on the issue ID format:
 * - Already contains `/` (e.g., "saber-ut/103103195") → show as-is (already has context)
 * - Numeric ID (e.g., "123456789") → suggest `<org>/123456789`
 * - Suffix only (e.g., "G") → suggest `<project>-G`
 * - Has dash (e.g., "cli-G") → suggest `<org>/cli-G`
 *
 * @param command - The issue subcommand (e.g., "view", "explain")
 * @param issueId - The user-provided issue ID
 * @param base - Base command prefix (default: "sentry issue")
 */
export function buildCommandHint(
  command: string,
  issueId: string,
  base = "sentry issue"
): string {
  // URLs are self-contained — no enrichment needed
  if (issueId.startsWith("http://") || issueId.startsWith("https://")) {
    return `${base} ${command} ${issueId}`;
  }
  // Selectors already include the @ prefix and are self-contained
  if (issueId.startsWith("@")) {
    return `${base} ${command} <org>/${issueId}`;
  }
  // Input already contains org/project context — show as-is to avoid double-prefixing,
  // unless it's the bare `org/suffix` form (a single slash with a non-project
  // suffix), in which case suggest the correct `org/<project>-suffix` format.
  if (issueId.includes("/")) {
    const slashIdx = issueId.indexOf("/");
    const org = issueId.slice(0, slashIdx);
    const afterSlash = issueId.slice(slashIdx + 1);
    // Only rewrite the genuine `org/suffix` case: a non-empty org, a single
    // slash, and a bare suffix. Skip multi-segment paths (`org/project/id`),
    // `#`-separated forms (`org/project#id`), `@` selectors (`org/@latest`),
    // dashed short IDs (`org/cli-G`), and numeric IDs (`org/123`) — all of
    // those are already fully specified or handled by other branches.
    if (
      org &&
      afterSlash &&
      !afterSlash.includes("/") &&
      !afterSlash.includes("#") &&
      !afterSlash.startsWith("@") &&
      !afterSlash.includes("-") &&
      !isAllDigits(afterSlash)
    ) {
      // Bare suffix after org — guide user to supply a project
      return `${base} ${command} ${org}/<project>-${afterSlash}`;
    }
    return `${base} ${command} ${issueId}`;
  }
  // Numeric IDs always need org context - can't be combined with project
  if (isAllDigits(issueId)) {
    return `${base} ${command} <org>/${issueId}`;
  }
  // Short suffixes can be combined with project prefix
  if (isShortSuffix(issueId)) {
    return `${base} ${command} <project>-${issueId}`;
  }
  // Everything else (has dash) needs org prefix
  return `${base} ${command} <org>/${issueId}`;
}

/** Default timeout in milliseconds (6 minutes) */
const DEFAULT_TIMEOUT_MS = 360_000;

/**
 * Result of resolving an issue ID - includes full issue object.
 * Used by view command which needs the complete issue data.
 */
export type ResolvedIssueResult = {
  /** Resolved organization slug (may be undefined for numeric IDs without context) */
  org: string | undefined;
  /** Full issue object from API */
  issue: SentryIssue;
};

/** Internal type for strict resolution (org required) */
type StrictResolvedIssue = {
  /** Resolved organization slug */
  org: string;
  /** Full issue object from API */
  issue: SentryIssue;
};

/** Command-specific recovery text shared by issue-style resolvers. */
type IssueCommandContext = {
  /** Primary recovery command for the original input. */
  commandHint: string;
  /** Active issue-style subcommand. */
  command: string;
  /** Command domain used for recovery suggestions. */
  commandBase: string;
};

/**
 * Try to resolve via alias cache.
 * Returns null if the alias is not found in cache or fingerprint doesn't match.
 *
 * @param alias - The project alias (lowercase)
 * @param suffix - The issue suffix (uppercase)
 * @param cwd - Current working directory for DSN detection
 */
async function tryResolveFromAlias(
  alias: string,
  suffix: string,
  cwd: string
): Promise<StrictResolvedIssue | null> {
  // Detect DSNs to get fingerprint for validation
  const detection = await detectAllDsns(cwd);
  const fingerprint = detection.fingerprint;
  const projectEntry = getProjectByAlias(alias, fingerprint);
  if (!projectEntry) {
    return null;
  }

  const resolvedShortId = expandToFullShortId(suffix, projectEntry.projectSlug);
  const issue = await getIssueByShortId(projectEntry.orgSlug, resolvedShortId, {
    collapse: ISSUE_DETAIL_COLLAPSE,
  });
  return { org: projectEntry.orgSlug, issue };
}

/**
 * Fallback for when the fast shortid fan-out found no matches.
 * Uses findProjectsBySlug to retry on transient failures; when no project
 * slug matches, reports the issue short ID as not found (not the project).
 *
 * @param projectSlug - Project slug parsed from the short ID
 * @param suffix - Issue short-ID suffix
 * @param commandContext - Command-specific recovery text
 */
async function resolveProjectSearchFallback(
  projectSlug: string,
  suffix: string,
  commandContext: IssueCommandContext
): Promise<StrictResolvedIssue> {
  const { command, commandBase, commandHint } = commandContext;
  const { projects } = await findProjectsBySlug(projectSlug.toLowerCase());

  if (projects.length === 0) {
    const fullShortId = expandToFullShortId(suffix, projectSlug);
    throw new ResolutionError(
      `Issue '${fullShortId}'`,
      "not found",
      commandHint,
      [
        "No issue with this short ID found in any accessible organization",
        "Check the project prefix and suffix, or use a numeric issue ID",
        `Specify the org: ${commandBase} ${command} <org>/${fullShortId}`,
      ]
    );
  }

  if (projects.length > 1) {
    const orgList = projects.map((p) => p.orgSlug).join(", ");
    throw new ResolutionError(
      `Project '${projectSlug}'`,
      "is ambiguous",
      commandHint,
      [
        `Found in: ${orgList}`,
        `Specify the org: ${commandBase} ${command} <org>/${projectSlug}-${suffix}`,
      ]
    );
  }

  // Project exists — retry the issue lookup. The fast path may have failed
  // due to a transient error (5xx, timeout); retrying here either succeeds
  // or propagates the real error to the user.
  const matchedProject = projects[0];
  const matchedOrg = matchedProject?.orgSlug;
  if (matchedOrg && matchedProject) {
    const retryShortId = expandToFullShortId(suffix, matchedProject.slug);
    const issue = await getIssueByShortId(matchedOrg, retryShortId, {
      collapse: ISSUE_DETAIL_COLLAPSE,
    });
    return { org: matchedOrg, issue };
  }

  throw new ResolutionError(
    `Project '${projectSlug}'`,
    "not found",
    commandHint
  );
}

/**
 * Resolve project-search type: search for project across orgs, then fetch issue.
 *
 * Resolution order:
 * 1. Try alias cache (fast, local)
 * 2. Check DSN detection cache
 * 3. Try shortid endpoint directly across all orgs (fast path)
 * 4. Fall back to findProjectsBySlug for precise error messages
 *
 * @param projectSlug - Project slug to search for
 * @param suffix - Issue suffix (uppercase)
 * @param cwd - Current working directory
 * @param commandContext - Command-specific recovery text
 */
async function resolveProjectSearch(
  projectSlug: string,
  suffix: string,
  cwd: string,
  commandContext: IssueCommandContext
): Promise<StrictResolvedIssue> {
  const { command, commandBase, commandHint } = commandContext;
  // 1. Try alias cache first (fast, local lookup)
  const aliasResult = await tryResolveFromAlias(
    projectSlug.toLowerCase(),
    suffix,
    cwd
  );
  if (aliasResult) {
    return aliasResult;
  }

  // 2. Check if DSN detection already resolved this project.
  //    resolveFromDsn() reads from the DSN cache (populated by detectAllDsns
  //    in tryResolveFromAlias above) + project cache. This avoids the expensive
  //    listOrganizations() fan-out when the DSN matches the target project.
  //    Only catch resolveFromDsn errors — getIssueByShortId errors (e.g. 404)
  //    must propagate so we don't duplicate the expensive call via fallback.
  let dsnTarget: Awaited<ReturnType<typeof resolveFromDsn>> | undefined;
  try {
    dsnTarget = await resolveFromDsn(cwd);
  } catch (error) {
    log.debug("DSN resolution failed, falling through to full search", error);
  }
  if (
    dsnTarget &&
    dsnTarget.project.toLowerCase() === projectSlug.toLowerCase()
  ) {
    const fullShortId = expandToFullShortId(suffix, dsnTarget.project);
    const issue = await getIssueByShortId(dsnTarget.org, fullShortId, {
      collapse: ISSUE_DETAIL_COLLAPSE,
    });
    return { org: dsnTarget.org, issue };
  }

  // 3. Fast path: try resolving the short ID directly across all orgs.
  //    The shortid endpoint validates both project existence and issue existence
  //    in a single call, eliminating the separate getProject() round-trip.
  //    Concurrency-limited to avoid overwhelming the API for enterprise users.
  const fullShortId = expandToFullShortId(suffix, projectSlug);
  const orgs = await listOrganizations();

  const limit = pLimit(ORG_FANOUT_CONCURRENCY);
  const results = await Promise.all(
    orgs.map((org) =>
      limit(() =>
        withAuthGuard(() =>
          tryGetIssueByShortId(org.slug, fullShortId, {
            collapse: ISSUE_DETAIL_COLLAPSE,
          })
        )
      )
    )
  );

  const successes: StrictResolvedIssue[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const org = orgs[i];
    if (result && org && result.ok && result.value) {
      successes.push({ org: org.slug, issue: result.value });
    }
  }

  if (successes.length === 1 && successes[0]) {
    return successes[0];
  }

  if (successes.length > 1) {
    const orgList = successes.map((s) => s.org).join(", ");
    throw new ResolutionError(
      `Project '${projectSlug}'`,
      "is ambiguous",
      commandHint,
      [
        `Found in: ${orgList}`,
        `Specify the org: ${commandBase} ${command} <org>/${projectSlug}-${suffix}`,
      ]
    );
  }

  // If every org failed with a real error (403, 5xx, network timeout),
  // surface it instead of falling through to a misleading "not found".
  // Only throw when ALL results are errors — if some orgs returned clean
  // 404s ({ok: true, value: null}), fall through to the fallback for a
  // precise error message.
  const realErrors = results.filter(
    (r): r is AuthGuardFailure => r !== undefined && !r.ok
  );
  if (realErrors.length === results.length && realErrors.length > 0) {
    const firstError = realErrors[0]?.error;
    if (firstError instanceof Error) {
      throw firstError;
    }
  }

  // 4. Fall back to findProjectsBySlug for precise error messages
  //    and retry the issue lookup (handles transient failures).
  return resolveProjectSearchFallback(projectSlug, suffix, commandContext);
}

/**
 * Resolve suffix-only type using DSN detection for project context.
 *
 * @param suffix - The issue suffix (uppercase)
 * @param cwd - Current working directory for DSN detection
 * @param commandHint - Hint for error messages
 */
async function resolveSuffixOnly(
  suffix: string,
  cwd: string,
  commandHint: string
): Promise<StrictResolvedIssue> {
  const target = await resolveOrgAndProject({ cwd });
  if (!target) {
    throw new ResolutionError(
      `Issue suffix '${suffix}'`,
      "could not be resolved without project context",
      commandHint
    );
  }
  const fullShortId = expandToFullShortId(suffix, target.project);
  const issue = await getIssueByShortId(target.org, fullShortId, {
    collapse: ISSUE_DETAIL_COLLAPSE,
  });
  return { org: target.org, issue };
}

/**
 * Resolve explicit-org-suffix type: org provided but only suffix given.
 *
 * This format (`org/suffix`) is ambiguous - we have org but no project.
 * We don't use DSN detection here because mixing explicit org with
 * DSN-detected project (which belongs to a potentially different org)
 * would be semantically wrong and confusing.
 *
 * @param org - Explicit organization slug
 * @param suffix - Issue suffix (uppercase)
 * @param commandContext - Command-specific recovery text
 */
function resolveExplicitOrgSuffix(
  org: string,
  suffix: string,
  commandContext: IssueCommandContext
): never {
  const { command, commandBase, commandHint } = commandContext;
  throw new ResolutionError(
    `Issue suffix '${suffix}'`,
    "could not be resolved without project context",
    commandHint,
    [
      `The format '${org}/${suffix}' requires a project to build the full issue ID.`,
      `Use: ${commandBase} ${command} ${org}/<project>-${suffix}`,
    ]
  );
}

/**
 * Map magic selectors to Sentry issue list sort parameters.
 *
 * `@latest` → `"date"` (most recent `lastSeen` timestamp)
 * `@most_frequent` → `"freq"` (highest event frequency)
 */
const SELECTOR_SORT_MAP: Record<IssueSelector, IssueSort> = {
  "@latest": "date",
  "@most_frequent": "freq",
};

/**
 * Human-readable labels for selectors (used in error messages).
 */
const SELECTOR_LABELS: Record<IssueSelector, string> = {
  "@latest": "most recent",
  "@most_frequent": "most frequent",
};

/**
 * Resolve a magic `@` selector to the top matching issue.
 *
 * Fetches the issue list sorted by the selector's criteria and returns
 * the first result. Requires organization context (explicit or auto-detected).
 *
 * @param selector - The magic selector (e.g., `@latest`, `@most_frequent`)
 * @param explicitOrg - Optional explicit org slug from `org/@selector` format
 * @param cwd - Current working directory for context resolution
 * @param commandContext - Command-specific recovery text
 * @returns The resolved issue with org context
 * @throws {ContextError} When organization cannot be resolved
 * @throws {ResolutionError} When no issues match the selector
 */
async function resolveSelector(
  selector: IssueSelector,
  explicitOrg: string | undefined,
  cwd: string,
  commandContext: IssueCommandContext
): Promise<StrictResolvedIssue> {
  const { commandHint } = commandContext;
  // Resolve org: explicit from `org/@latest` or auto-detected from DSN/defaults
  let orgSlug: string;
  if (explicitOrg) {
    orgSlug = await resolveEffectiveOrg(explicitOrg);
  } else {
    const resolved = await resolveOrg({ cwd });
    if (!resolved) {
      throw new ContextError("Organization", commandHint);
    }
    orgSlug = resolved.org;
  }

  const sort = SELECTOR_SORT_MAP[selector];
  const label = SELECTOR_LABELS[selector];

  // Fetch just the top issue with the appropriate sort.
  // Collapse all non-essential fields since we only need the issue identity.
  const { data: issues } = await listIssuesPaginated(orgSlug, "", {
    sort,
    perPage: 1,
    query: "is:unresolved",
    collapse: ISSUE_DETAIL_COLLAPSE,
  });

  const issue = issues[0];
  if (!issue) {
    throw new ResolutionError(
      `Selector '${selector}'`,
      "no unresolved issues found",
      `sentry issue list ${orgSlug}/ -q "is:resolved"`,
      [`The ${label} issue selector only matches unresolved issues.`]
    );
  }

  return { org: orgSlug, issue };
}

/**
 * Resolve a share URL to a full issue via two-step lookup:
 * 1. Call public share API to get numeric group ID
 * 2. Fetch full issue details via authenticated API
 *
 * Both requests require organization context, taken from the share URL
 * or the usual defaults and DSN resolution.
 *
 * @param share - Share URL components, including optional organization context
 * @param cwd - Current working directory for context resolution
 * @param commandHint - Recovery command when organization context is missing
 */
async function resolveShareIssue(
  share: Extract<ParsedIssueArg, { type: "share" }>,
  cwd: string,
  commandHint: string
): Promise<StrictResolvedIssue> {
  const { shareId, org, baseUrl } = share;
  const resolvedOrg = org
    ? await resolveEffectiveOrg(org)
    : (await resolveOrg({ cwd }))?.org;
  if (!resolvedOrg) {
    throw new ContextError("Organization", commandHint);
  }

  const shared = await getSharedIssue(baseUrl, resolvedOrg, shareId);
  const issue = await getIssueInOrg(resolvedOrg, shared.id, {
    collapse: ISSUE_DETAIL_COLLAPSE,
  });
  return { org: resolvedOrg, issue };
}

/**
 * Options for resolving an issue ID.
 */
export type ResolveIssueOptions = {
  /** User-provided issue argument (raw CLI input) */
  issueArg: string;
  /** Current working directory for context resolution */
  cwd: string;
  /** Command name for error messages (e.g., "view", "explain") */
  command: string;
  /** Base command prefix for error hints (default: "sentry issue") */
  commandBase?: string;
};

/**
 * Extract the organization slug from a Sentry issue permalink.
 *
 * Handles both path-based (`https://sentry.io/organizations/{org}/issues/...`)
 * and subdomain-style (`https://{org}.sentry.io/issues/...`) SaaS URLs.
 * Returns undefined if the permalink is missing or not a recognized format.
 *
 * @param permalink - Issue permalink URL from the Sentry API response
 */
function extractOrgFromPermalink(
  permalink: string | undefined
): string | undefined {
  if (!permalink) {
    return;
  }
  return parseSentryUrl(permalink)?.org;
}

/**
 * Result of {@link fetchIssueByNumericId}.
 *
 * `cacheEvicted` is true when the helper invalidated a stale `cachedOrg`
 * entry after a 404 and fell through to the legacy unscoped endpoint.
 * Callers MUST treat their local `cachedOrg` as stale when this flag is
 * set and re-derive the org from `issue.permalink` instead — otherwise
 * a stale slug leaks into downstream API calls (issue events, traces).
 */
type FetchIssueByNumericIdResult = {
  issue: SentryIssue;
  cacheEvicted: boolean;
};

/**
 * Fetch an issue by numeric ID, preferring an org-scoped endpoint when
 * the caller has explicit or cached org context. Falls back to the legacy
 * unscoped `/api/0/issues/{id}/` endpoint when no org is known, and also
 * when a cached org yields a 404 (stale mapping).
 *
 * Extracted from {@link resolveNumericIssue} to keep its cognitive
 * complexity below the project's lint threshold.
 */
async function fetchIssueByNumericId(
  id: string,
  explicitOrg: string | undefined,
  cachedOrg: string | null | undefined
): Promise<FetchIssueByNumericIdResult> {
  if (explicitOrg) {
    const issue = await getIssueInOrg(explicitOrg, id, {
      collapse: ISSUE_DETAIL_COLLAPSE,
    });
    return { issue, cacheEvicted: false };
  }
  if (cachedOrg) {
    try {
      const issue = await getIssueInOrg(cachedOrg, id, {
        collapse: ISSUE_DETAIL_COLLAPSE,
      });
      return { issue, cacheEvicted: false };
    } catch (orgErr) {
      if (orgErr instanceof ApiError && orgErr.status === 404) {
        // Stale mapping (issue moved / deleted / access revoked). Evict the
        // cache entry and fall through to the legacy unscoped endpoint.
        clearCachedIssueOrg(id);
        const issue = await getIssue(id, { collapse: ISSUE_DETAIL_COLLAPSE });
        return { issue, cacheEvicted: true };
      }
      throw orgErr;
    }
  }
  const issue = await getIssue(id, { collapse: ISSUE_DETAIL_COLLAPSE });
  return { issue, cacheEvicted: false };
}

/**
 * Resolve a bare numeric issue ID.
 *
 * Attempts org-scoped resolution with region routing when org context can be
 * derived from the working directory (DSN / env vars / config defaults), or
 * from the issue-id → org cache populated on previous runs.
 * Falls back to the legacy unscoped endpoint otherwise.
 * Extracts the org slug from the response permalink so callers like
 * {@link resolveOrgAndIssueId} can proceed without explicit org context.
 *
 * Caching: after a successful permalink-based org extraction, records the
 * numeric-id → org mapping so future runs skip the unscoped fallback and
 * route directly via the regional API. This addresses the
 * `sentry.issue.view` "Consecutive HTTP" fan-out pattern for bare numeric
 * IDs (Pattern D in the Sentry issue triage).
 */
async function resolveNumericIssue(
  id: string,
  cwd: string,
  command: string,
  commandBase = "sentry issue"
): Promise<ResolvedIssueResult> {
  const resolvedOrg = await resolveOrg({ cwd });
  // Prefer explicit context over the cache — `resolveOrg()` already factors
  // in env vars and config defaults that may point at a different org.
  const cachedOrg = resolvedOrg ? null : getCachedIssueOrg(id);
  try {
    const { issue, cacheEvicted } = await fetchIssueByNumericId(
      id,
      resolvedOrg?.org,
      cachedOrg
    );
    // When `cacheEvicted` is true, the cached org slug was stale (404'd) and
    // the helper fell through to the unscoped endpoint. Do NOT let the stale
    // `cachedOrg` participate in the `??` chain — re-derive from permalink.
    const effectiveCachedOrg = cacheEvicted ? null : cachedOrg;
    // Extract org from the response permalink as a fallback so that callers
    // like resolveOrgAndIssueId (used by explain/plan) get the org slug even
    // when no org context was available before the fetch.
    const org =
      resolvedOrg?.org ??
      effectiveCachedOrg ??
      extractOrgFromPermalink(issue.permalink);
    // Best-effort: remember the numeric-id → org mapping so the next run
    // skips the unscoped fallback. Skipped when the org came from a still-
    // valid cache hit (already stored). When the cache was evicted we SHOULD
    // re-write the corrected mapping derived from the permalink.
    if (org && !resolvedOrg && !effectiveCachedOrg) {
      // Best-effort — a broken/read-only DB must not fail a successful lookup.
      try {
        setCachedIssueOrg(id, org);
      } catch (cacheErr) {
        log.debug(
          `Failed to cache issue-org mapping for ${id}: ${String(cacheErr)}`
        );
      }
    }
    return { org, issue };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // Improve on the generic "Issue not found" message by including the ID
      // and suggesting the short-ID format, since users often confuse numeric
      // group IDs with short-ID suffixes. When org context is available, use
      // the real org slug instead of <org> placeholder (CLI-BT, 18 users).
      //
      // Skip `cachedOrg` here: if the unscoped legacy endpoint 404'd too,
      // the helper has already evicted the (proven-stale) cache entry, so
      // suggesting the old slug in the hint would mislead the user. Only
      // explicit `resolvedOrg` is worth preserving.
      const orgHint = resolvedOrg?.org ?? "<org>";
      const hint = `${commandBase} ${command} ${orgHint}/${id}`;
      throw new ResolutionError(`Issue ${id}`, "not found", hint, [
        `No issue with numeric ID ${id} found — you may not have access, or it may have been deleted.`,
        `If this is a short ID suffix, try: ${commandBase} ${command} <project>-${id}`,
      ]);
    }
    throw err;
  }
}

/**
 * Resolve an issue ID to organization slug and full issue object.
 *
 * Supports all issue ID formats (now parsed by parseIssueArg in arg-parsing.ts):
 * - selector: "@latest", "sentry/@most_frequent" → top issue by criteria
 * - explicit: "sentry/cli-G" → org + project + suffix
 * - explicit-org-suffix: "sentry/G" → org + suffix (needs DSN for project)
 * - explicit-org-numeric: "sentry/123456789" → org + numeric ID
 * - project-search: "cli-G" → search for project across orgs
 * - suffix-only: "G" (requires DSN context)
 * - numeric: "123456789" (direct fetch, no org)
 *
 * @param options - Resolution options
 * @returns Object with org slug and full issue
 * @throws {ContextError} When required context (org) is missing
 * @throws {ResolutionError} When an issue or project could not be found or resolved
 */
export async function resolveIssue(
  options: ResolveIssueOptions
): Promise<ResolvedIssueResult> {
  const { issueArg, cwd, command, commandBase } = options;
  const effectiveCommandBase = commandBase ?? "sentry issue";
  const parsed = parseIssueArg(issueArg);
  const commandHint = buildCommandHint(command, issueArg, effectiveCommandBase);
  const commandContext: IssueCommandContext = {
    command,
    commandBase: effectiveCommandBase,
    commandHint,
  };

  let result: ResolvedIssueResult;

  switch (parsed.type) {
    case "numeric":
      result = await resolveNumericIssue(parsed.id, cwd, command, commandBase);
      break;

    case "explicit": {
      // Full context: org + project + suffix
      const org = await resolveEffectiveOrg(parsed.org);
      const fullShortId = expandToFullShortId(parsed.suffix, parsed.project);
      const issue = await getIssueByShortId(org, fullShortId, {
        collapse: ISSUE_DETAIL_COLLAPSE,
      });
      result = { org, issue };
      break;
    }

    case "explicit-org-numeric": {
      // Org + numeric ID — use org-scoped endpoint for proper region routing.
      const org = await resolveEffectiveOrg(parsed.org);
      try {
        const issue = await getIssueInOrg(org, parsed.numericId, {
          collapse: ISSUE_DETAIL_COLLAPSE,
        });
        result = { org, issue };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          throw new ResolutionError(
            `Issue ${parsed.numericId}`,
            "not found",
            commandHint,
            [
              `No issue with numeric ID ${parsed.numericId} found in org '${org}' — you may not have access, or it may have been deleted.`,
              `If this is a short ID suffix, try: ${effectiveCommandBase} ${command} <project>-${parsed.numericId}`,
            ]
          );
        }
        throw err;
      }
      break;
    }

    case "explicit-org-suffix": {
      // Org + suffix only - ambiguous without project, always errors
      const org = await resolveEffectiveOrg(parsed.org);
      result = resolveExplicitOrgSuffix(org, parsed.suffix, commandContext);
      break;
    }

    case "project-search":
      // Project slug + suffix - search across orgs
      result = await resolveProjectSearch(
        parsed.projectSlug,
        parsed.suffix,
        cwd,
        commandContext
      );
      break;

    case "suffix-only":
      // Just suffix - need DSN for org and project
      result = await resolveSuffixOnly(parsed.suffix, cwd, commandHint);
      break;

    case "selector":
      // Magic @ selector - fetch top issue by sort criteria
      result = await resolveSelector(
        parsed.selector,
        parsed.org,
        cwd,
        commandContext
      );
      break;

    case "share":
      // Share URL — resolve via public share API, then authenticated fetch
      result = await resolveShareIssue(parsed, cwd, commandHint);
      break;

    default: {
      // Exhaustive check - this should never be reached
      const _exhaustive: never = parsed;
      throw new Error(
        `Unexpected issue arg type: ${JSON.stringify(_exhaustive)}`
      );
    }
  }

  // Set telemetry context from the resolved result
  if (result.org) {
    setOrgProjectContext(
      [result.org],
      result.issue.project?.slug ? [result.issue.project.slug] : []
    );
  }

  return result;
}

/**
 * Resolve both organization slug and numeric issue ID.
 * Required for autofix endpoints that need both org and issue ID.
 * This is a stricter wrapper around resolveIssue that throws if org is undefined.
 *
 * @param options - Resolution options
 * @returns Object with org slug, numeric issue ID, and the issue's project ID when known
 * @throws {ContextError} When organization cannot be resolved
 */
export async function resolveOrgAndIssueId(
  options: ResolveIssueOptions
): Promise<{ org: string; issueId: string; projectId?: string }> {
  const result = await resolveIssue(options);
  if (!result.org) {
    const commandHint = buildCommandHint(options.command, options.issueArg);
    throw new ContextError("Organization", commandHint);
  }
  return {
    org: result.org,
    issueId: result.issue.id,
    projectId: result.issue.project?.id,
  };
}

type PollAutofixOptions = {
  /** Organization slug */
  orgSlug: string;
  /** Numeric issue ID */
  issueId: string;
  /** Whether to suppress progress output (JSON mode) */
  json: boolean;
  /** Polling interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;
  /** Maximum time to wait in milliseconds (default: 360000 = 6 minutes) */
  timeoutMs?: number;
  /** Custom timeout error message */
  timeoutMessage?: string;
  /** Actionable hint appended to the TimeoutError (e.g., "Run the command again…").
   *  When omitted, defaults to a hint with the Sentry issue URL. */
  timeoutHint?: string;
  /** Stop polling when status is WAITING_FOR_USER_RESPONSE (default: false) */
  stopOnWaitingForUser?: boolean;
};

type EnsureRootCauseOptions = {
  /** Organization slug */
  org: string;
  /** Numeric issue ID */
  issueId: string;
  /** Whether to suppress progress output (JSON mode) */
  json: boolean;
  /** Force new analysis even if one exists */
  force?: boolean;
};

/**
 * Ensure root cause analysis exists for an issue.
 *
 * If no analysis exists (or force is true), triggers a new analysis.
 * If analysis is in progress, waits for it to complete.
 * If analysis failed (ERROR status), retries automatically.
 *
 * @param options - Configuration options
 * @returns The completed autofix state with root causes
 */
export async function ensureRootCauseAnalysis(
  options: EnsureRootCauseOptions
): Promise<AutofixState> {
  const { org, issueId, json, force = false } = options;

  // 1. Check for existing analysis (skip if --force)
  let state = force ? null : await getAutofixState(org, issueId);

  // Handle error status - we will retry the analysis
  if (state?.status === "ERROR") {
    if (!json) {
      log.info("Previous analysis failed, retrying...");
    }
    state = null;
  }

  // 2. Trigger new analysis if none exists or forced
  if (!state) {
    if (!json) {
      const prefix = force ? "Forcing fresh" : "Starting";
      log.info(`${prefix} root cause analysis, it can take several minutes...`);
    }
    await triggerRootCauseAnalysis(org, issueId);
  }

  // 3. Poll until complete (if not already completed)
  if (
    !state ||
    (state.status !== "COMPLETED" &&
      state.status !== "WAITING_FOR_USER_RESPONSE")
  ) {
    state = await pollAutofixState({
      orgSlug: org,
      issueId,
      json,
      stopOnWaitingForUser: true,
    });
  }

  return state;
}

/**
 * Check if polling should stop based on current state.
 *
 * Terminal statuses (COMPLETED, ERROR, CANCELLED) always stop polling.
 * When `stopOnWaitingForUser` is true, also stops on interactive statuses:
 * - `WAITING_FOR_USER_RESPONSE` — root cause analysis needs user input
 * - `NEED_MORE_INFORMATION` — solution step completed, awaiting user decision
 *
 * @param state - Current autofix state
 * @param stopOnWaitingForUser - Whether to stop on interactive statuses
 * @returns True if polling should stop
 */
function shouldStopPolling(
  state: AutofixState,
  stopOnWaitingForUser: boolean
): boolean {
  if (isTerminalStatus(state.status)) {
    return true;
  }
  if (
    stopOnWaitingForUser &&
    (state.status === "WAITING_FOR_USER_RESPONSE" ||
      state.status === "NEED_MORE_INFORMATION")
  ) {
    return true;
  }
  return false;
}

/**
 * Poll autofix state until completion or timeout.
 * Uses the generic poll utility with autofix-specific configuration.
 *
 * @param options - Polling configuration
 * @returns Final autofix state
 * @throws {Error} On timeout
 */
export async function pollAutofixState(
  options: PollAutofixOptions
): Promise<AutofixState> {
  const {
    orgSlug,
    issueId,
    json,
    pollIntervalMs,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    timeoutMessage = "Operation timed out after 6 minutes. Try again or check the issue in Sentry web UI.",
    timeoutHint,
    stopOnWaitingForUser = false,
  } = options;

  const issueUrl = buildIssueUrl(orgSlug, issueId);
  const hint =
    timeoutHint ??
    "The analysis may still complete in the background.\n" +
      `  View in Sentry: ${issueUrl}\n` +
      `  Or retry:       sentry issue explain ${issueId}`;

  return await poll<AutofixState>({
    fetchState: () => getAutofixState(orgSlug, issueId),
    shouldStop: (state) => shouldStopPolling(state, stopOnWaitingForUser),
    getProgressMessage,
    json,
    pollIntervalMs,
    timeoutMs,
    timeoutMessage,
    timeoutHint: hint,
    initialMessage: "Waiting for analysis to start...",
  });
}
