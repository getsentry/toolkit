import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PKCE_CODE_CHALLENGE } from "../../test-utils/pkce";
import handler from "../index";
import type { Env } from "../types";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("@sentry/mcp-core/telem/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/mcp-core/telem/logging")>()),
  logWarn,
}));

const ORIGIN = "https://mcp.sentry.dev";
const CLIENT_ID = "https://client.example.com/oauth/client.json";
const workerEnv = {
  ...(env as Record<string, unknown>),
  CF_VERSION_METADATA: { id: "test-version-id" },
} as Env;

function authorize() {
  const url = new URL("/oauth/authorize", ORIGIN);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: "http://127.0.0.1:43127/callback",
    scope: "org:read",
    state: "test-state",
    resource: `${ORIGIN}/mcp`,
    code_challenge: PKCE_CODE_CHALLENGE,
    code_challenge_method: "S256",
  }).toString();
  return handler.fetch(new Request(url), workerEnv, createExecutionContext());
}

function expectMetadataFailureLogged(extra: Record<string, unknown>) {
  expect(logWarn).toHaveBeenCalledWith(
    "OAuth client metadata could not be resolved",
    expect.objectContaining({
      extra: expect.objectContaining({
        clientIdHost: "client.example.com",
        ...extra,
      }),
    }),
  );
}

describe("authorization with unresolvable client metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    logWarn.mockReset();
  });

  // MCP-SERVER-G9P: a metadata URL that returns 404 surfaced as a 500 and a
  // Sentry issue for every request.
  it("rejects a client whose metadata document is missing", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const response = await authorize();

    expect(fetchSpy).toHaveBeenCalledWith(CLIENT_ID, expect.anything());
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe(
      "Invalid client_id: client metadata could not be retrieved or is invalid",
    );
    expectMetadataFailureLogged({
      failureClass: "terminal",
      failureReason: "http_status",
      metadataStatus: 404,
    });
  });

  it("rejects a client whose metadata document is invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        client_id: "https://other.example.com/client.json",
        client_name: "Mismatched client",
        redirect_uris: ["http://127.0.0.1/callback"],
      }),
    );

    const response = await authorize();

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expectMetadataFailureLogged({
      failureClass: "terminal",
      failureReason: "invalid_metadata",
    });
  });

  it("returns 503 when the metadata host is temporarily unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );

    const response = await authorize();

    expect(response.status).toBe(503);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe(
      "Client metadata is temporarily unavailable. Try again later.",
    );
    expectMetadataFailureLogged({
      failureClass: "transient",
      failureReason: "http_status",
      metadataStatus: 429,
    });
  });

  it("keeps reporting unclassified metadata fetch failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Network connection lost."),
    );

    const response = await authorize();

    expect(response.status).toBe(500);
    expect(logWarn).not.toHaveBeenCalledWith(
      "OAuth client metadata could not be resolved",
      expect.anything(),
    );
  });
});
