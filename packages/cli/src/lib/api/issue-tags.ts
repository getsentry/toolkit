/**
 * Issue tag distributions across retained events.
 */

import {
  type GetOrganizationIssueTagResponse,
  getOrganizationIssueTag,
} from "@sentry/api";
import { getOrgSdkConfig, unwrapResult } from "./infrastructure.js";

/**
 * Retrieve a tag's aggregate counts and top values for one issue.
 *
 * The public endpoint returns up to nine values across retained events. It
 * supports one environment, but no time range, query, or pagination. Although
 * the SDK types environment as an array, the backend reads only one value.
 * Counts and timestamps are preserved as returned, including nulls.
 */
export async function getIssueTag(
  orgSlug: string,
  issueId: string,
  key: string,
  environment?: string,
): Promise<GetOrganizationIssueTagResponse> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await getOrganizationIssueTag({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      issue_id: issueId,
      key,
    },
    query: {
      environment: environment === undefined ? undefined : [environment],
    },
  });

  return unwrapResult<GetOrganizationIssueTagResponse>(
    result,
    "Failed to retrieve issue tag distribution",
  );
}
