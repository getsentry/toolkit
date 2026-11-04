/**
 * Writes Sentry declares safe to replay.
 *
 * `script/generate-api-schema.ts` copies the non-safe operations that the
 * `@sentry/api` catalog marks `idempotent` (from Sentry's
 * `x-sentry-idempotent` OpenAPI extension). Endpoints opt in on the server,
 * so the CLI does not hard-code which assemble calls may retry. The list is
 * extracted at build time so the CLI doesn't load the full catalog on every
 * request.
 */

import {
  createIdempotentOperationMatcher,
  type IdempotentOperation,
} from "@sentry/api/client";
import generated from "../generated/idempotent-operations.json";

/**
 * Whether Sentry marks this request's operation idempotent.
 *
 * @param method - HTTP method (any case)
 * @param url - Absolute request URL
 */
export const isIdempotentOperation = createIdempotentOperationMatcher(
  () => generated as IdempotentOperation[],
);
