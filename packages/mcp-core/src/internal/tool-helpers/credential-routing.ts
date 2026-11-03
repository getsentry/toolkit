/**
 * Per-call credential routing for hosts that set
 * `ServerContext.credentialRouter` (the CLI's stdio server with several
 * stored logins). Each tool call resolves one credential from the
 * organization it targets and runs every API request with it, so one call
 * never mixes identities. Without a router, calls run on the context as is.
 */
import { ApiError, isApiAuthenticationErrorDeep } from "../../api-client";
import type { RoutedCredential, ServerContext } from "../../types";
import { parseSentryUrl } from "../url-helpers";

/**
 * Tool parameters that hold a Sentry URL whose organization the call targets
 * when `organizationSlug` is not given.
 */
const ORGANIZATION_URL_PARAMS = [
  "issueUrl",
  "replayUrl",
  "profileUrl",
  "url",
] as const;

/**
 * The organization a tool call targets: its `organizationSlug` (after
 * constraint injection), else the organization of a Sentry URL parameter.
 * The tool handlers resolve the organization from the same values.
 */
export function getTargetOrganizationSlug(
  params: Record<string, unknown>,
): string | null {
  const slug = params.organizationSlug;
  if (typeof slug === "string" && slug.trim()) {
    return slug.trim();
  }
  for (const key of ORGANIZATION_URL_PARAMS) {
    const value = params[key];
    if (typeof value !== "string") {
      continue;
    }
    try {
      return parseSentryUrl(value.trim()).organizationSlug;
    } catch {
      // Not a Sentry URL with an organization; the handler reports it.
    }
  }
  return null;
}

/** Routed contexts per base context and credential id. */
const routedContexts = new WeakMap<ServerContext, Map<string, ServerContext>>();
/** The base context each routed context was derived from. */
const baseContexts = new WeakMap<ServerContext, ServerContext>();

/**
 * The context a credential's calls run with: the base context with the
 * credential's token. One object per credential, so the per-context region
 * cache is shared by that credential's calls and never by another's.
 */
function getRoutedContext(
  context: ServerContext,
  credential: RoutedCredential,
): ServerContext {
  // A nested call (execute_sentry_tool, get_sentry_resource) routes again
  // from the context it was given; derive from the same base.
  const base = baseContexts.get(context) ?? context;
  let byCredential = routedContexts.get(base);
  if (!byCredential) {
    byCredential = new Map();
    routedContexts.set(base, byCredential);
  }
  let routed = byCredential.get(credential.id);
  if (!routed) {
    routed = { ...base };
    byCredential.set(credential.id, routed);
    baseContexts.set(routed, base);
  }
  routed.accessToken = credential.accessToken;
  return routed;
}

/** 401s whose credential was already refreshed by an inner call. */
const handledUnauthorized = new WeakSet<object>();

/** Whether a routed call already refreshed the credential behind `error`. */
export function isUnauthorizedHandled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    handledUnauthorized.has(error)
  );
}

/**
 * After an upstream 401, refresh the credential that made the request, once
 * per error: an outer call (execute_sentry_tool) sees the same error but
 * must not refresh its own, possibly different, credential. Refresh errors
 * are swallowed; the 401 is still reported to the caller.
 */
async function refreshAfterUnauthorized(
  credential: RoutedCredential,
  context: ServerContext,
  error: unknown,
): Promise<void> {
  if (
    !isApiAuthenticationErrorDeep(error) ||
    typeof error !== "object" ||
    error === null ||
    handledUnauthorized.has(error)
  ) {
    return;
  }
  handledUnauthorized.add(error);
  if (!credential.refresh) {
    return;
  }
  try {
    const token = await credential.refresh();
    if (token) {
      getRoutedContext(context, { ...credential, accessToken: token });
    }
  } catch {
    // The formatted 401 still reaches the client.
  }
}

/**
 * Run a tool handler with the credential routed for its parameters. Without
 * a router, `run` gets `context` unchanged.
 */
export async function withRoutedCredential<T>(
  context: ServerContext,
  params: Record<string, unknown>,
  run: (context: ServerContext) => Promise<T>,
): Promise<T> {
  const router = context.credentialRouter;
  if (!router) {
    return await run(context);
  }
  const credential = await router.resolve({
    organizationSlug: getTargetOrganizationSlug(params),
  });
  try {
    return await run(getRoutedContext(context, credential));
  } catch (error) {
    await refreshAfterUnauthorized(credential, context, error);
    throw error;
  }
}

/** A credential and the context its calls run with. */
export type CredentialContext = {
  credential: RoutedCredential;
  context: ServerContext;
};

/**
 * One context per usable credential, the default first, for tools that span
 * organizations. `null` without a router: the tool uses `context` as is.
 */
export async function listCredentialContexts(
  context: ServerContext,
): Promise<CredentialContext[] | null> {
  const router = context.credentialRouter;
  if (!router) {
    return null;
  }
  const credentials = await router.list();
  return credentials.map((credential) => ({
    credential,
    context: getRoutedContext(context, credential),
  }));
}

/**
 * Run `fn` once per credential, concurrently, for tools that span
 * organizations. A credential whose request fails with an API error (an
 * expired login, a server error) is skipped so the others still answer;
 * when every credential fails, the first error is thrown.
 */
export async function mapCredentialContexts<T>(
  entries: CredentialContext[],
  fn: (entry: CredentialContext) => Promise<T>,
): Promise<Array<{ entry: CredentialContext; value: T }>> {
  const settled = await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        return await fn(entry);
      } catch (error) {
        await refreshAfterUnauthorized(entry.credential, entry.context, error);
        throw error;
      }
    }),
  );
  const results: Array<{ entry: CredentialContext; value: T }> = [];
  let firstError: unknown;
  for (const [index, result] of settled.entries()) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (result.status === "fulfilled") {
      results.push({ entry, value: result.value });
      continue;
    }
    if (!(result.reason instanceof ApiError)) {
      throw result.reason;
    }
    firstError ??= result.reason;
  }
  if (results.length === 0 && firstError !== undefined) {
    throw firstError;
  }
  return results;
}
