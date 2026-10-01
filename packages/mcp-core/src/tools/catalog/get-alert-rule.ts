import { z } from "zod";
import type { Detector, IssueAlertRule } from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlugOrAll,
  ParamRegionUrl,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { getAlertRuleDetails } from "../support/alert-rule-details";
import {
  findExactMetricMonitorMatches,
  getMetricMonitor,
  toMetricMonitorDetails,
} from "../support/metric-monitors";
import {
  findExactIssueAlertRuleMatches,
  resolveIssueAlertRule,
  resolveMetricAlertRule,
} from "./support/alerts";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

const AlertRuleKind = z
  .enum(["all", "issue", "metric"])
  .describe(
    "Which alert family to inspect. Numeric metric IDs are legacy alert-rule IDs, not monitor IDs. `all` performs an exact-name lookup.",
  );

type AlertRuleMatch =
  | {
      kind: "issue";
      rule: IssueAlertRule;
      projectSlug?: string;
    }
  | {
      kind: "metric";
      rule: Detector;
      projectSlug?: string;
    };

function describeMatch(match: AlertRuleMatch): string {
  const project = match.projectSlug ? ` project ${match.projectSlug}` : "";
  return `${match.kind} alert ${String(match.rule.id)} (${match.rule.name})${project}`;
}

export default defineTool({
  name: "get_alert_rule",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "Get details for a Sentry alert rule.",
    "",
    "Use this tool when you need to inspect an alert rule's exact conditions, query, triggers, and actions before explaining or planning changes.",
    "",
    "<examples>",
    "get_alert_rule(organizationSlug='my-org', kind='metric', ruleIdOrName='12345')",
    "get_alert_rule(organizationSlug='my-org', kind='issue', projectSlug='backend', ruleIdOrName='Notify backend team')",
    "get_alert_rule(organizationSlug='my-org', projectSlug='backend', ruleIdOrName='P95 latency')",
    "</examples>",
    "",
    "<hints>",
    "- Prefer get_metric_monitor_details for Metric Monitors. With kind=metric, numeric IDs retain their legacy alert-rule meaning; detector:123 explicitly identifies monitor 123.",
    "- With `kind='all'`, a digit-only `ruleIdOrName` is treated as an exact alert rule name.",
    "- Issue Alerts are notification workflows and may cover multiple projects or have no connected sources. Omit projectSlug to inspect organization-wide.",
    "- Issue details include complete conditions, notification actions, connected monitors and project scope. Inaccessible or session-restricted sources are marked explicitly.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    kind: AlertRuleKind.default("all"),
    projectSlug: ParamProjectSlugOrAll.nullable().default(null),
    ruleIdOrName: z
      .string()
      .trim()
      .min(1)
      .describe(
        "An Alert ID or exact name. Metric references accept legacy numeric alert-rule IDs or detector:123 for canonical monitor IDs.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const requestedProjectSlug =
      params.projectSlug && params.projectSlug !== "all"
        ? params.projectSlug
        : undefined;
    if (requestedProjectSlug) {
      assertProjectRefWithinConstraint({
        resourceLabel: "Alert rule",
        scopedProjectSlug: context.constraints.projectSlug,
        project: { slug: requestedProjectSlug },
      });
    }
    const projectSlug = context.constraints.projectSlug ?? requestedProjectSlug;

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTagAndAttribute("organization.slug", organizationSlug);
    if (projectSlug) {
      setTagAndAttribute("project.slug", projectSlug);
    }

    let match: AlertRuleMatch;
    if (params.kind === "issue") {
      const rule = await resolveIssueAlertRule(apiService, {
        organizationSlug,
        projectSlug,
        ruleIdOrName: params.ruleIdOrName,
      });
      match = { kind: "issue", rule, projectSlug };
    } else if (params.kind === "metric") {
      const rule = await resolveMetricAlertRule(apiService, {
        organizationSlug,
        projectSlug,
        ruleIdOrName: params.ruleIdOrName,
      });
      match = { kind: "metric", rule, projectSlug };
    } else {
      const matches: AlertRuleMatch[] = [];
      const issueRules = await findExactIssueAlertRuleMatches(apiService, {
        organizationSlug,
        projectSlug,
        ruleName: params.ruleIdOrName,
      });
      matches.push(
        ...issueRules.map(
          (rule): AlertRuleMatch => ({ kind: "issue", rule, projectSlug }),
        ),
      );

      const metricMonitors = await findExactMetricMonitorMatches(apiService, {
        organizationSlug,
        projectSlug,
        name: params.ruleIdOrName,
      });
      matches.push(
        ...metricMonitors.map(
          (rule): AlertRuleMatch => ({
            kind: "metric",
            rule,
            projectSlug,
          }),
        ),
      );

      if (matches.length === 0) {
        throw new UserInputError(
          `Alert rule "${params.ruleIdOrName}" was not found.`,
        );
      }
      if (matches.length > 1) {
        throw new UserInputError(
          `Multiple alert rules named "${params.ruleIdOrName}" were found: ${matches.map(describeMatch).join(", ")}. Retry with the Alert ID and kind=issue, or use get_metric_monitor_details with the monitor ID.`,
        );
      }
      const [found] = matches;
      match =
        found.kind === "issue"
          ? {
              ...found,
              rule: await apiService.getIssueAlertRule({
                organizationSlug,
                projectSlug: found.projectSlug,
                ruleId: found.rule.id,
              }),
            }
          : {
              ...found,
              rule: await getMetricMonitor(apiService, {
                organizationSlug,
                projectSlug,
                monitorId: found.rule.id,
              }),
            };
    }

    if (match.kind === "issue") {
      return structuredResult({
        alertRule: await getAlertRuleDetails(
          apiService,
          organizationSlug,
          match.rule,
          context.constraints.projectSlug,
        ),
      });
    }

    return structuredResult({
      metricMonitor: toMetricMonitorDetails(
        apiService,
        organizationSlug,
        match.rule,
      ),
      guidance:
        "Use get_metric_monitor_details with this monitor's id for canonical Metric Monitor inspection. Connected notification Alerts are identified by workflowIds.",
    });
  },
});
