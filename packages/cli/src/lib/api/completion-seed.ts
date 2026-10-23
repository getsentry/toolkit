/**
 * Seed the shell-completion cache from API responses.
 *
 * Issue and dashboard API functions call these after a successful fetch so
 * `sentry __complete` can suggest what the user has already seen without an
 * API call (see `src/lib/db/completion-cache.ts`). Failures are reported and
 * swallowed: a cache problem must never fail the command that fetched the
 * data.
 */

import type { SentryIssue } from "../../types/index.js";
import {
  type CompletionEntity,
  type CompletionEntityKind,
  cacheCompletionEntities,
  DASHBOARD_ENTITY,
  ISSUE_ENTITY,
} from "../db/completion-cache.js";
import { reportCliError } from "../error-reporting.js";
import { logger } from "../logger.js";
import { isAllDigits } from "../utils.js";

const log = logger.withTag("completion-seed");

function seed(
  kind: CompletionEntityKind,
  orgSlug: string,
  entities: CompletionEntity[],
): void {
  try {
    cacheCompletionEntities(kind, orgSlug, entities);
  } catch (error) {
    log.debug(`Failed to cache ${kind} completions for '${orgSlug}'`, error);
    reportCliError(error);
  }
}

/**
 * Remember issues by short ID, with the title as description.
 *
 * @param orgSlug - Organization the issues belong to
 * @param issues - Issues in display order
 */
export function seedIssueCompletions(
  orgSlug: string,
  issues: readonly Pick<SentryIssue, "shortId" | "title">[],
): void {
  seed(
    ISSUE_ENTITY,
    orgSlug,
    issues.map((issue) => ({
      value: issue.shortId ?? "",
      label: issue.title,
    })),
  );
}

/**
 * Remember dashboards by ID, with the title as description.
 *
 * Only numeric IDs are kept: dashboard commands read `<org>/<id>` as an ID
 * only when the ID is numeric, so other IDs could not be completed in that
 * form.
 *
 * @param orgSlug - Organization the dashboards belong to
 * @param dashboards - Dashboards in display order
 */
export function seedDashboardCompletions(
  orgSlug: string,
  dashboards: readonly { id: string; title: string }[],
): void {
  seed(
    DASHBOARD_ENTITY,
    orgSlug,
    dashboards
      .filter((dashboard) => isAllDigits(dashboard.id))
      .map((dashboard) => ({ value: dashboard.id, label: dashboard.title })),
  );
}
