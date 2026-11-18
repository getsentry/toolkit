import { z } from "zod";
import type {
  Monitor,
  MonitorCheckIn,
  MonitorStat,
} from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId, validateSlugOrId } from "../../utils/slug-validation";
import {
  formatActor,
  formatDate,
  formatId,
  readString,
} from "./support/api-formatting";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

const STATS_BUCKET_LIMIT = 10;
const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

const monitorConfigSchema = z.object({
  scheduleType: nullableString,
  schedule: z
    .union([z.string(), z.array(z.union([z.number(), z.string()]))])
    .nullable()
    .describe("Crontab string, or [value, unit] for interval schedules."),
  timezone: nullableString,
  checkinMarginMinutes: nullableNumber,
  maxRuntimeMinutes: nullableNumber,
});

const checkInSchema = z.object({
  date: nullableString,
  status: nullableString,
  durationMs: nullableNumber,
  environment: nullableString,
});

const statBucketSchema = z.object({
  timestamp: z.string(),
  ok: nullableNumber,
  error: nullableNumber,
  missed: nullableNumber,
  timeout: nullableNumber,
  unknown: nullableNumber,
  avgDurationMs: nullableNumber,
});

export const getMonitorDetailsOutputSchema = z.object({
  monitor: z.object({
    id: z.string(),
    slug: z.string(),
    name: nullableString,
    project: nullableString,
    status: nullableString,
    type: nullableString,
    owner: nullableString,
    ownerEmail: nullableString.describe("Set when a user owns the monitor."),
    lastCheckIn: nullableString,
    nextCheckIn: nullableString,
    url: z.string(),
    config: monitorConfigSchema.nullable(),
  }),
  environments: z.array(
    z.object({
      name: nullableString,
      status: nullableString,
      lastCheckIn: nullableString,
      nextCheckIn: nullableString,
    }),
  ),
  checkIns: z.array(checkInSchema),
  stats: z
    .array(statBucketSchema)
    .nullable()
    .describe(
      `At most ${STATS_BUCKET_LIMIT} most recent stat buckets, oldest first. Null when includeStats is false.`,
    ),
});

function formatOwner(owner: Monitor["owner"]): string | null {
  const name = owner ? formatActor(owner) : null;
  return name === "unknown" ? null : name;
}

function formatProject(monitor: Monitor): string | null {
  if (!monitor.project) {
    return null;
  }

  return monitor.project.slug ?? monitor.project.name ?? null;
}

function readNumber(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const field = value[key];
  return typeof field === "number" ? field : null;
}

function readSchedule(
  value: unknown,
): z.infer<typeof monitorConfigSchema>["schedule"] {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string | number =>
        typeof item === "string" || typeof item === "number",
    );
  }
  return null;
}

function toConfig(
  monitor: Monitor,
): z.infer<typeof monitorConfigSchema> | null {
  const config = monitor.config;
  if (!config) {
    return null;
  }
  return {
    scheduleType: readString(config, "schedule_type"),
    schedule: readSchedule(config.schedule),
    timezone: readString(config, "timezone"),
    checkinMarginMinutes: readNumber(config, "checkin_margin"),
    maxRuntimeMinutes: readNumber(config, "max_runtime"),
  };
}

function toCheckIn(checkIn: MonitorCheckIn): z.infer<typeof checkInSchema> {
  return {
    date: formatDate(checkIn.dateCreated) ?? formatDate(checkIn.dateUpdated),
    status: checkIn.status ?? null,
    durationMs: checkIn.duration ?? null,
    environment: checkIn.environment ?? null,
  };
}

function toStat(stat: MonitorStat): z.infer<typeof statBucketSchema> {
  return {
    timestamp: new Date(stat.ts * 1000).toISOString(),
    ok: readNumber(stat, "ok"),
    error: readNumber(stat, "error"),
    missed: readNumber(stat, "missed"),
    timeout: readNumber(stat, "timeout"),
    unknown: readNumber(stat, "unknown"),
    avgDurationMs: readNumber(stat, "duration"),
  };
}

export default defineTool({
  name: "get_monitor_details",
  title: "Get Cron Monitor Details",
  skills: ["inspect"],
  requiredScopes: ["project:read"],
  description: [
    "Get a Sentry cron monitor (scheduled job): schedule, status, owner, environments, recent check-ins (missed, failed, timeout, OK), and check-in stats.",
    "Uptime URL checks: find_uptime_monitors. Metric thresholds: find_metric_monitors.",
    "Issues for a monitor: search_issues with monitor.slug:<slug>.",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlugOrId: z
      .string()
      .trim()
      .superRefine(validateSlugOrId)
      .nullable()
      .default(null)
      .describe(
        "Project slug or numeric ID, to pick between monitors that share a slug.",
      ),
    monitorSlug: z.string().trim().min(1).describe("Monitor slug or GUID."),
    environment: z
      .string()
      .trim()
      .describe("Environment to filter environments, check-ins, and stats by.")
      .nullable()
      .default(null),
    period: ParamPeriod.describe(
      "Relative time range, such as 24h or 7d. Defaults to 24h without start and end.",
    )
      .nullable()
      .default(null),
    start: z
      .string()
      .datetime()
      .describe("Absolute start time. Requires end; not with period.")
      .nullable()
      .default(null),
    end: z
      .string()
      .datetime()
      .describe("Absolute end time. Requires start; not with period.")
      .nullable()
      .default(null),
    checkInLimit: z
      .number()
      .int()
      .positive()
      .max(50)
      .describe("Maximum recent check-ins to include.")
      .default(10),
    includeStats: z
      .boolean()
      .describe("Include aggregate check-in stats for the selected time range.")
      .default(true),
    rollupSeconds: z
      .number()
      .int()
      .positive()
      .describe("Stats bucket size in seconds. Omit to let Sentry choose.")
      .nullable()
      .default(null),
  },
  outputSchema: getMonitorDetailsOutputSchema,
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
    const requestedProjectSlugOrId = params.projectSlugOrId ?? undefined;
    const projectSlugOrId =
      requestedProjectSlugOrId ?? context.constraints.projectSlug ?? null;
    setTargetTagsAndAttributes({
      organizationSlug,
      projectSlugOrId,
      monitorSlug: params.monitorSlug,
    });
    if (requestedProjectSlugOrId && !isNumericId(requestedProjectSlugOrId)) {
      assertProjectRefWithinConstraint({
        resourceLabel: "Monitor",
        scopedProjectSlug: context.constraints.projectSlug,
        project: { slug: requestedProjectSlugOrId },
      });
    }
    if (
      requestedProjectSlugOrId &&
      isNumericId(requestedProjectSlugOrId) &&
      context.constraints.projectSlug
    ) {
      const scopedProject = await apiService.getProject({
        organizationSlug,
        projectSlugOrId: context.constraints.projectSlug,
      });
      if (String(scopedProject.id) !== requestedProjectSlugOrId) {
        throw new UserInputError(
          `Monitor is outside the active project constraint. Expected project "${context.constraints.projectSlug}".`,
        );
      }
    }
    const start = params.start ?? undefined;
    const end = params.end ?? undefined;
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

    const monitor = await apiService.getMonitorDetails({
      organizationSlug,
      projectSlug: projectSlugOrId ?? undefined,
      monitorSlug: params.monitorSlug,
      environment: params.environment ?? undefined,
    });
    assertProjectRefWithinConstraint({
      resourceLabel: "Monitor",
      scopedProjectSlug: context.constraints.projectSlug,
      project: monitor.project,
    });

    const project = formatProject(monitor);
    const monitorUrl = apiService.getMonitorUrl(
      organizationSlug,
      monitor.slug,
      project ?? undefined,
    );

    const [checkIns, stats] = await Promise.all([
      apiService.listMonitorCheckIns({
        organizationSlug,
        projectSlug: projectSlugOrId ?? undefined,
        monitorSlug: params.monitorSlug,
        environment: params.environment ?? undefined,
        statsPeriod,
        start,
        end,
        limit: params.checkInLimit,
      }),
      params.includeStats
        ? apiService.getMonitorStats({
            organizationSlug,
            projectSlug: projectSlugOrId ?? undefined,
            monitorSlug: params.monitorSlug,
            environment: params.environment ?? undefined,
            statsPeriod,
            start,
            end,
            rollup: params.rollupSeconds ?? undefined,
          })
        : Promise.resolve([]),
    ]);

    return structuredResult({
      monitor: {
        id: formatId(monitor.id),
        slug: monitor.slug,
        name: monitor.name ?? null,
        project,
        status: monitor.status ?? null,
        type: monitor.type ?? null,
        owner: formatOwner(monitor.owner),
        ownerEmail:
          monitor.owner && typeof monitor.owner === "object"
            ? monitor.owner.email || null
            : null,
        lastCheckIn: formatDate(monitor.lastCheckIn),
        nextCheckIn: formatDate(monitor.nextCheckIn),
        url: monitorUrl,
        config: toConfig(monitor),
      },
      environments: (monitor.environments ?? []).map((environment) => ({
        name: environment.name ?? null,
        status: environment.status ?? null,
        lastCheckIn: formatDate(environment.lastCheckIn),
        nextCheckIn: formatDate(environment.nextCheckIn),
      })),
      checkIns: checkIns.slice(0, params.checkInLimit).map(toCheckIn),
      stats: params.includeStats
        ? stats.slice(-STATS_BUCKET_LIMIT).map(toStat)
        : null,
    });
  },
});
