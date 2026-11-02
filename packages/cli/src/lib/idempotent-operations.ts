/**
 * Writes Sentry declares safe to replay.
 *
 * `script/generate-api-schema.ts` copies the non-safe operations that the
 * `@sentry/api` catalog marks `idempotent` (from Sentry's
 * `x-sentry-idempotent` OpenAPI extension). Endpoints opt in on the server,
 * so the CLI does not hard-code which assemble calls may retry.
 */

import { matchApiPathTemplate } from "@sentry/toolkit-core/api-path-template";
import generated from "../generated/idempotent-operations.json";

/** A non-safe operation Sentry marks idempotent. */
export type IdempotentOperation = {
  /** Uppercase HTTP method */
  method: string;
  /** OpenAPI path template, such as `/api/0/organizations/{org}/chunk-upload/` */
  path: string;
};

const operations = generated as IdempotentOperation[];

/**
 * Whether Sentry marks this request's operation idempotent.
 *
 * Matches from the `/api/` segment on, so a self-hosted install served under
 * a path prefix still matches.
 *
 * @param method - HTTP method (any case)
 * @param url - Absolute request URL
 */
export function isIdempotentOperation(method: string, url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const pathname = new URL(url).pathname;
  const apiIndex = pathname.indexOf("/api/");
  if (apiIndex === -1) {
    return false;
  }
  const apiPath = pathname.slice(apiIndex);
  const normalized = apiPath.endsWith("/") ? apiPath : `${apiPath}/`;
  const upper = method.toUpperCase();
  return operations.some(
    (operation) =>
      operation.method === upper &&
      matchApiPathTemplate(operation.path, normalized) !== undefined,
  );
}
