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
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Create a Sentry Alert (workflow) with notification actions and explicit sources.",
    "Use get_alert_options for available actions, integrations, conditions, and sources. All notification providers use their native config and data fields.",
    "To copy an Alert, read get_alert_rule(kind='issue') and pass its configuration here; component IDs are discarded while integration and destination IDs are retained. New trigger groups require logicType='any-short'.",
    "To reuse an existing Alert across projects, use update_alert_rule instead.",
    "Supply projectSlugs for project issue streams and/or detectorIds for individual monitors. Pass detectorIds=[] explicitly to create an Alert without sources; it will not send notifications until connected.",
    "New Alerts default to active with a 30-minute notification interval. Use status='disabled' to configure one before enabling it.",
    "Project-constrained sessions require sources exclusively within that project. All-project sources require Sentry's feature and org:write in addition to alerts:write.",
    "After a timeout or error, search for the Alert before retrying: creation may already have succeeded.",
    "<examples>",
    "create_alert_rule(organizationSlug='my-org', name='Backend notifications', status='disabled', detectorIds=[], actionFilters=[])",
    "</examples>",
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
      .describe("Projects whose issue streams should be connected."),
    detectorIds: z
      .array(z.string().regex(/^\d+$/))
      .optional()
      .describe(
        "Existing source IDs from get_alert_options. Pass [] explicitly for an Alert without sources.",
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
