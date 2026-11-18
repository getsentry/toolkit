import { describe, expect, it } from "vitest";
import getSentryConfig from "./sentry.config";
import type { Env } from "./types";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "development",
    ASSETS: {} as Fetcher,
    OAUTH_KV: {} as KVNamespace,
    MCP_CACHE: {} as KVNamespace,
    COOKIE_SECRET: "test-secret",
    SENTRY_CLIENT_ID: "test-client-id",
    SENTRY_CLIENT_SECRET: "test-client-secret",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    SENTRY_HOST: "sentry.io",
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_MODEL: "openai/gpt-5.6-luna",
    EMBEDDED_AGENT_PROVIDER: "openrouter",
    OAUTH_PROVIDER: {} as Env["OAUTH_PROVIDER"],
    AI: {} as Ai,
    ...overrides,
  };
}

describe("getSentryConfig", () => {
  it("uses Cloudflare version metadata as the release when available", () => {
    const config = getSentryConfig(
      createEnv({
        CF_VERSION_METADATA: {
          id: "worker-version-123",
          tag: "current",
        } as WorkerVersionMetadata,
      }),
    );

    expect(config.release).toBe("worker-version-123");
  });

  it("omits the release when Cloudflare version metadata is missing", () => {
    const config = getSentryConfig(createEnv());

    expect(config.release).toBeUndefined();
  });
});
