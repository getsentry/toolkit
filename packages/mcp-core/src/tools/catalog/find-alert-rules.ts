import { z } from "zod";
import type { IssueAlertRule } from "../../api-client/types";
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
  getMetricMonitorReference,
  listMetricMonitors,
  toMetricMonitorDetails,
} from "../support/metric-monitors";
import { formatActor, formatDate } from "./support/api-formatting";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

const AlertRuleKind = z
  .enum(["all", "issue", "metric"])
  .describe(
    "Which alert rule family to search. Use `all` to include Alerts (workflows) and Metric Monitors.",
  );

const issueAlertRuleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().nullable(),
  actionMatch: z.string().nullable(),
  filterMatch: z.string().nullable(),
  frequencyMinutes: z.number().nullable(),
  environment: z.string().nullable(),
  owner: z.string().nullable(),
  dateCreated: z.string().nullable(),
  dateUpdated: z.string().nullable(),
  lastTriggered: z.string().nullable(),
  webUrl: z.string(),
});

const metricAlertRuleSummarySchema = z.object({
  id: z
    .string()
    .describe(
      "Legacy alert-rule ID when available, otherwise detector:<monitorId>.",
    ),
  monitorId: z.string(),
  projectId: z.string().nullable(),
  enabled: z.boolean(),
  name: z.string(),
  status: z.enum(["enabled", "disabled"]),
  dataset: z.string().nullable(),
  aggregate: z.string().nullable(),
  query: z.string().nullable(),
  timeWindowMinutes: z.number().nullable(),
  environment: z.string().nullable(),
  owner: z.string().nullable(),
  dateCreated: z.string().nullable(),
  webUrl: z.string(),
});

const paginationStateSchema = z.object({
  nextCursor: z.string().nullable(),
});

export const findAlertRulesOutputSchema = z.object({
  issueRules: z.array(issueAlertRuleSummarySchema),
  metricRules: z.array(metricAlertRuleSummarySchema),
  pagination: z.object({
    issue: paginationStateSchema.nullable(),
    metric: paginationStateSchema.nullable(),
  }),
  metricMonitorHint: z.string().optional(),
});

function getIssueAlertRuleFrequency(rule: IssueAlertRule): number | null {
  if (typeof rule.frequency === "number") {
    return rule.frequency;
  }
  const frequency = rule.config.frequency;
  return typeof frequency === "number" ? frequency : null;
}

function getIssueAlertRuleStatus(rule: IssueAlertRule): string | null {
  if (rule.status) {
    return rule.status;
  }
  if (rule.enabled === undefined) {
    return null;
  }
  return rule.enabled ? "enabled" : "disabled";
}

function getOwner(owner: unknown): string | null {
  return owner ? formatActor(owner) : null;
}

export default defineTool({
  name: "find_alert_rules",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "Find Sentry alert rules.",
    "",
    "Use this tool when you need to:",
    "- List Alerts (workflows) for an organization or project, including Alerts without connected sources",
    "- List Metric Monitors using compatibility references; prefer find_metric_monitors for canonical monitor IDs",
    "- Find an alert rule ID by name before inspecting it",
    "- Check alert conditions, queries, triggers, actions, owner, or environment",
    "",
    "<examples>",
    "find_alert_rules(organizationSlug='my-org')",
    "find_alert_rules(organizationSlug='my-org', projectSlug='backend')",
    "find_alert_rules(organizationSlug='my-org', kind='issue', projectSlug='backend', query='critical')",
    "</examples>",
    "",
    "<hints>",
    "- Omit `projectSlug` to search organization-wide. A project filter finds connected Alerts, which may also cover other projects.",
    "- Metric entries expose monitorId and projectId. id retains a legacy alert-rule ID when available, otherwise detector:<monitorId>. status describes enabled/disabled monitoring, not a legacy alert status.",
    "- Issue and metric alert rules have independent pagination state. Reuse a nextCursor only with its matching kind.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    kind: AlertRuleKind.default("all"),
    projectSlug: ParamProjectSlugOrAll.nullable().default(null),
    query: z
      .string()
      .trim()
      .describe("Optional search query for alert rule name.")
      .nullable()
      .default(null),
    cursor: z
      .string()
      .trim()
      .describe(
        "Optional pagination cursor from a previous Sentry API response.",
      )
      .nullable()
      .default(null),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .describe("Maximum number of alert rules to return per alert family.")
      .default(10),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findAlertRulesOutputSchema,
  async handler(params, context: ServerContext) {
    const requestedProjectSlug =
      params.projectSlug && params.projectSlug !== "all"
        ? params.projectSlug
        : undefined;
    if (requestedProjectSlug) {
      assertProjectRefWithinConstraint({
        resourceLabel: "Alert rule list",
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

    const includeIssue = params.kind !== "metric";
    const includeMetric = params.kind !== "issue";
    if (params.cursor && includeIssue && includeMetric) {
      throw new UserInputError(
        "cursor cannot be used with `kind='all'` when both issue and metric alert rules are included. Retry with `kind='issue'` or `kind='metric'` using a cursor from the same alert rule family.",
      );
    }
    const issuePage = includeIssue
      ? await apiService.listIssueAlertRulesPage({
          organizationSlug,
          projectSlug,
          query: params.query ?? undefined,
          cursor: params.cursor ?? undefined,
          limit: params.limit,
        })
      : { rules: [], nextCursor: null };
    const metricPage = includeMetric
      ? await listMetricMonitors(apiService, {
          organizationSlug,
          projectSlug,
          query: params.query
            ? `name:${JSON.stringify(`*${params.query}*`)}`
            : undefined,
          cursor: params.cursor ?? undefined,
          limit: params.limit,
        })
      : null;
    return structuredResult({
      issueRules: issuePage.rules.map((rule: IssueAlertRule) => ({
        id: String(rule.id),
        name: rule.name,
        status: getIssueAlertRuleStatus(rule),
        actionMatch: rule.actionMatch ?? null,
        filterMatch: rule.filterMatch ?? null,
        frequencyMinutes: getIssueAlertRuleFrequency(rule),
        environment: rule.environment ?? null,
        owner: getOwner(rule.owner),
        dateCreated: formatDate(rule.dateCreated),
        dateUpdated: formatDate(rule.dateUpdated),
        lastTriggered: formatDate(rule.lastTriggered),
        webUrl: apiService.getIssueAlertRuleUrl(organizationSlug, rule.id),
      })),
      metricRules: (metricPage?.detectors ?? []).map((detector) => {
        const monitor = toMetricMonitorDetails(
          apiService,
          organizationSlug,
          detector,
        );
        const source = monitor.dataSources.find(
          (source) => source.type === "snuba_query_subscription",
        );
        const query = source && "query" in source ? source.query : undefined;
        return {
          id: getMetricMonitorReference(detector),
          monitorId: monitor.id,
          projectId: monitor.projectId,
          enabled: monitor.enabled,
          name: monitor.name,
          status: monitor.enabled ? "enabled" : "disabled",
          dataset: query?.dataset ?? null,
          aggregate: query?.aggregate ?? null,
          query: query?.query ?? null,
          timeWindowMinutes: query ? query.timeWindowSeconds / 60 : null,
          environment: query?.environment ?? null,
          owner: monitor.owner,
          dateCreated: monitor.dateCreated,
          webUrl: monitor.webUrl,
        };
      }),
      pagination: {
        issue: includeIssue ? { nextCursor: issuePage.nextCursor } : null,
        metric: metricPage ? { nextCursor: metricPage.nextCursor } : null,
      },
      ...(includeMetric
        ? {
            metricMonitorHint:
              "Use get_metric_monitor_details with monitorId. Legacy get_alert_rule(kind=metric) accepts each entry's id; never pass monitorId as a bare legacy ID.",
          }
        : {}),
    });
  },
});
