import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi } from "vitest";
import app from "../../app";

const { convertToModelMessages, logIssue } = vi.hoisted(() => ({
  convertToModelMessages: vi.fn(),
  logIssue: vi.fn(() => "test-event-id"),
}));

vi.mock("@sentry/mcp-core/telem/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/mcp-core/telem/logging")>()),
  logIssue,
}));

vi.mock("@ai-sdk/mcp", () => ({
  experimental_createMCPClient: vi.fn(async () => ({
    tools: async () => ({}),
    close: async () => {},
  })),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  convertToModelMessages,
}));

const authData = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  token_type: "bearer",
};

function postChat(cookie?: string) {
  return app.request(
    "/api/chat",
    {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "192.0.2.1",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ messages: [] }),
    },
    { ...env, OPENROUTER_API_KEY: "test-openrouter-key" },
  );
}

describe("/api/chat", () => {
  beforeEach(() => {
    convertToModelMessages.mockReset();
    logIssue.mockClear();
  });

  it("should return 401 without authorization", async () => {
    const res = await postChat();

    expect(res.status).toBe(401);
  });

  it("returns a 500 with an event ID when the handler throws a non-Error value", async () => {
    convertToModelMessages.mockImplementation(() => {
      // oxlint-disable-next-line typescript/only-throw-error -- Upstream code can throw non-Error values; this is the case under test.
      throw "upstream failure";
    });

    const res = await postChat(
      `sentry_auth_data=${encodeURIComponent(JSON.stringify(authData))}`,
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Internal server error",
      name: "INTERNAL_ERROR",
      eventId: "test-event-id",
    });
    expect(logIssue).toHaveBeenCalledWith("upstream failure");
  });
});
