import { z } from "zod";
import type { IssueAlertRule } from "../../api-client/types";
import { UserInputError } from "../../errors";

const componentId = z.union([z.string(), z.number()]);
const logicType = z.enum(["all", "any", "any-short", "none"]);
const condition = z.object({
  id: componentId.optional(),
  type: z.string(),
  comparison: z.unknown(),
  conditionResult: z.unknown(),
});

export const ParamAlertTriggers = z
  .object({
    id: componentId.optional(),
    logicType,
    conditions: z.array(condition),
  })
  .describe(
    "Complete trigger group, copied from get_alert_rule. Keep existing condition IDs; omitted conditions are removed.",
  );

const action = z.object({
  id: componentId.optional(),
  type: z.string(),
  integrationId: componentId.nullable().optional(),
  data: z.record(z.string(), z.unknown()),
  config: z
    .record(z.string(), z.unknown())
    .describe(
      "Provider config. Slack and Teams: set targetDisplay to the channel name in the integrationId workspace; Sentry resolves the ID. Discord, PagerDuty, Opsgenie, email: set targetIdentifier; a new display name alone keeps the old target.",
    ),
  status: z.string().optional(),
});

export const ParamAlertActionFilters = z
  .array(
    z.object({
      id: componentId.optional(),
      logicType,
      conditions: z.array(condition),
      actions: z.array(action),
    }),
  )
  .describe(
    "Complete list of action groups with their conditions and notification actions, copied from get_alert_rule. Keep IDs and unchanged entries; omitted groups, conditions, and actions are removed.",
  );

// Creation allocates new components; copied IDs must never reach the API.
export const ParamNewAlertTriggers = ParamAlertTriggers.omit({ id: true })
  .extend({
    conditions: z.array(condition.omit({ id: true })),
  })
  .refine(
    (group) => group.conditions.length === 0 || group.logicType === "any-short",
    {
      message: "New Alert trigger conditions require logicType='any-short'.",
      path: ["logicType"],
    },
  )
  .describe(
    "Trigger conditions, in the shape get_alert_rule returns; copied IDs are dropped. Null or an empty group means no triggers.",
  );

export const ParamNewAlertActionFilters = z
  .array(
    ParamAlertActionFilters.element.omit({ id: true }).extend({
      conditions: z.array(condition.omit({ id: true })),
      actions: z.array(action.omit({ id: true })),
    }),
  )
  .describe(
    "Action groups with conditions and notification actions, from get_alert_options or copied from get_alert_rule. Component IDs are dropped; integration and destination IDs are kept. Pass [] for none.",
  );

export const alertRuleConfigFields = {
  name: z.string().trim().min(1).max(256).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  frequencyMinutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minimum interval between notifications, in minutes."),
  environment: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("Environment the Alert applies to. Null means all environments."),
  owner: z
    .string()
    .regex(/^(user|team):\d+$/)
    .nullable()
    .optional()
    .describe("Owner as user:<id> or team:<id>. Null clears it."),
};

export const alertRuleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  config: z
    .object({ frequency: z.number().int().min(0).optional() })
    .optional(),
  environment: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  triggers: ParamAlertTriggers.nullable().optional(),
  actionFilters: ParamAlertActionFilters.nullable().optional(),
  detectorIds: z.array(z.string()),
  webUrl: z.string().url(),
});

/** Returns editable alert configuration and component IDs, excluding backend metadata. */
export function toAlertRuleSummary(
  rule: IssueAlertRule,
  webUrl: string,
): z.infer<typeof alertRuleSummarySchema> {
  return alertRuleSummarySchema.parse({
    id: String(rule.id),
    name: rule.name,
    enabled: rule.enabled,
    config: rule.config,
    environment: rule.environment,
    owner:
      typeof rule.owner === "string" || rule.owner === null
        ? rule.owner
        : undefined,
    triggers: rule.triggers,
    actionFilters: rule.actionFilters,
    detectorIds: (rule.detectorIds ?? []).map(String),
    webUrl,
  });
}

/** Sentry can save a Slack action after a channel lookup timeout. */
export function assertResolvedAlertDestinations(
  rule: z.infer<typeof alertRuleSummarySchema>,
  operation: "create" | "update" = "update",
): void {
  if (
    rule.actionFilters?.some((group) =>
      group.actions.some(
        (action) =>
          action.type === "slack" &&
          (typeof action.config.targetIdentifier !== "string" ||
            action.config.targetIdentifier.length === 0),
      ),
    )
  ) {
    throw new UserInputError(
      operation === "create"
        ? `Alert ${rule.id} was created, but Sentry did not resolve a Slack destination. Read it with get_alert_rule(kind='issue', ruleIdOrName='${rule.id}') and fix it with update_alert_rule using both the channel name (targetDisplay) and explicit channel ID (targetIdentifier). Do not create another Alert.`
        : "The alert was saved, but Sentry did not resolve a Slack destination. Read the alert again and retry with both the channel name (targetDisplay) and explicit channel ID (targetIdentifier).",
    );
  }
}
