/**
 * Integration API functions
 *
 * List, fetch, and uninstall integrations installed on a Sentry organization
 * (GitHub, GitLab, Slack, Jira, ...). Installing new integrations is not
 * supported here: Sentry's install pipeline is browser-session bound.
 */

import {
  deleteOrganizationIntegration,
  getOrganizationIntegration,
  type ListOrganizationIntegrationsData,
  listOrganizationIntegrations,
} from "@sentry/api";

import type { SentryIntegration } from "../../types/index.js";
import { ApiError } from "../errors.js";
import {
  getOrgSdkConfig,
  type PaginatedResponse,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";

/**
 * Query shared by every integration list request.
 *
 * Sentry includes third-party configuration unless `includeConfig` is the
 * literal string `"0"` (any other value, including `false`, enables it),
 * and fetching that config can add several seconds per request. The
 * generated client types the param as boolean, hence the cast.
 */
const LIST_QUERY = {
  includeConfig: "0" as unknown as boolean,
} satisfies ListOrganizationIntegrationsData["query"];

/**
 * List one page of integrations installed on an organization.
 *
 * Includes integrations that are disabled or pending deletion.
 *
 * @param orgSlug - Organization slug
 * @param options - Pagination options
 * @returns Single page of integrations with cursor metadata
 * @throws {ApiError} When the response is not an array
 */
export async function listIntegrationsPaginated(
  orgSlug: string,
  options: { cursor?: string; perPage?: number } = {},
): Promise<PaginatedResponse<SentryIntegration[]>> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await listOrganizationIntegrations({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: {
      ...LIST_QUERY,
      cursor: options.cursor,
      per_page: options.perPage ?? 25,
    } as ListOrganizationIntegrationsData["query"],
  });

  const paginated = unwrapPaginatedResult<SentryIntegration[]>(
    result,
    "Failed to list integrations",
  );

  if (!Array.isArray(paginated.data)) {
    throw new ApiError(
      "Failed to list integrations: unexpected response format",
      result.response?.status ?? 0,
      "Expected the integrations endpoint to return an array. Check the configured Sentry URL and the endpoint response.",
    );
  }
  return paginated;
}

/**
 * List the first page of integrations installed on an organization.
 *
 * @param orgSlug - Organization slug
 * @returns Integrations on the first page
 */
export async function listIntegrations(
  orgSlug: string,
): Promise<SentryIntegration[]> {
  const { data } = await listIntegrationsPaginated(orgSlug);
  return data;
}

/**
 * Fetch one installed integration.
 *
 * @param orgSlug - Organization slug
 * @param integrationId - Numeric integration ID
 * @returns The integration
 * @throws {ApiError} 404 when the integration is not installed on the org
 */
export async function getIntegration(
  orgSlug: string,
  integrationId: string,
): Promise<SentryIntegration> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await getOrganizationIntegration({
    ...config,
    path: { organization_id_or_slug: orgSlug, integration_id: integrationId },
  });

  return unwrapResult<SentryIntegration>(
    result,
    `Failed to get integration '${integrationId}'`,
  );
}

/**
 * Uninstall an integration from an organization.
 *
 * Sentry marks the install as pending deletion and removes it, along with
 * its linked issues, asynchronously. Requires the `org:integrations` or
 * `org:admin` scope.
 *
 * @param orgSlug - Organization slug
 * @param integrationId - Numeric integration ID
 */
export async function deleteIntegration(
  orgSlug: string,
  integrationId: string,
): Promise<void> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await deleteOrganizationIntegration({
    ...config,
    path: { organization_id_or_slug: orgSlug, integration_id: integrationId },
  });

  unwrapResult(result, `Failed to delete integration '${integrationId}'`);
}
