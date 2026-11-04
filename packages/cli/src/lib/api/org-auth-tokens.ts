/**
 * Org auth token API functions
 *
 * List, create, and revoke organization auth tokens: the `org:ci` tokens used
 * for source map, debug file, and release uploads.
 *
 * The endpoints live on the control silo. They accept browser sessions and
 * OAuth application tokens that hold `org:tokens`, so they work with a CLI
 * login (`sentry auth login`) but reject personal and org auth tokens.
 */

import { array } from "valibot";

import { type OrgAuthToken, OrgAuthTokenSchema } from "../../types/index.js";
import { getControlSiloUrl } from "../sentry-client.js";
import {
  apiRequestToRegion,
  apiRequestToRegionNoContent,
} from "./infrastructure.js";

function tokensPath(orgSlug: string): string {
  return `/organizations/${encodeURIComponent(orgSlug)}/org-auth-tokens/`;
}

/**
 * List an organization's active org auth tokens.
 *
 * The endpoint isn't paginated. Sentry orders tokens by last use (unused
 * tokens last), then by name.
 *
 * @param orgSlug - Organization slug
 * @returns Active tokens, without their secret values
 */
export async function listOrgAuthTokens(
  orgSlug: string,
): Promise<OrgAuthToken[]> {
  const { data } = await apiRequestToRegion(
    getControlSiloUrl(),
    tokensPath(orgSlug),
    { schema: array(OrgAuthTokenSchema) },
  );
  return data;
}

/**
 * Create an org auth token with Sentry's default scope (`org:ci`).
 *
 * An OAuth caller can only mint scopes its own token holds, so the CLI's
 * grant needs `org:ci` too.
 *
 * @param orgSlug - Organization slug
 * @param name - Token name (max 255 characters)
 * @returns The new token, including its full `token` value
 */
export async function createOrgAuthToken(
  orgSlug: string,
  name: string,
): Promise<OrgAuthToken> {
  const { data } = await apiRequestToRegion(
    getControlSiloUrl(),
    tokensPath(orgSlug),
    { method: "POST", body: { name }, schema: OrgAuthTokenSchema },
  );
  return data;
}

/**
 * Revoke an org auth token. It stops working right away.
 *
 * @param orgSlug - Organization slug
 * @param tokenId - Numeric token ID
 */
export async function deleteOrgAuthToken(
  orgSlug: string,
  tokenId: string,
): Promise<void> {
  await apiRequestToRegionNoContent(
    getControlSiloUrl(),
    `${tokensPath(orgSlug)}${encodeURIComponent(tokenId)}/`,
    { method: "DELETE" },
  );
}
