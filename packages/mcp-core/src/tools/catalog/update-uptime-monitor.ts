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
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";
import {
  ParamUptimeHeaders,
  ParamUptimeHttpMethod,
  ParamUptimeIntervalSeconds,
  ParamUptimeMonitorStatus,
  ParamUptimeOwner,
  ParamUptimeTimeoutMs,
  toUptimeMonitorSummary,
  uptimeMonitorSummarySchema,
} from "./support/uptime-monitors";

export const updateUptimeMonitorOutputSchema = z.object({
  monitor: uptimeMonitorSummarySchema,
});

function hasDefinedUpdate(
  value: unknown,
): value is Exclude<typeof value, undefined> {
  return value !== undefined;
}

export default defineTool({
  name: "update_uptime_monitor",
  skills: ["project-management"],
  requiredScopes: ["project:write"],
  description: [
    "Update a Sentry HTTP uptime monitor.",
    "",
    "Use this tool when you need to:",
    "- Change URL, interval, timeout, method, headers, or body",
    "- Enable or disable a monitor (`status`)",
    "- Update owner, environment, or failure thresholds",
    "",
    "Be careful when using this tool!",
    "",
    "Omit a field to leave it unchanged. Pass explicit `null` to clear `owner`, `environment`, or `body`.",
    "",
    "<examples>",
    "update_uptime_monitor(organizationSlug='my-organization', projectSlug='backend', uptimeMonitorId='12345', status='disabled')",
    "update_uptime_monitor(organizationSlug='my-organization', projectSlug='backend', uptimeMonitorId='12345', intervalSeconds=300, timeoutMs=8000)",
    "update_uptime_monitor(organizationSlug='my-organization', projectSlug='backend', uptimeMonitorId='12345', owner=null)",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    uptimeMonitorId: z
      .string()
      .trim()
      .min(1)
      .describe("Uptime monitor ID (detector id)."),
    name: z.string().trim().min(1).max(128).optional(),
    url: z.string().url().optional(),
    intervalSeconds: ParamUptimeIntervalSeconds.optional(),
    timeoutMs: ParamUptimeTimeoutMs.optional(),
    method: ParamUptimeHttpMethod.optional(),
    headers: ParamUptimeHeaders.optional(),
    body: z
      .string()
      .nullable()
      .optional()
      .describe("Request body. Pass `null` to clear the body."),
    status: ParamUptimeMonitorStatus.optional(),
    owner: ParamUptimeOwner.nullable()
      .optional()
      .describe(
        "Owner actor in `user:ID` or `team:ID` format. Pass `null` to clear the owner.",
      ),
    environment: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .nullable()
      .optional()
      .describe("Environment name. Pass `null` to clear the environment."),
    traceSampling: z.boolean().optional(),
    responseCaptureEnabled: z.boolean().optional(),
    recoveryThreshold: z.number().int().min(1).optional(),
    downtimeThreshold: z.number().int().min(1).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: updateUptimeMonitorOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTagAndAttribute("organization.slug", organizationSlug);
    setTagAndAttribute("project.slug", params.projectSlug);
    setTagAndAttribute("uptime.monitor_id", params.uptimeMonitorId);

    assertProjectRefWithinConstraint({
      resourceLabel: "Uptime monitor",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: params.projectSlug },
    });

    // omitted = unchanged; explicit null clears owner/environment/body.
    const hasUpdate =
      hasDefinedUpdate(params.name) ||
      hasDefinedUpdate(params.url) ||
      hasDefinedUpdate(params.intervalSeconds) ||
      hasDefinedUpdate(params.timeoutMs) ||
      hasDefinedUpdate(params.method) ||
      hasDefinedUpdate(params.headers) ||
      hasDefinedUpdate(params.body) ||
      hasDefinedUpdate(params.status) ||
      hasDefinedUpdate(params.owner) ||
      hasDefinedUpdate(params.environment) ||
      hasDefinedUpdate(params.traceSampling) ||
      hasDefinedUpdate(params.responseCaptureEnabled) ||
      hasDefinedUpdate(params.recoveryThreshold) ||
      hasDefinedUpdate(params.downtimeThreshold);

    if (!hasUpdate) {
      throw new UserInputError(
        "Provide at least one field to update on the uptime monitor.",
      );
    }

    const monitor = await apiService.updateUptimeMonitor({
      organizationSlug,
      projectSlug: params.projectSlug,
      uptimeMonitorId: params.uptimeMonitorId,
      name: params.name,
      url: params.url,
      intervalSeconds: params.intervalSeconds,
      timeoutMs: params.timeoutMs,
      method: params.method,
      headers: params.headers,
      body: params.body,
      status: params.status,
      owner: params.owner,
      environment: params.environment,
      traceSampling: params.traceSampling,
      responseCaptureEnabled: params.responseCaptureEnabled,
      recoveryThreshold: params.recoveryThreshold,
      downtimeThreshold: params.downtimeThreshold,
    });

    return structuredResult({
      monitor: toUptimeMonitorSummary(
        monitor,
        apiService.getUptimeMonitorUrl(organizationSlug, monitor.id),
      ),
    });
  },
});
