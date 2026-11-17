/**
 * Output schemas of the `sentry dashboard` commands.
 */

import {
  array,
  boolean,
  description,
  type InferOutput,
  looseObject,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
} from "valibot";
import {
  DashboardDetailSchema,
  DashboardWidgetLayoutSchema,
  DashboardWidgetQuerySchema,
  DashboardWidgetSchema,
  WidgetDataResultSchema,
} from "../types/dashboard.js";
import { DryRunOutputField } from "./output.js";

// Also validates the revisions API response at runtime, so it stays in
// `types/dashboard.ts`.
export { DashboardRevisionSchema } from "../types/dashboard.js";

/** Schema for dashboard list items (lightweight, from GET /dashboards/) */
export const DashboardListItemSchema = looseObject({
  id: string(),
  title: string(),
  dateCreated: optional(string()),
  createdBy: optional(
    object({
      name: optional(string()),
      email: optional(string()),
    }),
  ),
  widgetDisplay: optional(array(nullable(string()))),
});

/**
 * JSON output of `dashboard view`: the dashboard with each widget's query
 * result. The type the command yields is derived from it
 * (`DashboardViewData` in `lib/formatters/dashboard.ts`).
 */
export const DashboardViewOutputSchema = object({
  id: pipe(string(), description("Dashboard ID")),
  title: pipe(string(), description("Dashboard title")),
  period: pipe(string(), description("Time range of the widget data")),
  fetchedAt: pipe(
    string(),
    description("When the data was fetched (ISO 8601)"),
  ),
  url: pipe(string(), description("Dashboard URL")),
  dateCreated: optional(
    pipe(string(), description("Creation date (ISO 8601)")),
  ),
  environment: optional(
    pipe(array(string()), description("Environment filter")),
  ),
  widgets: pipe(
    array(
      object({
        title: pipe(string(), description("Widget title")),
        displayType: pipe(nullable(string()), description("Display type")),
        widgetType: optional(pipe(string(), description("Dataset"))),
        description: optional(
          pipe(string(), description("Markdown content of a text widget")),
        ),
        layout: optional(DashboardWidgetLayoutSchema),
        queries: optional(array(DashboardWidgetQuerySchema)),
        data: WidgetDataResultSchema,
      }),
    ),
    description("Widgets with their query results"),
  ),
});

/**
 * JSON output of `dashboard widget add` and `dashboard widget edit`, for
 * `--fields`: the saved dashboard, the added or edited widget, and its URL.
 */
export const DashboardWidgetChangeOutputSchema = object({
  dashboard: pipe(DashboardDetailSchema, description("The saved dashboard")),
  widget: pipe(
    DashboardWidgetSchema,
    description("The added or edited widget"),
  ),
  url: pipe(string(), description("Dashboard URL")),
});

/**
 * JSON output of `dashboard widget delete`: the deleted (or, with
 * `--dry-run`, matched) widget and the dashboard's widget count.
 */
export const DashboardWidgetDeleteOutputSchema = object({
  dryRun: DryRunOutputField,
  deleted: optional(
    pipe(boolean(), description("True when the widget was deleted")),
  ),
  widgetTitle: pipe(string(), description("Title of the deleted widget")),
  widgetCount: pipe(
    number(),
    description(
      "Dashboard widget count after the delete (before it, with --dry-run)",
    ),
  ),
  url: pipe(string(), description("Dashboard URL")),
});

/** JSON output of `dashboard create`: the created dashboard and its URL. */
export const DashboardCreateOutputSchema = looseObject({
  ...DashboardDetailSchema.entries,
  url: pipe(string(), description("Dashboard URL")),
});

/** JSON output of `dashboard create`. */
export type DashboardCreateOutput = InferOutput<
  typeof DashboardCreateOutputSchema
>;

/**
 * JSON output of `dashboard restore`: the restored dashboard and the
 * revision it was restored to.
 */
export const DashboardRestoreOutputSchema = object({
  dashboard: pipe(DashboardDetailSchema, description("Restored dashboard")),
  orgSlug: pipe(string(), description("Organization slug")),
  revisionId: pipe(string(), description("Restored revision ID")),
});

/** JSON output of `dashboard restore`. */
export type DashboardRestoreOutput = InferOutput<
  typeof DashboardRestoreOutputSchema
>;
