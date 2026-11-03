import {
  AuthorizationError,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import * as Sentry from "@sentry/cloudflare";
import { logWarn } from "@sentry/mcp-core/telem/logging";
import { Hono } from "hono";
import { SCOPES } from "../../../constants";
import {
  getRememberedSkillsForClient,
  parseRedirectApproval,
  renderApprovalDialog,
} from "../../lib/approval-dialog";
import { resolveClientFamilyFromName } from "../../lib/client-family";
import { redirectUriHasUserInfo } from "../../lib/html-utils";
import { isRegisteredRedirectUri } from "../../lib/redirect-uri";
import type { Env } from "../../types";
import { SENTRY_AUTH_URL } from "../constants";
import {
  createAuthorizationErrorRedirect,
  createResourceValidationError,
  getAuthorizationServerIssuer,
  getUpstreamAuthorizeUrl,
  validateResourceParameter,
} from "../helpers";
import { parseResourceMcpConstraints } from "../resource-scope";
import { type OAuthState, signState } from "../state";
import {
  CLIENT_REGISTRATION_METHOD_ATTRIBUTE,
  getClientRegistrationMethodTelemetry,
} from "../telemetry";

/**
 * Extended AuthRequest that includes skills and resource parameter
 */
interface AuthRequestWithSkills extends AuthRequest {
  skills?: unknown;
  resource?: string;
}

async function redirectToUpstream(
  env: Env,
  request: Request,
  oauthReqInfo: AuthRequest | AuthRequestWithSkills,
  headers: HeadersInit = {},
  stateOverride?: string,
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set(
    "location",
    getUpstreamAuthorizeUrl({
      upstream_url: new URL(
        SENTRY_AUTH_URL,
        `https://${env.SENTRY_HOST || "sentry.io"}`,
      ).href,
      scope: Object.keys(SCOPES).join(" "),
      client_id: env.SENTRY_CLIENT_ID,
      redirect_uri: new URL("/oauth/callback", request.url).href,
      state: stateOverride ?? btoa(JSON.stringify(oauthReqInfo)),
    }),
  );

  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}

// Export Hono app for /authorize endpoints
export default new Hono<{ Bindings: Env }>()
  /**
   * OAuth Authorization Endpoint (GET /oauth/authorize)
   *
   * This route initiates the OAuth flow when a user wants to log in.
   */
  .get("/", async (c) => {
    let oauthReqInfo: AuthRequest;
    try {
      oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    } catch (err) {
      // workers-oauth-provider >= 0.10.0 throws AuthorizationError for
      // expected authorization-request validation failures (missing
      // client_id, invalid redirect URI, etc). These are user-correctable
      // and must be rendered locally when no redirectUri is attached, so
      // don't forward them to Sentry.
      if (err instanceof AuthorizationError) {
        const errorMessage = err.description;
        if (errorMessage.includes("Invalid redirect URI")) {
          // parseAuthRequest threw before producing a request, so read the
          // attempted values directly from the query string.
          const authUrl = new URL(c.req.url);
          const attemptedClientId = authUrl.searchParams.get("client_id");
          const attemptedRedirectUri = authUrl.searchParams.get("redirect_uri");
          let registeredUris: string[] | undefined;
          let clientName: string | undefined;
          if (attemptedClientId) {
            try {
              const client =
                await c.env.OAUTH_PROVIDER.lookupClient(attemptedClientId);
              registeredUris = client?.redirectUris;
              clientName = client?.clientName;
            } catch {}
          }
          logWarn(`OAuth authorization failed: ${errorMessage}`, {
            loggerScope: ["cloudflare", "oauth", "authorize"],
            extra: {
              error: errorMessage,
              clientId: attemptedClientId,
              redirectUri: attemptedRedirectUri,
              registeredUris,
              clientName,
            },
          });
          return c.text("Invalid redirect URI", 400);
        }

        logWarn(`OAuth authorization request rejected: ${errorMessage}`, {
          loggerScope: ["cloudflare", "oauth", "authorize"],
          extra: { code: err.code, error: errorMessage },
        });

        // Once redirect URI validation has succeeded, the provider attaches
        // the validated redirectUri so the error can be safely relayed to
        // the client instead of rendered locally.
        if (err.redirectUri) {
          return createAuthorizationErrorRedirect(
            err.redirectUri,
            err.code,
            errorMessage,
            err.state,
            err.issuer ?? getAuthorizationServerIssuer(c.req.url),
          );
        }

        return c.text(errorMessage, 400);
      }
      // Re-throw other errors to be captured by Sentry
      throw err;
    }

    const { clientId } = oauthReqInfo;
    if (!clientId) {
      return c.text("Invalid request", 400);
    }

    // Reject redirect URIs with userinfo components
    if (redirectUriHasUserInfo(oauthReqInfo.redirectUri)) {
      logWarn("Rejected redirect URI with userinfo component", {
        loggerScope: ["cloudflare", "oauth", "authorize"],
        extra: { clientId, redirectUri: oauthReqInfo.redirectUri },
      });
      return c.text("Invalid redirect URI", 400);
    }

    // Validate resource parameter per RFC 8707
    const requestUrl = new URL(c.req.url);
    const resourceParams = requestUrl.searchParams.getAll("resource");
    const resourceParam =
      resourceParams.length <= 1 ? (resourceParams[0] ?? null) : undefined;
    const hasInvalidResourceParam =
      resourceParams.length > 1 ||
      (resourceParam !== null &&
        !validateResourceParameter(resourceParam, c.req.url));

    if (hasInvalidResourceParam) {
      logWarn("Invalid resource parameter in authorization request", {
        loggerScope: ["cloudflare", "oauth", "authorize"],
        extra: {
          resource: resourceParams,
          requestUrl: c.req.url,
          clientId,
        },
      });

      // Use validated redirect_uri from oauthReqInfo (already validated by parseAuthRequest)
      // instead of raw query param to prevent open redirects
      if (oauthReqInfo.redirectUri) {
        return createResourceValidationError(
          oauthReqInfo.redirectUri,
          oauthReqInfo.state ?? undefined,
          c.req.url,
        );
      }

      return c.text("Invalid resource parameter", 400);
    }

    const { resource: _resource, ...oauthReqInfoWithoutResource } =
      oauthReqInfo as AuthRequestWithSkills;

    // Preserve resource in state (library's AuthRequest doesn't include it)
    const oauthReqInfoWithResource: AuthRequestWithSkills = {
      ...oauthReqInfoWithoutResource,
      ...(resourceParam ? { resource: resourceParam } : {}),
    };
    const approvalScope = parseResourceMcpConstraints(resourceParam);

    // XXX(dcramer): we want to confirm permissions on each time
    // so you can always choose new ones
    // This shouldn't be highly visible to users, as clients should use refresh tokens
    // behind the scenes.
    //
    // because we share a clientId with the upstream provider, we need to ensure that the
    // downstream client has been approved by the end-user (e.g. for a new client)
    // https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/265
    // const isApproved = await clientIdAlreadyApproved(
    //   c.req.raw,
    //   clientId,
    //   c.env.COOKIE_SECRET,
    // );
    // if (isApproved) {
    //   return redirectToUpstream(c.env, c.req.raw, oauthReqInfo);
    // }

    const client = await c.env.OAUTH_PROVIDER.lookupClient(clientId);
    const defaultSkills = await getRememberedSkillsForClient(
      c.req.raw.headers.get("Cookie"),
      clientId,
      c.env.COOKIE_SECRET,
    );
    const response = await renderApprovalDialog(c.req.raw, {
      client,
      server: {
        name: "Sentry MCP",
      },
      scope: approvalScope,
      redirectUri: oauthReqInfoWithResource.redirectUri,
      state: { oauthReqInfo: oauthReqInfoWithResource },
      cookieSecret: c.env.COOKIE_SECRET,
      defaultSkills,
    });

    const registrationMethodTelemetry =
      getClientRegistrationMethodTelemetry(clientId);
    Sentry.getActiveSpan()?.setAttribute(
      CLIENT_REGISTRATION_METHOD_ATTRIBUTE,
      registrationMethodTelemetry[CLIENT_REGISTRATION_METHOD_ATTRIBUTE],
    );
    Sentry.metrics.count("app.oauth.consent_prompted", 1, {
      attributes: {
        "app.client.family": resolveClientFamilyFromName(client?.clientName),
        ...registrationMethodTelemetry,
      },
    });

    return response;
  })

  /**
   * OAuth Authorization Endpoint (POST /oauth/authorize)
   *
   * Approve redirects to Sentry. Deny redirects the MCP client with
   * `error=access_denied`.
   */
  .post("/", async (c) => {
    // Validates form submission and extracts state. Approve also sets cookies
    // so the next consent prompt can remember this client and its skills.
    let result: Awaited<ReturnType<typeof parseRedirectApproval>>;
    try {
      result = await parseRedirectApproval(c.req.raw, c.env.COOKIE_SECRET);
    } catch (err) {
      logWarn("Failed to parse approval form", {
        loggerScope: ["cloudflare", "oauth", "authorize"],
        extra: { error: String(err) },
      });
      return c.text("Invalid request", 400);
    }

    const { state, headers, skills, decision } = result;

    if (!state.oauthReqInfo) {
      return c.text("Invalid request", 400);
    }

    // Store the selected skills in the OAuth request info
    // This will be passed through to the callback via the state parameter
    const oauthReqWithSkills = {
      ...state.oauthReqInfo,
      skills,
    };

    // Reject redirect URIs with userinfo components
    if (redirectUriHasUserInfo(oauthReqWithSkills.redirectUri)) {
      logWarn("Rejected redirect URI with userinfo component", {
        loggerScope: ["cloudflare", "oauth", "authorize"],
        extra: {
          clientId: oauthReqWithSkills.clientId,
          redirectUri: oauthReqWithSkills.redirectUri,
        },
      });
      return c.text("Invalid redirect URI", 400);
    }

    // Validate redirectUri first to prevent open redirects from error responses
    let client = null;
    try {
      client = await c.env.OAUTH_PROVIDER.lookupClient(
        oauthReqWithSkills.clientId,
      );
      const uriIsAllowed = isRegisteredRedirectUri(
        oauthReqWithSkills.redirectUri,
        client?.redirectUris,
      );
      if (!uriIsAllowed) {
        logWarn("Redirect URI not registered for client", {
          loggerScope: ["cloudflare", "oauth", "authorize"],
          extra: {
            clientId: oauthReqWithSkills.clientId,
            redirectUri: oauthReqWithSkills.redirectUri,
            registeredUris: client?.redirectUris,
            clientName: client?.clientName,
          },
        });
        return c.text("Invalid redirect URI", 400);
      }
    } catch (lookupErr) {
      logWarn("Failed to validate client redirect URI", {
        loggerScope: ["cloudflare", "oauth", "authorize"],
        extra: { error: String(lookupErr) },
      });
      return c.text("Invalid request", 400);
    }

    if (decision === "deny") {
      return createAuthorizationErrorRedirect(
        oauthReqWithSkills.redirectUri,
        "access_denied",
        "The user denied the authorization request",
        oauthReqWithSkills.state ?? undefined,
        getAuthorizationServerIssuer(c.req.url),
      );
    }

    // Validate resource parameter (RFC 8707)
    const resourceFromState = oauthReqWithSkills.resource;
    if (
      resourceFromState !== undefined &&
      !validateResourceParameter(resourceFromState, c.req.url)
    ) {
      logWarn("Invalid resource parameter in authorization approval", {
        loggerScope: ["cloudflare", "oauth", "authorize"],
        extra: {
          resource: resourceFromState,
          clientId: oauthReqWithSkills.clientId,
        },
      });

      return createResourceValidationError(
        oauthReqWithSkills.redirectUri,
        oauthReqWithSkills.state,
        c.req.url,
      );
    }

    // Build signed state for redirect to Sentry (10 minute validity)
    const now = Date.now();
    const payload: OAuthState = {
      req: oauthReqWithSkills as unknown as Record<string, unknown>,
      iat: now,
      exp: now + 10 * 60 * 1000,
    };
    const signedState = await signState(payload, c.env.COOKIE_SECRET);

    const registrationMethodTelemetry = getClientRegistrationMethodTelemetry(
      oauthReqWithSkills.clientId,
    );
    Sentry.getActiveSpan()?.setAttribute(
      CLIENT_REGISTRATION_METHOD_ATTRIBUTE,
      registrationMethodTelemetry[CLIENT_REGISTRATION_METHOD_ATTRIBUTE],
    );
    Sentry.metrics.count("app.oauth.consent_granted", 1, {
      attributes: {
        "app.client.family": resolveClientFamilyFromName(client?.clientName),
        ...registrationMethodTelemetry,
      },
    });

    return await redirectToUpstream(
      c.env,
      c.req.raw,
      oauthReqWithSkills,
      headers,
      signedState,
    );
  });
