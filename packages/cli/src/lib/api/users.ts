/**
 * User API functions
 *
 * Functions for retrieving authenticated user information.
 */

import { retrieveUserDetails } from "@sentry/api";

import { type SentryUser, SentryUserSchema } from "../../types/index.js";

import { ApiError } from "../errors.js";
import { getControlSiloUrl } from "../sentry-client.js";
import { getSdkClientConfig } from "../sentry-sdk-client.js";

import { apiRequestToRegion, unwrapValidatedResult } from "./infrastructure.js";

/**
 * Get the currently authenticated user's information.
 *
 * Reads `GET /users/me/` on the control silo. Servers older than
 * getsentry/sentry#130368 return 403 there for every bearer token, so a 403
 * falls back to the private `/auth/` endpoint, which accepts them.
 */
export async function getCurrentUser(): Promise<SentryUser> {
  try {
    const result = await retrieveUserDetails({
      ...getSdkClientConfig(getControlSiloUrl()),
      path: { user_id: "me" },
    });
    return unwrapValidatedResult(
      result,
      "Failed to get current user",
      SentryUserSchema,
      "/users/me/",
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 403)) {
      throw error;
    }
    const { data } = await apiRequestToRegion<SentryUser>(
      getControlSiloUrl(),
      "/auth/",
      { schema: SentryUserSchema },
    );
    return data;
  }
}
