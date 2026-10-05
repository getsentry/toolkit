/**
 * Test Environment Setup
 *
 * Isolates tests from user's real configuration and environment.
 * Runs before all tests via vitest setupFiles.
 */

// Polyfill `self` for Node.js — web worker code (e.g., grep-worker.js) references
// `self.onmessage` which exists in Bun and browsers but not in Node.
if (typeof globalThis.self === "undefined") {
  (globalThis as Record<string, unknown>).self = globalThis;
}

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Load .env.local for test credentials (SENTRY_TEST_*)
// This mimics what would happen in CI where secrets are injected as env vars
const envLocalPath = join(import.meta.dirname, "../.env.local");
if (existsSync(envLocalPath)) {
  const content = readFileSync(envLocalPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Only set if not already set (env vars take precedence)
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

import { TEST_TMP_DIR } from "./constants.js";

// Wipe stale test temp leftovers from previous runs (or crashes).
// This is the primary cleanup mechanism — individual test afterEach hooks
// clean up on success, but crashes/SIGKILL leave dirs behind.
try {
  rmSync(TEST_TMP_DIR, { recursive: true, force: true });
} catch {
  // Ignore — directory may not exist on first run
}
mkdirSync(TEST_TMP_DIR, { recursive: true });

// One-time migration: clean up old $HOME/.sentry-cli-test-* dirs left by
// the previous test infrastructure. Safe to remove after a few months.
try {
  const home = homedir();
  for (const entry of readdirSync(home)) {
    if (entry.startsWith(".sentry-cli-test-")) {
      rmSync(join(home, entry), { recursive: true, force: true });
    }
  }
} catch {
  // Ignore — home dir may not be listable in some CI environments
}

// Create isolated test directory under OS temp (not $HOME)
const testDir = join(TEST_TMP_DIR, `preload-${process.pid}`);
mkdirSync(testDir, { recursive: true });

// Override config directory for all tests
// Note: This must match CONFIG_DIR_ENV_VAR from src/lib/config.ts
process.env.SENTRY_CONFIG_DIR = testDir;

// Clear Sentry environment variables to ensure clean state
// (but preserve SENTRY_TEST_* vars for E2E tests)
delete process.env.SENTRY_DSN;
delete process.env.SENTRY_AUTH_TOKEN;
delete process.env.SENTRY_TOKEN;
delete process.env.SENTRY_CLIENT_ID;
delete process.env.SENTRY_URL;
delete process.env.SENTRY_HOST;
delete process.env.SENTRY_ORG;
delete process.env.SENTRY_PROJECT;

// Set a fake auth token so buildCommand's auth guard passes in tests.
// Real API calls are blocked by the global fetch mock below.
// Tests that specifically verify unauthenticated behavior (e.g., auth status)
// mock getAuthConfig to return undefined.
process.env.SENTRY_AUTH_TOKEN = "sntrys_test-token-for-unit-tests_000000";

// Disable telemetry and background update checks in tests
// This prevents Sentry SDK from keeping the process alive and making external calls
process.env.SENTRY_CLI_NO_TELEMETRY = "1";
process.env.SENTRY_CLI_NO_UPDATE_CHECK = "1";

// Mock global fetch to prevent any external network calls in unit tests
// Tests that need real fetch should restore it in their setup
const originalFetch = globalThis.fetch;

function getUrlFromInput(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

const mockFetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = getUrlFromInput(input);
  console.error(`[TEST] Unexpected fetch call to: ${url}`);
  console.error(
    "[TEST] Tests should mock fetch or use SENTRY_TEST_* credentials for real API calls"
  );
  throw new Error(`Unmocked fetch call to: ${url}`);
};

// Cast via unknown to avoid Bun's extended fetch type (which includes preconnect)
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Export original fetch for tests that need to restore it
(globalThis as { __originalFetch?: typeof fetch }).__originalFetch =
  originalFetch;

// Cleanup after all tests
process.on("exit", () => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// Also cleanup on SIGINT/SIGTERM
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// ---------------------------------------------------------------------------
// Custom matchers (polyfill Bun-specific expect extensions for vitest)
// ---------------------------------------------------------------------------
import { expect } from "vitest";

expect.extend({
  toStartWith(received: string, expected: string) {
    const pass = typeof received === "string" && received.startsWith(expected);
    return {
      pass,
      message: () =>
        `expected ${JSON.stringify(received)} to ${pass ? "not " : ""}start with ${JSON.stringify(expected)}`,
    };
  },
  toEndWith(received: string, expected: string) {
    const pass = typeof received === "string" && received.endsWith(expected);
    return {
      pass,
      message: () =>
        `expected ${JSON.stringify(received)} to ${pass ? "not " : ""}end with ${JSON.stringify(expected)}`,
    };
  },
  toBeString(received: unknown) {
    const pass = typeof received === "string";
    return {
      pass,
      message: () =>
        `expected ${JSON.stringify(received)} to ${pass ? "not " : ""}be a string`,
    };
  },
  toBeArray(received: unknown) {
    const pass = Array.isArray(received);
    return {
      pass,
      message: () =>
        `expected ${JSON.stringify(received)} to ${pass ? "not " : ""}be an array`,
    };
  },
});
