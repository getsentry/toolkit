import { z } from "zod";
import type { Monitor } from "../../api-client/types";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlugOrAll,
  ParamRegionUrl,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

const ENVIRONMENT_LIMIT = 5;

const monitorScheduleOutputSchema = z.object({
  type: z.string().nullable(),
  value: z.string().nullable(),
  checkInMargin: z.number().nullable(),
  maxRuntime: z.number().nullable(),
});

const monitorEnvironmentOutputSchema = z.object({
  name: z.string().nullable(),
  status: z.string().nullable(),
  lastCheckIn: z.string().datetime().nullable(),
});

const monitorSummaryOutputSchema = z.object({
  id: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  projectSlug: z.string().nullable(),
  status: z.string().nullable(),
  owner: z.string().nullable(),
  lastCheckIn: z.string().datetime().nullable(),
  nextCheckIn: z.string().datetime().nullable(),
  webUrl: z.string().url(),
  schedule: monitorScheduleOutputSchema.nullable(),
  environments: z.array(monitorEnvironmentOutputSchema),
  hasMoreEnvironments: z.boolean(),
});

export const findMonitorsOutputSchema = z.object({
  monitors: z.array(monitorSummaryOutputSchema),
  hasMore: z.boolean(),
});

function getOwnerName(monitor: Monitor): string | null {
  const owner = monitor.owner;
  if (!owner) {
    return null;
  }
  if (typeof owner === "string") {
    return owner.trim() || null;
  }
  return (
    owner.name?.trim() ||
    owner.email?.trim() ||
    owner.username?.trim() ||
    (owner.id === undefined ? null : String(owner.id))
  );
}

function parseSchedule(value: unknown): {
  type: string | null;
  value: string | null;
} {
  if (typeof value === "string") {
    return { type: null, value: value.trim() || null };
  }
  if (Array.isArray(value)) {
    const [first, second, third] = value;
    if (first === "crontab" && typeof second === "string") {
      return { type: "crontab", value: second };
    }
    if (
      first === "interval" &&
      (typeof second === "number" || typeof second === "string") &&
      typeof third === "string"
    ) {
      return { type: "interval", value: `${second} ${third}` };
    }
    if (
      (typeof first === "number" || typeof first === "string") &&
      typeof second === "string"
    ) {
      return { type: "interval", value: `${first} ${second}` };
    }
    return { type: null, value: null };
  }
  if (!value || typeof value !== "object") {
    return { type: null, value: null };
  }
  const schedule = value as Record<string, unknown>;
  const type = typeof schedule.type === "string" ? schedule.type : null;
  if (type === "crontab" && typeof schedule.value === "string") {
    return { type, value: schedule.value };
  }
  if (
    type === "interval" &&
    (typeof schedule.value === "number" ||
      typeof schedule.value === "string") &&
    typeof schedule.unit === "string"
  ) {
    return { type, value: `${schedule.value} ${schedule.unit}` };
  }
  return { type, value: null };
}

function getSchedule(monitor: Monitor) {
  const config = monitor.config;
  if (!config) {
    return null;
  }
  const parsedSchedule = parseSchedule(config.schedule);
  const type =
    typeof config.schedule_type === "string"
      ? config.schedule_type
      : parsedSchedule.type;
  const value = parsedSchedule.value;
  const checkInMargin =
    typeof config.checkin_margin === "number" ? config.checkin_margin : null;
  const maxRuntime =
    typeof config.max_runtime === "number" ? config.max_runtime : null;
  if (
    type === null &&
    value === null &&
    checkInMargin === null &&
    maxRuntime === null
  ) {
    return null;
  }
  return { type, value, checkInMargin, maxRuntime };
}

export default defineTool({
  name: "find_monitors",
  skills: ["inspect"],
  requiredScopes: ["org:read"],
  description: [
    "Find Sentry cron monitors.",
    "",
    "Use this tool when you need to:",
    "- List cron monitors in an organization",
    "- Find a monitor by name or slug before getting details",
    "- Check monitor status, owner, project, schedule, or recent environment state",
    "- When `hasMore` is true, narrow the results with project, environment, owner, or query filters",
    "",
    "<examples>",
    "find_monitors(organizationSlug='my-organization')",
    "find_monitors(organizationSlug='my-organization', projectSlug='backend', query='billing')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlugOrAll.nullable().default(null),
    environment: z
      .string()
      .trim()
      .describe("Optional environment name to limit monitor state.")
      .nullable()
      .default(null),
    owner: z
      .string()
      .trim()
      .describe(
        "Optional owner filter, such as `user:123`, `team:456`, `myteams`, or `unassigned`.",
      )
      .nullable()
      .default(null),
    query: z
      .string()
      .trim()
      .describe("Optional search query for monitor name or slug.")
      .nullable()
      .default(null),
    limit: z
      .number()
      .int()
      .positive()
      .max(99)
      .describe("Maximum number of monitors to return.")
      .default(10),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findMonitorsOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTagAndAttribute("organization.slug", organizationSlug);
    const requestedProjectSlug =
      params.projectSlug && params.projectSlug !== "all"
        ? params.projectSlug
        : undefined;
    if (requestedProjectSlug) {
      assertProjectRefWithinConstraint({
        resourceLabel: "Monitor list",
        scopedProjectSlug: context.constraints.projectSlug,
        project: { slug: requestedProjectSlug },
      });
    }
    const projectSlug = context.constraints.projectSlug ?? requestedProjectSlug;
    if (projectSlug) {
      setTagAndAttribute("project.slug", projectSlug);
    }

    const monitors = await apiService.listMonitors({
      organizationSlug,
      projectSlug,
      environment: params.environment ?? undefined,
      owner: params.owner ?? undefined,
      query: params.query ?? undefined,
      limit: params.limit + 1,
    });

    return structuredResult({
      monitors: monitors.slice(0, params.limit).map((monitor) => {
        const projectSlug =
          monitor.project?.slug ?? monitor.project?.name ?? null;
        const environments = monitor.environments ?? [];
        return {
          id: monitor.id === undefined ? null : String(monitor.id),
          slug: monitor.slug,
          name: monitor.name ?? monitor.slug,
          projectSlug,
          status: monitor.status ?? null,
          owner: getOwnerName(monitor),
          lastCheckIn: monitor.lastCheckIn ?? null,
          nextCheckIn: monitor.nextCheckIn ?? null,
          webUrl: apiService.getMonitorUrl(
            organizationSlug,
            monitor.slug,
            projectSlug ?? undefined,
          ),
          schedule: getSchedule(monitor),
          environments: environments
            .slice(0, ENVIRONMENT_LIMIT)
            .map((environment) => ({
              name: environment.name ?? null,
              status: environment.status ?? null,
              lastCheckIn: environment.lastCheckIn ?? null,
            })),
          hasMoreEnvironments: environments.length > ENVIRONMENT_LIMIT,
        };
      }),
      hasMore: monitors.length > params.limit,
    });
  },
});
