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
  title: "Delete Alert Rule",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Permanently delete a Sentry Alert (notification workflow) and its notifications for every connected project and monitor. Connected monitors are kept.",
    "To stop one source or pause it, use update_alert_rule. Metric Monitors are deleted with delete_metric_monitor.",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug.nullable().optional(),
    ruleId: z
      .string()
      .regex(/^\d+$/)
      .describe(
        "Alert workflow ID from get_alert_rule with `issue`. Metric Monitor and legacy metric alert IDs are not workflow IDs.",
      ),
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
