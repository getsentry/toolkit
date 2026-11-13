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
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  alertRuleDetailsSchema,
  getAlertRuleDetails,
} from "../support/alert-rule-details";
import {
  findExactMetricMonitorMatches,
  getMetricMonitor,
  metricMonitorDetailsSchema,
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

const LIST_HINT = "To list alert rules, use find_alert_rules.";

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

export const getAlertRuleOutputSchema = z.object({
  alertRule: alertRuleDetailsSchema
    .optional()
    .describe("Set when the match is an Issue Alert."),
  metricMonitor: metricMonitorDetailsSchema
    .optional()
    .describe("Set when the match is a Metric Monitor."),
  guidance: z.string().optional(),
});

export default defineTool({
  name: "get_alert_rule",
  title: "Get Alert Rule",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "Get details for one Sentry alert rule by ID or exact name.",
    "",
    "Use this tool when you need to inspect an alert rule's exact conditions, query, triggers, and actions before explaining or planning changes.",
    "To list or search alert rules, use find_alert_rules instead.",
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
      .string({
        // The SDK rejects a missing value before the handler runs, so this
        // message is the only hint for callers that wanted a list.
        error: `Required: one Alert ID or exact name. ${LIST_HINT}`,
      })
      .trim()
      .min(1, `Required: one Alert ID or exact name. ${LIST_HINT}`)
      .describe(
        "An Alert ID or exact name. Metric references accept legacy numeric alert-rule IDs or detector:123 for canonical monitor IDs.",
      ),
  },
  outputSchema: getAlertRuleOutputSchema,
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
    setTargetTagsAndAttributes({ organizationSlug, projectSlug });

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
        ...issueRules.map((rule): AlertRuleMatch => ({
          kind: "issue",
          rule,
          projectSlug,
        })),
      );

      const metricMonitors = await findExactMetricMonitorMatches(apiService, {
        organizationSlug,
        projectSlug,
        name: params.ruleIdOrName,
      });
      matches.push(
        ...metricMonitors.map((rule): AlertRuleMatch => ({
          kind: "metric",
          rule,
          projectSlug,
        })),
      );

      if (matches.length === 0) {
        throw new UserInputError(
          `Alert rule "${params.ruleIdOrName}" was not found. ${LIST_HINT}`,
        );
      }
      if (matches.length > 1) {
        throw new UserInputError(
          `Multiple alert rules named "${params.ruleIdOrName}" were found: ${matches.map(describeMatch).join(", ")}. Retry with the Alert ID and kind=issue, or use get_metric_monitor_details with the monitor ID. ${LIST_HINT}`,
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
