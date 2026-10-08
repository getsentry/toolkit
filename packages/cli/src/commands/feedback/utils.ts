/**
 * Shared resolution utilities for modern User Feedback commands.
 */

import { listFeedback } from "../../lib/api-client.js";
import { type IssueSelector, parseIssueArg } from "../../lib/arg-parsing.js";
import {
  ApiError,
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import { resolveEffectiveOrg } from "../../lib/region.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import { setOrgProjectContext } from "../../lib/telemetry.js";
import type { SentryFeedback } from "../../types/index.js";
import { buildCommandHint, resolveIssue } from "../issue/utils.js";

/** Positional parameter for a Feedback selector or issue-style identifier. */
export const feedbackIdPositional = {
  kind: "tuple",
  parameters: [
    {
      placeholder: "feedback",
      brief:
        "Feedback: @latest, numeric ID, short ID, <org>/SHORT-ID, or <org>/<project>/<suffix>",
      parse: String,
    },
  ],
} as const;

/** Result of resolving and category-checking a modern Feedback issue. */
export type ResolvedFeedback = {
  /** Resolved organization slug, when available. */
  org: string | undefined;
  /** Category-constrained Feedback issue. */
  feedback: SentryFeedback;
};

/** Resolve a supported Feedback selector inside the mandatory Feedback category. */
async function resolveFeedbackSelector(
  selector: IssueSelector,
  explicitOrg: string | undefined,
  cwd: string,
  command: string,
): Promise<ResolvedFeedback> {
  if (selector !== "@latest") {
    throw new ValidationError(
      "Feedback only supports @latest; @most_frequent is not meaningful for Feedback.",
      "feedback selector",
    );
  }

  const org = explicitOrg
    ? await resolveEffectiveOrg(explicitOrg)
    : (await resolveOrg({ cwd }))?.org;
  if (!org) {
    throw new ContextError(
      "Organization",
      `sentry feedback ${command} <org>/@latest`,
    );
  }

  const { feedback } = await listFeedback(org, "", {
    limit: 1,
    status: "unresolved",
  });
  const latest = feedback[0];
  if (!latest) {
    throw new ResolutionError(
      "Selector '@latest'",
      "found no unresolved User Feedback",
      `sentry feedback list ${org}/ --status all`,
      ["The @latest selector only matches unresolved Feedback."],
    );
  }

  setOrgProjectContext(
    [org],
    latest.project?.slug ? [latest.project.slug] : [],
  );
  return { org, feedback: latest };
}

/**
 * Resolve an issue-style identifier or the newest unresolved Feedback via
 * `@latest`, and require the result to remain inside the Feedback category.
 * The command name keeps recovery hints aligned with the caller's operation.
 */
export async function resolveFeedback(
  feedbackArg: string,
  cwd: string,
  command = "view",
): Promise<ResolvedFeedback> {
  const parsed = parseIssueArg(feedbackArg);
  if (parsed.type === "selector") {
    return resolveFeedbackSelector(parsed.selector, parsed.org, cwd, command);
  }

  let resolved: Awaited<ReturnType<typeof resolveIssue>>;
  try {
    resolved = await resolveIssue({
      issueArg: feedbackArg,
      cwd,
      command,
      commandBase: "sentry feedback",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ResolutionError(
        `Feedback '${feedbackArg}'`,
        "not found",
        buildCommandHint(command, feedbackArg, "sentry feedback"),
        ["List available Feedback: sentry feedback list"],
      );
    }
    throw error;
  }
  const { org, issue } = resolved;

  if (issue.issueCategory !== "feedback") {
    throw new ResolutionError(
      `Issue '${issue.shortId}'`,
      "is not User Feedback",
      `sentry issue view ${org ? `${org}/` : ""}${issue.shortId}`,
      ["Use a Feedback ID from: sentry feedback list"],
    );
  }

  return { org, feedback: issue as SentryFeedback };
}
