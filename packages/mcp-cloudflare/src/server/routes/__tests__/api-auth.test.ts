import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../../app";

describe("/api/auth", () => {
  describe("GET /api/auth/status", () => {
    it("should return 401 when not authenticated", async () => {
      const res = await app.request(
        "/api/auth/status",
        {
          headers: {
            "CF-Connecting-IP": "192.0.2.1",
          },
        },
        env,
      );

      expect(res.status).toBe(401);
      const json = await res.json<{ authenticated: boolean }>();
      expect(json.authenticated).toBe(false);
    });

    it("should return 401 with invalid auth cookie", async () => {
      const res = await app.request(
        "/api/auth/status",
        {
          headers: {
            "CF-Connecting-IP": "192.0.2.1",
            Cookie: "sentry_auth_data=invalid-json",
          },
        },
        env,
      );

      expect(res.status).toBe(401);
      const json = await res.json<{ authenticated: boolean }>();
      expect(json.authenticated).toBe(false);
    });

    it("should return 401 with expired token", async () => {
      const expiredAuthData = {
        access_token: "test-token",
        refresh_token: "test-refresh",
        expires_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        token_type: "Bearer",
      };

      const res = await app.request(
        "/api/auth/status",
        {
          headers: {
            "CF-Connecting-IP": "192.0.2.1",
            Cookie: `sentry_auth_data=${JSON.stringify(expiredAuthData)}`,
          },
        },
        env,
      );

      expect(res.status).toBe(401);
      const json = await res.json<{ authenticated: boolean }>();
      expect(json.authenticated).toBe(false);
    });

    it("should return 200 with valid auth cookie", async () => {
      const validAuthData = {
        access_token: "test-token",
        refresh_token: "test-refresh",
        expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        token_type: "Bearer",
      };

      const res = await app.request(
        "/api/auth/status",
        {
          headers: {
            "CF-Connecting-IP": "192.0.2.1",
            Cookie: `sentry_auth_data=${encodeURIComponent(JSON.stringify(validAuthData))}`,
          },
        },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json<{ authenticated: boolean }>();
      expect(json.authenticated).toBe(true);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("should return success", async () => {
      const res = await app.request(
        "/api/auth/logout",
        {
          method: "POST",
          headers: {
            "CF-Connecting-IP": "192.0.2.1",
            Origin: "http://localhost", // Required for CSRF check
          },
        },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json<{ success: boolean }>();
      expect(json.success).toBe(true);
    });

    it("should clear auth cookie", async () => {
      const res = await app.request(
        "/api/auth/logout",
        {
          method: "POST",
          headers: {
            "CF-Connecting-IP": "192.0.2.1",
            Origin: "http://localhost", // Required for CSRF check
            Cookie: "sentry_auth_data=some-token",
          },
        },
        env,
      );

      expect(res.status).toBe(200);
      // Check that Set-Cookie header is present to clear the cookie
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toContain("sentry_auth_data=");
    });
  });
});
