/**
 * Shared issue alert rule reference parsing and resolution (view / delete / edit).
 */

import { MAX_PAGINATION_PAGES } from "../../../lib/api/infrastructure.js";
import {
  API_MAX_PER_PAGE,
  getIssueAlertRule,
  type IssueAlertRule,
  isNotFoundApiError,
  listIssueAlertsPaginated,
} from "../../../lib/api-client.js";
import { ResolutionError, ValidationError } from "../../../lib/errors.js";
import { fuzzyMatch } from "../../../lib/fuzzy.js";
import { logger } from "../../../lib/logger.js";
import type { ResolvedTarget } from "../../../lib/resolve-target.js";
import { isAllDigits } from "../../../lib/utils.js";

const log = logger.withTag("alert.issues");

export type IssueRuleResolution = {
  target: ResolvedTarget;
  rule: IssueAlertRule;
};

/**
 * Parse `org/project/<rule-id-or-name>` (two+ slashes) or a bare `rule-id-or-name` (no slashes).
 * A single `org/project` (exactly one slash) is invalid — the rule id or name is required.
 */
export function parseIssueRuleArg(
  arg: string,
  usageHint: string
): {
  ref: string;
  targetArg: string | undefined;
} {
  const trimmed = arg.trim();
  if (!trimmed) {
    throw new ValidationError(
      `Rule id or name is required.\nUse: ${usageHint}`,
      "rule"
    );
  }

  const slashCount = [...trimmed].filter((c) => c === "/").length;
  if (slashCount === 0) {
    return { ref: trimmed, targetArg: undefined };
  }
  if (slashCount === 1) {
    throw new ValidationError(
      `Missing rule id or name after the project (got '${trimmed}').\n` +
        `Use: ${usageHint}\n` +
        `Example: ${trimmed}/<rule-id-or-name>`,
      "rule"
    );
  }

  const lastSlash = trimmed.lastIndexOf("/");
  const targetPart = trimmed.slice(0, lastSlash).trim();
  const ref = trimmed.slice(lastSlash + 1).trim();
  if (!ref) {
    throw new ValidationError(
      `Invalid rule reference '${arg}'.\nUse: ${usageHint}`,
      "rule"
    );
  }
  return { ref, targetArg: targetPart || undefined };
}

/** List all issue alert rules for a project (paginated). */
export async function listAllIssueRulesForTarget(
  target: ResolvedTarget
): Promise<IssueAlertRule[]> {
  const all: IssueAlertRule[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const { data, nextCursor } = await listIssueAlertsPaginated(
      target.org,
      target.project,
      { perPage: API_MAX_PER_PAGE, cursor }
    );
    all.push(...data);
    if (!nextCursor) {
      return all;
    }
    cursor = nextCursor;
  }
  log.warn(
    `Pagination limit reached for issue alert rules in ${target.org}/${target.project}. Results may be incomplete.`
  );
  return all;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-target list + name resolution
export async function resolveIssueAlertRule(
  targets: ResolvedTarget[],
  ref: string,
  usageHint: string
): Promise<IssueRuleResolution> {
  if (isAllDigits(ref)) {
    const hits: IssueRuleResolution[] = [];
    for (const target of targets) {
      try {
        const rule = await getIssueAlertRule(target.org, target.project, ref);
        hits.push({ target, rule });
      } catch (e) {
        if (isNotFoundApiError(e)) {
          continue;
        }
        throw e;
      }
    }

    if (hits.length === 1) {
      return hits[0] as IssueRuleResolution;
    }
    if (hits.length > 1) {
      throw new ValidationError(
        `Alert rule ID '${ref}' matched multiple projects.\n` +
          "Use an explicit target: sentry alert issues <command> <org>/<project>/<rule-id>"
      );
    }
    throw new ResolutionError(
      `Issue alert rule '${ref}'`,
      "not found",
      usageHint
    );
  }

  const hits: IssueRuleResolution[] = [];
  const allRuleNames: string[] = [];

  for (const target of targets) {
    const rules = await listAllIssueRulesForTarget(target);
    for (const r of rules) {
      if (r.name) {
        allRuleNames.push(r.name);
      }
    }
    const exact = rules.find(
      (rule) => rule.name && rule.name.toLowerCase() === ref.toLowerCase()
    );
    if (exact) {
      hits.push({ target, rule: exact });
    }
  }

  if (hits.length === 1) {
    return hits[0] as IssueRuleResolution;
  }
  if (hits.length > 1) {
    throw new ValidationError(
      `Alert rule name '${ref}' matched multiple projects.\n` +
        "Use an explicit target: sentry alert issues <command> <org>/<project>/<rule-id-or-name>"
    );
  }

  const uniqueNames = [...new Set(allRuleNames)];
  const similar = fuzzyMatch(ref, uniqueNames, { maxResults: 5 });
  if (similar.length > 0) {
    const lines = similar.map((n) => `  ${n}`).join("\n");
    throw new ValidationError(
      `No issue alert rule named '${ref}' in the selected project(s).\n\n` +
        `Did you mean:\n${lines}`,
      "rule"
    );
  }

  throw new ResolutionError(
    `Issue alert rule '${ref}'`,
    "not found",
    usageHint
  );
}
