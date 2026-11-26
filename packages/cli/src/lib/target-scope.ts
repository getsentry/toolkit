/**
 * The organization and project an SDK invocation is limited to: the `org`
 * and `project` of `createSentrySDK()`, unless `limitToTarget` is `false`.
 *
 * The caller checks the targets a call names, but not an issue that an ID
 * alone names: a numeric ID, a share link, or a selector such as `@latest`
 * says nothing about its project. Issue lookups check the issue they find
 * with {@link assertIssueInScope} before a command reads or changes it.
 */

import type { SentryIssue } from "../types/index.js";
import { sentry } from "./app-identity.js";
import { getEnv, SCOPE_ORG_ENV_VAR, SCOPE_PROJECT_ENV_VAR } from "./env.js";
import { ResolutionError } from "./errors.js";

/** The organization, and project if any, an invocation is limited to. */
type TargetScope = { org: string; project?: string };

/** The current invocation's limit, or `undefined` when it has none. */
export function getTargetScope(): TargetScope | undefined {
  const env = getEnv();
  const org = env[SCOPE_ORG_ENV_VAR];
  if (!org) {
    return;
  }
  const project = env[SCOPE_PROJECT_ENV_VAR];
  return project ? { org, project } : { org };
}

function outsideScope(issueId: string, scope: TargetScope): ResolutionError {
  const target = scope.project ? `${scope.org}/${scope.project}` : scope.org;
  return new ResolutionError(
    `Issue ${issueId}`,
    `is outside this session's scope (${target})`,
    sentry`issue list ${scope.project ? target : `${target}/`}`,
    [`This session can only read or change issues in ${target}.`],
  );
}

/**
 * Refuse an organization outside the invocation's limit, before a request
 * to it.
 *
 * @param org - The organization a lookup asks
 * @param issueId - The issue as given, for the error
 * @throws {ResolutionError} When `org` is not the limit's organization
 */
export function assertOrgInScope(org: string, issueId: string): void {
  const scope = getTargetScope();
  if (scope && org !== scope.org) {
    throw outsideScope(issueId, scope);
  }
}

/**
 * Refuse an issue outside the invocation's limit. An issue whose project is
 * unknown is refused in a project-limited invocation.
 *
 * @param org - The organization the issue was found in
 * @param issue - The issue a lookup found
 * @throws {ResolutionError} When the issue is in another organization or
 *   project
 */
export function assertIssueInScope(
  org: string,
  issue: Pick<SentryIssue, "id" | "project">,
): void {
  const scope = getTargetScope();
  if (!scope) {
    return;
  }
  const issueId = issue.id;
  assertOrgInScope(org, issueId);
  if (scope.project && issue.project?.slug !== scope.project) {
    throw outsideScope(issueId, scope);
  }
}
