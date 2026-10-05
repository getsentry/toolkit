import type { SentryApiService } from "../../../api-client";
import { ApiClientError, ApiNotFoundError } from "../../../api-client";
import type { Detector, IssueAlertRule } from "../../../api-client/types";
import { UserInputError } from "../../../errors";
import {
  findExactMetricMonitorMatches,
  getMetricMonitor,
} from "../../support/metric-monitors";

export function isNumericAlertRuleId(value: string): boolean {
  return /^\d+$/.test(value);
}

/** Resolve case-insensitive names only when the search results are complete. */
export async function findExactIssueAlertRuleMatches(
  apiService: SentryApiService,
  params: {
    organizationSlug: string;
    projectSlug?: string;
    ruleName: string;
  },
): Promise<IssueAlertRule[]> {
  const page = await apiService.listIssueAlertRulesPage({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    query: params.ruleName,
    limit: 100,
  });
  if (page.nextCursor) {
    throw new UserInputError(
      "Alert name search is incomplete. Find the Alert with find_alert_rules and retry with its numeric ID and explicit kind.",
    );
  }
  return page.rules.filter(
    (rule) => rule.name.toLowerCase() === params.ruleName.toLowerCase(),
  );
}

export async function resolveIssueAlertRule(
  apiService: SentryApiService,
  params: {
    organizationSlug: string;
    projectSlug?: string;
    ruleIdOrName: string;
  },
): Promise<IssueAlertRule> {
  if (isNumericAlertRuleId(params.ruleIdOrName)) {
    try {
      return await apiService.getIssueAlertRule({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        ruleId: params.ruleIdOrName,
      });
    } catch (error) {
      if (!(error instanceof ApiNotFoundError)) {
        throw error;
      }
    }
  }

  const matches = await findExactIssueAlertRuleMatches(apiService, {
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    ruleName: params.ruleIdOrName,
  });

  if (matches.length === 1) {
    return apiService.getIssueAlertRule({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      ruleId: matches[0].id,
    });
  }
  if (matches.length > 1) {
    throw new UserInputError(
      `Multiple issue alert rules named "${params.ruleIdOrName}" were found. Retry with the numeric rule ID.`,
    );
  }
  throw new UserInputError(
    `Issue alert rule "${params.ruleIdOrName}" was not found${params.projectSlug ? ` in project ${params.projectSlug}` : ""}.`,
  );
}

/** Bare numeric references retain their legacy alert-rule identity. */
export async function resolveMetricAlertRule(
  apiService: SentryApiService,
  params: {
    organizationSlug: string;
    projectSlug?: string;
    ruleIdOrName: string;
  },
): Promise<Detector> {
  const { organizationSlug, projectSlug, ruleIdOrName } = params;
  let monitorId: string;
  if (/^detector:\d+$/.test(ruleIdOrName)) {
    monitorId = ruleIdOrName.slice("detector:".length);
  } else if (isNumericAlertRuleId(ruleIdOrName)) {
    try {
      monitorId = await apiService.getDetectorForAlertRule({
        organizationSlug,
        alertRuleId: ruleIdOrName,
      });
    } catch (error) {
      if (
        !(error instanceof ApiClientError) ||
        (error.status !== 404 && error.status !== 410)
      ) {
        throw error;
      }
      throw new UserInputError(
        `Legacy metric alert "${ruleIdOrName}" could not be mapped to a monitor. Use find_metric_monitors, then get_metric_monitor_details with its monitor ID.`,
      );
    }
  } else {
    const matches = await findExactMetricMonitorMatches(apiService, {
      organizationSlug,
      projectSlug,
      name: ruleIdOrName,
    });
    if (matches.length !== 1) {
      throw new UserInputError(
        matches.length > 1
          ? `Multiple metric monitors named "${ruleIdOrName}" were found. Use find_metric_monitors and get_metric_monitor_details with a monitor ID.`
          : `Metric monitor "${ruleIdOrName}" was not found. Use find_metric_monitors to find its monitor ID.`,
      );
    }
    monitorId = matches[0].id;
  }
  return getMetricMonitor(apiService, {
    organizationSlug,
    projectSlug,
    monitorId,
  });
}
