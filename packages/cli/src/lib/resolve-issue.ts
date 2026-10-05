/**
 * Issue ID Resolution
 *
 * Single source of truth for resolving issue IDs from various formats:
 * - Alias-suffix format: "s-5d", "e-4y" (requires alias cache from `issue list`)
 * - Short suffix: "5d", "G" (requires project context)
 * - Full short ID: "SPOTLIGHT-5D", "CRAFT-G" (requires org context)
 * - Numeric ID: "123456789" (requires org context)
 *
 * The Sentry API accepts both short IDs and numeric IDs for org-scoped
 * endpoints, so we don't need to fetch the issue just to resolve the ID.
 */

import { getProjectByAlias } from "./db/project-aliases.js";
import { detectAllDsns } from "./dsn/index.js";
import { ContextError } from "./errors.js";
import {
  expandToFullShortId,
  isShortId,
  isShortSuffix,
  parseAliasSuffix,
} from "./issue-id.js";
import { resolveOrg, resolveOrgAndProject } from "./resolve-target.js";

/**
 * Options for resolving an issue ID.
 */
export type ResolveIssueOptions = {
  /** Organization slug */
  org?: string;
  /** Project slug (needed for short suffix resolution) */
  project?: string;
  /** Current working directory for DSN detection and alias cache */
  cwd: string;
};

/**
 * Result of resolving an issue ID.
 * The issueId is always a valid identifier for the Sentry API
 * (either a full short ID like "SPOTLIGHT-5D" or a numeric ID).
 */
export type ResolvedIssue = {
  /** Resolved organization slug */
  org: string;
  /** Resolved issue ID (full short ID or numeric) */
  issueId: string;
};

/**
 * Resolve an alias-suffix format issue ID (e.g., "s-5d", "e-4y").
 * Returns null if the alias is not found in cache or fingerprint doesn't match.
 *
 * @param alias - The project alias from the alias-suffix format
 * @param suffix - The issue suffix
 * @param cwd - Current working directory for DSN detection
 */
async function resolveAliasSuffix(
  alias: string,
  suffix: string,
  cwd: string
): Promise<ResolvedIssue | null> {
  // Detect DSNs to get fingerprint for validation
  const detection = await detectAllDsns(cwd);
  const fingerprint = detection.fingerprint;
  const projectEntry = getProjectByAlias(alias, fingerprint);

  if (!projectEntry) {
    return null;
  }

  const resolvedShortId = expandToFullShortId(suffix, projectEntry.projectSlug);
  return { org: projectEntry.orgSlug, issueId: resolvedShortId };
}

/**
 * Resolve a short suffix format issue ID (e.g., "5d", "G").
 * Requires project context from flags or DSN detection.
 *
 * @param suffix - The short suffix (e.g., "5d", "G")
 * @param options - Resolution options with org/project flags and cwd
 * @returns Resolved issue or null if project context unavailable
 */
async function resolveShortSuffix(
  suffix: string,
  options: ResolveIssueOptions
): Promise<ResolvedIssue | null> {
  const { org, project, cwd } = options;

  const target = await resolveOrgAndProject({ org, project, cwd });
  if (!target) {
    return null;
  }

  const resolvedShortId = expandToFullShortId(suffix, target.project);
  return { org: target.org, issueId: resolvedShortId };
}

/**
 * Resolve org context for a full short ID or numeric ID.
 *
 * @param issueId - The issue ID (full short ID or numeric)
 * @param options - Resolution options
 * @param commandHint - Command example for error messages
 * @returns Resolved issue with org context
 * @throws {ContextError} When organization cannot be resolved
 */
async function resolveWithOrgContext(
  issueId: string,
  options: ResolveIssueOptions,
  commandHint: string
): Promise<ResolvedIssue> {
  const { org, cwd } = options;

  const resolved = await resolveOrg({ org, cwd });
  if (!resolved) {
    throw new ContextError("Organization", commandHint);
  }

  // Normalize short IDs to uppercase for consistent API calls
  const normalizedId = isShortId(issueId) ? issueId.toUpperCase() : issueId;
  return { org: resolved.org, issueId: normalizedId };
}

/**
 * Resolve an issue ID from any supported format to a form usable with the Sentry API.
 *
 * Supports:
 * - Alias-suffix format: "s-5d", "e-4y" (from `issue list` in multi-project mode)
 * - Short suffix: "5d", "G" (requires project context)
 * - Full short ID: "SPOTLIGHT-5D", "CRAFT-G"
 * - Numeric ID: "123456789"
 *
 * The resolved issueId can be used directly with org-scoped Sentry API endpoints
 * like `/organizations/{org}/issues/{issueId}/`.
 *
 * @param input - User-provided issue ID in any supported format
 * @param options - Resolution options with org/project flags and cwd
 * @param commandHint - Command example for error messages (e.g., "sentry issue view <org>/ID")
 * @returns Resolved organization and issue ID
 * @throws {ContextError} When required context (org/project) cannot be resolved
 *
 * @example
 * // From alias-suffix (after multi-project `issue list`)
 * const { org, issueId } = await resolveIssueId("s-5d", { cwd });
 * // org: "sentry-sdks", issueId: "SPOTLIGHT-5D"
 *
 * @example
 * // From short suffix (with project context)
 * const { org, issueId } = await resolveIssueId("5d", { cwd });
 * // org: "sentry-sdks", issueId: "SPOTLIGHT-5D"
 *
 * @example
 * // From full short ID
 * const { org, issueId } = await resolveIssueId("SPOTLIGHT-5D", { cwd });
 * // org: "sentry-sdks", issueId: "SPOTLIGHT-5D"
 */
export async function resolveIssueId(
  input: string,
  options: ResolveIssueOptions,
  commandHint: string
): Promise<ResolvedIssue> {
  const { cwd } = options;

  // 1. Try alias-suffix format (e.g., "s-5d", "e-4y")
  const aliasSuffix = parseAliasSuffix(input);
  if (aliasSuffix) {
    const resolved = await resolveAliasSuffix(
      aliasSuffix.alias,
      aliasSuffix.suffix,
      cwd
    );
    if (resolved) {
      return resolved;
    }
    // Alias not found in cache - fall through to try other formats
  }

  // 2. Try short suffix format (e.g., "5d", "G")
  if (isShortSuffix(input)) {
    const resolved = await resolveShortSuffix(input, options);
    if (resolved) {
      return resolved;
    }
    // No project context - fall through to treat as regular ID
  }

  // 3. Full short ID (e.g., "SPOTLIGHT-5D") or numeric ID (e.g., "123456789")
  return resolveWithOrgContext(input, options, commandHint);
}
