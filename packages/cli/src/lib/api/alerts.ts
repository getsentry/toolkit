/**
 * Alert rules API functions
 *
 * Fetch operations for Sentry alert rules:
 * - Issue alerts: event-based rules that trigger on matching errors (per-project)
 * - Metric alerts: threshold-based rules that trigger on metric queries (org-wide)
 */

import {
  createOrganizationProjectDetector,
  createOrganizationWorkflow,
  deleteOrganizationDetector,
  getOrganizationDetector,
  getOrganizationWorkflow,
  listOrganizationDetectors,
  updateOrganizationDetector,
  updateOrganizationWorkflow,
} from "@sentry/api";
import { ApiError, ValidationError } from "../errors.js";
import { resolveOrgRegion } from "../region.js";
import {
  apiRequestToRegion,
  apiRequestToRegionNoContent,
  getOrgSdkConfig,
  type PaginatedResponse,
  parseLinkHeader,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";

// Types

/** A single issue alert rule (event-based) */
export type IssueAlertRule = {
  id: string;
  name: string;
  /** "active" | "disabled" */
  status: string;
  actionMatch: string;
  conditions?: unknown[];
  actions?: unknown[];
  frequency: number;
  environment: string | null;
  owner: string | null;
  projects: string[];
  dateCreated: string;
  /**
   * Detector IDs the workflow is attached to. Returned by the org-scoped
   * `/workflows/` endpoint; used to filter out unattached org-level workflows
   * (a workflow with no detectors is not an issue alert rule).
   */
  detectorIds?: Array<string | number>;
};

/** A single metric alert rule (threshold-based, org-scoped) */
export type MetricAlertRule = {
  id: string;
  name: string;
  /** 0/"0"/absent = active, 1/"1" = disabled */
  status?: number | string;
  query: string;
  aggregate: string;
  dataset: string;
  timeWindow: number;
  environment: string | null;
  owner: string | null;
  projects: string[];
  dateCreated: string;
};

/**
 * A metric-issue detector as returned by the org-scoped `/detectors/` endpoint.
 *
 * The new detectors API replaces the legacy `/alert-rules/` endpoint. The
 * threshold query fields (aggregate, dataset, query, timeWindow) live inside
 * the first entry of `dataSources`, and the active/disabled state is the
 * top-level `enabled` boolean. Only the fields the CLI reads are typed; the
 * nested `dataSources`/`config` objects are otherwise opaque.
 */
type MetricDetector = {
  id: string | number;
  name: string;
  /** Detector kind, e.g. `metric_issue`. Other kinds (uptime, cron) are rejected on read. */
  type?: string;
  enabled?: boolean;
  environment?: string | null;
  projectSlug?: string | null;
  projects?: string[] | null;
  owner?: { type: string; name?: string; id?: string } | string | null;
  dateCreated?: string;
  dataSources?: Record<string, unknown>[] | null;
};

/**
 * Map a metric-issue detector onto the flat `MetricAlertRule` shape the CLI
 * commands (list/view/resolve) already consume.
 *
 * The threshold query fields live in the first data source, possibly nested
 * under `queryObj`, `snubaQuery`, or `queryObj.snubaQuery` — `resolveThresholdSource`
 * picks the right container. `enabled === false` maps to the legacy disabled
 * status (1); an enabled or absent flag maps to active (0), matching
 * `metricAlertStatusLabel`.
 */
function pickDetectorString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pickDetectorNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Resolve the project slug list for a detector.
 *
 * Detectors are project-scoped and expose a single `projectSlug`, not the
 * legacy `projects` slug array; fall back to `projects` for deployments that
 * still return it so metric alert view doesn't incorrectly show `(all)`.
 */
function pickDetectorProjects(detector: MetricDetector): string[] {
  if (detector.projectSlug) {
    return [detector.projectSlug];
  }
  return detector.projects ?? [];
}

/**
 * Reduce a detector owner (object or bare string) to the flat actor identifier.
 *
 * Legacy `/alert-rules/` returned `owner` as an actor string like `user:123`
 * or `team:456`, and the CLI formatters/JSON still treat it that way. Detectors
 * expose the owner as `{ type, id, name }`, so reconstruct `type:id` to preserve
 * that shape; fall back to a bare `id`/`name` when `type` is absent.
 */
function pickDetectorOwner(owner: MetricDetector["owner"]): string | null {
  if (typeof owner === "string") {
    return owner;
  }
  if (owner && typeof owner === "object") {
    if (owner.type && owner.id) {
      return `${owner.type}:${owner.id}`;
    }
    return owner.id ?? owner.name ?? null;
  }
  return null;
}

/**
 * Locate the object holding the threshold query fields for a detector.
 *
 * Depending on deployment the `SnubaQuery` fields (aggregate/dataset/query/
 * timeWindow) sit directly on `dataSources[0]`, under a `queryObj`, under a
 * `snubaQuery`, or nested at `queryObj.snubaQuery`. Walk those candidates
 * breadth-first and return the first that actually exposes an `aggregate` or
 * `query`, so a wrapper object (e.g. a `queryObj` whose real fields live in a
 * nested `snubaQuery`) doesn't flatten everything to empty.
 */
function resolveThresholdSource(
  source: Record<string, unknown>
): Record<string, unknown> {
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  const queryObj = asRecord(source.queryObj);
  const snubaQuery = asRecord(source.snubaQuery);
  const candidates = [
    queryObj && asRecord(queryObj.snubaQuery),
    queryObj,
    snubaQuery,
    source,
  ];

  for (const candidate of candidates) {
    if (candidate && ("aggregate" in candidate || "query" in candidate)) {
      return candidate;
    }
  }
  return source;
}

function mapDetectorToMetricAlertRule(
  detector: MetricDetector
): MetricAlertRule {
  const source = detector.dataSources?.[0] ?? {};
  const nested = resolveThresholdSource(source);

  const environment =
    pickDetectorString(nested.environment) || detector.environment || null;

  // The detector payload exposes timeWindow in seconds, but MetricAlertRule
  // (and every CLI formatter, which appends "m") treats it as whole minutes.
  const timeWindowSeconds = pickDetectorNumber(nested.timeWindow);

  return {
    id: String(detector.id),
    name: detector.name,
    status: detector.enabled === false ? 1 : 0,
    query: pickDetectorString(nested.query),
    aggregate: pickDetectorString(nested.aggregate),
    dataset: pickDetectorString(nested.dataset),
    timeWindow: timeWindowSeconds > 0 ? Math.round(timeWindowSeconds / 60) : 0,
    environment,
    owner: pickDetectorOwner(detector.owner),
    projects: pickDetectorProjects(detector),
    dateCreated: detector.dateCreated ?? "",
  };
}

// Issue alerts
//
// Issue alert rules are read from the org-scoped `/organizations/{org}/workflows/`
// endpoint (filtered by `projectSlug`). The legacy project-scoped
// `/projects/{org}/{project}/rules/` endpoint was deprecated on 2026-05-14 and
// now returns HTTP 410 during recurring brownouts (getsentry/cli#1182). The
// workflows endpoint returns rule-shaped payloads, so the existing
// `IssueAlertRule` shape is preserved. Mutations (create/update/delete) still
// use the legacy endpoint pending a follow-up migration.

/**
 * Keep only workflows that are attached to a detector.
 *
 * A `projectSlug`-filtered workflows response can also include unattached
 * org-level workflows; those are not issue alert rules, so we drop any entry
 * with no `detectorIds`. Mirrors the sentry-mcp filter of the same name.
 */
function filterAttachedIssueAlertRules(
  rules: IssueAlertRule[]
): IssueAlertRule[] {
  return rules.filter((rule) => (rule.detectorIds ?? []).length > 0);
}

/**
 * List issue alert rules for a project with cursor-based pagination.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @param options - Pagination parameters (perPage, cursor)
 * @returns Paginated response with issue alert rules and optional next cursor
 */
export async function listIssueAlertsPaginated(
  orgSlug: string,
  projectSlug: string,
  options: { perPage?: number; cursor?: string } = {}
): Promise<PaginatedResponse<IssueAlertRule[]>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data, headers } = await apiRequestToRegion<IssueAlertRule[]>(
    regionUrl,
    `/organizations/${orgSlug}/workflows/`,
    {
      params: {
        projectSlug,
        sortBy: "-id",
        per_page: options.perPage,
        cursor: options.cursor,
      },
    }
  );
  const { nextCursor } = parseLinkHeader(headers.get("link") ?? null);
  return { data: filterAttachedIssueAlertRules(data), nextCursor };
}

/**
 * Full workflow document for the edit baseline (name, config, environment,
 * triggers, action_filters, detector_ids, ...), read from the org-scoped
 * `/organizations/{org}/workflows/{id}/` detail endpoint.
 */
export async function getIssueAlertWorkflowDocument(
  orgSlug: string,
  workflowId: string
): Promise<Record<string, unknown>> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await getOrganizationWorkflow({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      workflow_id: Number(workflowId),
    },
  });
  return unwrapResult<Record<string, unknown>>(
    result,
    "Failed to fetch issue alert rule"
  );
}

/**
 * Resolve the id of a project's error detector ("Error Monitor"). An issue alert
 * workflow must connect to it via `detector_ids` to fire on new issues. Reads the
 * org-scoped detectors endpoint filtered to the project and the `error` type.
 *
 * @throws {ApiError} 404 if the project has no error detector
 */
export async function resolveErrorDetectorId(
  orgSlug: string,
  projectSlug: string
): Promise<number> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await listOrganizationDetectors({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: { project: [projectSlug], query: "type:error" },
  });
  const detectors = unwrapResult<Array<{ id: string | number }>>(
    result,
    "Failed to resolve error detector"
  );
  const detector = detectors[0];
  if (!detector) {
    throw new ApiError(
      `No error detector found for project '${projectSlug}'`,
      404,
      undefined,
      `/organizations/${orgSlug}/detectors/`
    );
  }
  return Number(detector.id);
}

/**
 * Get a single issue alert rule by ID.
 *
 * Reads from the org-scoped `/workflows/` endpoint, filtered by project and id.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @param ruleId - Alert rule ID
 * @returns The issue alert rule
 * @throws {ApiError} 404 if no attached rule matches the id in the project
 */
export async function getIssueAlertRule(
  orgSlug: string,
  projectSlug: string,
  ruleId: string
): Promise<IssueAlertRule> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await apiRequestToRegion<IssueAlertRule[]>(
    regionUrl,
    `/organizations/${orgSlug}/workflows/`,
    { params: { projectSlug, id: ruleId, per_page: 1 } }
  );
  const rule = filterAttachedIssueAlertRules(data)[0];
  if (!rule) {
    throw new ApiError(
      `Issue alert rule '${ruleId}' not found`,
      404,
      undefined,
      `/organizations/${orgSlug}/workflows/`
    );
  }
  return rule;
}

// Metric alerts
//
// Metric alert rules are read from the org-scoped
// `/organizations/{org}/detectors/` endpoint (filtered to `type:metric_issue`).
// The legacy `/organizations/{org}/alert-rules/` endpoint is being retired on
// 2026-08-17 (getsentry/cli#1274, #1182). Detectors return a nested shape, so
// `mapDetectorToMetricAlertRule` flattens each detector into the existing
// `MetricAlertRule` shape the commands already consume. Mutations
// (create/update/delete) also target the detectors write API — the flat CLI
// input is translated into the nested detector body by `buildDetectorBody`.

/** Search query that limits the detectors endpoint to metric alert rules. */
const METRIC_DETECTOR_QUERY = "type:metric_issue";

/**
 * List metric alert rules for an organization with cursor-based pagination.
 *
 * Reads from the org-scoped `/detectors/` endpoint filtered to
 * `type:metric_issue` and maps each detector onto the flat `MetricAlertRule`
 * shape.
 *
 * @param orgSlug - Organization slug
 * @param options - Pagination parameters (perPage, cursor)
 * @returns Paginated response with metric alert rules and optional next cursor
 */
export async function listMetricAlertsPaginated(
  orgSlug: string,
  options: { perPage?: number; cursor?: string } = {}
): Promise<PaginatedResponse<MetricAlertRule[]>> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await listOrganizationDetectors({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: {
      query: METRIC_DETECTOR_QUERY,
      sortBy: "-id",
      cursor: options.cursor,
      per_page: options.perPage,
    } as {
      query?: string;
      sortBy?: string;
      cursor?: string;
      per_page?: number;
    },
  });
  const { data, nextCursor } = unwrapPaginatedResult<MetricDetector[]>(
    result,
    "Failed to list metric alert rules"
  );
  return { data: data.map(mapDetectorToMetricAlertRule), nextCursor };
}

/**
 * Get a single metric alert rule by ID.
 *
 * Reads from the org-scoped `/detectors/{id}/` endpoint and maps the detector
 * onto the flat `MetricAlertRule` shape.
 *
 * The `/detectors/{id}/` endpoint returns any detector kind (uptime, cron,
 * error, …), unlike the `type:metric_issue`-filtered list. A non-metric id is
 * rejected with a 404 so view/edit/delete don't silently render an unrelated
 * detector as a metric alert with empty threshold fields.
 *
 * @param orgSlug - Organization slug
 * @param ruleId - Detector (alert rule) ID
 * @returns The metric alert rule
 */
export async function getMetricAlertRule(
  orgSlug: string,
  ruleId: string
): Promise<MetricAlertRule> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await getOrganizationDetector({
    ...config,
    // The SDK types detector_id as number, but detector IDs are opaque strings
    // the API accepts verbatim; pass the string through the string-keyed path.
    path: {
      organization_id_or_slug: orgSlug,
      detector_id: ruleId,
    } as unknown as {
      organization_id_or_slug: string;
      detector_id: number;
    },
  });
  const data = unwrapResult<MetricDetector>(
    result,
    `Failed to get metric alert rule '${ruleId}'`
  );
  if (data.type !== undefined && data.type !== "metric_issue") {
    throw new ApiError(
      `Metric alert rule '${ruleId}' not found`,
      404,
      `Detector '${ruleId}' is of type '${data.type}', not a metric alert.`,
      `/organizations/${orgSlug}/detectors/${encodeURIComponent(ruleId)}/`
    );
  }
  return mapDetectorToMetricAlertRule(data);
}

// Issue alert write operations

/**
 * Delete an issue alert rule via the org-scoped `/workflows/` endpoint.
 *
 * `ruleId` is the workflow id surfaced by the migrated read path (`list`/`view`),
 * so the delete is keyed by id alone — no project slug is needed (project scoping
 * already happens upstream when the rule is resolved via `resolveIssueAlertRule`).
 *
 * Succeeds with 204 No Content and no response body.
 */
export async function deleteIssueAlertRule(
  orgSlug: string,
  ruleId: string
): Promise<void> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  await apiRequestToRegionNoContent(
    regionUrl,
    `/organizations/${orgSlug}/workflows/${encodeURIComponent(ruleId)}/`,
    { method: "DELETE" }
  );
}

/**
 * Replace (update) an issue alert workflow. Sentry PUT is a full replacement.
 *
 * `workflowId` is the id surfaced by the migrated read path; the update is keyed
 * by id on the org-scoped `/workflows/{id}/` endpoint.
 */
export async function updateIssueAlertRule(
  orgSlug: string,
  workflowId: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await updateOrganizationWorkflow({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      workflow_id: Number(workflowId),
    },
    // The SDK types conditions/actions as `unknown[]`; the CLI supplies the
    // workflow-native body as a plain record, so cast into the typed arg.
    body: body as unknown as Parameters<
      typeof updateOrganizationWorkflow
    >[0]["body"],
  });
  return unwrapResult<Record<string, unknown>>(
    result,
    "Failed to update issue alert rule"
  );
}

/**
 * Create an issue alert workflow on the org-scoped `/workflows/` endpoint.
 *
 * `body` must be workflow-shaped (name, detector_ids, config, triggers,
 * action_filters, ...). Project linkage is carried by `detector_ids`, so no
 * project slug is part of the request.
 */
export async function createIssueAlertRule(
  orgSlug: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await createOrganizationWorkflow({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    // The SDK types conditions/actions as `unknown[]`; the CLI supplies the
    // workflow-native body as a plain record, so cast into the typed arg.
    body: body as unknown as Parameters<
      typeof createOrganizationWorkflow
    >[0]["body"],
  });
  return unwrapResult<Record<string, unknown>>(
    result,
    "Failed to create issue alert rule"
  );
}

// Metric alert (org) write operations
//
// The CLI create/edit commands build a *flat* legacy alert-rule body (name,
// query, aggregate, dataset, timeWindow, triggers, projects, environment,
// owner). The detectors write API takes a *nested* shape (dataSources /
// conditionGroup / config), so `buildDetectorBody` translates the flat body
// into the detector document before the request is sent. This keeps the
// command layer unchanged while the transport moves off the retiring
// `/alert-rules/` endpoint (getsentry/cli#1274, #1277).

/**
 * Datasets whose events flow through the error/transaction pipeline
 * (`queryType: 0`) rather than the trace-item pipeline (`queryType: 1`).
 */
const ERROR_LIKE_DATASETS = new Set(["errors", "events"]);

/** Detector `queryType` for a metric alert dataset. */
function datasetQueryType(dataset: string): 0 | 1 {
  return ERROR_LIKE_DATASETS.has(dataset.trim().toLowerCase()) ? 0 : 1;
}

/**
 * Default `eventTypes` for a metric alert dataset.
 *
 * Error-like datasets track `error`/`default` events; everything else measures
 * spans. The backend accepts an explicit `eventTypes` on the data source and
 * derives the internal query type from `queryType`.
 */
function datasetEventTypes(dataset: string): string[] {
  return ERROR_LIKE_DATASETS.has(dataset.trim().toLowerCase())
    ? ["error", "default"]
    : ["trace_item_span"];
}

/**
 * Build the single data source describing the threshold query for a detector.
 *
 * `timeWindow` is carried by the flat body in *minutes* (every CLI formatter
 * appends "m"), but the detector API expects *seconds*, matching the inverse
 * conversion in `mapDetectorToMetricAlertRule`.
 */
function buildDetectorDataSource(
  body: Record<string, unknown>
): Record<string, unknown> {
  const dataset = typeof body.dataset === "string" ? body.dataset : "";
  const timeWindowMinutes =
    typeof body.timeWindow === "number" ? body.timeWindow : 0;
  const source: Record<string, unknown> = {
    aggregate: typeof body.aggregate === "string" ? body.aggregate : "",
    dataset,
    query: typeof body.query === "string" ? body.query : "",
    queryType: datasetQueryType(dataset),
    eventTypes: datasetEventTypes(dataset),
    timeWindow: timeWindowMinutes * 60,
  };
  if (typeof body.environment === "string" && body.environment !== "") {
    source.environment = body.environment;
  }
  return source;
}

/**
 * Translate a flat metric alert body into the nested detector write payload.
 *
 * The flat body is what the create/edit commands assemble (and the edit merge
 * baseline, which reuses the `MetricAlertRule` shape). Trigger objects are
 * passed through verbatim as the condition group's conditions — their
 * `alertThreshold`/`actions` shape is already validated command-side. `status`
 * (0 active / 1 disabled) maps onto the detector's `enabled` boolean.
 */
function buildDetectorBody(
  body: Record<string, unknown>
): Record<string, unknown> {
  const detectorBody: Record<string, unknown> = {
    name: typeof body.name === "string" ? body.name : "",
    type: "metric_issue",
    dataSources: [buildDetectorDataSource(body)],
    config: { detectionType: "static" },
  };

  const triggers = Array.isArray(body.triggers) ? body.triggers : undefined;
  if (triggers) {
    detectorBody.conditionGroup = {
      logicType: "any",
      conditions: triggers,
    };
  }

  if (body.status !== undefined) {
    detectorBody.enabled = Number(body.status) !== 1;
  }
  if (body.owner !== undefined) {
    detectorBody.owner = body.owner as string | null;
  }
  return detectorBody;
}

/**
 * Resolve the target project slug for a metric detector create.
 *
 * Detector create is project-scoped (`/projects/{project}/detectors/`), unlike
 * the legacy org-scoped `/alert-rules/` create. The flat body carries the
 * project(s) in `projects`; the first entry is used. A metric alert without a
 * project cannot be created against the detectors API.
 *
 * @throws {ValidationError} when no project slug is present
 */
function resolveDetectorProject(body: Record<string, unknown>): string {
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const project = projects.find(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  );
  if (!project) {
    throw new ValidationError(
      "A project is required to create a metric alert rule (pass --project).",
      "project"
    );
  }
  return project;
}

/**
 * Delete a metric alert rule via the org-scoped `/detectors/{id}/` endpoint.
 *
 * `ruleId` is the detector id surfaced by the migrated read path. Succeeds with
 * 204 No Content and no response body.
 */
export async function deleteMetricAlertRule(
  orgSlug: string,
  ruleId: string
): Promise<void> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await deleteOrganizationDetector({
    ...config,
    // Detector IDs are opaque strings the API accepts verbatim; the SDK types
    // detector_id as number, so pass the string through the string-keyed path.
    path: {
      organization_id_or_slug: orgSlug,
      detector_id: ruleId,
    } as unknown as {
      organization_id_or_slug: string;
      detector_id: number;
    },
  });
  unwrapResult(result, `Failed to delete metric alert rule '${ruleId}'`);
}

/**
 * Fetch the edit baseline for a metric alert rule.
 *
 * The edit command merges flag overrides onto this baseline in the flat
 * `MetricAlertRule` shape, then hands the merged body to `putMetricAlertRule`,
 * which translates it into the nested detector document. Returning the flat
 * shape (rather than the raw detector) keeps the command-side merge coherent.
 */
export async function getMetricAlertRuleDocument(
  orgSlug: string,
  ruleId: string
): Promise<Record<string, unknown>> {
  const rule = await getMetricAlertRule(orgSlug, ruleId);
  return { ...rule };
}

/**
 * Update a metric alert rule via the org-scoped `/detectors/{id}/` endpoint.
 *
 * `body` is the flat merged edit body; it is translated into the nested
 * detector update payload before the PUT.
 */
export async function putMetricAlertRule(
  orgSlug: string,
  ruleId: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await updateOrganizationDetector({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      detector_id: ruleId,
    } as unknown as {
      organization_id_or_slug: string;
      detector_id: number;
    },
    // The SDK types the detector body with snake_case keys and opaque
    // dataSources/conditions; the CLI supplies the camelCase document the
    // endpoint's CamelSnakeSerializer expects, so cast into the typed arg.
    body: buildDetectorBody(body) as unknown as Parameters<
      typeof updateOrganizationDetector
    >[0]["body"],
  });
  return unwrapResult<Record<string, unknown>>(
    result,
    `Failed to update metric alert rule '${ruleId}'`
  );
}

/**
 * Create a metric alert rule via the project-scoped `/detectors/` endpoint.
 *
 * `body` is the flat create body; the target project is taken from
 * `body.projects` and the rest is translated into the nested detector payload.
 */
export async function createMetricAlertRule(
  orgSlug: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const projectSlug = resolveDetectorProject(body);
  const config = await getOrgSdkConfig(orgSlug);
  const result = await createOrganizationProjectDetector({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      project_id_or_slug: projectSlug,
    },
    body: buildDetectorBody(body) as unknown as Parameters<
      typeof createOrganizationProjectDetector
    >[0]["body"],
  });
  return unwrapResult<Record<string, unknown>>(
    result,
    "Failed to create metric alert rule"
  );
}
