/**
 * Unit Tests for .sentryclirc Config File Reader
 *
 * Tests the walk-up discovery, merging, env shim, and caching behavior.
 * Uses real temp directories with actual .sentryclirc files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { closeDatabase } from "../../src/lib/db/index.js";
import {
  captureEnvTokenHost,
  resetEnvTokenHostForTesting,
} from "../../src/lib/env-token-host.js";
import {
  applySentryCliRcEnvShim,
  assertRcUrlTrusted,
  CONFIG_FILENAME,
  clearSentryCliRcCache,
  getRcInjectedTokenSource,
  loadSentryCliRc,
} from "../../src/lib/sentryclirc.js";
import { cleanupTestDir, createTestConfigDir } from "../helpers.js";

const ENV_KEYS = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_CONFIG_DIR",
] as const;

let testDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  clearSentryCliRcCache();
  closeDatabase();
  // Save env vars we'll modify
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  testDir = await createTestConfigDir("sentryclirc-test-", {
    isolateProjectRoot: true,
  });
  // Point config dir at the test dir so getConfigDir() returns a predictable path
  process.env.SENTRY_CONFIG_DIR = testDir;
  resetEnvTokenHostForTesting();
});

afterEach(async () => {
  clearSentryCliRcCache();
  closeDatabase();
  // Restore all saved env vars to their exact pre-test state.
  // Vars that were undefined before must be deleted — otherwise values
  // set during tests leak into subsequent test files in the suite.
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved !== undefined) {
      process.env[key] = saved;
    } else {
      delete process.env[key];
    }
  }
  resetEnvTokenHostForTesting();
  await cleanupTestDir(testDir);
});

/** Helper: write a .sentryclirc file */
function writeRcFile(dir: string, content: string): void {
  writeFileSync(join(dir, CONFIG_FILENAME), content, "utf-8");
}

/** Read an env var without TypeScript narrowing issues after `delete` */
function readEnv(key: string): string | undefined {
  return process.env[key];
}

describe("loadSentryCliRc", () => {
  test("returns empty config when no .sentryclirc files exist", async () => {
    const result = await loadSentryCliRc(testDir);
    expect(result.org).toBeUndefined();
    expect(result.project).toBeUndefined();
    expect(result.url).toBeUndefined();
    expect(result.token).toBeUndefined();
    expect(result.sources).toEqual({});
  });

  test("reads org and project from local .sentryclirc", async () => {
    writeRcFile(testDir, "[defaults]\norg = my-org\nproject = my-project\n");

    const result = await loadSentryCliRc(testDir);
    expect(result.org).toBe("my-org");
    expect(result.project).toBe("my-project");
    expect(result.sources.org).toBe(join(testDir, CONFIG_FILENAME));
    expect(result.sources.project).toBe(join(testDir, CONFIG_FILENAME));
  });

  test("reads auth token from local .sentryclirc", async () => {
    writeRcFile(testDir, "[auth]\ntoken = sntrys_abc123\n");

    const result = await loadSentryCliRc(testDir);
    expect(result.token).toBe("sntrys_abc123");
    expect(result.sources.token).toBe(join(testDir, CONFIG_FILENAME));
  });

  test("reads url from local .sentryclirc", async () => {
    writeRcFile(testDir, "[defaults]\nurl = https://sentry.example.com\n");

    const result = await loadSentryCliRc(testDir);
    expect(result.url).toBe("https://sentry.example.com");
  });

  test("reads all fields from a complete .sentryclirc", async () => {
    writeRcFile(
      testDir,
      `[defaults]
org = my-org
project = my-project
url = https://sentry.io/

[auth]
token = sntrys_test
`
    );

    const result = await loadSentryCliRc(testDir);
    expect(result.org).toBe("my-org");
    expect(result.project).toBe("my-project");
    expect(result.url).toBe("https://sentry.io/");
    expect(result.token).toBe("sntrys_test");
  });

  test("walks up from subdirectory to find .sentryclirc", async () => {
    writeRcFile(testDir, "[defaults]\norg = parent-org\nproject = parent-proj");

    const subDir = join(testDir, "packages", "frontend", "src");
    mkdirSync(subDir, { recursive: true });

    const result = await loadSentryCliRc(subDir);
    expect(result.org).toBe("parent-org");
    expect(result.project).toBe("parent-proj");
    expect(result.sources.org).toBe(join(testDir, CONFIG_FILENAME));
  });

  test("closest file wins for overlapping fields", async () => {
    // Parent has org + project
    writeRcFile(testDir, "[defaults]\norg = parent-org\nproject = parent-proj");

    // Child overrides project only
    const childDir = join(testDir, "packages", "frontend");
    mkdirSync(childDir, { recursive: true });
    writeRcFile(childDir, "[defaults]\nproject = child-proj");

    const result = await loadSentryCliRc(childDir);
    expect(result.org).toBe("parent-org");
    expect(result.project).toBe("child-proj");
    expect(result.sources.org).toBe(join(testDir, CONFIG_FILENAME));
    expect(result.sources.project).toBe(join(childDir, CONFIG_FILENAME));
  });

  test("closest file wins: token from child, org from parent", async () => {
    writeRcFile(
      testDir,
      "[defaults]\norg = parent-org\n[auth]\ntoken = parent-token"
    );

    const childDir = join(testDir, "sub");
    mkdirSync(childDir, { recursive: true });
    writeRcFile(childDir, "[auth]\ntoken = child-token");

    const result = await loadSentryCliRc(childDir);
    expect(result.org).toBe("parent-org");
    expect(result.token).toBe("child-token");
  });

  test("partial config is valid (only org, no project)", async () => {
    writeRcFile(testDir, "[defaults]\norg = only-org\n");

    const result = await loadSentryCliRc(testDir);
    expect(result.org).toBe("only-org");
    expect(result.project).toBeUndefined();
  });

  test("empty values are treated as unset", async () => {
    writeRcFile(testDir, "[defaults]\norg =\nproject = real-proj\n");

    const result = await loadSentryCliRc(testDir);
    // Empty string after trim is falsy, so org should not be set
    expect(result.org).toBeUndefined();
    expect(result.project).toBe("real-proj");
  });

  test("cache returns same object on repeated calls", async () => {
    writeRcFile(testDir, "[defaults]\norg = cached-org\n");

    const promise1 = loadSentryCliRc(testDir);
    const promise2 = loadSentryCliRc(testDir);
    // Same promise reference (concurrent callers share the load)
    expect(promise1).toBe(promise2);
  });

  test("clearSentryCliRcCache invalidates the cache", async () => {
    writeRcFile(testDir, "[defaults]\norg = first\n");
    const result1 = await loadSentryCliRc(testDir);

    clearSentryCliRcCache();

    // Modify the file
    writeRcFile(testDir, "[defaults]\norg = second\n");
    const result2 = await loadSentryCliRc(testDir);

    expect(result1.org).toBe("first");
    expect(result2.org).toBe("second");
    expect(result1).not.toBe(result2);
  });

  test("invalid INI content is gracefully handled", async () => {
    writeRcFile(testDir, "this is not ini format at all\n===\nmore garbage");

    const result = await loadSentryCliRc(testDir);
    expect(result.org).toBeUndefined();
    expect(result.project).toBeUndefined();
  });
});

describe("applySentryCliRcEnvShim", () => {
  test("sets SENTRY_AUTH_TOKEN when not already set", async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_TOKEN;
    writeRcFile(testDir, "[auth]\ntoken = rc-token\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_AUTH_TOKEN")).toBe("rc-token");
  });

  test("records the rc file as the injected token source", async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_TOKEN;
    writeRcFile(testDir, "[auth]\ntoken = rc-token\n");

    await applySentryCliRcEnvShim(testDir);
    expect(getRcInjectedTokenSource()).toBe(join(testDir, CONFIG_FILENAME));
  });

  test("does not record an injected source when a real env token is set", async () => {
    process.env.SENTRY_AUTH_TOKEN = "existing-token";
    writeRcFile(testDir, "[auth]\ntoken = rc-token\n");

    await applySentryCliRcEnvShim(testDir);
    expect(getRcInjectedTokenSource()).toBeUndefined();
  });

  test("does not override existing SENTRY_AUTH_TOKEN", async () => {
    process.env.SENTRY_AUTH_TOKEN = "existing-token";
    writeRcFile(testDir, "[auth]\ntoken = rc-token\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_AUTH_TOKEN")).toBe("existing-token");
  });

  test("does not override non-empty whitespace SENTRY_AUTH_TOKEN", async () => {
    process.env.SENTRY_AUTH_TOKEN = "  real-token  ";
    writeRcFile(testDir, "[auth]\ntoken = rc-token\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_AUTH_TOKEN")).toBe("  real-token  ");
  });

  test("overrides empty/whitespace-only SENTRY_AUTH_TOKEN", async () => {
    process.env.SENTRY_AUTH_TOKEN = "   ";
    writeRcFile(testDir, "[auth]\ntoken = rc-token\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_AUTH_TOKEN")).toBe("rc-token");
  });

  test("does not override existing SENTRY_TOKEN (fallback env var)", async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    process.env.SENTRY_TOKEN = "env-fallback-token";
    writeRcFile(testDir, "[auth]\ntoken = rc-token\n");

    await applySentryCliRcEnvShim(testDir);
    // SENTRY_AUTH_TOKEN should NOT be set — SENTRY_TOKEN already provides auth
    expect(readEnv("SENTRY_AUTH_TOKEN")).toBeUndefined();
    expect(readEnv("SENTRY_TOKEN")).toBe("env-fallback-token");
  });

  test("sets SENTRY_URL for SaaS rc url (no credential risk, no scoping check)", async () => {
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    writeRcFile(testDir, "[defaults]\nurl = https://sentry.io\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_URL")).toBe("https://sentry.io");
  });

  test("normalizes bare-hostname rc url before SaaS / scope checks", async () => {
    // Regression: `url = sentry.io` (no scheme) used to throw inside
    // `new URL(...)` deep in the SaaS check. The shim now normalizes
    // the rc url through `normalizeUrl` first so bare hostnames are
    // accepted as the equivalent `https://sentry.io`.
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    writeRcFile(testDir, "[defaults]\nurl = sentry.io\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_URL")).toBe("https://sentry.io");
  });

  test("assertRcUrlTrusted throws when non-SaaS rc url does not match active token's scoped host", async () => {
    // Env-token defaults to SaaS (no SENTRY_HOST set at capture time).
    // Any non-SaaS rc url is therefore a mismatch → CliError. This closes
    // the CVE where a committed .sentryclirc could redirect requests +
    // token to an attacker host. The shim itself applies the URL
    // unconditionally; the trust check lives in assertRcUrlTrusted, called
    // by buildCommand's wrapper.
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    // Capture env-token host BEFORE shim mutates env (mirrors boot order).
    captureEnvTokenHost();
    writeRcFile(testDir, "[defaults]\nurl = https://evil.example.com\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_URL")).toBe("https://evil.example.com");

    await expect(assertRcUrlTrusted(testDir)).rejects.toThrow(
      /does not match|sentry auth login --url/
    );
  });

  test("does not set SENTRY_URL when SENTRY_HOST is set", async () => {
    process.env.SENTRY_HOST = "sentry.other.com";
    delete process.env.SENTRY_URL;
    writeRcFile(testDir, "[defaults]\nurl = https://sentry.example.com\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_URL")).toBeUndefined();
  });

  test("does not set SENTRY_URL when SENTRY_URL is already set", async () => {
    delete process.env.SENTRY_HOST;
    process.env.SENTRY_URL = "https://existing.sentry.io";
    writeRcFile(testDir, "[defaults]\nurl = https://sentry.example.com\n");

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_URL")).toBe("https://existing.sentry.io");
  });

  test("does nothing when no .sentryclirc exists", async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;

    await applySentryCliRcEnvShim(testDir);
    expect(readEnv("SENTRY_AUTH_TOKEN")).toBeUndefined();
    expect(readEnv("SENTRY_URL")).toBeUndefined();
  });

  test("does not set org/project as env vars (only token and url)", async () => {
    writeRcFile(testDir, "[defaults]\norg = my-org\nproject = my-proj\n");

    const orgBefore = readEnv("SENTRY_ORG");
    const projBefore = readEnv("SENTRY_PROJECT");

    await applySentryCliRcEnvShim(testDir);

    // Org and project should NOT be set as env vars
    // (they're handled in the resolution chain, not via env shim)
    expect(readEnv("SENTRY_ORG")).toBe(orgBefore);
    expect(readEnv("SENTRY_PROJECT")).toBe(projBefore);
  });
});

describe("monorepo scenario", () => {
  test("root has org, each package has project", async () => {
    // Root: org only
    writeRcFile(testDir, "[defaults]\norg = acme-corp\n");

    // Frontend package: project override
    const frontendDir = join(testDir, "packages", "frontend");
    mkdirSync(frontendDir, { recursive: true });
    writeRcFile(frontendDir, "[defaults]\nproject = frontend-web\n");

    // Backend package: project override
    const backendDir = join(testDir, "packages", "backend");
    mkdirSync(backendDir, { recursive: true });
    writeRcFile(backendDir, "[defaults]\nproject = backend-api\n");

    const frontendResult = await loadSentryCliRc(frontendDir);
    expect(frontendResult.org).toBe("acme-corp");
    expect(frontendResult.project).toBe("frontend-web");

    clearSentryCliRcCache();

    const backendResult = await loadSentryCliRc(backendDir);
    expect(backendResult.org).toBe("acme-corp");
    expect(backendResult.project).toBe("backend-api");
  });

  test("deep nesting: child of child inherits from multiple ancestors", async () => {
    writeRcFile(testDir, "[auth]\ntoken = root-token\n");

    const pkgDir = join(testDir, "packages", "web");
    mkdirSync(pkgDir, { recursive: true });
    writeRcFile(pkgDir, "[defaults]\norg = web-org\nproject = web-proj\n");

    const srcDir = join(pkgDir, "src", "components");
    mkdirSync(srcDir, { recursive: true });

    const result = await loadSentryCliRc(srcDir);
    expect(result.org).toBe("web-org");
    expect(result.project).toBe("web-proj");
    expect(result.token).toBe("root-token");
  });
});
