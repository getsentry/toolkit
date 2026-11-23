/**
 * Re-export of issue parsing utilities for tool modules.
 * These utilities handle flexible input formats for Sentry issues.
 */
import type { SentryApiService } from "../../api-client";
import type { Issue } from "../../api-client/types";
import { assertScopedProjectSlug } from "../url-scope";

export { parseIssueParams } from "../../internal/issue-helpers";

export function assertIssueWithinProjectConstraint({
  issue,
  projectSlug,
  resourceLabel = "Issue",
}: {
  issue: Pick<Issue, "project">;
  projectSlug?: string | null | undefined;
  resourceLabel?: string;
}): void {
  assertScopedProjectSlug({
    resourceLabel,
    scopedProjectSlug: projectSlug,
    actualProjectSlug: issue.project.slug,
  });
}

export async function ensureIssueWithinProjectConstraint({
  apiService,
  organizationSlug,
  issueId,
  projectSlug,
  resourceLabel = "Issue",
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  issueId: string;
  projectSlug?: string | null | undefined;
  resourceLabel?: string;
}): Promise<void> {
  if (!projectSlug) {
    return;
  }

  const issue = await apiService.getIssue({
    organizationSlug,
    issueId,
  });

  assertIssueWithinProjectConstraint({
    issue,
    projectSlug,
    resourceLabel,
  });
}

/**
 * Whether an issue's events live in the errors dataset. Every other issue
 * type, such as performance, cron, uptime, or metric issues, lives in the
 * issue platform, as in Sentry's issue type config (`usesIssuePlatform`).
 */
export function isErrorIssue(
  issue: Pick<Issue, "issueCategory" | "type">,
): boolean {
  return issue.issueCategory === "error" || issue.type === "error";
}
