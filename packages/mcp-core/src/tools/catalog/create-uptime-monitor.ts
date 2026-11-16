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
  toUptimeHeaderPairs,
  toUptimeMonitorSummary,
  uptimeMonitorSummarySchema,
} from "./support/uptime-monitors";

export const createUptimeMonitorOutputSchema = z.object({
  monitor: uptimeMonitorSummarySchema,
});

export default defineTool({
  name: "create_uptime_monitor",
  title: "Create Uptime Monitor",
  skills: ["project-management"],
  requiredScopes: ["project:write"],
  description: [
    "Create a Sentry uptime monitor that checks a URL over HTTP on an interval. Response assertions are not supported; set them in the Sentry UI.",
    "Scheduled jobs (cron): find_monitors. Metric thresholds: find_metric_monitors.",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    name: z.string().trim().min(1).max(128).describe("Monitor display name."),
    url: z
      .string()
      .url()
      .max(255)
      .describe("URL to check (max 255 characters)."),
    intervalSeconds: ParamUptimeIntervalSeconds,
    timeoutMs: ParamUptimeTimeoutMs.default(5000),
    method: ParamUptimeHttpMethod.optional(),
    headers: ParamUptimeHeaders.optional(),
    body: z
      .string()
      .describe("Request body, for methods that take one.")
      .optional(),
    status: ParamUptimeMonitorStatus.optional(),
    owner: ParamUptimeOwner.optional(),
    environment: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe("Environment for uptime issues this monitor creates.")
      .optional(),
    traceSampling: z
      .boolean()
      .describe("Whether check requests may be considered for tracing.")
      .optional(),
    responseCaptureEnabled: z
      .boolean()
      .describe("Capture response body and headers on failed checks.")
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
      headers: params.headers && toUptimeHeaderPairs(params.headers),
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
