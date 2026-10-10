/**
 * MCP Handler using createMcpHandler from Cloudflare agents library.
 *
 * Stateless request handling approach:
 * - Uses createMcpHandler to wrap the MCP server
 * - OAuth requests extract auth props from ExecutionContext (set by OAuth provider)
 * - Sentry-Bearer requests pass an explicit upstream token directly
 * - Context captured in tool handler closures during buildServer()
 * - No session state required - each request is independent
 *
 * Direct Sentry-Bearer mode intentionally does not validate, store, refresh,
 * or revoke the upstream token. It only supplies that token to ServerContext.
 */

import type { ExportedHandler } from "@cloudflare/workers-types";
import * as Sentry from "@sentry/cloudflare";
import { buildServer } from "@sentry/mcp-core/server";
import {
  ACTIVE_SKILLS,
  type Skill,
  parseSkills,
} from "@sentry/mcp-core/skills";
import { logWarn } from "@sentry/mcp-core/telem/logging";
import type { ServerContext } from "@sentry/mcp-core/types";
import { createMcpHandler } from "agents/mcp/server";
import { annotateResponseMetric } from "../metrics";
import {
  ACCESS_METHOD_ATTRIBUTE,
  getOAuthGrantLifecycleTelemetry,
  getOAuthGrantTelemetry,
  OAUTH_GRANT_REVOKED_REASON_ATTRIBUTE,
} from "../oauth/telemetry";
import type { WorkerProps } from "../types";
import type { Env } from "../types";
import {
  MCP_RATE_LIMIT_EXCEEDED_MESSAGE,
  checkRateLimit,
} from "../utils/rate-limiter";
import { setSentryUserFromRequest } from "../utils/sentry-user";
import {
  UTM_SOURCE_ATTRIBUTE,
  resolveUtmSourceFromRequest,
} from "./attribution";
import { resolveClientFamily } from "./client-family";
import { verifyConstraintsAccess } from "./constraint-utils";

/**
 * ExecutionContext with OAuth props injected by the OAuth provider.
 */
type OAuthExecutionContext = ExecutionContext & {
  props?: Record<string, unknown>;
};

type OAuthMcpContext = {
  kind: "oauth";
  accessToken: string;
  grantedSkills: Set<Skill>;
  userId: string;
  clientId: string;
  clientName?: string;
  tokenConstraintOrganizationSlug?: string | null;
  tokenConstraintProjectSlug?: string | null;
  onUpstreamUnauthorized: () => void | Promise<void>;
};

type SentryBearerMcpContext = {
  kind: "sentry-bearer";
  accessToken: string;
  grantedSkills: Set<Skill>;
};

type AuthenticatedMcpContext = OAuthMcpContext | SentryBearerMcpContext;

function getSkillGrantedAttributeName(skill: string): string {
  return `app.consent.skill.${skill.replaceAll("-", "_")}.granted`;
}

function escapeAuthenticateHeaderValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "")
    .replaceAll("\n", "");
}

/**
 * Extracts the grantId from the wrapper bearer token (format
 * `userId:grantId:secret`, validated by the library before our handler runs).
 * Concurrent grants per `(userId, clientId)` mean a clientId-based lookup
 * cannot safely identify the request's own grant.
 */
export function getRequestGrantId(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const parts = match[1].split(":");
  if (parts.length !== 3) return null;
  return parts[1] || null;
}

type GrantRevokedReason =
  | "stale_props_no_refresh"
  | "upstream_rejected"
  | "upstream_rejected_in_use";

function logGrantReauthorization(
  reason: GrantRevokedReason,
  userId: string,
  clientId: string,
  clientFamily: string,
  grantId: string | null,
  lifecycleTelemetry: Record<string, string>,
): void {
  logWarn("OAuth grant rejected for reauthorization", {
    loggerScope: ["cloudflare", "mcp-handler"],
    extra: {
      [OAUTH_GRANT_REVOKED_REASON_ATTRIBUTE]: reason,
      "app.client.family": clientFamily,
      userId,
      clientId,
      ...getOAuthGrantTelemetry(grantId),
      ...lifecycleTelemetry,
    },
  });
}

/**
 * Revokes the OAuth grant for the current request in the background, then
 * returns a 401 response prompting re-authorization.
 */
function revokeStaleGrant(
  ctx: ExecutionContext,
  env: Env,
  userId: string,
  clientId: string,
  grantId: string | null,
  logLabel: string,
  revokeReason: Exclude<GrantRevokedReason, "upstream_rejected_in_use">,
  clientFamily: string,
  lifecycleTelemetry: Record<string, string>,
  errorDescription = "Token requires re-authorization",
): Response {
  if (grantId) {
    Sentry.metrics.count("app.oauth.grant_revoked", 1, {
      attributes: {
        [OAUTH_GRANT_REVOKED_REASON_ATTRIBUTE]: revokeReason,
        "app.client.family": clientFamily,
        ...lifecycleTelemetry,
      },
    });
  }

  logGrantReauthorization(
    revokeReason,
    userId,
    clientId,
    clientFamily,
    grantId,
    lifecycleTelemetry,
  );

  ctx.waitUntil(
    (async () => {
      if (!grantId) {
        // Without a grantId, falling back to clientId-based lookup would
        // risk revoking another active session. Log and skip — the user
        // will still see the 401 and re-auth, just leaving the stale grant
        // behind to expire naturally (refreshTokenTTL = 30d).
        logWarn(`Cannot revoke ${logLabel} without grantId`, {
          loggerScope: ["cloudflare", "mcp-handler"],
          extra: { clientId, userId },
        });
        return;
      }
      try {
        await env.OAUTH_PROVIDER.revokeGrant(grantId, userId);
      } catch (err) {
        logWarn(`Failed to revoke ${logLabel}`, {
          loggerScope: ["cloudflare", "mcp-handler"],
          extra: {
            error: String(err),
            clientId,
            userId,
            ...getOAuthGrantTelemetry(grantId),
          },
        });
      }
    })(),
  );
  return new Response(
    "Your authorization has expired. Please re-authorize to continue using Sentry MCP.",
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="Sentry MCP", error="invalid_token", error_description="${escapeAuthenticateHeaderValue(errorDescription)}"`,
      },
    },
  );
}

function formatInvalidSkills(invalid: string[], source: string): string {
  return `${source} provided invalid skills: ${invalid.join(", ")}`;
}

/**
 * Resolves direct-mode skill exposure from URL query parameters.
 *
 * Direct requests default to all active skills. `skills` replaces that set,
 * while `disable-skills` removes entries from it. Empty or invalid inputs fail
 * before the MCP server is built so direct callers do not silently widen access.
 */
function resolveDirectGrantedSkills(
  url: URL,
): { ok: true; grantedSkills: Set<Skill> } | { ok: false; response: Response } {
  const skillsParam = url.searchParams.get("skills");
  const disableSkillsParam = url.searchParams.get("disable-skills");

  let grantedSkills: Set<Skill>;
  if (url.searchParams.has("skills")) {
    const { valid, invalid } = parseSkills(skillsParam);
    if (invalid.length > 0) {
      return {
        ok: false,
        response: new Response(formatInvalidSkills(invalid, "skills"), {
          status: 400,
        }),
      };
    }
    if (valid.size === 0) {
      return {
        ok: false,
        response: new Response("skills must include at least one valid skill", {
          status: 400,
        }),
      };
    }
    grantedSkills = valid;
  } else {
    grantedSkills = new Set(ACTIVE_SKILLS);
  }

  if (disableSkillsParam) {
    const { valid, invalid } = parseSkills(disableSkillsParam);
    if (invalid.length > 0) {
      return {
        ok: false,
        response: new Response(formatInvalidSkills(invalid, "disable-skills"), {
          status: 400,
        }),
      };
    }
    for (const skill of valid) {
      grantedSkills.delete(skill);
    }
    if (grantedSkills.size === 0) {
      return {
        ok: false,
        response: new Response(
          "disable-skills removed all available skills; at least one skill must remain enabled",
          { status: 400 },
        ),
      };
    }
  }

  return { ok: true, grantedSkills };
}

/**
 * Builds a direct MCP request context from an explicit upstream Sentry token.
 *
 * This bypasses OAuth entirely: no grant props, token validation, token
 * storage, upstream refresh, or grant revocation are used for direct mode.
 */
export async function handleSentryBearerMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  accessToken: string,
): Promise<Response> {
  const skills = resolveDirectGrantedSkills(new URL(request.url));
  if (!skills.ok) {
    return skills.response;
  }

  return handleAuthenticatedMcpRequest(request, env, ctx, {
    kind: "sentry-bearer",
    accessToken,
    grantedSkills: skills.grantedSkills,
  });
}

/**
 * Shared MCP server builder for OAuth-backed and direct-token requests.
 *
 * OAuth mode verifies URL constraints and owns upstream-401 grant revocation.
 * Direct mode only parses URL constraints into context and leaves upstream
 * token validity, refresh, and revocation to the caller/provider.
 */
async function handleAuthenticatedMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  auth: AuthenticatedMcpContext,
): Promise<Response> {
  const url = new URL(request.url);

  // Parse constraints from URL pattern /mcp/:org?/:project?
  const pattern = new URLPattern({ pathname: "/mcp/:org?/:project?" });
  const result = pattern.exec(url);

  if (!result) {
    return new Response("Not found", { status: 404 });
  }

  const { groups } = result.pathname;
  const organizationSlug = groups?.org || null;
  const projectSlug = groups?.project || null;

  // Check for experimental mode query parameter
  const isExperimentalMode = url.searchParams.get("experimental") === "1";

  // Read utm_source for attribution tracking (header preferred, query fallback)
  const utmSource = resolveUtmSourceFromRequest(request, url);

  const sentryHost = env.SENTRY_HOST || "sentry.io";
  const clientFamily = resolveClientFamily(request.headers.get("user-agent"));
  const { ip_address: userIpAddress } = setSentryUserFromRequest(
    request,
    auth.kind === "oauth" ? auth.userId : undefined,
  );

  // Discovery and unsupported-method spans bypass the tool handlers.
  Sentry.getIsolationScope().setAttributes({
    "app.client.family": clientFamily,
    "app.transport": "http",
    ...(auth.kind === "oauth" && auth.clientName
      ? { "app.client.name": auth.clientName }
      : {}),
  });

  const activeSpan = Sentry.getActiveSpan();
  activeSpan?.setAttribute("app.transport", "http");
  activeSpan?.setAttribute(
    ACCESS_METHOD_ATTRIBUTE,
    auth.kind === "oauth" ? "mcp_grant" : "sentry_access",
  );
  activeSpan?.setAttribute("app.client.family", clientFamily);
  activeSpan?.setAttribute("app.server.mode.experimental", isExperimentalMode);
  if (utmSource) {
    activeSpan?.setAttribute(UTM_SOURCE_ATTRIBUTE, utmSource);
  }

  if (auth.kind === "oauth") {
    for (const skill of Array.from(auth.grantedSkills).sort()) {
      activeSpan?.setAttribute(getSkillGrantedAttributeName(skill), true);
    }
  }

  const rateLimitConfig =
    auth.kind === "oauth"
      ? {
          identifier: auth.userId,
          keyPrefix: "mcp:user" as const,
          scope: "user" as const,
        }
      : {
          identifier: auth.accessToken,
          keyPrefix: "mcp:sentry-token" as const,
          scope: "sentry_access" as const,
        };
  const rateLimitResult = await checkRateLimit(
    rateLimitConfig.identifier,
    env.MCP_USER_RATE_LIMITER ?? env.MCP_RATE_LIMITER,
    {
      keyPrefix: rateLimitConfig.keyPrefix,
      errorMessage: MCP_RATE_LIMIT_EXCEEDED_MESSAGE,
    },
  );

  if (!rateLimitResult.allowed) {
    return annotateResponseMetric(
      new Response(rateLimitResult.errorMessage, {
        status: 429,
      }),
      {
        responseReason: "local_rate_limit",
        rateLimitScope: rateLimitConfig.scope,
      },
    );
  }

  if (auth.kind === "oauth") {
    const tokenOrg = auth.tokenConstraintOrganizationSlug?.trim() || null;
    const tokenProject = auth.tokenConstraintProjectSlug?.trim() || null;
    if (tokenOrg && organizationSlug !== tokenOrg) {
      return new Response(
        "This token is scoped to an organization. Use the MCP URL for the organization you authorized.",
        { status: 403 },
      );
    }
    if (tokenProject) {
      if (!projectSlug || projectSlug !== tokenProject) {
        return new Response(
          "This token is scoped to a project. Use the MCP URL that includes that project (for example /mcp/<org>/<project>).",
          { status: 403 },
        );
      }
    }
  }

  const constraints =
    auth.kind === "oauth"
      ? await (async () => {
          const verification = await verifyConstraintsAccess(
            { organizationSlug, projectSlug },
            {
              accessToken: auth.accessToken,
              sentryHost,
              cache: {
                kv: env.MCP_CACHE,
                userId: auth.userId,
              },
            },
          );

          if (!verification.ok) {
            return new Response(verification.message, {
              status: verification.status ?? 500,
            });
          }

          return verification.constraints;
        })()
      : {
          organizationSlug,
          projectSlug,
          regionUrl: null,
          projectCapabilities: null,
        };

  if (constraints instanceof Response) {
    return constraints;
  }

  const serverContext: ServerContext = {
    userId: auth.kind === "oauth" ? auth.userId : undefined,
    userIpAddress,
    clientId: auth.kind === "oauth" ? auth.clientId : undefined,
    clientName: auth.kind === "oauth" ? auth.clientName : undefined,
    clientFamily,
    utmSource,
    accessToken: auth.accessToken,
    grantedSkills: auth.grantedSkills,
    constraints,
    sentryHost,
    mcpUrl: env.MCP_URL,
    experimentalMode: isExperimentalMode,
    transport: "http",
    onUpstreamUnauthorized:
      auth.kind === "oauth" ? auth.onUpstreamUnauthorized : undefined,
  };

  // The modern handler requires a factory and creates a fresh SDK v2 server
  // for every request. Context remains request-scoped through tool closures.
  return createMcpHandler(
    () =>
      buildServer({
        context: serverContext,
        experimentalMode: isExperimentalMode,
        sdkVersion: "v2",
      }),
    {
      route: url.pathname,
      // The Agents handler rejects browser Origins by default except localhost.
      // Permit only the hostname serving this authenticated endpoint.
      allowedOriginHostnames: [url.hostname],
    },
  )(request, env, ctx);
}

/**
 * Main request handler that:
 * 1. Extracts auth props from ExecutionContext
 * 2. Applies per-user rate limiting for authenticated traffic
 * 3. Parses org/project constraints from URL
 * 4. Verifies user has access to the constraints
 * 5. Builds complete ServerContext
 * 6. Creates and configures MCP server per-request (context captured in closures)
 * 7. Runs MCP handler
 */
const mcpHandler: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Extract OAuth props from ExecutionContext (set by OAuth provider)
    const oauthCtx = ctx as OAuthExecutionContext;

    if (!oauthCtx.props) {
      throw new Error("No authentication context available");
    }

    const rawProps = oauthCtx.props as Partial<WorkerProps>;

    const userId = rawProps.id as string;
    const accessToken = rawProps.accessToken as string;
    const clientId = rawProps.clientId as string;
    const clientName = rawProps.clientName;
    const clientFamily = resolveClientFamily(request.headers.get("user-agent"));
    const requestGrantId = getRequestGrantId(request);
    const lifecycleTelemetry = getOAuthGrantLifecycleTelemetry(rawProps);
    setSentryUserFromRequest(request, userId);

    // Parse and validate granted skills (primary authorization method)
    // Legacy tokens without grantedSkills are no longer supported
    if (!rawProps.grantedSkills) {
      logWarn("Legacy token without grantedSkills detected - revoking grant", {
        loggerScope: ["cloudflare", "mcp-handler"],
        extra: { clientId, userId },
      });
      return revokeStaleGrant(
        ctx,
        env,
        userId,
        clientId,
        requestGrantId,
        "legacy grant",
        "stale_props_no_refresh",
        clientFamily,
        lifecycleTelemetry,
      );
    }

    // Attribute values avoid sensitive substrings (token/bearer/auth/credentials)
    // so Sentry's default PII scrubber doesn't replace them with "[Filtered]".
    if (!rawProps.refreshToken) {
      return revokeStaleGrant(
        ctx,
        env,
        userId,
        clientId,
        requestGrantId,
        "stale grant (missing refresh token)",
        "stale_props_no_refresh",
        clientFamily,
        lifecycleTelemetry,
      );
    }

    if (rawProps.upstreamTokenInvalid) {
      return revokeStaleGrant(
        ctx,
        env,
        userId,
        clientId,
        requestGrantId,
        "stale grant (invalid upstream token)",
        "upstream_rejected",
        clientFamily,
        lifecycleTelemetry,
        "Upstream authorization is no longer valid",
      );
    }

    const grantedSkills = (rawProps.grantedSkills as string[]).map((skill) =>
      skill === "preprod" ? "inspect" : skill,
    );
    const { valid: validSkills, invalid: invalidSkills } =
      parseSkills(grantedSkills);

    if (invalidSkills.length > 0) {
      logWarn("Ignoring invalid skills from OAuth provider", {
        loggerScope: ["cloudflare", "mcp-handler"],
        extra: {
          invalidSkills,
        },
      });
    }

    // Validate that at least one valid skill was granted
    if (validSkills.size === 0) {
      logWarn("Authorization rejected: No valid skills in token", {
        loggerScope: ["cloudflare", "mcp-handler"],
        extra: {
          clientId,
          userId: rawProps.id,
          rawGrantedSkills: rawProps.grantedSkills,
          rawGrantedSkillsType: typeof rawProps.grantedSkills,
          rawGrantedSkillsIsArray: Array.isArray(rawProps.grantedSkills),
        },
      });
      return new Response(
        "Authorization failed: No valid skills were granted. Please re-authorize and select at least one permission.",
        { status: 400 },
      );
    }

    let upstreamUnauthorizedHandled = false;

    return handleAuthenticatedMcpRequest(request, env, ctx, {
      kind: "oauth",
      userId,
      clientId,
      clientName,
      accessToken,
      grantedSkills: validSkills,
      tokenConstraintOrganizationSlug: rawProps.constraintOrganizationSlug,
      tokenConstraintProjectSlug: rawProps.constraintProjectSlug,
      onUpstreamUnauthorized: () => {
        if (upstreamUnauthorizedHandled) return;
        upstreamUnauthorizedHandled = true;
        if (!requestGrantId) {
          logWarn("Cannot revoke grant after upstream 401 without grantId", {
            loggerScope: ["cloudflare", "mcp-handler"],
            extra: { clientId, userId },
          });
          return;
        }
        Sentry.metrics.count("app.oauth.grant_revoked", 1, {
          attributes: {
            [OAUTH_GRANT_REVOKED_REASON_ATTRIBUTE]: "upstream_rejected_in_use",
            "app.client.family": clientFamily,
            ...lifecycleTelemetry,
          },
        });
        logGrantReauthorization(
          "upstream_rejected_in_use",
          userId,
          clientId,
          clientFamily,
          requestGrantId,
          lifecycleTelemetry,
        );
        ctx.waitUntil(
          (async () => {
            try {
              await env.OAUTH_PROVIDER.revokeGrant(requestGrantId, userId);
            } catch (err) {
              logWarn("Failed to revoke grant after upstream 401", {
                loggerScope: ["cloudflare", "mcp-handler"],
                extra: {
                  error: String(err),
                  clientId,
                  userId,
                  ...getOAuthGrantTelemetry(requestGrantId),
                },
              });
            }
          })(),
        );
      },
    });
  },
};

export default mcpHandler;
