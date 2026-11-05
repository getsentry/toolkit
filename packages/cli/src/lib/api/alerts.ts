/** Organization-scoped native alert (workflow) API. */
import {
  createOrganizationWorkflow,
  deleteOrganizationWorkflow,
  getOrganizationWorkflow,
  listOrganizationWorkflows,
  updateOrganizationWorkflow,
} from "@sentry/api";
import type {
  CreateOrganizationWorkflowData,
  GetOrganizationWorkflowResponse,
  UpdateOrganizationWorkflowData,
} from "@sentry/api";
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
