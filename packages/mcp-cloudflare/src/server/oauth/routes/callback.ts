import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import * as Sentry from "@sentry/cloudflare";
import { getScopesForSkills, parseSkills } from "@sentry/mcp-core/skills";
import { logIssue, logWarn } from "@sentry/mcp-core/telem/logging";
import { Hono } from "hono";
import { clientIdAlreadyApproved } from "../../lib/approval-dialog";
import { resolveClientFamilyFromName } from "../../lib/client-family";
import {
  CLIENT_REGISTRATION_METHOD_ATTRIBUTE,
  getClientRegistrationMethodTelemetry,
} from "../telemetry";
import { isRegisteredRedirectUri } from "../../lib/redirect-uri";
import type { Env, WorkerProps } from "../../types";
import { setSentryUserFromRequest } from "../../utils/sentry-user";
import { SENTRY_TOKEN_URL } from "../constants";
import {
  appendAuthorizationResponseIss,
  createOAuthFailureResponse,
  exchangeCodeForAccessToken,
  getAuthorizationServerIssuer,
  getOAuthCallbackFailureDetails,
  validateResourceParameter,
} from "../helpers";
import { parseResourceMcpConstraints } from "../resource-scope";
import { type OAuthState, verifyAndParseState } from "../state";

/**
 * Extended AuthRequest that includes skills and resource parameter
 */
interface AuthRequestWithSkills extends AuthRequest {
  skills?: unknown; // Skill-based authorization system
  resource?: string;
}

function getUpstreamTokenExpiryTimestamp(payload: {
  expires_at: string;
  expires_in: number;
}): number {
  const parsed = new Date(payload.expires_at).getTime();
  return Number.isFinite(parsed)
    ? parsed
    : Date.now() + payload.expires_in * 1000;
}

/**
 * Parse the space-delimited `scope` from Sentry's token response (RFC 6749
 * §5.1) into a sorted list. Returns undefined when Sentry omitted it so we
 * don't record an empty list that looks like "no scopes granted".
 */
function parseUpstreamScopes(scope: string | undefined): string[] | undefined {
  if (typeof scope !== "string") {
    return undefined;
  }
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

function getUpstreamUserLabel(payload: {
  user: { name: string | null; email?: string | null; id: string };
}): string {
  return payload.user.name ?? payload.user.email ?? payload.user.id;
}

/**
 * OAuth Callback Endpoint (GET /oauth/callback)
 *
 * This route handles the callback from Sentry after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 */
// Export Hono app for /callback endpoint
export default new Hono<{ Bindings: Env }>().get("/", async (c) => {
  // Verify and parse the signed state
  let parsedState: OAuthState;
  try {
    const rawState = c.req.query("state") ?? "";
    parsedState = await verifyAndParseState(rawState, c.env.COOKIE_SECRET);
  } catch (err) {
    logWarn("Invalid state received on OAuth callback", {
      loggerScope: ["cloudflare", "oauth", "callback"],
      extra: { error: String(err) },
    });
    return c.text("Invalid state", 400);
  }

  // Reconstruct oauth request info exactly as provided by downstream client
  const oauthReqInfo = parsedState.req as unknown as AuthRequestWithSkills;

  if (!oauthReqInfo.clientId) {
    logWarn("Missing clientId in OAuth state", {
      loggerScope: ["cloudflare", "oauth", "callback"],
    });
    return c.text("Invalid state", 400);
  }

  // Validate redirectUri is a valid URL
  if (!oauthReqInfo.redirectUri) {
    logWarn("Missing redirectUri in OAuth state", {
      loggerScope: ["cloudflare", "oauth", "callback"],
    });
    return c.text("Authorization failed: No redirect URL provided", 400);
  }

  try {
    new URL(oauthReqInfo.redirectUri);
  } catch (err) {
    logWarn(`Invalid redirectUri in OAuth state: ${oauthReqInfo.redirectUri}`, {
      loggerScope: ["cloudflare", "oauth", "callback"],
      extra: { error: String(err) },
    });
    return c.text("Authorization failed: Invalid redirect URL", 400);
  }

  // Validate resource parameter per RFC 8707
  const resourceFromState = oauthReqInfo.resource;
  if (
    resourceFromState !== undefined &&
    !validateResourceParameter(resourceFromState, c.req.url)
  ) {
    logWarn("Invalid resource parameter in callback", {
      loggerScope: ["cloudflare", "oauth", "callback"],
      extra: {
        resource: resourceFromState,
        clientId: oauthReqInfo.clientId,
      },
    });

    return c.text("Authorization failed: Invalid resource parameter", 400);
  }

  const oauthError = c.req.query("error") ?? undefined;
  if (oauthError) {
    const failure = getOAuthCallbackFailureDetails({ oauthError });
    const logMessage = "[oauth] Upstream authorization callback error";
    const logOptions = {
      contexts: {
        oauth: {
          clientId: oauthReqInfo.clientId,
          oauthError,
          errorDescription: c.req.query("error_description"),
        },
      },
      extra: {
        queryKeys: [...new URL(c.req.url).searchParams.keys()],
      },
      loggerScope: ["cloudflare", "oauth", "callback"],
    } as const;
    let eventId: string | undefined;
    if (failure.shouldLogIssue) {
      eventId = logIssue(logMessage, logOptions);
    } else {
      logWarn(logMessage, logOptions);
    }

    return createOAuthFailureResponse({
      message: failure.message,
      status: failure.status,
      oauthError,
      eventId,
    });
  }

  if (!c.req.query("code")) {
    logWarn("[oauth] Callback reached without code or upstream error", {
      contexts: {
        oauth: {
          clientId: oauthReqInfo.clientId,
        },
      },
      extra: {
        queryKeys: [...new URL(c.req.url).searchParams.keys()],
      },
      loggerScope: ["cloudflare", "oauth", "callback"],
    });

    return createOAuthFailureResponse({
      message:
        "The authorization callback did not include an authorization code.",
      status: 400,
    });
  }

  // because we share a clientId with the upstream provider, we need to ensure that the
  // downstream client has been approved by the end-user (e.g. for a new client)
  // https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/265
  const isApproved = await clientIdAlreadyApproved(
    c.req.raw,
    oauthReqInfo.clientId,
    c.env.COOKIE_SECRET,
  );
  if (!isApproved) {
    return c.text("Authorization failed: Client not approved", 403);
  }

  // Validate redirectUri is registered for this client
  let registeredClientName: string | undefined;
  try {
    const client = await c.env.OAUTH_PROVIDER.lookupClient(
      oauthReqInfo.clientId,
    );
    registeredClientName = client?.clientName;
    const uriIsAllowed = isRegisteredRedirectUri(
      oauthReqInfo.redirectUri,
      client?.redirectUris,
    );
    if (!uriIsAllowed) {
      logWarn("Redirect URI not registered for client on callback", {
        loggerScope: ["cloudflare", "oauth", "callback"],
        extra: {
          clientId: oauthReqInfo.clientId,
          redirectUri: oauthReqInfo.redirectUri,
          registeredUris: client?.redirectUris,
          clientName: registeredClientName,
        },
      });
      return c.text("Authorization failed: Invalid redirect URL", 400);
    }
  } catch (lookupErr) {
    const eventId = logIssue(
      "Failed to validate client redirect URI on callback",
      {
        contexts: {
          oauth: {
            clientId: oauthReqInfo.clientId,
            redirectUri: oauthReqInfo.redirectUri,
          },
        },
        extra: { error: String(lookupErr) },
        loggerScope: ["cloudflare", "oauth", "callback"],
      },
    );
    return createOAuthFailureResponse({
      message:
        "There was an internal error validating the callback redirect URL.",
      status: 500,
      eventId,
    });
  }

  // Exchange the code for an access token
  // Note: redirect_uri must match the one used in the authorization request
  // This is the Sentry callback URL, not the downstream MCP client's redirect URI
  const sentryCallbackUrl = new URL("/oauth/callback", c.req.url).href;
  const [payload, errResponse] = await exchangeCodeForAccessToken({
    upstream_url: new URL(
      SENTRY_TOKEN_URL,
      `https://${c.env.SENTRY_HOST || "sentry.io"}`,
    ).href,
    client_id: c.env.SENTRY_CLIENT_ID,
    client_secret: c.env.SENTRY_CLIENT_SECRET,
    code: c.req.query("code"),
    redirect_uri: sentryCallbackUrl,
  });
  if (errResponse) return errResponse;

  // Parse and validate granted skills first
  const { valid: validSkills, invalid: invalidSkills } = parseSkills(
    oauthReqInfo.skills,
  );

  // Log warning for any invalid skill names
  if (invalidSkills.length > 0) {
    logWarn("OAuth callback received invalid skill names", {
      loggerScope: ["cloudflare", "oauth", "callback"],
      extra: {
        clientId: oauthReqInfo.clientId,
        invalidSkills,
      },
    });
  }

  // Validate that at least one valid skill is granted
  if (validSkills.size === 0) {
    logWarn("OAuth authorization rejected: No valid skills selected", {
      loggerScope: ["cloudflare", "oauth", "callback"],
      extra: {
        clientId: oauthReqInfo.clientId,
        receivedSkills: oauthReqInfo.skills,
      },
    });
    return c.text(
      "Authorization failed: You must select at least one valid permission to continue.",
      400,
    );
  }

  // Calculate Sentry API scopes from validated skills
  const grantedScopes = await getScopesForSkills(validSkills);

  // Convert valid skills Set to array for OAuth props
  const grantedSkills = [...validSkills];

  const resource = (oauthReqInfo as AuthRequestWithSkills).resource;
  const resourceScope = parseResourceMcpConstraints(
    typeof resource === "string" ? resource : undefined,
  );
  const constraintOrganizationSlug = resourceScope?.organizationSlug ?? null;
  const constraintProjectSlug = resourceScope?.projectSlug ?? null;

  // Return back to the MCP client a new token
  const accessTokenExpiresAt = getUpstreamTokenExpiryTimestamp(payload);
  const sessionStartedAt = Date.now();
  const userLabel = getUpstreamUserLabel(payload);

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo as AuthRequest,
    userId: payload.user.id,
    metadata: {
      label: userLabel,
    },
    scope: oauthReqInfo.scope,
    // Default revokes every existing grant for (userId, clientId), which
    // cascades a sign-out to every other concurrent session of the same
    // user — common when Claude Code processes share DCR credentials
    // across project folders. Our props don't drift between re-auths in a
    // way that would require server-forced single-grant semantics, so
    // allow concurrent grants instead. See issue #924.
    revokeExistingGrants: false,
    // Props are available via ExecutionContext.props in the MCP handler
    props: {
      // OAuth standard fields
      id: payload.user.id,

      // Sentry-specific fields
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      // Cache upstream expiry so future refresh grants can avoid
      // unnecessary upstream refresh calls when still valid
      accessTokenExpiresAt,
      sessionStartedAt,
      upstreamExpiresAt: accessTokenExpiresAt,
      clientId: oauthReqInfo.clientId,
      clientName: registeredClientName,
      scope: oauthReqInfo.scope.join(" "),
      // Scopes derived from skills - for backward compatibility with old MCP clients
      // that don't support grantedSkills and only understand grantedScopes
      grantedScopes: [...grantedScopes],
      // Scopes Sentry actually granted on the upstream token (from the token
      // response), which can differ from the skill-derived grantedScopes
      upstreamScopes: parseUpstreamScopes(payload.scope),
      grantedSkills, // Primary authorization method

      constraintOrganizationSlug,
      constraintProjectSlug,

      // Note: sentryHost and mcpUrl come from env, not OAuth props
    } as WorkerProps,
  });

  setSentryUserFromRequest(c.req.raw, payload.user.id);
  // /oauth/callback is browser-navigated, so the User-Agent is the user's
  // browser, not the MCP client. Derive client family from the DCR-registered
  // client_name (resolved above).
  const clientFamily = resolveClientFamilyFromName(registeredClientName);
  const registrationMethodTelemetry = getClientRegistrationMethodTelemetry(
    oauthReqInfo.clientId,
  );
  Sentry.getActiveSpan()?.setAttribute(
    CLIENT_REGISTRATION_METHOD_ATTRIBUTE,
    registrationMethodTelemetry[CLIENT_REGISTRATION_METHOD_ATTRIBUTE],
  );
  Sentry.metrics.count("app.oauth.callback_completed", 1, {
    attributes: {
      "app.client.family": clientFamily,
      ...registrationMethodTelemetry,
    },
  });
  for (const skill of grantedSkills) {
    Sentry.metrics.count("app.consent.skill_granted", 1, {
      attributes: {
        "app.consent.skill": skill,
        "app.client.family": clientFamily,
      },
    });
  }

  // RFC 9207: workers-oauth-provider does not emit `iss` on authorization
  // responses. Append the canonical origin-level issuer so clients that
  // validate `iss` against PRM/root AS metadata can mix-up-protect the code.
  const issuer = getAuthorizationServerIssuer(c.req.url);
  // Use manual redirect instead of Response.redirect() to allow middleware to add headers
  return c.redirect(appendAuthorizationResponseIss(redirectTo, issuer));
});
