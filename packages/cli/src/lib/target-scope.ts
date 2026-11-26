/**
 * The organization and project an SDK invocation is limited to: the `org`
 * and `project` of `createSentrySDK()`, unless `limitToTarget` is `false`.
 *
 * The caller checks the targets a call names, but not what an ID alone
 * names: a numeric issue ID, an event, trace or replay ID, a share link, or a
 * selector such as `@latest` says nothing about its project. Lookups check
 * what they find with {@link assertProjectInScope} (or
 * {@link assertIssueInScope}) before a command reads or changes it.
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

function outsideScope(subject: string, scope: TargetScope): ResolutionError {
  const target = scope.project ? `${scope.org}/${scope.project}` : scope.org;
  return new ResolutionError(
    subject,
    `is outside this session's scope (${target})`,
    sentry`issue list ${scope.project ? target : `${target}/`}`,
    [`This session can only read or change data in ${target}.`],
  );
}

/**
 * Refuse an organization outside the invocation's limit, before a request
 * to it.
 *
 * @param org - The organization a lookup asks
 * @param subject - What is looked up, for the error (`Issue 123`)
 * @throws {ResolutionError} When `org` is not the limit's organization
 */
export function assertOrgInScope(org: string, subject: string): void {
  const scope = getTargetScope();
  if (scope && org !== scope.org) {
    throw outsideScope(subject, scope);
  }
}

/**
 * Refuse something a lookup found outside the invocation's limit. Something
 * whose project is unknown is refused in a project-limited invocation.
 *
 * @param org - The organization it was found in
 * @param project - The slug of its project, if known
 * @param subject - What was found, for the error (`Event abc`)
 * @throws {ResolutionError} When it is in another organization or project
 */
export function assertProjectInScope(
  org: string,
  project: string | undefined,
  subject: string,
): void {
  assertOrgInScope(org, subject);
  const scope = getTargetScope();
  if (scope?.project && project !== scope.project) {
    throw outsideScope(subject, scope);
  }
}

/**
 * Refuse an issue outside the invocation's limit, as
 * {@link assertProjectInScope} does.
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
  assertProjectInScope(org, issue.project?.slug, `Issue ${issue.id}`);
}
