import { logIssue } from "@sentry/mcp-core/telem/logging";
import { type Context, Hono } from "hono";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { generateHomepageMarkdown } from "../homepage-content";
import { createScopedAuthorizationServerMetadataResponse } from "./authorization-server-metadata";
import { createRequestLogger } from "./logging";
import sentryOauth from "./oauth";
import { createProtectedResourceMetadataResponse } from "./protected-resource-metadata";
import chat from "./routes/chat";
import chatOauth from "./routes/chat-oauth";
import mcpRoutes from "./routes/mcp";
import metadata from "./routes/metadata";
import search from "./routes/search";
import type { Env } from "./types";
import { setSentryUserFromRequest } from "./utils/sentry-user";

/** Derive the base URL (origin) from the current request. */
function getBaseUrl(c: Context): string {
  return new URL(c.req.url).origin;
}

// RFC 9728: OAuth 2.0 Protected Resource Metadata handler
function handleOAuthProtectedResourceMetadata(c: Context): Response {
  return createProtectedResourceMetadataResponse(new URL(c.req.url));
}

const app = new Hono<{
  Bindings: Env;
}>()
  .use("*", createRequestLogger())
  // Seed Sentry telemetry context with the request IP when available.
  .use("*", async (c, next) => {
    setSentryUserFromRequest(c.req.raw);
    await next();
  })
  // Apply security middleware globally
  .use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      strictTransportSecurity: "max-age=31536000; includeSubDomains",
    }),
  )
  .use(
    "*",
    csrf({
      origin: (origin, c) => {
        // In hono 4.11.x+, this handler is only called when origin is defined
        const requestUrl = new URL(c.req.url);
        return origin === requestUrl.origin;
      },
      secFetchSite: (secFetchSite) => {
        // Allow same-origin and same-site requests (handles requests without Origin header)
        return secFetchSite === "same-origin" || secFetchSite === "same-site";
      },
    }),
  )
  // Content-negotiated homepage: serve markdown to agents, SPA to browsers
  .get("/", async (c, next) => {
    const accept = c.req.header("Accept") ?? "";
    if (!accept.includes("text/markdown")) {
      return next();
    }
    return c.text(generateHomepageMarkdown(getBaseUrl(c)), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
    });
  })
  .get("/robots.txt", (c) => {
    return c.text(
      [
        "User-agent: *",
        "Disallow: /oauth/",
        "Disallow: /api/",
        "Allow: /mcp.json",
        "Disallow: /mcp",
        "Disallow: /sse",
      ].join("\n"),
    );
  })
  .get("/llms.txt", (c) => {
    return c.text(generateHomepageMarkdown(getBaseUrl(c)), 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  })
  .get("/_health/version", (c) => {
    return c.json({ id: c.env?.CF_VERSION_METADATA?.id ?? null });
  })
  .get("/mcp.json", (c) => {
    const baseUrl = getBaseUrl(c);
    return c.json({
      name: "Sentry",
      description:
        "Connect your Sentry account to search, analyze, and manage errors and performance issues across your applications.",
      icon: `${baseUrl}/favicon.ico`,
      endpoint: `${baseUrl}/mcp`,
    });
  })
  // RFC 9728: OAuth 2.0 Protected Resource Metadata for /mcp resources.
  .get(
    "/.well-known/oauth-protected-resource/mcp",
    handleOAuthProtectedResourceMetadata,
  )
  .get(
    "/.well-known/oauth-protected-resource/mcp/*",
    handleOAuthProtectedResourceMetadata,
  )
  // Compatibility shim for clients that probe path-scoped RFC 8414 discovery
  // endpoints instead of RFC 9728 protected resource metadata.
  .get("/.well-known/oauth-authorization-server/mcp", (c) =>
    createScopedAuthorizationServerMetadataResponse(new URL(c.req.url)),
  )
  .get("/.well-known/oauth-authorization-server/mcp/*", (c) =>
    createScopedAuthorizationServerMetadataResponse(new URL(c.req.url)),
  )
  .route("/oauth", sentryOauth)
  .route("/api/auth", chatOauth)
  .route("/api/chat", chat)
  .route("/api/search", search)
  .route("/api/metadata", metadata)
  .route("/.mcp", mcpRoutes)
  .get("/sse", (c) => {
    return c.json(
      {
        error: "SSE transport has been removed",
        message:
          "The SSE transport endpoint is no longer supported. Please use the HTTP transport at /mcp instead.",
        migrationGuide: "https://mcp.sentry.dev",
      },
      410,
    );
  });

// TODO: propagate the error as sentry isnt injecting into hono
app.onError((err, c) => {
  logIssue(err);
  return c.text("Internal Server Error", 500);
});

export default app;
