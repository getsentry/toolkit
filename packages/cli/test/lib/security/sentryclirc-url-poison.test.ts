/**
 * CVE regression: .sentryclirc URL injection attack.
 *
 * Attack: a committed `.sentryclirc` file in a cloned repo sets
 * `[defaults] url = https://evil.com`. The env-shim previously wrote
 * `env.SENTRY_URL=https://evil.com` when neither `SENTRY_HOST` nor
 * `SENTRY_URL` was set, independent of whether `SENTRY_AUTH_TOKEN` was
 * present — so a developer's real token got sent to the attacker on every
 * CLI command.
 *
 * Fix (this PR): the shim consults `getActiveTokenHost()` (from env-only
 * snapshot, not .sentryclirc itself) and throws `CliError` when the rc
 * url doesn't match the active token's scope. SaaS URLs bypass the check
 * (no credentials can leak to SaaS).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { closeDatabase } from "../../../src/lib/db/index.js";
import {
  captureEnvTokenHost,
  resetEnvTokenHostForTesting,
} from "../../../src/lib/env-token-host.js";
import {
  applySentryCliRcEnvShim,
  assertRcUrlTrusted,
  CONFIG_FILENAME,
  clearSentryCliRcCache,
} from "../../../src/lib/sentryclirc.js";
import { cleanupTestDir, createTestConfigDir } from "../../helpers.js";

// Don't use useEnvSandbox here: these tests depend on preload's
// SENTRY_AUTH_TOKEN being present (so getActiveTokenHost() returns a host)
// while still controlling SENTRY_HOST/URL/CONFIG_DIR per-test.
const ENV_KEYS = ["SENTRY_HOST", "SENTRY_URL", "SENTRY_CONFIG_DIR"] as const;

function writeRc(dir: string, content: string): void {
  writeFileSync(join(dir, CONFIG_FILENAME), content, "utf-8");
}

describe("CVE: .sentryclirc URL credential exfiltration", () => {
  let testDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    clearSentryCliRcCache();
    closeDatabase();
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    testDir = await createTestConfigDir("sentryclirc-cve-", {
      isolateProjectRoot: true,
    });
    process.env.SENTRY_CONFIG_DIR = testDir;
    resetEnvTokenHostForTesting();
  });

  afterEach(async () => {
    clearSentryCliRcCache();
    closeDatabase();
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
    resetEnvTokenHostForTesting();
    await cleanupTestDir(testDir);
  });

  test("repo-local .sentryclirc with attacker URL throws (SENTRY_AUTH_TOKEN default SaaS scope)", async () => {
    // Attack setup: user has SENTRY_AUTH_TOKEN (scoped to SaaS by default
    // because no SENTRY_HOST is set). Attacker repo ships .sentryclirc
    // pointing at evil.com.
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    // SENTRY_AUTH_TOKEN is already set by test/preload.ts
    // Capture env-token host BEFORE the shim mutates env (mirrors boot
    // ordering in cli.ts::preloadProjectContext).
    captureEnvTokenHost();
    writeRc(testDir, "[defaults]\nurl = https://evil.com\n");

    // Shim applies the URL unconditionally — the trust check is deferred.
    await applySentryCliRcEnvShim(testDir);
    expect(process.env.SENTRY_URL).toBe("https://evil.com");

    // Critical: assertRcUrlTrusted must throw, blocking any credentialed
    // request via buildCommand's wrapper.
    await expect(assertRcUrlTrusted(testDir)).rejects.toThrow(
      /does not match|sentry auth login --url/
    );
  });

  test("global-style .sentryclirc with attacker URL is rejected too (no 'global is trusted' bypass)", async () => {
    // The plan explicitly rejects 'global rc is trusted' because CI runners
    // can write ~/.sentryclirc. Writing to the config dir (treated as
    // global) must NOT be a trust-establishment pathway.
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    captureEnvTokenHost();
    // Write the rc in the config dir (SENTRY_CONFIG_DIR is set above).
    // That's treated as a "global" path by the shim's scope tagging.
    writeRc(testDir, "[defaults]\nurl = https://evil.com\n");

    await applySentryCliRcEnvShim(testDir);
    await expect(assertRcUrlTrusted(testDir)).rejects.toThrow(
      /does not match|sentry auth login --url/
    );
  });

  test("SaaS URL in .sentryclirc proceeds (no credential leak possible to SaaS)", async () => {
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    writeRc(testDir, "[defaults]\nurl = https://sentry.io\n");

    await applySentryCliRcEnvShim(testDir);
    expect(process.env.SENTRY_URL).toBe("https://sentry.io");
  });

  test("matching self-hosted URL proceeds when env-token is scoped to that host", async () => {
    // Simulate boot ordering: user sets SENTRY_HOST via env (shell export),
    // captureEnvTokenHost() pins the token's scope to that host, THEN the
    // env gets cleared (simulating e.g. a test isolation or a shell that
    // only exported SENTRY_HOST for a particular subcommand). The rc file
    // then proposes the same host the token was scoped to — match.
    process.env.SENTRY_HOST = "https://sentry.example.com";
    resetEnvTokenHostForTesting();
    captureEnvTokenHost(); // pin to sentry.example.com
    // Now simulate the shim running when both env vars are unset so the
    // shim's "only write if both unset" guard admits the rc-sourced URL.
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    writeRc(testDir, "[defaults]\nurl = https://sentry.example.com\n");

    await applySentryCliRcEnvShim(testDir);
    expect(process.env.SENTRY_URL).toBe("https://sentry.example.com");
  });

  test("existing SENTRY_HOST is never overridden by rc (shim has its own guard)", async () => {
    // Pre-existing SENTRY_HOST from user env — rc must not override it
    // regardless of what the rc says.
    process.env.SENTRY_HOST = "https://sentry.example.com";
    resetEnvTokenHostForTesting();
    writeRc(testDir, "[defaults]\nurl = https://evil.com\n");

    // Shim's own "only write if both unset" guard kicks in first → silent no-op
    await applySentryCliRcEnvShim(testDir);
    expect(process.env.SENTRY_HOST).toBe("https://sentry.example.com");
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("shim applies rc URL unconditionally; assertRcUrlTrusted is the gate", async () => {
    // The shim always writes the rc URL to env (for routing). The trust
    // check is deferred to assertRcUrlTrusted, which buildCommand calls
    // after Stricli identifies the command. Commands that opt out
    // (auth login/logout via skipRcUrlCheck: true) never call it.
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    writeRc(testDir, "[defaults]\nurl = https://sentry.example.com\n");

    await applySentryCliRcEnvShim(testDir);
    // URL applied to env (no trust check at this stage).
    expect(process.env.SENTRY_URL).toBe("https://sentry.example.com");

    // The trust check is the deferred gate — would throw for non-matching
    // hosts. Already covered by the other tests in this file.
  });
});
