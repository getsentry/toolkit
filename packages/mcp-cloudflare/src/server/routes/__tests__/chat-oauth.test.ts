import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi } from "vitest";
import app from "../../app";

const { logIssue, logWarn } = vi.hoisted(() => ({
  logIssue: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@sentry/mcp-core/telem/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/mcp-core/telem/logging")>()),
  logIssue,
  logWarn,
}));

function requestCallback(query: string, cookie?: string) {
  return app.request(
    `/api/auth/callback?${query}`,
    {
      headers: {
        "CF-Connecting-IP": "192.0.2.1",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    },
    env,
  );
}

describe("/api/auth OAuth flow", () => {
  beforeEach(() => {
    logIssue.mockReset();
    logWarn.mockReset();
  });

  describe("GET /api/auth/callback", () => {
    it("should return 400 when state parameter is missing", async () => {
      const res = await requestCallback("code=test-code");

      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Authentication Failed");
      expect(html).toContain("Invalid state parameter");
      expect(logWarn).toHaveBeenCalledWith(
        "Invalid state parameter received",
        expect.objectContaining({
          extra: expect.objectContaining({
            stateFailure: "missing_state_param",
          }),
        }),
      );
      expect(logIssue).not.toHaveBeenCalled();
    });

    it("should return 400 when state does not match stored state", async () => {
      const res = await requestCallback(
        "code=test-code&state=wrong-state",
        "chat_oauth_state=different-state",
      );

      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Authentication Failed");
      expect(html).toContain("Invalid state parameter");
      expect(res.headers.get("Set-Cookie")).toContain("chat_oauth_state=;");
      expect(logWarn).toHaveBeenCalledWith(
        "Invalid state parameter received",
        expect.objectContaining({
          extra: expect.objectContaining({ stateFailure: "state_mismatch" }),
        }),
      );
      expect(logIssue).not.toHaveBeenCalled();
    });

    // MCP-SERVER-G94: stale or replayed callback URLs arrive with a state but
    // without the chat state cookie. That is user or bot noise, not a fault.
    it("should not create a Sentry issue when the state cookie is missing", async () => {
      const res = await requestCallback(
        "code=test-code&state=valid-state-12345&iss=https%3A%2F%2Fmcp.sentry.dev",
      );

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Invalid state parameter");
      expect(logWarn).toHaveBeenCalledWith("Invalid state parameter received", {
        loggerScope: ["cloudflare", "chat-oauth", "callback"],
        extra: {
          stateFailure: "missing_stored_state",
          hasCode: true,
          hasUpstreamError: false,
        },
      });
      expect(logIssue).not.toHaveBeenCalled();
    });

    // MCP-SERVER-GA3: clicking Deny on the approval page redirects back with
    // error=access_denied and a valid state.
    it("should show a denial message when the user denies authorization", async () => {
      const state = "valid-state-12345";
      const res = await requestCallback(
        `error=access_denied&error_description=User+denied&state=${state}`,
        `chat_oauth_state=${state}; chat_oauth_code_verifier=test-verifier`,
      );

      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Authorization was denied");
      expect(html).not.toContain("No authorization code received");
      expect(logWarn).toHaveBeenCalledWith(
        "Chat OAuth callback received an authorization error",
        expect.objectContaining({
          extra: { upstreamError: "access_denied" },
        }),
      );
      expect(logIssue).not.toHaveBeenCalled();
    });

    it("should return 400 when code is missing but state is valid", async () => {
      const state = "valid-state-12345";
      const res = await requestCallback(
        `state=${state}`,
        `chat_oauth_state=${state}`,
      );

      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Authentication Failed");
      expect(html).toContain("No authorization code received");
    });
  });
});
