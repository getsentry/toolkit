import { z } from "zod";
import type {
  Dashboard,
  DashboardListItem,
  Project,
  DashboardWidget,
  SentryApiService,
} from "../../../api-client";
import { UserInputError } from "../../../errors";
import { isNumericId } from "../../../utils/slug-validation";
import { isPlainObject } from "../../../internal/type-guards";
import {
  formatActor,
  formatDate,
  formatId,
  readString,
} from "../../catalog/support/api-formatting";

function dashboardIncludesProject(
  dashboard: Pick<DashboardListItem, "projects">,
  projectId: string | number | null,
): boolean {
  if (!projectId || dashboard.projects.length === 0) {
    return true;
  }

  return dashboard.projects.some((dashboardProjectId) =>
    Object.is(String(dashboardProjectId), String(projectId)),
  );
}

function dashboardProjectConstraintError(
  resourceLabel: string,
  scopedProjectSlug: string,
) {
  return new UserInputError(
    `${resourceLabel} is outside the active project constraint. Expected project "${scopedProjectSlug}".`,
  );
}

/** Resolves an active project slug constraint to its numeric project ID. */
export async function resolveDashboardProjectConstraint({
  apiService,
  organizationSlug,
  scopedProjectSlug,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  scopedProjectSlug?: string | null;
}): Promise<Project | null> {
  if (!scopedProjectSlug) {
    return null;
  }

  return await apiService.getProject({
    organizationSlug,
    projectSlugOrId: scopedProjectSlug,
  });
}

/** Filters dashboard list items to those compatible with the active project. */
export function filterDashboardsByProjectConstraint({
  dashboards,
  projectId,
}: {
  dashboards: DashboardListItem[];
  projectId?: string | number | null;
}): DashboardListItem[] {
  return dashboards.filter((dashboard) =>
    dashboardIncludesProject(dashboard, projectId ?? null),
  );
}

/** Throws when a dashboard with explicit projects excludes the active project. */
export function assertDashboardWithinProjectConstraint({
  dashboard,
  scopedProjectSlug,
  projectId,
}: {
  dashboard: Dashboard;
  scopedProjectSlug?: string | null;
  projectId?: string | number | null;
}): void {
  if (
    scopedProjectSlug &&
    !dashboardIncludesProject(dashboard, projectId ?? null)
  ) {
    throw dashboardProjectConstraintError("Dashboard", scopedProjectSlug);
  }
}

const nullableString = z.string().nullable();

const dashboardWidgetSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: nullableString,
  displayType: nullableString,
  widgetType: nullableString,
  datasetSource: nullableString,
  interval: nullableString,
  limit: z.number().nullable(),
  layout: z
    .object({
      x: z.number().nullable(),
      y: z.number().nullable(),
      w: z.number().nullable(),
      h: z.number().nullable(),
    })
    .nullable(),
  queries: z.array(
    z.object({
      name: nullableString,
      conditions: nullableString,
      fields: z.array(z.string()),
      aggregates: z.array(z.string()),
      columns: z.array(z.string()),
      orderby: nullableString,
    }),
  ),
});

/** Saved dashboard configuration; widgets carry query definitions, not live data. */
export const dashboardDetailsSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  dateCreated: nullableString,
  createdBy: nullableString,
  createdByEmail: nullableString,
  projects: z.array(z.string()),
  environments: z.array(z.string()),
  period: nullableString,
  start: nullableString,
  end: nullableString,
  utc: z.boolean().nullable(),
  expired: z.boolean().nullable(),
  prebuiltId: nullableString,
  isFavorited: z.boolean(),
  filters: z.object({
    releases: z.array(z.string()),
    releaseIds: z.array(z.string()),
    globalFilters: z.array(
      z.object({
        dataset: nullableString,
        tagKey: nullableString,
        value: nullableString,
      }),
    ),
  }),
  widgets: z.array(dashboardWidgetSchema),
});

export type DashboardDetails = z.infer<typeof dashboardDetailsSchema>;

function readNumber(
  value: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const field = value?.[key];
  return typeof field === "number" ? field : null;
}

function formatCreator(createdBy: unknown): string | null {
  const name = createdBy ? formatActor(createdBy) : null;
  return name === "unknown" ? null : name;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toWidget(
  widget: DashboardWidget,
): DashboardDetails["widgets"][number] {
  const layout = widget.layout;
  return {
    id: formatId(widget.id),
    title: widget.title,
    description: widget.description || null,
    displayType: widget.displayType || null,
    widgetType: widget.widgetType || null,
    datasetSource: widget.datasetSource || null,
    interval: widget.interval || null,
    limit: widget.limit ?? null,
    layout: layout
      ? {
          x: readNumber(layout, "x"),
          y: readNumber(layout, "y"),
          w: readNumber(layout, "w"),
          h: readNumber(layout, "h"),
        }
      : null,
    queries: widget.queries.map((query) => ({
      name: query.name || null,
      conditions: query.conditions || null,
      fields: query.fields,
      aggregates: query.aggregates,
      columns: query.columns,
      orderby: query.orderby || null,
    })),
  };
}

function toFilters(
  filters: Record<string, unknown>,
): DashboardDetails["filters"] {
  const globalFilters = Array.isArray(filters.globalFilter)
    ? filters.globalFilter.filter(isPlainObject).map((filter) => ({
        dataset: readString(filter, "dataset"),
        tagKey: isPlainObject(filter.tag)
          ? readString(filter.tag, "key")
          : null,
        value: readString(filter, "value"),
      }))
    : [];
  return {
    releases: readStringArray(filters.release),
    releaseIds: readStringArray(filters.releaseId),
    globalFilters,
  };
}

/** Maps saved dashboard metadata, filters, widgets, and query definitions. */
export function toDashboardDetails({
  dashboard,
  dashboardUrl,
}: {
  dashboard: Dashboard;
  dashboardUrl: string;
}): DashboardDetails {
  return {
    id: formatId(dashboard.id),
    title: dashboard.title,
    url: dashboardUrl,
    dateCreated: formatDate(dashboard.dateCreated),
    createdBy: formatCreator(dashboard.createdBy),
    createdByEmail: isPlainObject(dashboard.createdBy)
      ? readString(dashboard.createdBy, "email")
      : null,
    projects: dashboard.projects.map(String),
    environments: dashboard.environment,
    period: dashboard.period || null,
    start: formatDate(dashboard.start),
    end: formatDate(dashboard.end),
    utc:
      dashboard.utc === null || dashboard.utc === undefined
        ? null
        : dashboard.utc === true || dashboard.utc === "true",
    expired: dashboard.expired ?? null,
    prebuiltId:
      dashboard.prebuiltId === null || dashboard.prebuiltId === undefined
        ? null
        : String(dashboard.prebuiltId),
    isFavorited: dashboard.isFavorited ?? false,
    filters: toFilters(dashboard.filters),
    widgets: dashboard.widgets.map(toWidget),
  };
}

function formatCandidates(candidates: DashboardListItem[]): string {
  return candidates
    .slice(0, 5)
    .map((dashboard) => `- ${dashboard.title} (ID: ${formatId(dashboard.id)})`)
    .join("\n");
}

/** Resolves a numeric dashboard ID directly or a single exact title match. */
export async function resolveDashboardId({
  apiService,
  organizationSlug,
  dashboardIdOrTitle,
  projectId,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  dashboardIdOrTitle: string;
  projectId?: string | number | null;
}): Promise<string> {
  const ref = dashboardIdOrTitle.trim();
  if (isNumericId(ref)) {
    return ref;
  }

  const visibleDashboards: DashboardListItem[] = [];
  const exactMatches: DashboardListItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const { dashboards, nextCursor } = await apiService.listDashboards({
      organizationSlug,
      query: ref,
      sortBy: "title",
      limit: 100,
      cursor,
    });

    const visiblePage = filterDashboardsByProjectConstraint({
      dashboards,
      projectId,
    });
    visibleDashboards.push(...visiblePage);
    exactMatches.push(
      ...visiblePage.filter(
        (dashboard) => dashboard.title.toLowerCase() === ref.toLowerCase(),
      ),
    );

    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  if (exactMatches.length === 1) {
    return String(exactMatches[0]!.id);
  }

  if (exactMatches.length > 1) {
    throw new UserInputError(
      `Multiple dashboards match the title "${ref}". Use a dashboard ID instead.\n\n${formatCandidates(exactMatches)}`,
    );
  }

  const candidateText = visibleDashboards.length
    ? `\n\nDid you mean:\n${formatCandidates(visibleDashboards)}`
    : "";
  throw new UserInputError(
    `No dashboard with title "${ref}" found in "${organizationSlug}".${candidateText}`,
  );
}
