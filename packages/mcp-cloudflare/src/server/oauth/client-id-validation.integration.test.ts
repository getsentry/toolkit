import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PKCE_CODE_CHALLENGE } from "../../test-utils/pkce";
import handler from "../index";
import type { Env } from "../types";

const ORIGIN = "https://mcp.sentry.dev";
const workerEnv = {
  ...(env as Record<string, unknown>),
  CF_VERSION_METADATA: { id: "test-version-id" },
} as Env;

function createAuthorizationRequest(clientId: string) {
  const url = new URL("/oauth/authorize", ORIGIN);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:43127/callback",
    scope: "org:read",
    state: "test-state",
    resource: `${ORIGIN}/mcp`,
    code_challenge: PKCE_CODE_CHALLENGE,
    code_challenge_method: "S256",
  }).toString();
  return new Request(url);
}

describe("authorization client ID validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["whitespace", "https://example.com/client meta.json"],
    ["invalid percent encoding", "https://example.com/client%2"],
    ["encoded dot segments", "https://example.com/a/%2e%2e/client.json"],
    ["userinfo", "https://user:password@example.com/client.json"],
    ["fragment", "https://example.com/client.json#fragment"],
  ])("rejects a CIMD client ID containing %s locally", async (_, clientId) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handler.fetch!(
      createAuthorizationRequest(clientId),
      workerEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe("Invalid client_id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves an upstream metadata failure for a valid client ID", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handler.fetch!(
      createAuthorizationRequest(
        "https://chatgpt.com/oauth/codex/client.json?other-client=1",
      ),
      workerEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe("Internal Server Error");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
