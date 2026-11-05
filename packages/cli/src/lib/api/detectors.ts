/** Native metric monitor documents. No legacy alert-rule projection. */
import {
  createOrganizationProjectDetector,
  deleteOrganizationDetector,
  getOrganizationDetector,
  type GetOrganizationDetectorResponse,
  listOrganizationDetectors,
  updateOrganizationDetector,
} from "@sentry/api";
import { ApiError } from "../errors.js";
import {
  getOrgSdkConfig,
  type PaginatedResponse,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";

export type MetricMonitor = GetOrganizationDetectorResponse;
export type MetricMonitorCreateBody = NonNullable<
  Parameters<typeof createOrganizationProjectDetector>[0]["body"]
>;
export type MetricMonitorUpdateBody = NonNullable<
  Parameters<typeof updateOrganizationDetector>[0]["body"]
>;

function detectorPath(org: string, id: string) {
  // SDK uses a number for path IDs; keep the server's decimal ID lossless.
  return { organization_id_or_slug: org, detector_id: id } as unknown as {
    organization_id_or_slug: string;
    detector_id: number;
  };
}

export async function listMetricMonitorsPaginated(
  org: string,
  options: {
    perPage?: number;
    cursor?: string;
    query?: string;
    project?: string[];
  } = {},
): Promise<PaginatedResponse<MetricMonitor[]>> {
  const result = await listOrganizationDetectors({
    ...(await getOrgSdkConfig(org)),
    path: { organization_id_or_slug: org },
    query: {
      query: options.query
        ? `type:metric_issue ${options.query}`
        : "type:metric_issue",
      sortBy: "-id",
      cursor: options.cursor,
      per_page: options.perPage,
      project: options.project ?? ["-1"],
    } as NonNullable<Parameters<typeof listOrganizationDetectors>[0]["query"]>,
  });
  return unwrapPaginatedResult<MetricMonitor[]>(
    result,
    "Failed to list metric monitors",
  );
}

export async function getMetricMonitor(
  org: string,
  id: string,
): Promise<MetricMonitor> {
  const result = await getOrganizationDetector({
    ...(await getOrgSdkConfig(org)),
    path: detectorPath(org, id),
  });
  const monitor = unwrapResult<MetricMonitor>(
    result,
    `Failed to get metric monitor '${id}'`,
  );
  if (monitor.type !== "metric_issue") {
    throw new ApiError(
      `Metric monitor '${id}' not found`,
      404,
      `Detector '${id}' is '${monitor.type}', not 'metric_issue'.`,
      `/organizations/${org}/detectors/${encodeURIComponent(id)}/`,
    );
  }
  return monitor;
}

export async function createMetricMonitor(
  org: string,
  projectSlug: string,
  body: MetricMonitorCreateBody,
): Promise<MetricMonitor> {
  const result = await createOrganizationProjectDetector({
    ...(await getOrgSdkConfig(org)),
    path: { organization_id_or_slug: org, project_id_or_slug: projectSlug },
    body,
  });
  return unwrapResult<MetricMonitor>(result, "Failed to create metric monitor");
}

export async function updateMetricMonitor(
  org: string,
  id: string,
  body: MetricMonitorUpdateBody,
): Promise<MetricMonitor> {
  await getMetricMonitor(org, id);
  const result = await updateOrganizationDetector({
    ...(await getOrgSdkConfig(org)),
    path: detectorPath(org, id),
    body,
  });
  return unwrapResult<MetricMonitor>(
    result,
    `Failed to update metric monitor '${id}'`,
  );
}

export async function deleteMetricMonitor(
  org: string,
  id: string,
): Promise<void> {
  await getMetricMonitor(org, id);
  const result = await deleteOrganizationDetector({
    ...(await getOrgSdkConfig(org)),
    path: detectorPath(org, id),
  });
  unwrapResult(result, `Failed to delete metric monitor '${id}'`);
}
