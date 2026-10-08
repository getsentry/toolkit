import { describe, it, expect } from "vitest";
import app from "./app";

// RFC 5737 TEST-NET-1 address; required by the IP-extraction middleware
const TEST_HEADERS = { "CF-Connecting-IP": "192.0.2.1" } as const;

describe("app", () => {
  describe("GET /", () => {
    it("should return markdown when Accept includes text/markdown", async () => {
      const res = await app.request("https://mcp.sentry.dev/", {
        headers: { ...TEST_HEADERS, Accept: "text/markdown" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/markdown");
      expect(res.headers.get("Vary")).toBe("Accept");

      const text = await res.text();
      expect(text).toContain("# Sentry MCP Server");
      expect(text).toContain("https://mcp.sentry.dev/mcp");
      expect(text).toContain("{organizationSlug}");
      expect(text).toContain("{projectSlug}");
    });

    it("should fall through when Accept is text/html", async () => {
      const res = await app.request("/", {
        headers: { ...TEST_HEADERS, Accept: "text/html" },
      });

      // Falls through to static assets / 404 since no SPA in test env
      expect(res.status).not.toBe(200);
    });

    it("should fall through when no Accept header", async () => {
      const res = await app.request("/", {
        headers: TEST_HEADERS,
      });

      expect(res.status).not.toBe(200);
    });
  });

  describe("GET /robots.txt", () => {
    it("should return correct robots.txt content", async () => {
      const res = await app.request("/robots.txt", {
        headers: TEST_HEADERS,
      });

      expect(res.status).toBe(200);

      const text = await res.text();
      expect(text).toBe(
        [
          "User-agent: *",
          "Disallow: /oauth/",
          "Disallow: /api/",
          "Allow: /mcp.json",
          "Disallow: /mcp",
          "Disallow: /sse",
        ].join("\n"),
      );
    });
  });

  describe("GET /_health/version", () => {
    it("exposes the version actually serving the request", async () => {
      const res = await app.request(
        "/_health/version",
        { headers: TEST_HEADERS },
        {
          CF_VERSION_METADATA: { id: "11111111-1111-4111-8111-111111111111" },
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "11111111-1111-4111-8111-111111111111",
      });
    });
  });

  describe("GET /llms.txt", () => {
    it("should return comprehensive llms.txt content", async () => {
      const res = await app.request("https://mcp.sentry.dev/llms.txt", {
        headers: TEST_HEADERS,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");

      const text = await res.text();
      expect(text).toContain("# Sentry MCP Server");
      expect(text).toContain("https://mcp.sentry.dev/mcp");
      expect(text).toContain("{organizationSlug}");
      expect(text).toContain("{projectSlug}");
      expect(text).toContain("claude mcp add");
      expect(text).toContain("?experimental=1");
    });
  });

  describe("GET /sse", () => {
    it("should return deprecation message with 410 status", async () => {
      const res = await app.request("/sse", {
        headers: TEST_HEADERS,
      });

      expect(res.status).toBe(410);

      const json = await res.json();
      expect(json).toEqual({
        error: "SSE transport has been removed",
        message:
          "The SSE transport endpoint is no longer supported. Please use the HTTP transport at /mcp instead.",
        migrationGuide: "https://mcp.sentry.dev",
      });
    });
  });

  describe("GET /.well-known/oauth-protected-resource", () => {
    it("should not expose origin-level protected resource metadata", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /.well-known/oauth-protected-resource/mcp", () => {
    it("should return RFC 9728 protected resource metadata", async () => {
      const res = await app.request(
        "/.well-known/oauth-protected-resource/mcp",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        resource: "http://localhost/mcp",
        authorization_servers: ["http://localhost"],
        scopes_supported: [
          "org:read",
          "project:write",
          "team:write",
          "event:write",
          "alerts:write",
        ],
        bearer_methods_supported: ["header"],
      });
    });

    it("should return correct URLs for custom host", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        resource: "https://mcp.sentry.dev/mcp",
        authorization_servers: ["https://mcp.sentry.dev"],
        scopes_supported: [
          "org:read",
          "project:write",
          "team:write",
          "event:write",
          "alerts:write",
        ],
        bearer_methods_supported: ["header"],
      });
    });

    it("should handle dynamic subpaths", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/sentry/mcp-server",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        resource: "https://mcp.sentry.dev/mcp/sentry/mcp-server",
        authorization_servers: ["https://mcp.sentry.dev"],
        scopes_supported: [
          "org:read",
          "project:write",
          "team:write",
          "event:write",
          "alerts:write",
        ],
        bearer_methods_supported: ["header"],
      });
    });

    it("should handle organization-scoped subpaths", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/sentry",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        resource: "https://mcp.sentry.dev/mcp/sentry",
        authorization_servers: ["https://mcp.sentry.dev"],
        scopes_supported: [
          "org:read",
          "project:write",
          "team:write",
          "event:write",
          "alerts:write",
        ],
        bearer_methods_supported: ["header"],
      });
    });

    it("should handle dynamic subpaths with query parameters", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/sentry/mcp-server?experimental=1",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        resource: "https://mcp.sentry.dev/mcp/sentry/mcp-server?experimental=1",
        authorization_servers: ["https://mcp.sentry.dev"],
        scopes_supported: [
          "org:read",
          "project:write",
          "team:write",
          "event:write",
          "alerts:write",
        ],
        bearer_methods_supported: ["header"],
      });
    });

    // Regression: Claude plugin ships ?utm_source=plugin on the MCP URL.
    // PRM must round-trip that exact resource so clients don't invent a bare
    // /mcp identifier that later disagrees with the authorize request.
    it("should preserve plugin utm_source on the base /mcp resource", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp?utm_source=plugin",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        resource: "https://mcp.sentry.dev/mcp?utm_source=plugin",
        authorization_servers: ["https://mcp.sentry.dev"],
        scopes_supported: [
          "org:read",
          "project:write",
          "team:write",
          "event:write",
          "alerts:write",
        ],
        bearer_methods_supported: ["header"],
      });
    });
  });

  describe("GET /.well-known/oauth-authorization-server/mcp", () => {
    it("should return scoped OAuth metadata with a resource-aware authorization endpoint", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-authorization-server/mcp/sentry/mcp-server",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toEqual({
        issuer: "https://mcp.sentry.dev/mcp/sentry/mcp-server",
        authorization_endpoint:
          "https://mcp.sentry.dev/oauth/authorize?resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp%2Fsentry%2Fmcp-server",
        token_endpoint: "https://mcp.sentry.dev/oauth/token",
        registration_endpoint: "https://mcp.sentry.dev/oauth/register",
        client_id_metadata_document_supported: true,
        scopes_supported: [
          "org:read",
          "project:write",
          "team:write",
          "event:write",
          "alerts:write",
        ],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        revocation_endpoint: "https://mcp.sentry.dev/oauth/token",
        code_challenge_methods_supported: ["plain", "S256"],
      });
    });

    it("should keep query flags in resource while emitting a query-free issuer", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-authorization-server/mcp/sentry/mcp-server?experimental=1",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.authorization_endpoint).toBe(
        "https://mcp.sentry.dev/oauth/authorize?resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp%2Fsentry%2Fmcp-server%3Fexperimental%3D1",
      );
      expect(json.issuer).toBe("https://mcp.sentry.dev/mcp/sentry/mcp-server");
      expect(
        json.authorization_response_iss_parameter_supported,
      ).toBeUndefined();
    });

    // Regression: path-scoped AS metadata is a Claude/compat discovery path.
    // RFC 8414 forbids query components on issuer, but the authorize endpoint
    // must still carry the full plugin resource (including utm_source).
    it("should advertise a query-free issuer while binding authorize to utm_source=plugin", async () => {
      const res = await app.request(
        "https://mcp.sentry.dev/.well-known/oauth-authorization-server/mcp?utm_source=plugin",
        { headers: TEST_HEADERS },
      );

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.issuer).toBe("https://mcp.sentry.dev/mcp");
      expect(json.authorization_endpoint).toBe(
        "https://mcp.sentry.dev/oauth/authorize?resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp%3Futm_source%3Dplugin",
      );
      expect(
        json.authorization_response_iss_parameter_supported,
      ).toBeUndefined();
    });
  });
});
