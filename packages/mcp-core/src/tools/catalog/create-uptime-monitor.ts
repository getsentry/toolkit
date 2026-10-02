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

export const createUptimeMonitorOutputSchema = z.object({
  monitor: uptimeMonitorSummarySchema,
});

export default defineTool({
  name: "create_uptime_monitor",
  skills: ["project-management"],
  requiredScopes: ["project:write"],
  description: [
    "Create a Sentry HTTP uptime monitor.",
    "",
    "Use this tool when you need to:",
    "- Start monitoring a URL for availability",
    "- Create a new uptime check with interval and timeout",
    "",
    "Be careful when using this tool!",
    "",
    "Required fields match Sentry's uptime API: name, url, intervalSeconds, timeoutMs.",
    "Advanced response assertions are not supported in this MVP; configure them in the Sentry UI if needed.",
    "",
    "<examples>",
    "create_uptime_monitor(organizationSlug='my-organization', projectSlug='backend', name='API Health', url='https://api.example.com/health', intervalSeconds=60, timeoutMs=5000)",
    "create_uptime_monitor(organizationSlug='my-organization', projectSlug='backend', name='Checkout', url='https://example.com/checkout', intervalSeconds=300, timeoutMs=10000, method='GET', environment='production')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    name: z.string().trim().min(1).max(128).describe("Monitor display name."),
    url: z.string().url().describe("URL to check."),
    intervalSeconds: ParamUptimeIntervalSeconds,
    timeoutMs: ParamUptimeTimeoutMs.default(5000),
    method: ParamUptimeHttpMethod.optional(),
    headers: ParamUptimeHeaders.optional(),
    body: z
      .string()
      .describe("Optional request body for methods that support a body.")
      .optional(),
    status: ParamUptimeMonitorStatus.optional(),
    owner: ParamUptimeOwner.optional(),
    environment: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe("Optional environment name for created uptime issues.")
      .optional(),
    traceSampling: z
      .boolean()
      .describe("Whether check requests may be considered for tracing.")
      .optional(),
    responseCaptureEnabled: z
      .boolean()
      .describe("Capture response body/headers on failures.")
      .optional(),
    recoveryThreshold: z
      .number()
      .int()
      .min(1)
      .describe("Consecutive successful checks required to recover.")
      .optional(),
    downtimeThreshold: z
      .number()
      .int()
      .min(1)
      .describe("Consecutive failed checks required to mark down.")
      .optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: createUptimeMonitorOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes(params);

    assertProjectRefWithinConstraint({
      resourceLabel: "Uptime monitor",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: params.projectSlug },
    });

    const monitor = await apiService.createUptimeMonitor({
      organizationSlug,
      projectSlug: params.projectSlug,
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
