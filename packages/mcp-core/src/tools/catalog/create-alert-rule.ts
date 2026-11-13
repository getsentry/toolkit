import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  alertRuleConfigFields,
  alertRuleSummarySchema,
  assertResolvedAlertDestinations,
  ParamNewAlertActionFilters,
  ParamNewAlertTriggers,
  toAlertRuleSummary,
} from "../support/alert-rule-config";
import { resolveAlertRuleConnections } from "../support/alert-rule-connections";

export default defineTool({
  name: "create_alert_rule",
  title: "Create Alert Rule",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Create a Sentry Alert (notification workflow) that sends Slack, email, PagerDuty, or other notifications when its connected issue streams or monitors trigger.",
    "get_alert_options lists valid actions, conditions, and sources; update_alert_rule adds sources to an existing Alert.",
    "Monitors are separate tools: find_metric_monitors (metric thresholds), find_monitors (cron jobs), find_uptime_monitors (URL checks).",
    "After a timeout or error, search for the Alert before retrying: it may already exist.",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    ...alertRuleConfigFields,
    name: alertRuleConfigFields.name.unwrap(),
    status: alertRuleConfigFields.status.default("active"),
    frequencyMinutes: alertRuleConfigFields.frequencyMinutes.default(30),
    triggers: ParamNewAlertTriggers.nullable().optional(),
    actionFilters: ParamNewAlertActionFilters,
    projectSlugs: z
      .array(ParamProjectSlug)
      .optional()
      .describe(
        "Projects whose issue streams to connect. Set this, detector IDs, or both.",
      ),
    detectorIds: z
      .array(z.string().regex(/^\d+$/))
      .optional()
      .describe(
        "Monitor source IDs from get_alert_options. Pass [] for an Alert with no sources; it sends nothing until connected. An all-project source also needs org:write.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  outputSchema: z.object({
    alertRule: alertRuleSummarySchema,
    guidance: z.string().optional(),
  }),
  async handler(params, context: ServerContext) {
    if (params.projectSlugs === undefined && params.detectorIds === undefined) {
      throw new UserInputError(
        "Specify projectSlugs or detectorIds. Pass detectorIds=[] explicitly to create an Alert without sources.",
      );
    }
    const api = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    setTargetTagsAndAttributes(params);
    const project = context.constraints.projectSlug
      ? await api.getProject({
          organizationSlug: params.organizationSlug,
          projectSlugOrId: context.constraints.projectSlug,
        })
      : undefined;
    const detectorIds = await resolveAlertRuleConnections(api, {
      organizationSlug: params.organizationSlug,
      currentDetectorIds: [],
      addProjectSlugs: params.projectSlugs,
      addDetectorIds: params.detectorIds,
      scopedProject: project
        ? { id: String(project.id), slug: project.slug }
        : undefined,
    });
    const created = await api.createAlertRule({
      organizationSlug: params.organizationSlug,
      body: {
        name: params.name,
        enabled: params.status === "active",
        config: { frequency: params.frequencyMinutes },
        environment: params.environment,
        owner: params.owner,
        triggers: params.triggers?.conditions.length
          ? params.triggers
          : undefined,
        actionFilters: params.actionFilters,
        detectorIds,
      },
    });
    const alertRule = toAlertRuleSummary(
      created,
      api.getIssueAlertRuleUrl(params.organizationSlug, created.id),
    );
    assertResolvedAlertDestinations(alertRule, "create");
    return structuredResult({
      alertRule,
      ...(alertRule.detectorIds.length === 0
        ? {
            guidance:
              "This Alert has no sources and will not send notifications until connected using update_alert_rule.",
          }
        : {}),
    });
  },
});
