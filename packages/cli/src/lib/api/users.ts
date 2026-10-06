/**
 * User API functions
 *
 * Functions for retrieving authenticated user information.
 */

import { type SentryUser, SentryUserSchema } from "../../types/index.js";

import { getControlSiloUrl } from "../sentry-client.js";

import { apiRequestToRegion } from "./infrastructure.js";

/**
 * Get the currently authenticated user's information.
 *
 * Uses the `/auth/` endpoint on the control silo, which works with all token
 * types (OAuth, API tokens, OAuth App tokens). Unlike `/users/me/`, this
 * endpoint does not return 403 for OAuth tokens.
 */
export async function getCurrentUser(): Promise<SentryUser> {
  const { data } = await apiRequestToRegion<SentryUser>(
    getControlSiloUrl(),
    "/auth/",
    { schema: SentryUserSchema }
  );
  return data;
}
