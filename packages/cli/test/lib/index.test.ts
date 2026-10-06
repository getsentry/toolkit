import { afterEach, beforeEach, describe, expect, test } from "vitest";
import createSentrySDK, { SentryError } from "../../src/index.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("sdk-library-");

describe("createSentrySDK() library API", () => {
  // Silence unmocked fetch calls from resolution cascade.
  // SDK tests that call commands like "issue list" or "org list" trigger
  // the org/project resolution cascade which hits real API endpoints.
  // A silent 404 prevents preload warnings while preserving error behavior.
  let originalFetch: typeof globalThis.fetch;
  let authorizationHeaders: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    authorizationHeaders = [];
    // Return empty successes rather than 404s so the resolution cascade
    // terminates cleanly without triggering follow-up requests that could
    // outlive the test and spill into later test files.
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      authorizationHeaders.push(request.headers.get("Authorization") ?? "");
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = new Request(input).url;
      }
      if (url.includes("/regions/")) {
        return new Response(JSON.stringify({ regions: [] }), { status: 200 });
      }
      if (url.includes("/organizations")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      // Return empty 200 for all other endpoints (projects, issues, etc.)
      // to prevent follow-up requests from outliving the test.
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sdk.run returns version string for --version", async () => {
    const sdk = createSentrySDK();
    const result = await sdk.run("--version");
    expect(typeof result).toBe("string");
    // Version output is a semver string like "0.0.0-dev" or "0.21.0"
    expect(result as string).toMatch(/\d+\.\d+\.\d+/);
  });

  test("sdk.run returns parsed object for help command in JSON mode", async () => {
    const sdk = createSentrySDK();
    const result = await sdk.run("help");
    // help --json returns a parsed object with routes
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("routes");
  });

  test("sdk.run throws when auth is required but missing", async () => {
    // Clear the preload's test auth token so the auth guard fires.
    const savedToken = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
    try {
      // Use cwd:/tmp to prevent DSN scanning of the repo root which finds
      // real DSNs and triggers async project resolution that can outlive the test.
      const sdk = createSentrySDK({ cwd: "/tmp" });
      try {
        // issue list requires auth — with no token and isolated config, it should fail
        await sdk.run("issue", "list");
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        // The error should have an exitCode (either SentryError or CliError subclass)
        expect((err as { exitCode?: number }).exitCode).toBeGreaterThan(0);
      }
    } finally {
      // Restore the preload token for other tests
      if (savedToken !== undefined) {
        process.env.SENTRY_AUTH_TOKEN = savedToken;
      }
    }
  });

  test("process.env is unchanged after successful call", async () => {
    const sdk = createSentrySDK();
    const envBefore = { ...process.env };
    await sdk.run("--version");
    // Check that no new SENTRY_OUTPUT_FORMAT key leaked
    expect(process.env.SENTRY_OUTPUT_FORMAT).toBe(
      envBefore.SENTRY_OUTPUT_FORMAT
    );
    expect(process.env.SENTRY_AUTH_TOKEN).toBe(envBefore.SENTRY_AUTH_TOKEN);
  });

  test("process.env is unchanged after failed call", async () => {
    const sdk = createSentrySDK({ cwd: "/tmp" });
    const envBefore = { ...process.env };
    try {
      await sdk.run("issue", "list");
    } catch {
      // expected
    }
    expect(process.env.SENTRY_OUTPUT_FORMAT).toBe(
      envBefore.SENTRY_OUTPUT_FORMAT
    );
  });

  test("{ text: true } returns string for help command", async () => {
    const sdk = createSentrySDK({ text: true });
    const result = await sdk.run("help");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("sentry");
  });

  test("accepts cwd option without error", async () => {
    const sdk = createSentrySDK({ cwd: "/tmp" });
    const result = await sdk.run("--version");
    expect(typeof result).toBe("string");
  });

  test("nested namespaces (dashboard.widget)", () => {
    const sdk = createSentrySDK();
    expect(sdk.dashboard.widget).toBeDefined();
    expect(typeof sdk.dashboard.widget.add).toBe("function");
  });

  test("token option is plumbed through", { timeout: 15_000 }, async () => {
    const sdk = createSentrySDK({ token: "invalid-token" });
    try {
      await sdk.org.list();
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SentryError);
    }
  });

  test("explicit token overrides stored OAuth credentials", async () => {
    setAuthToken("stored-oauth-token", 3600);
    const sdk = createSentrySDK({ token: "explicit-sdk-token" });

    await sdk.auth.status();

    expect(authorizationHeaders).toContain("Bearer explicit-sdk-token");
    expect(authorizationHeaders).not.toContain("Bearer stored-oauth-token");
  });

  test("sdk.run returns AsyncIterable for streaming flag --follow", () => {
    const sdk = createSentrySDK();
    const result = sdk.run("log", "list", "--follow");
    // Streaming flags return an AsyncIterable, not a Promise
    expect(Symbol.asyncIterator in (result as object)).toBe(true);
  });

  test("sdk.run returns AsyncIterable for streaming flag --refresh", () => {
    const sdk = createSentrySDK();
    const result = sdk.run("issue", "list", "--refresh");
    expect(Symbol.asyncIterator in (result as object)).toBe(true);
  });

  test("sdk.run returns AsyncIterable for streaming short flag -f", () => {
    const sdk = createSentrySDK();
    const result = sdk.run("log", "list", "-f");
    expect(Symbol.asyncIterator in (result as object)).toBe(true);
  });
});
