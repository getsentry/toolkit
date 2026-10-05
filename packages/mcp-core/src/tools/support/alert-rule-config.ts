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
    "The complete trigger group. Preserve existing condition IDs when editing; omitted conditions are removed. Use the configuration returned by get_alert_rule.",
  );

const action = z.object({
  id: componentId.optional(),
  type: z.string(),
  integrationId: componentId.nullable().optional(),
  data: z.record(z.string(), z.unknown()),
  config: z.record(z.string(), z.unknown()),
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
    "The complete list of action groups, conditions, and notification actions. Preserve their IDs and all unchanged groups and actions; omitted entries are removed. Slack and Microsoft Teams resolve config.targetDisplay as a channel name within integrationId. Other providers use their native config.targetIdentifier and data fields.",
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
    "Trigger conditions. Nonempty groups require logicType='any-short' for new Alerts. Copied component IDs are discarded. Omit, pass null, or use an empty group for no trigger conditions.",
  );

export const ParamNewAlertActionFilters = z
  .array(
    ParamAlertActionFilters.element.omit({ id: true }).extend({
      conditions: z.array(condition.omit({ id: true })),
      actions: z.array(action.omit({ id: true })),
    }),
  )
  .describe(
    "Action groups with conditions and notification actions, from get_alert_options or get_alert_rule. Copied component IDs are discarded; integration and destination IDs are retained. Pass [] explicitly for no notification actions.",
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
  environment: z.string().min(1).nullable().optional(),
  owner: z
    .string()
    .regex(/^(user|team):\d+$/)
    .nullable()
    .optional()
    .describe("Owner actor user:ID or team:ID. Pass null to clear."),
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
