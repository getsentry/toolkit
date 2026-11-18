import { MAX_LIST_PAGES, paginate } from "@sentry/api/client";
import { z } from "zod";
import type { DashboardListItem, SentryApiService } from "../../api-client";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  filterDashboardsByProjectConstraint,
  resolveDashboardProjectConstraint,
} from "../support/dashboards";
import { formatActor } from "./support/api-formatting";

const dashboardSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  widgetCount: z.number().int().nonnegative(),
  widgetTypes: z.array(z.string()),
  projects: z.array(z.string()),
  environments: z.array(z.string()),
  createdBy: z.string().nullable(),
  dateCreated: z.string(),
  lastVisited: z.string().nullable(),
  isFavorited: z.boolean(),
  prebuiltId: z.string().nullable(),
  url: z.string().url(),
});

export const findDashboardsOutputSchema = z.object({
  dashboards: z.array(dashboardSummarySchema),
  nextCursor: z.string().nullable(),
});

/**
 * Lists dashboards, walking API pages until `limit` dashboards are found.
 * In a project-constrained session each page is filtered to the project
 * first, so `limit` and the returned cursor count only visible dashboards;
 * a cursor that stops inside a page records how many of its visible rows
 * were already returned.
 */
async function listVisibleDashboards({
  apiService,
  organizationSlug,
  titleQuery,
  sort,
  limit,
  cursor,
  projectId,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  titleQuery: string | null;
  sort: "title" | "-title" | "dateCreated" | "-dateCreated";
  limit: number;
  cursor: string | null;
  projectId: string | number | undefined;
}): Promise<{ dashboards: DashboardListItem[]; nextCursor: string | null }> {
  const { data, nextCursor } = await paginate(
    { limit, cursor: cursor ?? undefined, maxPages: MAX_LIST_PAGES },
    async (perPage, pageCursor) => {
      const page = await apiService.listDashboards({
        organizationSlug,
        query: titleQuery ?? undefined,
        sortBy: sort,
        limit: perPage,
        cursor: pageCursor,
      });
      return {
        data:
          projectId === undefined
            ? page.dashboards
            : filterDashboardsByProjectConstraint({
                dashboards: page.dashboards,
                projectId,
              }),
        nextCursor: page.nextCursor ?? undefined,
      };
    },
  );
  return { dashboards: data, nextCursor: nextCursor ?? null };
}

export default defineTool({
  name: "find_dashboards",
  title: "Find Dashboards",
  skills: ["inspect"],
  requiredScopes: ["org:read"],
  description:
    "List or search Sentry dashboards in an organization by title, returning dashboard IDs and titles. Open one with get_dashboard_details.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    titleQuery: z
      .string()
      .trim()
      .describe("Title substring to search for.")
      .nullable()
      .default(null),
    sort: z
      .enum(["title", "-title", "dateCreated", "-dateCreated"])
      .describe("Sort order for dashboard results.")
      .default("title"),
    cursor: z
      .string()
      .trim()
      .describe(
        "Pagination cursor from a previous response with the same search.",
      )
      .nullable()
      .default(null),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .describe("Maximum number of dashboards to return.")
      .default(10),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findDashboardsOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes({ organizationSlug });

    const scopedProject = await resolveDashboardProjectConstraint({
      apiService,
      organizationSlug,
      scopedProjectSlug: context.constraints.projectSlug,
    });
    if (scopedProject) {
      setTargetTagsAndAttributes({
        organizationSlug,
        projectSlug: scopedProject.slug,
        projectId: scopedProject.id,
      });
    }

    const { dashboards, nextCursor } = await listVisibleDashboards({
      apiService,
      organizationSlug,
      titleQuery: params.titleQuery,
      sort: params.sort,
      limit: params.limit,
      cursor: params.cursor,
      projectId: scopedProject?.id,
    });

    return structuredResult({
      dashboards: dashboards.map((dashboard) => ({
        id: String(dashboard.id),
        title: dashboard.title,
        widgetCount: dashboard.widgetPreview.length,
        widgetTypes: [
          ...new Set(dashboard.widgetDisplay.filter((type) => type !== null)),
        ],
        projects: dashboard.projects.map(String),
        environments: dashboard.environment,
        createdBy: dashboard.createdBy
          ? formatActor(dashboard.createdBy)
          : null,
        dateCreated: dashboard.dateCreated,
        lastVisited: dashboard.lastVisited ?? null,
        isFavorited: dashboard.isFavorited ?? false,
        prebuiltId:
          dashboard.prebuiltId === null || dashboard.prebuiltId === undefined
            ? null
            : String(dashboard.prebuiltId),
        url: apiService.getDashboardUrl(
          organizationSlug,
          String(dashboard.id),
          {
            projectId:
              scopedProject?.id ??
              (dashboard.projects.length === 1 ? dashboard.projects[0] : null),
          },
        ),
      })),
      nextCursor,
    });
  },
});
