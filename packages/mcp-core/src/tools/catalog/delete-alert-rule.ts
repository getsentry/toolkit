import { z } from "zod";
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
import { validateAlertRuleProjectScope } from "../support/alert-rule-connections";

export default defineTool({
  name: "delete_alert_rule",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Permanently delete a Sentry Alert (workflow), preserving its connected monitors.",
    "Use get_alert_rule(kind='issue') to inspect the Alert and obtain its workflow ID before deletion. Metric Monitor IDs and legacy metric alert IDs are not workflow IDs.",
    "Deleting a shared Alert removes its notifications for every connected project and monitor. Use update_alert_rule to disconnect individual sources or disable it instead.",
    "A project-constrained session can only delete Alerts affecting that project exclusively.",
    "Sentry removes the Alert from normal reads immediately and completes internal deletion in the background.",
    "<examples>",
    "delete_alert_rule(organizationSlug='my-org', ruleId='12345')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug.nullable().optional(),
    ruleId: z
      .string()
      .regex(/^\d+$/)
      .describe("Workflow ID from get_alert_rule(kind='issue')."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: z.object({
    success: z.literal(true),
    ruleId: z.string(),
  }),
  async handler(params, context: ServerContext) {
    const api = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    setTargetTagsAndAttributes(params);
    await validateAlertRuleProjectScope(api, {
      organizationSlug: params.organizationSlug,
      ruleId: params.ruleId,
      projectSlug: params.projectSlug,
      scopedProjectSlug: context.constraints.projectSlug,
    });
    await api.deleteAlertRule({
      organizationSlug: params.organizationSlug,
      ruleId: params.ruleId,
    });
    return structuredResult({ success: true as const, ruleId: params.ruleId });
  },
});
