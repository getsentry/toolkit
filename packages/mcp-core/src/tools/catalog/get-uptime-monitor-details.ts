import { z } from "zod";
import type { UptimeCheck } from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { formatDate } from "./support/api-formatting";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";
import {
  toUptimeHeadersForOutput,
  toUptimeMonitorSummary,
  uptimeHeaderSchema,
  uptimeMonitorSummarySchema,
} from "./support/uptime-monitors";

const uptimeCheckOutputSchema = z.object({
  time: z.string().nullable(),
  status: z.string(),
  statusReason: z.string().nullable(),
  httpStatusCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  region: z.string().nullable(),
  environment: z.string().nullable(),
});

export const getUptimeMonitorDetailsOutputSchema = z.object({
  monitor: uptimeMonitorSummarySchema.extend({
    headers: z
      .array(uptimeHeaderSchema)
      .describe("Configured request headers; sensitive values are redacted."),
    hasRequestBody: z
      .boolean()
      .describe(
        "Whether a request body is configured. The body is never returned.",
      ),
    assertion: z
      .unknown()
      .describe(
        "Response assertion tree as configured in Sentry, or null when none is set.",
      ),
  }),
  checks: z.array(uptimeCheckOutputSchema),
});

function toCheck(check: UptimeCheck): z.infer<typeof uptimeCheckOutputSchema> {
  return {
    time: formatDate(check.timestamp) ?? formatDate(check.scheduledCheckTime),
    status: check.checkStatus ?? "unknown",
    statusReason: check.checkStatusReason || null,
    httpStatusCode: check.httpStatusCode ?? null,
    durationMs: check.durationMs ?? null,
    region: check.regionName || check.region || null,
    environment: check.environment?.trim() || null,
  };
}

export default defineTool({
  name: "get_uptime_monitor_details",
  title: "Get Uptime Monitor Details",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description: [
    "Get details for a Sentry uptime monitor, including recent checks.",
    "",
    "Use this tool when you need to:",
    "- Inspect an uptime monitor's URL, interval, thresholds, and status",
    "- Review recent HTTP check results (success/failure, status code, duration)",
    "- Debug why an uptime monitor is failing",
    "",
    "This is separate from cron monitors (`get_monitor_details`).",
    "",
    "Request bodies are never returned. Sensitive header values are redacted.",
    "To find related issues, call `search_issues` with query `uptime_rule:<id>`.",
    "",
    "<examples>",
    "get_uptime_monitor_details(organizationSlug='my-organization', projectSlug='backend', uptimeMonitorId='12345')",
    "get_uptime_monitor_details(organizationSlug='my-organization', projectSlug='backend', uptimeMonitorId='12345', period='7d', checkLimit=20)",
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
    period: ParamPeriod.describe(
      "Relative time range for recent checks. Defaults to `24h` when `start` and `end` are omitted.",
    ).optional(),
    start: z
      .string()
      .datetime()
      .describe(
        "Absolute start time. Must be provided with `end`; do not combine with `period`.",
      )
      .optional(),
    end: z
      .string()
      .datetime()
      .describe(
        "Absolute end time. Must be provided with `start`; do not combine with `period`.",
      )
      .optional(),
    checkLimit: z
      .number()
      .int()
      .positive()
      .max(50)
      .describe("Maximum number of recent checks to include.")
      .default(10),
  },
  outputSchema: getUptimeMonitorDetailsOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
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

    const start = params.start;
    const end = params.end;
    if ((start && !end) || (!start && end)) {
      throw new UserInputError("`start` and `end` must be provided together.");
    }
    const hasAbsoluteTimeRange = start !== undefined || end !== undefined;
    const requestedPeriod = params.period?.trim() || undefined;
    if (hasAbsoluteTimeRange && requestedPeriod) {
      throw new UserInputError(
        "`period` cannot be combined with `start` and `end`.",
      );
    }
    const statsPeriod = hasAbsoluteTimeRange
      ? undefined
      : (requestedPeriod ?? "24h");

    const monitor = await apiService.getUptimeMonitorDetails({
      organizationSlug,
      projectSlug: params.projectSlug,
      uptimeMonitorId: params.uptimeMonitorId,
    });
    assertProjectRefWithinConstraint({
      resourceLabel: "Uptime monitor",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: monitor.projectSlug },
    });

    const checks = await apiService.listUptimeMonitorChecks({
      organizationSlug,
      projectSlug: params.projectSlug,
      uptimeMonitorId: params.uptimeMonitorId,
      statsPeriod,
      start,
      end,
      limit: params.checkLimit,
    });

    const webUrl = apiService.getUptimeMonitorUrl(organizationSlug, monitor.id);

    return structuredResult({
      monitor: {
        ...toUptimeMonitorSummary(monitor, webUrl),
        headers: toUptimeHeadersForOutput(monitor.headers),
        hasRequestBody: Boolean(monitor.body),
        assertion: monitor.assertion ?? null,
      },
      checks: checks.slice(0, params.checkLimit).map(toCheck),
    });
  },
});
