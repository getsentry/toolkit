import { z } from "zod";
import type { AlertRuleUpdate, IssueAlertRule } from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { isPlainObject } from "../../internal/type-guards";
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
  ParamAlertActionFilters,
  ParamAlertTriggers,
  toAlertRuleSummary,
} from "../support/alert-rule-config";
import {
  resolveAlertRuleConnections,
  validateAlertRuleProjectScope,
} from "../support/alert-rule-connections";
import {
  findExactIssueAlertRuleMatches,
  isNumericAlertRuleId,
} from "./support/alerts";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

// Owns workflow configuration and connection edits; constrained writes must remain exclusive.

export const updateAlertRuleOutputSchema = z.object({
  alertRule: alertRuleSummarySchema,
});

/** Preserve copied actions while asking Sentry to resolve a changed Slack destination. */
function resolveChangedSlackDestinations(
  groups: z.infer<typeof ParamAlertActionFilters>,
  current: IssueAlertRule,
): z.infer<typeof ParamAlertActionFilters> {
  const previousActions = (current.actionFilters ?? []).flatMap((group) =>
    Array.isArray(group.actions) ? group.actions.filter(isPlainObject) : [],
  );
  return groups.map((group) => ({
    ...group,
    actions: group.actions.map((action) => {
      const previous = previousActions.find(
        (candidate) =>
          action.id !== undefined && String(candidate.id) === String(action.id),
      );
      if (
        action.type !== "slack" ||
        !previous ||
        !isPlainObject(previous.config) ||
        typeof action.config.targetDisplay !== "string" ||
        action.config.targetDisplay.length === 0 ||
        (action.config.targetDisplay === previous.config.targetDisplay &&
          String(action.integrationId) === String(previous.integrationId)) ||
        action.config.targetIdentifier !== previous.config.targetIdentifier
      ) {
        return action;
      }
      // Slack validates a supplied ID against the name and workspace; discard a copied stale ID.
      const config = { ...action.config };
      delete config.targetIdentifier;
      return { ...action, config };
    }),
  }));
}

export default defineTool({
  name: "update_alert_rule",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Update a Sentry Alert (workflow), including notification actions and connections.",
    "Use get_alert_rule with kind='issue' first to inspect the complete triggers and actionFilters configuration.",
    "Use get_alert_options to discover notification actions, integrations, conditions, and available sources.",
    "Omit fields to leave them unchanged. Pass null to clear owner or environment.",
    "triggers replaces the trigger conditions. actionFilters replaces ALL action groups: copy the complete configuration, retain existing IDs, and change only the intended values. Omitted groups, conditions, and actions are removed.",
    "For Slack or Microsoft Teams, change config.targetDisplay to the channel name and use integrationId for the workspace or team. Sentry resolves the channel ID. Slack also accepts an explicit new targetIdentifier; a copied old ID is cleared when the name or workspace changes.",
    "Other actions use their provider's config and data. For Discord, PagerDuty, Opsgenie, and email, update targetIdentifier to the channel, service, team, or recipient ID; changing only its display name does not change the destination.",
    "Use addProjectSlugs/removeProjectSlugs to connect/disconnect a project's issue stream. Other monitors in that project remain connected. Use addDetectorIds/removeDetectorIds for individual monitors. Unmentioned connections are preserved.",
    "Metric Monitor detection queries and thresholds are separate operations.",
    "All-project connections require Sentry's all-project feature and an API token with org:write in addition to alerts:write.",
    "A project-constrained session can only edit alerts affecting that project exclusively.",
    "Requires alerts:write; reconnect OAuth if the existing token lacks it.",
    "<examples>",
    "update_alert_rule(organizationSlug='my-org', ruleIdOrName='12345', status='disabled')",
    "update_alert_rule(organizationSlug='my-org', projectSlug='backend', ruleIdOrName='Notify backend team', frequencyMinutes=30)",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug.nullable().optional(),
    ruleIdOrName: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Workflow ID or exact alert name. Digit-only values are treated as IDs. Use IDs from get_alert_rule(kind='issue').",
      ),
    ...alertRuleConfigFields,
    triggers: ParamAlertTriggers.optional(),
    actionFilters: ParamAlertActionFilters.optional(),
    addProjectSlugs: z
      .array(ParamProjectSlug)
      .min(1)
      .optional()
      .describe("Projects whose existing issue streams should be connected."),
    removeProjectSlugs: z
      .array(ParamProjectSlug)
      .min(1)
      .optional()
      .describe(
        "Projects whose issue streams should be disconnected; other monitor connections are retained.",
      ),
    addDetectorIds: z
      .array(z.string().regex(/^\d+$/))
      .min(1)
      .optional()
      .describe(
        "Existing detector IDs to connect, from get_alert_options(section='sources').",
      ),
    removeDetectorIds: z
      .array(z.string().regex(/^\d+$/))
      .min(1)
      .optional()
      .describe("Detector IDs to disconnect. Other connections are retained."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    // Replacement groups without IDs create new components on each invocation.
    idempotentHint: false,
    openWorldHint: true,
  },
  outputSchema: updateAlertRuleOutputSchema,
  async handler(params, context: ServerContext) {
    if (
      [
        params.name,
        params.status,
        params.frequencyMinutes,
        params.environment,
        params.owner,
        params.triggers,
        params.actionFilters,
        params.addProjectSlugs,
        params.removeProjectSlugs,
        params.addDetectorIds,
        params.removeDetectorIds,
      ].every((value) => value === undefined)
    ) {
      throw new UserInputError(
        "Provide at least one field to update on the alert rule.",
      );
    }
    if (params.projectSlug) {
      assertProjectRefWithinConstraint({
        resourceLabel: "Alert rule",
        scopedProjectSlug: context.constraints.projectSlug,
        project: { slug: params.projectSlug },
      });
    }
    const projectSlug = context.constraints.projectSlug ?? params.projectSlug;
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes({ organizationSlug, projectSlug });
    let ruleId = params.ruleIdOrName;
    if (!isNumericAlertRuleId(ruleId)) {
      const matches = await findExactIssueAlertRuleMatches(apiService, {
        organizationSlug,
        projectSlug: projectSlug ?? undefined,
        ruleName: ruleId,
      });
      if (matches.length > 1) {
        throw new UserInputError(
          "The alert name cannot be resolved unambiguously. Retry with the numeric workflow ID from get_alert_rule.",
        );
      }
      if (matches.length === 0) {
        throw new UserInputError(
          `Alert rule "${ruleId}" was not found${projectSlug ? ` in project ${projectSlug}` : ""}.`,
        );
      }
      ruleId = String(matches[0].id);
    }
    const current = await apiService.getIssueAlertRule({
      organizationSlug,
      ruleId,
    });
    const scopedProject = await validateAlertRuleProjectScope(apiService, {
      organizationSlug,
      ruleId,
      projectSlug,
      scopedProjectSlug: context.constraints.projectSlug,
    });
    if (typeof current.enabled !== "boolean") {
      throw new Error(
        "Sentry returned an alert without its enabled state; refusing to update it.",
      );
    }
    // The workflow API defaults enabled to true even on PUT, so always preserve it explicitly.
    const body: AlertRuleUpdate = {
      name: params.name ?? current.name,
      enabled:
        params.status === undefined
          ? current.enabled
          : params.status === "active",
    };
    if (params.frequencyMinutes !== undefined)
      body.config = { ...current.config, frequency: params.frequencyMinutes };
    if (params.environment !== undefined) body.environment = params.environment;
    if (params.owner !== undefined) body.owner = params.owner;
    if (params.triggers !== undefined) body.triggers = params.triggers;
    if (params.actionFilters !== undefined)
      body.actionFilters = resolveChangedSlackDestinations(
        params.actionFilters,
        current,
      );
    if (
      [
        params.addProjectSlugs,
        params.removeProjectSlugs,
        params.addDetectorIds,
        params.removeDetectorIds,
      ].some((value) => value !== undefined)
    ) {
      body.detectorIds = await resolveAlertRuleConnections(apiService, {
        organizationSlug,
        currentDetectorIds: current.detectorIds ?? [],
        addProjectSlugs: params.addProjectSlugs,
        removeProjectSlugs: params.removeProjectSlugs,
        addDetectorIds: params.addDetectorIds,
        removeDetectorIds: params.removeDetectorIds,
        scopedProject,
      });
    }
    const updated = await apiService.updateAlertRule({
      organizationSlug,
      ruleId,
      body,
    });
    const alertRule = toAlertRuleSummary(
      updated,
      apiService.getIssueAlertRuleUrl(organizationSlug, updated.id),
    );
    if (params.actionFilters !== undefined) {
      assertResolvedAlertDestinations(alertRule);
    }
    return structuredResult({ alertRule });
  },
});
