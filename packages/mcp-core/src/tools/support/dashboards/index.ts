import type {
  Dashboard,
  DashboardListItem,
  Project,
  DashboardWidget,
  SentryApiService,
} from "../../../api-client";
import { UserInputError } from "../../../errors";
import { isNumericId } from "../../../utils/slug-validation";
import {
  compactLines,
  formatActor,
  formatDate,
  formatId,
  formatUnknown,
} from "../../catalog/support/api-formatting";

function formatList(values: Array<string | number> | undefined): string | null {
  if (!values || values.length === 0) {
    return null;
  }
  return values.map(String).join(", ");
}

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

function formatWidgetQuery(
  query: DashboardWidget["queries"][number],
): string[] {
  const lines = compactLines([
    `- **${query.name || "Query"}**`,
    query.conditions ? `  - Conditions: \`${query.conditions}\`` : null,
    query.fields?.length ? `  - Fields: ${query.fields.join(", ")}` : null,
    query.aggregates?.length
      ? `  - Aggregates: ${query.aggregates.join(", ")}`
      : null,
    query.columns?.length ? `  - Columns: ${query.columns.join(", ")}` : null,
    query.orderby ? `  - Sort: \`${query.orderby}\`` : null,
  ]);

  return lines;
}

function formatWidget(widget: DashboardWidget, index: number): string {
  const layout = widget.layout;
  const layoutText =
    layout && typeof layout === "object"
      ? ["x", "y", "w", "h"]
          .filter((key) => layout[key] !== undefined)
          .map((key) => `${key}=${formatUnknown(layout[key])}`)
          .join(", ")
      : null;

  const lines = compactLines([
    `### ${index + 1}. ${widget.title}`,
    "",
    `**ID**: ${formatId(widget.id)}`,
    `**Display Type**: ${widget.displayType}`,
    widget.widgetType ? `**Widget Type**: ${widget.widgetType}` : null,
    widget.datasetSource ? `**Dataset**: ${widget.datasetSource}` : null,
    widget.interval ? `**Interval**: ${widget.interval}` : null,
    widget.limit !== null && widget.limit !== undefined
      ? `**Limit**: ${widget.limit}`
      : null,
    layoutText ? `**Layout**: ${layoutText}` : null,
    widget.description ? `**Description**: ${widget.description}` : null,
  ]);

  if (widget.queries.length > 0) {
    lines.push("", "#### Queries", "");
    for (const query of widget.queries) {
      lines.push(...formatWidgetQuery(query));
    }
  }

  return lines.join("\n");
}

function formatFilters(filters: Record<string, unknown>): string[] {
  return Object.entries(filters).map(
    ([key, value]) => `- **${key}**: ${formatUnknown(value)}`,
  );
}

/** Formats saved dashboard metadata, filters, widgets, and query definitions. */
export function formatDashboardDetails({
  dashboard,
  organizationSlug,
  dashboardUrl,
}: {
  dashboard: Dashboard;
  organizationSlug: string;
  dashboardUrl: string;
}): string {
  const lines = compactLines([
    `# Dashboard ${dashboard.title} in **${organizationSlug}**`,
    "",
    `**ID**: ${formatId(dashboard.id)}`,
    `**URL**: [Open Dashboard](${dashboardUrl})`,
    formatDate(dashboard.dateCreated)
      ? `**Created**: ${formatDate(dashboard.dateCreated)}`
      : null,
    dashboard.createdBy
      ? `**Created By**: ${formatActor(dashboard.createdBy)}`
      : null,
    formatList(dashboard.projects)
      ? `**Projects**: ${formatList(dashboard.projects)}`
      : null,
    formatList(dashboard.environment)
      ? `**Environments**: ${formatList(dashboard.environment)}`
      : null,
    dashboard.period ? `**Period**: ${dashboard.period}` : null,
    dashboard.start ? `**Start**: ${formatDate(dashboard.start)}` : null,
    dashboard.end ? `**End**: ${formatDate(dashboard.end)}` : null,
    dashboard.utc !== null && dashboard.utc !== undefined
      ? `**UTC**: ${formatUnknown(dashboard.utc)}`
      : null,
    dashboard.expired !== undefined
      ? `**Expired**: ${formatUnknown(dashboard.expired)}`
      : null,
    dashboard.prebuiltId !== null && dashboard.prebuiltId !== undefined
      ? `**Prebuilt ID**: ${formatId(dashboard.prebuiltId)}`
      : null,
    dashboard.isFavorited ? "**Favorited**: yes" : null,
  ]);

  const filterLines = formatFilters(dashboard.filters);
  if (filterLines.length > 0) {
    lines.push("", "## Filters", "", ...filterLines);
  }

  lines.push("", "## Widgets", "");

  if (dashboard.widgets.length === 0) {
    lines.push("No widgets found.");
  } else {
    lines.push(
      dashboard.widgets
        .map((widget, index) => formatWidget(widget, index))
        .join("\n\n"),
    );
  }

  lines.push("", "## Response Notes", "");
  lines.push(
    "- Dashboard widgets include saved query definitions, not live query results.",
  );

  return lines.join("\n");
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
