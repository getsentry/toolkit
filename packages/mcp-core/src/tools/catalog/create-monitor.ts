import { z } from "zod";
import type { Monitor } from "../../api-client/types";
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

// Limits mirror src/sentry/monitors/constants.py.
const MAX_CHECKIN_MARGIN_MINUTES = 40_320;
const MAX_RUNTIME_MINUTES = 10_080;
const MAX_THRESHOLD = 720;
// Bounds untrusted input; far above any realistic number of Alerts per monitor.
const MAX_WORKFLOW_IDS = 50;

const INTERVAL_UNITS = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;

export const createMonitorOutputSchema = z.object({
  monitor: z.object({
    id: z.string().nullable().describe("Cron monitor ID."),
    slug: z.string().describe("Monitor slug that check-ins must use."),
    name: z.string(),
    projectSlug: z.string().nullable(),
    status: z
      .string()
      .nullable()
      .describe(
        "`active` or `disabled`; unrequested `disabled` means no seat was available.",
      ),
    scheduleType: z.string().nullable().describe("`crontab` or `interval`."),
    schedule: z
      .string()
      .nullable()
      .describe("Crontab expression, or interval as `<value> <unit>`."),
    timezone: z.string().nullable().describe("tz database timezone."),
    checkInMargin: z
      .number()
      .nullable()
      .describe("Minutes before a late check-in counts as missed."),
    maxRuntime: z
      .number()
      .nullable()
      .describe("Minutes a check-in may stay in progress."),
    failureIssueThreshold: z
      .number()
      .nullable()
      .describe("Consecutive failures before an issue opens."),
    recoveryThreshold: z
      .number()
      .nullable()
      .describe("Consecutive successes before the issue resolves."),
    workflowIds: z
      .array(z.string())
      .describe("Connected notification Alert IDs."),
    webUrl: z.string().url().describe("Monitor page in Sentry."),
  }),
});

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function formatSchedule(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length === 2) {
    return `${value[0]} ${value[1]}`;
  }
  return null;
}

function toMonitorSummary(
  monitor: Monitor,
  workflowIds: string[],
  webUrl: string,
) {
  const config = monitor.config ?? {};
  return {
    id: monitor.id == null ? null : String(monitor.id),
    slug: monitor.slug,
    name: monitor.name ?? monitor.slug,
    projectSlug: monitor.project?.slug ?? null,
    status: monitor.status ?? null,
    scheduleType:
      typeof config.schedule_type === "string" ? config.schedule_type : null,
    schedule: formatSchedule(config.schedule),
    timezone: typeof config.timezone === "string" ? config.timezone : null,
    checkInMargin: numberOrNull(config.checkin_margin),
    maxRuntime: numberOrNull(config.max_runtime),
    failureIssueThreshold: numberOrNull(config.failure_issue_threshold),
    recoveryThreshold: numberOrNull(config.recovery_threshold),
    workflowIds,
    webUrl,
  };
}

export default defineTool({
  name: "create_monitor",
  title: "Create Cron Monitor",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Create a Sentry cron monitor.",
    "",
    "Use this tool when you need to:",
    "- Monitor a scheduled job (cron job, scheduled task) for missed, failed, or slow runs",
    "- Set up a cron monitor before instrumenting check-ins",
    "",
    "Set `schedule` to exactly one crontab or interval schedule. Check-ins must still be sent by the job (SDK `monitor_config`/check-ins or `sentry monitor run`) using the returned slug.",
    "workflowIds optionally connect existing notification Alerts without modifying them. Use find_alert_rules(kind='issue') to find workflow IDs.",
    "If the returned status is `disabled` but you did not request that, the organization has no cron monitor seat available. Tell the user; the monitor ignores check-ins until a seat frees up and it is enabled.",
    "After an error or timeout, use find_monitors with the name and project before retrying; creation is not idempotent.",
    "",
    "<examples>",
    "create_monitor(organizationSlug='my-organization', projectSlug='backend', name='Nightly Import', schedule={ type: 'crontab', crontab: '0 3 * * *' }, timezone='America/Los_Angeles', checkInMargin=5, maxRuntime=30)",
    "create_monitor(organizationSlug='my-organization', projectSlug='backend', name='Queue Drain', schedule={ type: 'interval', value: 15, unit: 'minute' })",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    name: z.string().trim().min(1).max(128).describe("Monitor display name."),
    slug: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Optional monitor slug used by check-ins. Derived from the name when omitted.",
      )
      .optional(),
    schedule: z
      .discriminatedUnion("type", [
        z
          .object({
            type: z.literal("crontab"),
            crontab: z
              .string()
              .trim()
              .min(1)
              .describe(
                "Five-field crontab schedule or `@` alias, e.g. `0 3 * * *` or `@daily`. Seconds fields are not supported.",
              ),
          })
          .strict(),
        z
          .object({
            type: z.literal("interval"),
            value: z.number().int().positive(),
            unit: z.enum(INTERVAL_UNITS),
          })
          .strict(),
      ])
      .describe(
        "Monitor schedule: exactly one of `{ type: 'crontab', crontab: '0 3 * * *' }` or `{ type: 'interval', value: 15, unit: 'minute' }`.",
      ),
    timezone: z
      .string()
      .trim()
      .min(1)
      .describe("tz database timezone for the schedule, e.g. `UTC`.")
      .optional(),
    checkInMargin: z
      .number()
      .int()
      .min(0)
      .max(MAX_CHECKIN_MARGIN_MINUTES)
      .describe(
        "Minutes after the expected time before a check-in counts as missed. Sentry treats 0 as 1.",
      )
      .optional(),
    maxRuntime: z
      .number()
      .int()
      .min(1)
      .max(MAX_RUNTIME_MINUTES)
      .describe("Minutes a check-in may stay in progress before it fails.")
      .optional(),
    failureIssueThreshold: z
      .number()
      .int()
      .min(1)
      .max(MAX_THRESHOLD)
      .describe("Consecutive failed or missed check-ins before an issue opens.")
      .optional(),
    recoveryThreshold: z
      .number()
      .int()
      .min(1)
      .max(MAX_THRESHOLD)
      .describe("Consecutive successful check-ins before the issue resolves.")
      .optional(),
    status: z
      .enum(["active", "disabled"])
      .describe("Monitor status. Disabled monitors ignore check-ins.")
      .optional(),
    owner: z
      .string()
      .trim()
      .regex(
        /^(user|team):\d+$/,
        "owner must use `user:ID` or `team:ID` format (e.g. `user:123` or `team:456`).",
      )
      .describe("Owner actor in `user:ID` or `team:ID` format.")
      .optional(),
    workflowIds: z
      .array(z.string().regex(/^\d+$/))
      .max(MAX_WORKFLOW_IDS)
      .describe("Existing notification Alert IDs to connect.")
      .optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: createMonitorOutputSchema,
  async handler(params, context: ServerContext) {
    const { schedule } = params;
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes(params);

    assertProjectRefWithinConstraint({
      resourceLabel: "Cron monitor",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: params.projectSlug },
    });

    const { detector, monitor } = await apiService.createMonitor({
      organizationSlug,
      projectSlug: params.projectSlug,
      name: params.name,
      slug: params.slug,
      status: params.status,
      owner: params.owner,
      workflowIds: params.workflowIds,
      config: {
        ...(schedule.type === "crontab"
          ? { schedule_type: "crontab" as const, schedule: schedule.crontab }
          : {
              schedule_type: "interval" as const,
              schedule: [schedule.value, schedule.unit] as [number, string],
            }),
        ...(params.timezone !== undefined && { timezone: params.timezone }),
        ...(params.checkInMargin !== undefined && {
          checkin_margin: params.checkInMargin,
        }),
        ...(params.maxRuntime !== undefined && {
          max_runtime: params.maxRuntime,
        }),
        ...(params.failureIssueThreshold !== undefined && {
          failure_issue_threshold: params.failureIssueThreshold,
        }),
        ...(params.recoveryThreshold !== undefined && {
          recovery_threshold: params.recoveryThreshold,
        }),
      },
    });

    const projectSlug = monitor.project?.slug ?? params.projectSlug;
    return structuredResult({
      monitor: toMonitorSummary(
        monitor,
        detector.workflowIds ?? [],
        apiService.getMonitorUrl(organizationSlug, monitor.slug, projectSlug),
      ),
    });
  },
});
