import { array, nullable, object, string } from "valibot";

import { getControlSiloUrl } from "../sentry-client.js";
import { apiRequestToRegion } from "./infrastructure.js";

const AuthStatusSchema = object({
  auth: nullable(
    object({
      scopes: array(string()),
    })
  ),
});

export async function getCurrentAuthScopes(): Promise<
  readonly string[] | null
> {
  const { data } = await apiRequestToRegion(getControlSiloUrl(), "", {
    schema: AuthStatusSchema,
  });
  return data.auth?.scopes ?? null;
}
