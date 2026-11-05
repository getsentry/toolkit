/** Organization-scoped native alert (workflow) API. */
import {
  createOrganizationWorkflow,
  deleteOrganizationWorkflow,
  getOrganizationWorkflow,
  listOrganizationDetectors,
  listOrganizationWorkflows,
  updateOrganizationWorkflow,
} from "@sentry/api";
import type {
  CreateOrganizationWorkflowData,
  GetOrganizationDetectorResponse,
  GetOrganizationWorkflowResponse,
  UpdateOrganizationWorkflowData,
} from "@sentry/api";
import { ValidationError } from "../errors.js";
import {
  getOrgSdkConfig,
  type PaginatedResponse,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";

export type Alert = GetOrganizationWorkflowResponse;
export type AlertCreateBody = CreateOrganizationWorkflowData["body"];
export type AlertUpdateBody = UpdateOrganizationWorkflowData["body"];
export type AlertListOptions = {
  perPage?: number;
  cursor?: string;
  query?: string;
  project?: string[];
  monitor?: string[];
};

/** Match Sentry's alert project selection: connect the project's issue stream. */
export async function resolveProjectAlertMonitorId(
  org: string,
  project: string,
): Promise<string> {
  const result = await listOrganizationDetectors({
    ...(await getOrgSdkConfig(org)),
    path: { organization_id_or_slug: org },
    query: { project: [project], query: "type:issue_stream", per_page: 2 },
  });
  const monitors = unwrapResult<GetOrganizationDetectorResponse[]>(
    result,
    "Failed to find the project's issue stream",
  );
  const monitor = monitors[0];
  if (!monitor || monitors.length !== 1) {
    throw new ValidationError(
      `Expected one issue stream in '${org}/${project}', found ${monitors.length}. Use --monitor with an explicit monitor ID.`,
      "project",
    );
  }
  return monitor.id;
}

/** List all accessible alerts, including workflows with no connected monitors. */
export async function listAlertsPaginated(
  org: string,
  options: AlertListOptions = {},
): Promise<PaginatedResponse<Alert[]>> {
  const config = await getOrgSdkConfig(org);
  const result = await listOrganizationWorkflows({
    ...config,
    path: { organization_id_or_slug: org },
    query: {
      sortBy: "-id",
      per_page: options.perPage,
      cursor: options.cursor,
      query: options.query,
      // Explicit all-projects scope avoids the backend's default "My Projects".
      project: options.project ?? ["-1"],
      detector: options.monitor?.map(Number),
    },
  });
  return unwrapPaginatedResult<Alert[]>(result, "Failed to list alerts");
}

export async function getAlert(org: string, id: string): Promise<Alert> {
  const config = await getOrgSdkConfig(org);
  const result = await getOrganizationWorkflow({
    ...config,
    path: { organization_id_or_slug: org, workflow_id: Number(id) },
  });
  return unwrapResult<Alert>(result, "Failed to fetch alert");
}

export async function createAlert(
  org: string,
  body: AlertCreateBody,
): Promise<Alert> {
  const config = await getOrgSdkConfig(org);
  const result = await createOrganizationWorkflow({
    ...config,
    path: { organization_id_or_slug: org },
    body,
  });
  return unwrapResult<Alert>(result, "Failed to create alert");
}

/**
 * PUT requires name and defaults enabled to true. Other omitted fields are
 * preserved by WorkflowValidator.update; included groups replace their members.
 */
export async function updateAlert(
  org: string,
  id: string,
  body: AlertUpdateBody,
): Promise<Alert> {
  const config = await getOrgSdkConfig(org);
  const result = await updateOrganizationWorkflow({
    ...config,
    path: { organization_id_or_slug: org, workflow_id: Number(id) },
    body,
  });
  return unwrapResult<Alert>(result, "Failed to update alert");
}

export async function deleteAlert(org: string, id: string): Promise<void> {
  const config = await getOrgSdkConfig(org);
  const result = await deleteOrganizationWorkflow({
    ...config,
    path: { organization_id_or_slug: org, workflow_id: Number(id) },
  });
  unwrapResult(result, "Failed to delete alert");
}
