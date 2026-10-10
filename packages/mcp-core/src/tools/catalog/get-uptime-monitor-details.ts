import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { compactLines, formatDate } from "./support/api-formatting";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";
import {
  formatUptimeHeadersForOutput,
  formatUptimeStatus,
  getUptimeOwnerName,
} from "./support/uptime-monitors";

function formatCheck(
  check: {
    timestamp?: string;
    scheduledCheckTime?: string;
    checkStatus?: string;
    checkStatusReason?: string | null;
    httpStatusCode?: number | null;
    durationMs?: number;
    regionName?: string;
    region?: string;
    environment?: string;
  },
  monitorEnvironment: string | null | undefined,
): string {
  const time =
    formatDate(check.timestamp) ??
    formatDate(check.scheduledCheckTime) ??
    "unknown time";
  const status = check.checkStatus ?? "unknown";
  const reason = check.checkStatusReason ? ` (${check.checkStatusReason})` : "";
  const http =
    check.httpStatusCode === undefined || check.httpStatusCode === null
      ? ""
      : `, HTTP ${check.httpStatusCode}`;
  const duration =
    check.durationMs === undefined ? "" : `, ${check.durationMs}ms`;
  const region = check.regionName || check.region;
  const regionPart = region ? `, ${region}` : "";
  // Only print environment when it differs from the monitor-level value.
  const checkEnvironment = check.environment?.trim();
  const monitorEnv = monitorEnvironment?.trim() || null;
  const environment =
    checkEnvironment && checkEnvironment !== monitorEnv
      ? `, ${checkEnvironment}`
      : "";
  return `- ${time}: ${status}${reason}${http}${duration}${regionPart}${environment}`;
}

export default defineTool({
  name: "get_uptime_monitor_details",
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
    const owner = getUptimeOwnerName(monitor);
    const uptimeStatus = formatUptimeStatus(monitor.uptimeStatus);

    const output = compactLines([
      `# Uptime Monitor ${monitor.name} in **${organizationSlug}**`,
      "",
      `**ID**: ${monitor.id}`,
      `**Project**: ${monitor.projectSlug}`,
      `**Status**: ${monitor.status}`,
      `**Uptime Status**: ${uptimeStatus}`,
      `**URL**: ${monitor.url}`,
      monitor.method ? `**Method**: ${monitor.method}` : null,
      `**Interval**: ${monitor.intervalSeconds}s`,
      `**Timeout**: ${monitor.timeoutMs}ms`,
      monitor.environment ? `**Environment**: ${monitor.environment}` : null,
      owner ? `**Owner**: ${owner}` : null,
      monitor.recoveryThreshold !== undefined &&
      monitor.recoveryThreshold !== null
        ? `**Recovery Threshold**: ${monitor.recoveryThreshold}`
        : null,
      monitor.downtimeThreshold !== undefined &&
      monitor.downtimeThreshold !== null
        ? `**Downtime Threshold**: ${monitor.downtimeThreshold}`
        : null,
      monitor.traceSampling !== undefined && monitor.traceSampling !== null
        ? `**Trace Sampling**: ${monitor.traceSampling}`
        : null,
      monitor.responseCaptureEnabled !== undefined &&
      monitor.responseCaptureEnabled !== null
        ? `**Response Capture**: ${monitor.responseCaptureEnabled}`
        : null,
      `**Web URL**: [Open Monitor](${webUrl})`,
    ]);

    const headerLines = formatUptimeHeadersForOutput(monitor.headers);
    if (headerLines.length > 0) {
      output.push("", "## Headers", "", ...headerLines);
    }
    if (monitor.body) {
      output.push(
        "",
        "## Request Payload",
        "",
        "Request body is configured but omitted from this view.",
      );
    }

    if (monitor.assertion !== undefined && monitor.assertion !== null) {
      output.push(
        "",
        "## Assertion",
        "",
        "```json",
        JSON.stringify(monitor.assertion, null, 2),
        "```",
      );
    }

    output.push("", "## Recent Checks", "");
    output.push(
      checks.length === 0
        ? "No checks found in this time range."
        : checks
            .slice(0, params.checkLimit)
            .map((check) => formatCheck(check, monitor.environment))
            .join("\n"),
    );

    output.push("", "## Response Notes", "");
    output.push(
      `- Search related issues with \`search_issues\` query \`uptime_rule:${monitor.id}\`.`,
    );

    return `${output.join("\n")}\n`;
  },
});
