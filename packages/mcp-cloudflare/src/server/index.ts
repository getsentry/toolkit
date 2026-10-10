import OAuthProvider from "@cloudflare/workers-oauth-provider";
import * as Sentry from "@sentry/cloudflare";
import { logWarn } from "@sentry/mcp-core/telem/logging";
import { SCOPES } from "../constants";
import app from "./app";
import {
  UTM_SOURCE_ATTRIBUTE,
  resolveUtmSourceFromRequest,
} from "./lib/attribution";
import { resolveClientFamily } from "./lib/client-family";
import { redirectUriHasUserInfo } from "./lib/html-utils";
import sentryMcpHandler, {
  handleSentryBearerMcpRequest,
} from "./lib/mcp-handler";
import {
  type RateLimitScope,
  annotateTrackedRequestSpan,
  extractResponseMetricOptions,
  recordResponseMetric,
  stripResponseMetricHeaders,
} from "./metrics";
import { tokenExchangeCallback } from "./oauth";
import { CLIENT_ID_METADATA_DOCUMENTS } from "./oauth/client-metadata";
import {
  ACCESS_METHOD_ATTRIBUTE,
  CLIENT_REGISTRATION_METHOD_ATTRIBUTE,
  bucketOAuthErrorCode,
  bucketOAuthErrorDescription,
  getOAuthErrorTelemetry,
  OAUTH_ERROR_ATTRIBUTE,
  OAUTH_ERROR_REASON_ATTRIBUTE,
} from "./oauth/telemetry";
import { patchRootAuthorizationServerMetadata } from "./authorization-server-metadata";
import { createProtectedResourceMetadataResponse } from "./protected-resource-metadata";
import getSentryConfig from "./sentry.config";
import type { Env } from "./types";
import { getClientIp } from "./utils/client-ip";
import {
  addCorsHeaders,
  addOAuthPublicClientCorsHeaders,
  isOAuthPublicClientEndpoint,
  isPublicMetadataEndpoint,
  stripCorsHeaders,
} from "./utils/cors";
import {
  MCP_RATE_LIMIT_EXCEEDED_MESSAGE,
  checkRateLimit,
} from "./utils/rate-limiter";
import { setSentryUserFromRequest } from "./utils/sentry-user";

const AUTH_PARAM_SEPARATOR = /,\s*(?=[A-Za-z_][A-Za-z0-9_-]*\s*=)/;
const AUTH_CHALLENGE = /^(\S+)(?:\s+(.+))?$/;
const RESOURCE_METADATA_PARAM = /^resource_metadata\s*=/i;
const SENTRY_BEARER_SCHEME = /^Sentry-Bearer\b/i;
const SENTRY_BEARER_AUTH = /^Sentry-Bearer\s+(\S+)$/i;

type SentryBearerAuth = { matched: false } | { matched: true; token?: string };

/**
 * Detects the direct-token Authorization scheme without consuming normal
 * OAuth `Bearer` tokens. Malformed Sentry-Bearer headers still return
 * `matched: true` without a token so callers can fail directly before OAuth.
 */
function parseSentryBearerAuthorization(
  header: string | null,
): SentryBearerAuth {
  if (!header) {
    return { matched: false };
  }

  const trimmedHeader = header.trim();
  if (!SENTRY_BEARER_SCHEME.test(trimmedHeader)) {
    return { matched: false };
  }

  const match = SENTRY_BEARER_AUTH.exec(trimmedHeader);
  if (!match) {
    return { matched: true };
  }

  return match[1] ? { matched: true, token: match[1] } : { matched: true };
}

function replaceResourceMetadataParam(
  headerValue: string,
  resourceMetadataUrl: string,
): string {
  const match = headerValue.match(AUTH_CHALLENGE);
  if (!match) {
    return headerValue;
  }

  const [, scheme, params = ""] = match;
  const filteredParams = params
    .split(AUTH_PARAM_SEPARATOR)
    .map((param) => param.trim())
    .filter((param) => param && !RESOURCE_METADATA_PARAM.test(param));

  filteredParams.push(`resource_metadata="${resourceMetadataUrl}"`);
  return `${scheme} ${filteredParams.join(", ")}`;
}

/**
 * RFC 9728 §3.1: Patch 401 responses on MCP routes to include a
 * `resource_metadata` parameter in the WWW-Authenticate header so
 * clients can discover the protected-resource metadata endpoint.
 *
 * The underlying OAuth library may already set its own `resource_metadata`
 * pointing at the (path-less) origin metadata URL, which 404s on this
 * deployment. We strip any pre-existing `resource_metadata` parameter and
 * replace it with our path-specific one so the challenge contains exactly
 * one such param, as required by RFC 9110 §11.2.
 */
function patchWwwAuthenticate(response: Response, url: URL): Response {
  if (response.status !== 401 || !url.pathname.startsWith("/mcp")) {
    return response;
  }
  const existing = response.headers.get("WWW-Authenticate");
  if (!existing) {
    return response;
  }
  const prmUrl = `${url.protocol}//${url.host}/.well-known/oauth-protected-resource${url.pathname}${url.search}`;
  const newResponse = new Response(response.body, response);

  newResponse.headers.set(
    "WWW-Authenticate",
    replaceResourceMetadataParam(existing, prmUrl),
  );
  return newResponse;
}

async function finalizeResponse(
  request: Request,
  url: URL,
  response: Response,
  options?: {
    rateLimitScope?: RateLimitScope;
    responseReason?: "local_rate_limit";
  },
): Promise<Response> {
  const responseMetricOptions = extractResponseMetricOptions(response);
  const responseWithoutMetricHeaders = stripResponseMetricHeaders(response);
  const oauthErrorTelemetry =
    response.status >= 400 &&
    (url.pathname.startsWith("/mcp") || url.pathname.startsWith("/oauth"))
      ? await getOAuthErrorTelemetry(request, responseWithoutMetricHeaders)
      : {};
  const finalized = isPublicMetadataEndpoint(url.pathname)
    ? addCorsHeaders(responseWithoutMetricHeaders)
    : isOAuthPublicClientEndpoint(url.pathname)
      ? addOAuthPublicClientCorsHeaders(
          responseWithoutMetricHeaders,
          request.headers.get("Origin"),
        )
      : stripCorsHeaders(responseWithoutMetricHeaders);

  const metricOptions = {
    ...responseMetricOptions,
    ...oauthErrorTelemetry,
    ...options,
  };

  annotateTrackedRequestSpan(request, url, finalized, metricOptions);
  recordResponseMetric(request, finalized, {
    ...metricOptions,
  });
  return finalized;
}

// Wrap OAuth Provider to take control of CORS.
//
// The OAuth provider manages several routes directly and may attach its own
// CORS headers to the responses it handles. We wrap it to:
//   1. Intercept OPTIONS before the library — return our own preflight response.
//   2. Route explicit Sentry-Bearer `/mcp` requests before OAuth.
//   3. Let the library handle the remaining request normally.
//   4. On the way out, apply our CORS policy:
//      - Public metadata endpoints → restrictive read-only CORS (`*`, GET only)
//      - Everything else → strip all CORS headers the library added
const wrappedOAuthProvider = {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    setSentryUserFromRequest(request);

    // --- Phase 1: Intercept preflight before the library can respond ---
    // Public metadata gets restrictive CORS; everything else gets a bare 204
    // with no CORS headers so the browser blocks the cross-origin request.
    if (request.method === "OPTIONS") {
      if (
        isPublicMetadataEndpoint(url.pathname) ||
        isOAuthPublicClientEndpoint(url.pathname)
      ) {
        return finalizeResponse(
          request,
          url,
          new Response(null, { status: 204 }),
        );
      }
      return finalizeResponse(
        request,
        url,
        new Response(null, { status: 204 }),
      );
    }

    // RFC 9728 metadata must be derived from the exact protected resource
    // identifier. We expose only path-specific metadata for `/mcp...`.
    //
    // workers-oauth-provider >=0.4 intercepts all PRM well-known paths itself.
    // Its path-aware implementation does not preserve query strings on the
    // `resource` identifier, and it would also serve origin-level metadata at
    // `/.well-known/oauth-protected-resource`. Keep our handler in front so
    // `/mcp...` metadata (including query) stays exact and the origin endpoint
    // remains 404.
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return finalizeResponse(
        request,
        url,
        new Response("Not Found", { status: 404 }),
      );
    }

    if (
      url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
      url.pathname.startsWith("/.well-known/oauth-protected-resource/mcp/")
    ) {
      return finalizeResponse(
        request,
        url,
        createProtectedResourceMetadataResponse(url),
      );
    }

    // --- Rate limiting (before any OAuth/MCP processing) ---
    if (url.pathname.startsWith("/mcp") || url.pathname.startsWith("/oauth")) {
      const clientIP = getClientIp(request);

      if (clientIP) {
        const rateLimitResult = await checkRateLimit(
          clientIP,
          env.MCP_IP_RATE_LIMITER ?? env.MCP_RATE_LIMITER,
          {
            keyPrefix: "mcp:ip",
            errorMessage: MCP_RATE_LIMIT_EXCEEDED_MESSAGE,
          },
        );

        if (!rateLimitResult.allowed) {
          return finalizeResponse(
            request,
            url,
            new Response(rateLimitResult.errorMessage, { status: 429 }),
            {
              responseReason: "local_rate_limit",
              rateLimitScope: "ip",
            },
          );
        }
      }
    }

    const clientFamily = resolveClientFamily(request.headers.get("user-agent"));
    const activeSpan = Sentry.getActiveSpan();
    activeSpan?.setAttribute("app.client.family", clientFamily);
    // Set utm_source early on /mcp requests so the attribute is present even
    // if the request is rejected before reaching mcp-handler.ts. Prefer the
    // attribution header so clients can avoid folding tags into the OAuth
    // resource URL; fall back to ?utm_source= for existing configs.
    if (url.pathname.startsWith("/mcp")) {
      const utmSource = resolveUtmSourceFromRequest(request, url);
      if (utmSource) {
        activeSpan?.setAttribute(UTM_SOURCE_ATTRIBUTE, utmSource);
      }
    }

    if (url.pathname.startsWith("/mcp")) {
      const sentryBearerAuth = parseSentryBearerAuthorization(
        request.headers.get("Authorization"),
      );

      if (sentryBearerAuth.matched) {
        activeSpan?.setAttribute(ACCESS_METHOD_ATTRIBUTE, "sentry_access");

        if (!sentryBearerAuth.token) {
          return finalizeResponse(
            request,
            url,
            new Response("Missing or invalid Sentry-Bearer token", {
              status: 401,
              headers: {
                "WWW-Authenticate":
                  'Sentry-Bearer realm="Sentry MCP", error="invalid_token", error_description="Missing or invalid Sentry-Bearer token"',
              },
            }),
          );
        }

        const response = await handleSentryBearerMcpRequest(
          request,
          env,
          ctx,
          sentryBearerAuth.token,
        );
        return finalizeResponse(request, url, response);
      }
    }

    // Reject registrations with userinfo-spoofed redirect URIs before the
    // library stores the client (e.g. host@example.io).
    if (request.method === "POST" && url.pathname === "/oauth/register") {
      try {
        const body = (await request.clone().json()) as {
          redirect_uris?: unknown;
        };
        const redirectUris = Array.isArray(body.redirect_uris)
          ? body.redirect_uris
          : [];
        if (
          redirectUris.some(
            (uri) => typeof uri === "string" && redirectUriHasUserInfo(uri),
          )
        ) {
          return finalizeResponse(
            request,
            url,
            new Response(
              JSON.stringify({
                error: "invalid_redirect_uri",
                error_description:
                  "redirect_uris must not contain a userinfo component",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
      } catch {
        // Malformed body — let the library produce its own error.
      }
    }

    // --- Phase 2: Let the OAuth library handle the request ---
    // We normalize any CORS headers it returns in the response handling below.
    const oAuthProvider = new OAuthProvider({
      apiRoute: "/mcp",
      // @ts-expect-error - OAuthProvider types don't support specific Env types
      apiHandler: sentryMcpHandler,
      defaultHandler: app,
      // must match the routes registered in `app.ts`
      authorizeEndpoint: "/oauth/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      // Accept HTTPS URL client_ids via Client ID Metadata Documents (CIMD).
      // Requires wrangler `global_fetch_strictly_public` (already set) so the
      // provider can safely fetch metadata without zone-origin SSRF bypass.
      // Root AS metadata advertises support automatically; scoped metadata is
      // handled in authorization-server-metadata.ts.
      clientIdMetadataDocumentEnabled: true,
      clientIdMetadataDocuments: CLIENT_ID_METADATA_DOCUMENTS,
      tokenExchangeCallback: (options) =>
        tokenExchangeCallback(options, env, request, clientFamily),
      scopesSupported: Object.keys(SCOPES),
      // Expire grants after 30 days to prevent unbounded KV accumulation.
      // Sentry access tokens also have a 30-day lifetime, so re-auth is
      // required after this window regardless.
      refreshTokenTTL: 30 * 24 * 60 * 60,
      onError: ({ status, code, description }) => {
        logWarn(`OAuth error response: ${status} ${code} - ${description}`, {
          loggerScope: ["cloudflare", "oauth", "provider"],
          extra: {
            "http.response.status_code": status,
            [OAUTH_ERROR_ATTRIBUTE]: bucketOAuthErrorCode(code),
            [OAUTH_ERROR_REASON_ATTRIBUTE]:
              bucketOAuthErrorDescription(description),
            "app.client.family": clientFamily,
          },
        });
      },
    });

    const response = await oAuthProvider.fetch(request, env, ctx);

    if (
      request.method === "POST" &&
      url.pathname === "/oauth/register" &&
      response.ok
    ) {
      // /oauth/register is the DCR path; CIMD clients never hit this endpoint.
      const registrationMethodTelemetry = {
        [CLIENT_REGISTRATION_METHOD_ATTRIBUTE]: "dcr" as const,
      };
      activeSpan?.setAttribute(
        CLIENT_REGISTRATION_METHOD_ATTRIBUTE,
        registrationMethodTelemetry[CLIENT_REGISTRATION_METHOD_ATTRIBUTE],
      );
      Sentry.metrics.count("app.oauth.register", 1, {
        attributes: {
          "app.client.family": clientFamily,
          ...registrationMethodTelemetry,
        },
      });
    }

    // --- Phase 3: Patch headers/metadata, then apply our CORS policy ---
    const patchedAuth = patchWwwAuthenticate(response, url);
    const patched = await patchRootAuthorizationServerMetadata(
      patchedAuth,
      url,
    );
    return finalizeResponse(request, url, patched);
  },
};

export default Sentry.withSentry(
  getSentryConfig,
  wrappedOAuthProvider,
) satisfies ExportedHandler<Env>;
