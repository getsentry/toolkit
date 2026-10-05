import { z } from "zod";
import type { DashboardListItem, SentryApiService } from "../../api-client";
import { UserInputError } from "../../errors";
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

const PROJECT_DASHBOARD_CURSOR_PREFIX = "mcp-dashboard-project:";

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

type ProjectDashboardCursor = {
  v: 1;
  apiCursor: string | null;
  offset: number;
  pageLimit: number;
};

function isProjectDashboardCursor(
  value: unknown,
): value is ProjectDashboardCursor {
  if (!value || typeof value !== "object") {
    return false;
  }

  const cursor = value as Record<string, unknown>;
  return (
    cursor.v === 1 &&
    (typeof cursor.apiCursor === "string" || cursor.apiCursor === null) &&
    typeof cursor.offset === "number" &&
    Number.isInteger(cursor.offset) &&
    cursor.offset >= 0 &&
    typeof cursor.pageLimit === "number" &&
    Number.isInteger(cursor.pageLimit) &&
    cursor.pageLimit > 0 &&
    cursor.pageLimit <= 100
  );
}

/**
 * Encodes the project-scoped pagination state that Sentry's dashboard API
 * cannot represent: a visible-item offset inside one upstream API page.
 */
function encodeProjectDashboardCursor(
  cursor: Omit<ProjectDashboardCursor, "v">,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      ...cursor,
    } satisfies ProjectDashboardCursor),
  ).toString("base64url");
  return `${PROJECT_DASHBOARD_CURSOR_PREFIX}${payload}`;
}

/** Decodes MCP-owned project cursors while leaving raw Sentry API cursors intact. */
function decodeProjectDashboardCursor(
  cursor: string | null | undefined,
): ProjectDashboardCursor | null {
  if (!cursor?.startsWith(PROJECT_DASHBOARD_CURSOR_PREFIX)) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(
      Buffer.from(
        cursor.slice(PROJECT_DASHBOARD_CURSOR_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    );
    if (isProjectDashboardCursor(value)) {
      return value;
    }
  } catch {
    // Fall through to the user-facing validation error below.
  }

  throw new UserInputError(
    "Invalid dashboard cursor. Pass the cursor exactly as returned by find_dashboards.",
  );
}

/** Ensures org-wide dashboard searches only pass raw Sentry cursors upstream. */
function assertRawDashboardCursor(cursor: string | null | undefined): void {
  if (!cursor?.startsWith(PROJECT_DASHBOARD_CURSOR_PREFIX)) {
    return;
  }

  throw new UserInputError(
    "Project-scoped dashboard cursors can only be used in project-scoped dashboard searches. Start a new org-wide find_dashboards request without a cursor.",
  );
}

/** Formats the next project cursor without exposing raw API cursors for constrained pages. */
function formatProjectDashboardNextCursor({
  apiCursor,
  offset = 0,
  pageLimit,
}: {
  apiCursor: string | null;
  offset?: number;
  pageLimit: number;
}): string | null {
  if (!apiCursor) {
    return null;
  }

  return encodeProjectDashboardCursor({
    apiCursor,
    offset,
    pageLimit,
  });
}

/**
 * Lists dashboards visible to one project, refilling across API pages while
 * keeping Sentry's cursor page size stable for every followed API cursor.
 */
async function listProjectVisibleDashboards({
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
  titleQuery?: string | null;
  sort: "title" | "-title" | "dateCreated" | "-dateCreated";
  limit: number;
  cursor?: string | null;
  projectId: string | number;
}): Promise<{ dashboards: DashboardListItem[]; nextCursor: string | null }> {
  const projectCursor = decodeProjectDashboardCursor(cursor);
  const dashboards: DashboardListItem[] = [];
  const seenCursors = new Set<string>();
  const pageLimit = projectCursor?.pageLimit ?? limit;
  let pageCursor = projectCursor ? projectCursor.apiCursor : (cursor ?? null);
  let visibleOffset = projectCursor?.offset ?? 0;
  let nextCursor: string | null = null;

  if (pageCursor) {
    seenCursors.add(pageCursor);
  }

  do {
    const page = await apiService.listDashboards({
      organizationSlug,
      query: titleQuery ?? undefined,
      sortBy: sort,
      limit: pageLimit,
      cursor: pageCursor ?? undefined,
    });

    const visiblePage = filterDashboardsByProjectConstraint({
      dashboards: page.dashboards,
      projectId,
    });
    const offsetVisiblePage = visiblePage.slice(visibleOffset);
    const remaining = limit - dashboards.length;

    if (offsetVisiblePage.length > remaining) {
      dashboards.push(...offsetVisiblePage.slice(0, remaining));
      return {
        dashboards,
        nextCursor: encodeProjectDashboardCursor({
          apiCursor: pageCursor,
          offset: visibleOffset + remaining,
          pageLimit,
        }),
      };
    }

    dashboards.push(...offsetVisiblePage);
    visibleOffset = 0;

    nextCursor = page.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      nextCursor = null;
      break;
    }

    seenCursors.add(nextCursor);
    pageCursor = nextCursor;
  } while (dashboards.length < limit);

  return {
    dashboards,
    nextCursor: formatProjectDashboardNextCursor({
      apiCursor: nextCursor,
      pageLimit,
    }),
  };
}

export default defineTool({
  name: "find_dashboards",
  skills: ["inspect"],
  requiredScopes: ["org:read"],
  description: [
    "Find Sentry dashboards in an organization.",
    "",
    "Use this tool when you need to:",
    "- List dashboards in an organization",
    "- Find a dashboard ID before calling get_dashboard_details",
    "- Search dashboards by title",
    "",
    "<examples>",
    "find_dashboards(organizationSlug='my-organization')",
    "find_dashboards(organizationSlug='my-organization', titleQuery='errors')",
    "</examples>",
    "",
    "<hints>",
    "- Dashboard IDs are organization-scoped.",
    "- Use `get_dashboard_details` after finding the correct dashboard ID.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    titleQuery: z
      .string()
      .trim()
      .describe("Optional title substring to search for.")
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
        "Optional pagination cursor from a previous response. Reuse cursors only with the same search scope and project constraint.",
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

    let dashboards: DashboardListItem[];
    let nextCursor: string | null;
    if (scopedProject) {
      ({ dashboards, nextCursor } = await listProjectVisibleDashboards({
        apiService,
        organizationSlug,
        titleQuery: params.titleQuery,
        sort: params.sort,
        limit: params.limit,
        projectId: scopedProject.id,
        cursor: params.cursor,
      }));
    } else {
      assertRawDashboardCursor(params.cursor);
      ({ dashboards, nextCursor } = await apiService.listDashboards({
        organizationSlug,
        query: params.titleQuery ?? undefined,
        sortBy: params.sort,
        limit: params.limit,
        cursor: params.cursor ?? undefined,
      }));
    }

    return structuredResult({
      dashboards: dashboards.map((dashboard) => ({
        id: String(dashboard.id),
        title: dashboard.title,
        widgetCount: dashboard.widgetPreview.length,
        widgetTypes: Array.from(new Set(dashboard.widgetDisplay)),
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
