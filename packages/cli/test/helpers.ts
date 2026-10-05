/**
 * Test Helpers
 *
 * Shared utilities for test setup and teardown.
 */

import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
  resetAuthRowCache,
  resetAuthTokenCache,
  resetHasStoredCredsCache,
  resetIdentityFingerprintCache,
} from "../src/lib/db/auth.js";
import { CONFIG_DIR_ENV_VAR, closeDatabase } from "../src/lib/db/index.js";

// biome-ignore lint/performance/noBarrelFile: re-exporting a single constant, not a barrel
export { TEST_TMP_DIR } from "./constants.js";

import { TEST_TMP_DIR } from "./constants.js";

mkdirSync(TEST_TMP_DIR, { recursive: true });

type TestConfigDirOptions = {
  /**
   * Creates a .git directory to make this an isolated "project root".
   * This prevents DSN detection from walking up to the actual project root,
   * which would find real DSNs and cause fingerprint mismatches in tests.
   */
  isolateProjectRoot?: boolean;
};

/**
 * Creates a unique temporary directory for test isolation.
 * Uses a namespaced subdirectory under the OS temp directory.
 *
 * @param prefix - Directory name prefix (default: "sentry-test-")
 * @param options - Configuration options
 * @returns Full path to the created temporary directory
 */
export async function createTestConfigDir(
  prefix = "sentry-test-",
  options?: TestConfigDirOptions
): Promise<string> {
  const dir = await mkdtemp(join(TEST_TMP_DIR, prefix));

  if (options?.isolateProjectRoot) {
    mkdirSync(join(dir, ".git"));
  }

  return dir;
}

/**
 * Safely removes a test directory.
 *
 * @param dir - Directory path to remove
 */
export async function cleanupTestDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Helper type for fetch mock functions.
 * Bun's fetch type includes extra properties like `preconnect` that our mocks don't have.
 * Supports both full signature and simpler forms for tests that don't need input/init.
 */
type FetchMockFn =
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | (() => Promise<Response>);

/**
 * Create a properly typed fetch mock for tests.
 * This casts the mock function to handle Bun's extended fetch type.
 *
 * @param fn - Fetch mock implementation
 * @returns Properly typed fetch function
 */
export function mockFetch(fn: FetchMockFn): typeof fetch {
  return fn as unknown as typeof fetch;
}

/**
 * Sets up an isolated test config directory with proper env var lifecycle.
 *
 * Registers beforeEach/afterEach hooks that create a unique config directory,
 * point SENTRY_CONFIG_DIR at it, and restore the original value on teardown.
 * This eliminates the fragile pattern of manually managing process.env in
 * each test file, which caused cross-file pollution when afterEach hooks
 * deleted the env var while other files were still loading.
 *
 * Must be called at module scope or inside a describe() block.
 *
 * @param prefix - Directory name prefix for the temp directory
 * @param options - Configuration options (e.g., isolateProjectRoot)
 * @returns Getter function for the current test's config directory path
 */
export function useTestConfigDir(
  prefix = "sentry-test-",
  options?: TestConfigDirOptions
): () => string {
  let dir: string;
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    savedConfigDir = process.env[CONFIG_DIR_ENV_VAR];
    closeDatabase();
    // Fresh DB — drop module-scoped auth caches from the previous test.
    resetAuthTokenCache();
    resetAuthRowCache();
    resetHasStoredCredsCache();
    resetIdentityFingerprintCache();
    dir = await createTestConfigDir(prefix, options);
    process.env[CONFIG_DIR_ENV_VAR] = dir;
  });

  afterEach(async () => {
    closeDatabase();
    resetAuthTokenCache();
    resetAuthRowCache();
    resetHasStoredCredsCache();
    resetIdentityFingerprintCache();
    // Always restore the previous value — never delete.
    // Deleting process.env.SENTRY_CONFIG_DIR causes failures in test files
    // that load after this afterEach runs, because their module-level code
    // (or beforeEach hooks) may read the env var and get undefined.
    // Note: preload.ts always sets SENTRY_CONFIG_DIR, so savedConfigDir is
    // always defined in practice. The else branch is intentionally omitted
    // to avoid the "delete process.env" anti-pattern.
    if (savedConfigDir !== undefined) {
      process.env[CONFIG_DIR_ENV_VAR] = savedConfigDir;
    }
    await cleanupTestDir(dir);
  });

  return () => dir;
}

/**
 * Save/restore a set of `process.env` keys around each test in a `describe`
 * block. Saved values are restored verbatim in `afterEach`; missing keys are
 * deleted on restore. Each test starts with all listed keys cleared.
 *
 * Use for security/host-scoping tests where env vars influence the code path
 * being tested. Keeps the boilerplate `Object.fromEntries(KEYS.map(...))`
 * out of every test file.
 *
 * Must be called at module scope or inside a `describe()` block.
 */
export function useEnvSandbox(keys: readonly string[]): void {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      const v = saved[k];
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  });
}

/**
 * Reset the in-process host-scoping state (env-token snapshot, login trust
 * anchor, region-URL trust extension). Tests that mutate any of these
 * should call this in `beforeEach` and `afterEach` to avoid bleeding state
 * between cases.
 */
export async function resetHostScopingState(): Promise<void> {
  const [
    { resetEnvTokenHostForTesting },
    regions,
    { resetLoginTrustAnchorForTesting },
  ] = await Promise.all([
    import("../src/lib/env-token-host.js"),
    import("../src/lib/db/regions.js"),
    import("../src/lib/token-host.js"),
  ]);
  resetEnvTokenHostForTesting();
  regions.resetTrustedRegionUrlsForTesting();
  resetLoginTrustAnchorForTesting();
}

/**
 * Mint a `sntrys_<base64-payload>_<secret>` token shape for tests, matching
 * the server's `generate_token` format
 * (`getsentry/sentry/src/sentry/utils/security/orgauthtoken_token.py`).
 *
 * The secret tail is a fixed placeholder — its content is irrelevant to
 * parsing. Padding `=` is stripped to match the server's `b64encode().rstrip("=")`.
 */
export function mintSntrysToken(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64").replace(/=+$/, "");
  return `sntrys_${b64}_test-secret-tail`;
}

/**
 * Extract the URL string from a fetch input (`string | URL | Request`).
 * Used by tests that intercept `globalThis.fetch` and assert on the
 * destination URLs of captured calls.
 */
export function extractFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

// ---------------------------------------------------------------------------
// Route-based fetch mock
// ---------------------------------------------------------------------------

/** A single route handler for the fetch mock. */
export type FetchRoute = {
  /** URL pattern — string for `includes()` match, or RegExp */
  match: string | RegExp;
  /** HTTP method filter (default: any) */
  method?: string;
  /** Response body (JSON-serialized) or a handler function */
  response:
    | unknown
    | ((url: string, init?: RequestInit) => unknown | Promise<unknown>);
  /** HTTP status code (default: 200) */
  status?: number;
  /** Response headers */
  headers?: Record<string, string>;
};

/** Recorded fetch call for assertions. */
export type FetchCall = {
  url: string;
  method: string;
  body?: string;
};

/**
 * Create a route-based fetch mock that replaces `globalThis.fetch`.
 *
 * Matches requests against a list of routes and returns configured responses.
 * Unmatched requests return 404 by default. All requests are recorded for
 * assertion.
 *
 * Usage:
 * ```typescript
 * const { calls, restore } = installFetchMock([
 *   { match: "/organizations/", response: [{ slug: "acme" }] },
 *   { match: "/projects/", response: sampleProject, status: 201 },
 * ]);
 * afterEach(restore);
 * ```
 *
 * @param routes - Route handlers (matched in order, first match wins)
 * @param fallback - Response for unmatched requests (default: 404)
 * @returns Object with `calls` array and `restore` function
 */
export function installFetchMock(
  routes: FetchRoute[],
  fallback?: { status?: number; body?: unknown }
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  const fallbackStatus = fallback?.status ?? 404;
  const fallbackBody = fallback?.body ?? { detail: "Not found" };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test mock router requires branching for method/URL/body matching
  ): Promise<Response> => {
    const url = extractFetchUrl(input);
    const method = init?.method ?? "GET";
    const body =
      init?.body && typeof init.body === "string" ? init.body : undefined;

    calls.push({ url, method, body });

    for (const route of routes) {
      // Method filter
      if (route.method && route.method.toUpperCase() !== method.toUpperCase()) {
        continue;
      }

      // URL match
      const matched =
        typeof route.match === "string"
          ? url.includes(route.match)
          : route.match.test(url);

      if (!matched) {
        continue;
      }

      const status = route.status ?? 200;
      const responseBody =
        typeof route.response === "function"
          ? await route.response(url, init)
          : route.response;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(route.headers ?? {}),
      };

      return new Response(
        responseBody !== undefined ? JSON.stringify(responseBody) : undefined,
        { status, headers }
      );
    }

    // Fallback for unmatched routes
    return new Response(JSON.stringify(fallbackBody), {
      status: fallbackStatus,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
