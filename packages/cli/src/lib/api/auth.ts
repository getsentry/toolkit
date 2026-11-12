import { retrieveApiIndex } from "@sentry/api";
import { array, nullable, object, string } from "valibot";

import { getControlSiloUrl } from "../sentry-client.js";
import { getSdkClientConfig } from "../sentry-sdk-client.js";
import { unwrapValidatedResult } from "./infrastructure.js";

const AuthStatusSchema = object({
  auth: nullable(
    object({
      scopes: array(string()),
    }),
  ),
});

export async function getCurrentAuthScopes(): Promise<
  readonly string[] | null
> {
  const result = await retrieveApiIndex({
    ...getSdkClientConfig(getControlSiloUrl()),
  });
  const data = unwrapValidatedResult(
    result,
    "Failed to read token scopes",
    AuthStatusSchema,
    "/",
  );
  return data.auth?.scopes ?? null;
}
