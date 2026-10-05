/** Shared helpers for alert list commands. */

import { ApiError, ValidationError } from "../../lib/errors.js";
import { LIST_MAX_LIMIT } from "../../lib/list-command.js";
import {
  type FetchGroupsOptions,
  type FetchResult,
  fetchGroupsWithBudget,
  type ListFetchPage,
} from "../../lib/org-list.js";

/** Alert rules with the cursor metadata used by shared list fetching. */
export type AlertRuleFetchPage<TRule> = ListFetchPage & {
  /** Rules returned for this group. */
  rules: TRule[];
};

type BudgetOptions<
  TGroup,
  TRule,
  TPage extends AlertRuleFetchPage<TRule>,
> = Omit<FetchGroupsOptions<TGroup, TRule, TPage>, "getItems">;

export function assertAlertListLimit(limit: number): void {
  if (limit < 1) {
    throw new ValidationError("--limit must be at least 1.", "limit");
  }
  if (limit > LIST_MAX_LIMIT) {
    throw new ValidationError(
      `--limit cannot exceed ${LIST_MAX_LIMIT}. ` +
        "Use --cursor to paginate through larger result sets.",
      "limit"
    );
  }
}

export function throwAlertListFetchFailure(
  prefix: string,
  error: Error
): never {
  if (!(error instanceof ApiError)) {
    throw new Error(`${prefix}: ${error.message}`);
  }
  throw new ApiError(
    `${prefix}: ${error.message}`,
    error.status,
    error.detail,
    error.endpoint,
    error.enriched403
  );
}

export function buildAlertListFailureErrors<TKey extends string, TFailure>(
  failures: TFailure[],
  labelKey: TKey,
  getLabel: (failure: TFailure) => string,
  getError: (failure: TFailure) => Error
): (Record<TKey, string> & { status?: number; message: string })[] | undefined {
  if (failures.length === 0) {
    return;
  }
  return failures.map((failure) => {
    const error = getError(failure);
    return {
      [labelKey]: getLabel(failure),
      ...(error instanceof ApiError && { status: error.status }),
      message: error.message,
    } as Record<TKey, string> & { status?: number; message: string };
  });
}

/** Preserve the alert page shape while sharing budget and cursor handling. */
export function fetchAlertRulesWithBudget<
  TGroup,
  TRule,
  TPage extends AlertRuleFetchPage<TRule>,
>(
  groups: TGroup[],
  options: BudgetOptions<TGroup, TRule, TPage>
): Promise<{ results: FetchResult<TPage>[]; hasMore: boolean }> {
  return fetchGroupsWithBudget<TGroup, TRule, TPage>(groups, {
    ...options,
    getItems: (page) => page.rules,
  });
}
