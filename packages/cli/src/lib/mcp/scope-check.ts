/**
 * Startup check of the `sentry mcp` scope (`<org>/[<project>]`, `--org`,
 * `--project`).
 *
 * mcp-core adds the scope to every tool call, so a scope that names an
 * organization or project the credential cannot see makes every call fail
 * with a generic 404. One request at startup reports it once, naming the
 * scope, before the client connects.
 *
 * Only a 404 fails startup. Anything else (a 401 or 403, a token without
 * `org:read`, a 5xx, a network failure, or no answer within the time limit)
 * starts the server as before, so offline starts, transient outages, and
 * narrow tokens keep working.
 *
 * Loaded lazily with the rest of the server, as it pulls in mcp-core.
 */

import {
  ApiNotFoundError,
  SentryApiService,
} from "@sentry/mcp-core/api-client";
import { getInvocationCommand } from "../app-identity.js";
import { ResolutionError } from "../errors.js";
import { logger } from "../logger.js";
import type { McpServerConfig } from "./config.js";

const log = logger.withTag("mcp.scope");

/** How long startup waits for each request before serving without it. */
const SCOPE_CHECK_TIMEOUT_MS = 3000;

type ScopeCheckResult = "ok" | "not-found" | "unknown";

/**
 * Whether `request` finds the resource: "unknown" for any failure but a 404,
 * and when it takes longer than `timeoutMs`.
 */
async function probe(
  request: () => Promise<unknown>,
  timeoutMs: number,
): Promise<ScopeCheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ScopeCheckResult>((resolve) => {
    timer = setTimeout(() => {
      log.debug(`MCP server scope check timed out after ${timeoutMs}ms`);
      resolve("unknown");
    }, timeoutMs);
    timer.unref();
  });
  const outcome = request().then(
    (): ScopeCheckResult => "ok",
    (error: unknown): ScopeCheckResult => {
      if (error instanceof ApiNotFoundError) {
        return "not-found";
      }
      log.debug("Could not check the MCP server scope", error);
      return "unknown";
    },
  );
  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function organizationNotFound(org: string, scope: string): ResolutionError {
  return new ResolutionError(
    `Organization '${org}' (MCP server scope '${scope}')`,
    "not found",
    `Check the <org>/ argument or --org in the MCP client's server config`,
    [
      `The account the server uses may not be a member of '${org}': run '${getInvocationCommand()} auth status'`,
    ],
  );
}

function projectNotFound(org: string, project: string): ResolutionError {
  return new ResolutionError(
    `Project '${project}' (MCP server scope '${org}/${project}')`,
    "not found",
    `Check the <org>/<project> argument or --project in the MCP client's server config`,
    [
      `The account the server uses may not have access to '${org}/${project}': run '${getInvocationCommand()} auth status'`,
    ],
  );
}

/**
 * Fail when the configured scope names an organization or project that does
 * not exist for `accessToken`. Resolves when the scope exists, when there is
 * no scope, and when the check is inconclusive.
 *
 * @throws {ResolutionError} When Sentry answers 404 for the scope
 */
export async function assertMcpScopeExists(
  config: Pick<
    McpServerConfig,
    "organizationSlug" | "projectSlug" | "sentryHost" | "sentryProtocol"
  >,
  accessToken: string,
  timeoutMs = SCOPE_CHECK_TIMEOUT_MS,
): Promise<void> {
  const { organizationSlug, projectSlug } = config;
  if (!organizationSlug) {
    return;
  }
  const scope = `${organizationSlug}/${projectSlug ?? ""}`;
  const api = new SentryApiService({
    host: config.sentryHost,
    protocol: config.sentryProtocol,
    accessToken,
  });
  const checkOrg = () =>
    probe(
      () => api.getOrganization(organizationSlug, { detailed: false }),
      timeoutMs,
    );

  if (!projectSlug) {
    if ((await checkOrg()) === "not-found") {
      throw organizationNotFound(organizationSlug, scope);
    }
    return;
  }

  // One request for a valid scope; a second only to say which part is wrong.
  const project = await probe(
    () =>
      api.getProject({
        organizationSlug,
        projectSlugOrId: projectSlug,
        collapse: "organization",
      }),
    timeoutMs,
  );
  if (project !== "not-found") {
    return;
  }
  if ((await checkOrg()) === "not-found") {
    throw organizationNotFound(organizationSlug, scope);
  }
  throw projectNotFound(organizationSlug, projectSlug);
}
