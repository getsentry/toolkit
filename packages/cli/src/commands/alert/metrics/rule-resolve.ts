/**
 * Shared metric alert rule reference parsing and resolution (view / delete / edit).
 */

import { MAX_PAGINATION_PAGES } from "../../../lib/api/infrastructure.js";
import {
  API_MAX_PER_PAGE,
  getMetricAlertRule,
  isNotFoundApiError,
  listMetricAlertsPaginated,
  type MetricAlertRule,
} from "../../../lib/api-client.js";
import { ResolutionError, ValidationError } from "../../../lib/errors.js";
import { fuzzyMatch } from "../../../lib/fuzzy.js";
import { logger } from "../../../lib/logger.js";
import { isAllDigits } from "../../../lib/utils.js";

const log = logger.withTag("alert.metrics");

export type MetricRuleResolution = {
  orgSlug: string;
  rule: MetricAlertRule;
};

/**
 * Parse `org/<rule-id-or-name>` (one slash), or bare `rule-id-or-name` for auto-detect.
 * Trailing-only org is invalid (empty ref).
 */
export function parseMetricRuleArg(
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

  if (!trimmed.includes("/")) {
    return { ref: trimmed, targetArg: undefined };
  }

  const slashCount = [...trimmed].filter((c) => c === "/").length;
  if (slashCount > 1) {
    throw new ValidationError(
      `Metric alerts are org-scoped — use '<org>/<rule-id-or-name>', not '<org>/<project>/<rule>'.\nUse: ${usageHint}`,
      "rule"
    );
  }

  const lastSlash = trimmed.lastIndexOf("/");
  const targetPart = trimmed.slice(0, lastSlash).trim();
  const ref = trimmed.slice(lastSlash + 1).trim();
  if (!ref) {
    throw new ValidationError(
      `Invalid rule reference '${arg}' (missing id or name after org).\nUse: ${usageHint}`,
      "rule"
    );
  }
  return { ref, targetArg: targetPart ? `${targetPart}/` : undefined };
}

export async function listAllMetricRulesForOrg(
  orgSlug: string
): Promise<MetricAlertRule[]> {
  const all: MetricAlertRule[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const { data, nextCursor } = await listMetricAlertsPaginated(orgSlug, {
      perPage: API_MAX_PER_PAGE,
      cursor,
    });
    all.push(...data);
    if (!nextCursor) {
      return all;
    }
    cursor = nextCursor;
  }
  log.warn(
    `Pagination limit reached for metric alert rules in ${orgSlug}. Results may be incomplete.`
  );
  return all;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-org list + name resolution
export async function resolveMetricAlertRule(
  orgSlugs: string[],
  ref: string,
  usageHint: string
): Promise<MetricRuleResolution> {
  if (isAllDigits(ref)) {
    const hits: MetricRuleResolution[] = [];
    for (const orgSlug of orgSlugs) {
      try {
        const rule = await getMetricAlertRule(orgSlug, ref);
        hits.push({ orgSlug, rule });
      } catch (e) {
        if (isNotFoundApiError(e)) {
          continue;
        }
        throw e;
      }
    }

    if (hits.length === 1) {
      return hits[0] as MetricRuleResolution;
    }
    if (hits.length > 1) {
      throw new ValidationError(
        `Alert rule ID '${ref}' matched multiple organizations.\n` +
          "Use an explicit target: sentry alert metrics <command> <org>/<rule-id>"
      );
    }
    throw new ResolutionError(
      `Metric alert rule '${ref}'`,
      "not found",
      usageHint
    );
  }

  const hits: MetricRuleResolution[] = [];
  const allNames: string[] = [];

  for (const orgSlug of orgSlugs) {
    const rules = await listAllMetricRulesForOrg(orgSlug);
    for (const r of rules) {
      if (r.name) {
        allNames.push(r.name);
      }
    }
    const exact = rules.find(
      (rule) => rule.name && rule.name.toLowerCase() === ref.toLowerCase()
    );
    if (exact) {
      hits.push({ orgSlug, rule: exact });
    }
  }

  if (hits.length === 1) {
    return hits[0] as MetricRuleResolution;
  }
  if (hits.length > 1) {
    throw new ValidationError(
      `Alert rule name '${ref}' matched multiple organizations.\n` +
        "Use an explicit target: sentry alert metrics <command> <org>/<rule-id-or-name>"
    );
  }

  const uniqueNames = [...new Set(allNames)];
  const similar = fuzzyMatch(ref, uniqueNames, { maxResults: 5 });
  if (similar.length > 0) {
    const lines = similar.map((n) => `  ${n}`).join("\n");
    throw new ValidationError(
      `No metric alert rule named '${ref}' in the selected organization(s).\n\n` +
        `Did you mean:\n${lines}`,
      "rule"
    );
  }

  throw new ResolutionError(
    `Metric alert rule '${ref}'`,
    "not found",
    usageHint
  );
}
