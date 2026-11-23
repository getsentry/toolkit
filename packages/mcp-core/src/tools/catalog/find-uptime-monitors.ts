import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlugOrAll,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";
import {
  toUptimeMonitorListItem,
  uptimeMonitorListItemSchema,
} from "./support/uptime-monitors";

export const findUptimeMonitorsOutputSchema = z.object({
  monitors: z.array(uptimeMonitorListItemSchema),
  hasMore: z.boolean(),
});

export default defineTool({
  name: "find_uptime_monitors",
  title: "Find Uptime Monitors",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "Find Sentry uptime monitors, which check a URL over HTTP. Returns each monitor's URL, status, interval, owner, and project.",
    "Scheduled jobs (cron): find_monitors. Metric thresholds: find_metric_monitors.",
    "When more results exist, narrow by project, environment, owner, or name.",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    // `all` means no project filter (same convention as find_monitors/find_releases).
    projectSlug: ParamProjectSlugOrAll.optional(),
    environment: z
      .string()
      .trim()
      .min(1)
      .describe("Environment to filter monitors by.")
      .optional(),
    owner: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Owner filter: `user:123`, `team:456`, `myteams`, or `unassigned`.",
      )
      .optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .describe("Text to match in the monitor name or URL.")
      .optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(99)
      .describe("Maximum monitors to return.")
      .default(10),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findUptimeMonitorsOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    const requestedProjectSlug =
      params.projectSlug && params.projectSlug !== "all"
        ? params.projectSlug
        : undefined;
    if (requestedProjectSlug) {
      assertProjectRefWithinConstraint({
        resourceLabel: "Uptime monitor list",
        scopedProjectSlug: context.constraints.projectSlug,
        project: { slug: requestedProjectSlug },
      });
    }
    const projectSlug = context.constraints.projectSlug ?? requestedProjectSlug;
    setTargetTagsAndAttributes({ organizationSlug, projectSlug });

    const monitors = await apiService.listUptimeMonitors({
      organizationSlug,
      projectSlug,
      environment: params.environment,
      owner: params.owner,
      query: params.query,
      limit: params.limit + 1,
    });

    return structuredResult({
      monitors: monitors
        .slice(0, params.limit)
        .map((monitor) =>
          toUptimeMonitorListItem(
            monitor,
            apiService.getUptimeMonitorUrl(organizationSlug, monitor.id),
          ),
        ),
      hasMore: monitors.length > params.limit,
    });
  },
});
