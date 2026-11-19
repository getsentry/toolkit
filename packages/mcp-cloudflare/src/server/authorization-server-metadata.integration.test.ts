import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import handler from "./index";
import type { Env } from "./types";

const workerEnv = {
  ...(env as Record<string, unknown>),
  CF_VERSION_METADATA: { id: "test-version-id" },
} as Env;

async function fetchMetadata(path: string): Promise<Record<string, unknown>> {
  const response = await handler.fetch(
    new Request(`https://mcp.sentry.dev${path}`),
    workerEnv,
    createExecutionContext(),
  );
  expect(response.status).toBe(200);
  return await response.json();
}

describe("authorization server metadata", () => {
  // Regression: the scoped compatibility document advertised `plain` PKCE,
  // which the provider rejects, so clients that picked it failed to authorize.
  it("advertises the same PKCE methods at the root and scoped endpoints", async () => {
    const root = await fetchMetadata("/.well-known/oauth-authorization-server");
    const scoped = await fetchMetadata(
      "/.well-known/oauth-authorization-server/mcp/sentry/mcp-server",
    );

    expect(root.code_challenge_methods_supported).toEqual(["S256"]);
    expect(scoped.code_challenge_methods_supported).toEqual(
      root.code_challenge_methods_supported,
    );
  });
});
