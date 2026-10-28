/**
 * Writes Sentry declares safe to replay.
 *
 * `script/generate-api-schema.ts` copies the non-safe operations that the
 * `@sentry/api` catalog marks `idempotent` (from Sentry's
 * `x-sentry-idempotent` OpenAPI extension). Endpoints opt in on the server,
 * so the CLI no longer hard-codes which assemble and upload calls may retry.
 * The generated file is committed and refreshed by `generate:schema`; commit
 * it again after bumping `@sentry/api`.
 */

import generated from "../generated/idempotent-operations.json";

/** A non-safe operation Sentry marks idempotent. */
export type IdempotentOperation = {
  /** Uppercase HTTP method */
  method: string;
  /** OpenAPI path template, such as `/api/0/organizations/{org}/chunk-upload/` */
  path: string;
};

type Matcher = { method: string; pattern: RegExp };

const TEMPLATE_SEGMENT = /^\{[^/]+\}$/;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function toMatcher({ method, path }: IdempotentOperation): Matcher {
  const source = path
    .split("/")
    .map((segment) =>
      TEMPLATE_SEGMENT.test(segment)
        ? "[^/]+"
        : segment.replace(REGEXP_SPECIAL, "\\$&"),
    )
    .join("/");
  return { method: method.toUpperCase(), pattern: new RegExp(`^${source}$`) };
}

let matchers: Matcher[] | undefined;

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

  matchers ??= (generated satisfies IdempotentOperation[]).map(toMatcher);
  return matchers.some(
    (matcher) => matcher.method === upper && matcher.pattern.test(normalized),
  );
}
