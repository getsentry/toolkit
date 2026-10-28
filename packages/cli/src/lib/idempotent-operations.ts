/**
 * Writes Sentry declares safe to replay.
 *
 * Read from the `@sentry/api` operation catalog, which marks an operation
 * `idempotent` when Sentry sets the `x-sentry-idempotent` OpenAPI extension.
 * Endpoints opt in on the server, so the CLI does not hard-code which
 * assemble calls may retry.
 */

import { isRetryableMethod } from "./retry-policy.js";

type Matcher = { method: string; pattern: RegExp };

const TEMPLATE_SEGMENT = /^\{[^/]+\}$/;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function toMatcher(method: string, path: string): Matcher {
  const source = path
    .split("/")
    .map((segment) =>
      TEMPLATE_SEGMENT.test(segment)
        ? "[^/]+"
        : segment.replace(REGEXP_SPECIAL, "\\$&"),
    )
    .join("/");
  return { method, pattern: new RegExp(`^${source}$`) };
}

/** Loaded on the first write so read-only commands never parse the catalog. */
let matchers: Promise<Matcher[]> | undefined;

async function loadMatchers(): Promise<Matcher[]> {
  const { operations } = await import("@sentry/api/operations");
  return operations
    .filter((op) => op.idempotent && !isRetryableMethod(op.method))
    .map((op) => toMatcher(op.method, op.path));
}

/**
 * Whether Sentry marks this write's operation idempotent.
 *
 * Matches from the `/api/` segment on, so a self-hosted install served under
 * a path prefix still matches. Safe methods return false without loading the
 * catalog; they retry regardless.
 *
 * @param method - HTTP method (any case)
 * @param url - Absolute request URL
 */
export async function isIdempotentOperation(
  method: string,
  url: string,
): Promise<boolean> {
  if (isRetryableMethod(method) || !URL.canParse(url)) {
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

  matchers ??= loadMatchers();
  return (await matchers).some(
    (matcher) => matcher.method === upper && matcher.pattern.test(normalized),
  );
}
