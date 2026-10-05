/**
 * Version Check Logic Tests
 */

import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UPGRADE_SOURCES } from "../../src/lib/binary.js";
import { setReleaseChannel } from "../../src/lib/db/release-channel.js";
import {
  getVersionCheckInfo,
  setVersionCheckInfo,
} from "../../src/lib/db/version-check.js";
// biome-ignore lint/performance/noNamespaceImport: Vitest requires the module namespace to spy on an ESM export
import * as deltaUpgrade from "../../src/lib/delta-upgrade.js";
import {
  ApiError,
  ContextError,
  ValidationError,
} from "../../src/lib/errors.js";
import {
  abortPendingVersionCheck,
  getErrorUpdateNotification,
  getUpdateNotification,
  maybeCheckForUpdateInBackground,
  resetUpdateNotificationState,
  shouldSuppressNotification,
} from "../../src/lib/version-check.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

/**
 * Force `process.stderr.isTTY` for the duration of a test.
 *
 * `getUpdateNotification` suppresses output when stderr is not a TTY
 * (scripts, CI, pipes) so tests that assert a non-null notification
 * must simulate a TTY first. Restores the previous value on cleanup.
 */
function withStderrTTY(value: boolean): () => void {
  const original = process.stderr.isTTY;
  (process.stderr as { isTTY?: boolean }).isTTY = value;
  return () => {
    if (original === undefined) {
      delete (process.stderr as { isTTY?: boolean }).isTTY;
    } else {
      (process.stderr as { isTTY?: boolean }).isTTY = original;
    }
  };
}

describe("shouldSuppressNotification", () => {
  test("suppresses for upgrade command", () => {
    expect(shouldSuppressNotification(["upgrade"])).toBe(true);
    expect(shouldSuppressNotification(["upgrade", "--check"])).toBe(true);
  });

  test("suppresses for cli management commands", () => {
    expect(shouldSuppressNotification(["cli", "setup"])).toBe(true);
    expect(shouldSuppressNotification(["cli", "fix"])).toBe(true);
    expect(
      shouldSuppressNotification([
        "cli",
        "setup",
        "--install",
        "--method",
        "curl",
      ])
    ).toBe(true);
  });

  test("suppresses cli management commands with global flags before the subcommand", () => {
    // Global flags are no longer hoisted to the tail, so they may sit between
    // `cli` and the subcommand. Suppression must still find `setup`/`fix`.
    expect(shouldSuppressNotification(["cli", "--verbose", "setup"])).toBe(
      true
    );
    expect(shouldSuppressNotification(["cli", "-v", "fix"])).toBe(true);
    expect(
      shouldSuppressNotification(["cli", "--log-level", "debug", "setup"])
    ).toBe(true);
    expect(shouldSuppressNotification(["cli", "--org", "acme", "setup"])).toBe(
      true
    );
    expect(shouldSuppressNotification(["cli", "--org=acme", "fix"])).toBe(true);
  });

  test("suppresses cli management commands with global flags before cli", () => {
    // Global flags can also precede the command group (`sentry --verbose cli
    // setup`) since they're no longer hoisted; `cli` need not be args[0].
    expect(shouldSuppressNotification(["--verbose", "cli", "setup"])).toBe(
      true
    );
    expect(shouldSuppressNotification(["-v", "cli", "fix"])).toBe(true);
    expect(shouldSuppressNotification(["--org", "acme", "cli", "setup"])).toBe(
      true
    );
    expect(shouldSuppressNotification(["--org=acme", "cli", "fix"])).toBe(true);
    expect(
      shouldSuppressNotification(["--verbose", "cli", "--org", "acme", "setup"])
    ).toBe(true);
  });

  test("does not suppress when a non-flag token precedes cli", () => {
    // The first positional token settles the command group. If it isn't `cli`,
    // a later `cli setup` is an argument, not the management command.
    expect(shouldSuppressNotification(["issue", "cli", "setup"])).toBe(false);
  });

  test("does not suppress for cli feedback", () => {
    expect(shouldSuppressNotification(["cli", "feedback"])).toBe(false);
  });

  test("does not suppress when setup/fix appear as non-cli args", () => {
    expect(
      shouldSuppressNotification(["issue", "list", "--project", "setup"])
    ).toBe(false);
    expect(
      shouldSuppressNotification(["issue", "list", "--query", "fix"])
    ).toBe(false);
  });

  test("suppresses for --version flag", () => {
    expect(shouldSuppressNotification(["--version"])).toBe(true);
    expect(shouldSuppressNotification(["-V"])).toBe(true);
  });

  test("suppresses for --json flag", () => {
    expect(shouldSuppressNotification(["issue", "list", "--json"])).toBe(true);
    expect(shouldSuppressNotification(["--json", "issue", "list"])).toBe(true);
  });

  test("does not suppress for regular commands", () => {
    expect(shouldSuppressNotification(["issue", "list"])).toBe(false);
    expect(shouldSuppressNotification(["auth", "status"])).toBe(false);
    expect(shouldSuppressNotification(["help"])).toBe(false);
  });

  test("does not suppress for empty args", () => {
    expect(shouldSuppressNotification([])).toBe(false);
  });
});

// Note: shouldCheckForUpdate is now an internal function that reads from the DB.
// Its probabilistic behavior is tested indirectly through maybeCheckForUpdateInBackground.

describe("getUpdateNotification", () => {
  useTestConfigDir("test-version-notif-");
  let savedNoUpdateCheck: string | undefined;
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    // Save and clear the env var to test real implementation
    savedNoUpdateCheck = process.env.SENTRY_CLI_NO_UPDATE_CHECK;
    delete process.env.SENTRY_CLI_NO_UPDATE_CHECK;
    // Reset the in-process "already notified" latch so each test starts fresh.
    resetUpdateNotificationState();
    // Default to TTY so the human-facing banner path is exercised. Tests
    // that specifically check non-TTY suppression override this.
    restoreTTY = withStderrTTY(true);
  });

  afterEach(() => {
    // Restore the env var
    if (savedNoUpdateCheck !== undefined) {
      process.env.SENTRY_CLI_NO_UPDATE_CHECK = savedNoUpdateCheck;
    }
    restoreTTY?.();
    restoreTTY = undefined;
  });

  test("returns null when no version info is cached", () => {
    const notification = getUpdateNotification();
    expect(notification).toBeNull();
  });

  test("returns null when cached version is same as current", () => {
    // CLI_VERSION is "0.0.0-dev" in test environment
    setVersionCheckInfo("0.0.0-dev");
    const notification = getUpdateNotification();
    expect(notification).toBeNull();
  });

  test("returns null when cached version is older than current", () => {
    // Any version older than 0.0.0-dev (which is essentially "no version")
    // Actually 0.0.0 is equal to 0.0.0-dev in semver (pre-release is older)
    // So let's use something clearly older
    setVersionCheckInfo("0.0.0-alpha");
    const notification = getUpdateNotification();
    expect(notification).toBeNull();
  });

  test("returns notification message when newer version is available", () => {
    setVersionCheckInfo("99.0.0");
    const notification = getUpdateNotification();

    expect(notification).not.toBeNull();
    expect(notification).toContain("Update available:");
    expect(notification).toContain("99.0.0");
    expect(notification).toContain("sentry cli upgrade");
  });

  test("uses 'New nightly available:' label when on nightly channel", () => {
    setReleaseChannel("nightly");
    setVersionCheckInfo("99.0.0");
    const notification = getUpdateNotification();

    expect(notification).not.toBeNull();
    expect(notification).toContain("New nightly available:");
    expect(notification).not.toContain("Update available:");
    expect(notification).toContain("99.0.0");
  });

  test("uses 'Update available:' label when on stable channel", () => {
    setReleaseChannel("stable");
    setVersionCheckInfo("99.0.0");
    const notification = getUpdateNotification();

    expect(notification).not.toBeNull();
    expect(notification).toContain("Update available:");
    expect(notification).not.toContain("New nightly available:");
  });

  test("returns null when stderr is not a TTY (scripts, CI, pipes)", () => {
    // Override the TTY shim set in beforeEach with a non-TTY stderr.
    restoreTTY?.();
    restoreTTY = withStderrTTY(false);

    setVersionCheckInfo("99.0.0");
    const notification = getUpdateNotification();
    expect(notification).toBeNull();
  });

  test("only notifies once per process even with a newer version", () => {
    setVersionCheckInfo("99.0.0");

    const first = getUpdateNotification();
    const second = getUpdateNotification();
    const third = getUpdateNotification();

    expect(first).not.toBeNull();
    // Subsequent calls in the same process must be silent — the banner
    // is printed once at the end of the command run, not per API call.
    expect(second).toBeNull();
    expect(third).toBeNull();
  });

  test("rate-limits across CLI invocations to once per day", () => {
    setVersionCheckInfo("99.0.0");

    // First invocation emits the banner and stamps last_notified.
    const first = getUpdateNotification();
    expect(first).not.toBeNull();

    // Simulate a fresh CLI invocation.
    resetUpdateNotificationState();

    // Still within the 24h window → no banner.
    const second = getUpdateNotification();
    expect(second).toBeNull();
  });
});

describe("getErrorUpdateNotification", () => {
  useTestConfigDir("test-version-error-notif-");
  const defaultArgs = ["issue", "list"];
  let savedNoUpdateCheck: string | undefined;
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    savedNoUpdateCheck = process.env.SENTRY_CLI_NO_UPDATE_CHECK;
    delete process.env.SENTRY_CLI_NO_UPDATE_CHECK;
    resetUpdateNotificationState();
    restoreTTY = withStderrTTY(true);
  });

  afterEach(() => {
    if (savedNoUpdateCheck !== undefined) {
      process.env.SENTRY_CLI_NO_UPDATE_CHECK = savedNoUpdateCheck;
    }
    restoreTTY?.();
    restoreTTY = undefined;
  });

  test("returns null when no version info is cached", () => {
    expect(
      getErrorUpdateNotification(new Error("boom"), defaultArgs)
    ).toBeNull();
  });

  test("returns null when cached version is same as current", () => {
    setVersionCheckInfo("0.0.0-dev");
    expect(
      getErrorUpdateNotification(new Error("boom"), defaultArgs)
    ).toBeNull();
  });

  test("returns contextual message for unexpected errors when newer version is available", () => {
    setVersionCheckInfo("99.0.0");
    const notification = getErrorUpdateNotification(
      new Error("boom"),
      defaultArgs
    );

    expect(notification).not.toBeNull();
    expect(notification).toContain("99.0.0");
    expect(notification).toContain("Upgrading may resolve this");
    expect(notification).toContain("sentry cli upgrade");
  });

  test("does not contain standard 'Update available:' label", () => {
    setVersionCheckInfo("99.0.0");
    const notification = getErrorUpdateNotification(
      new Error("boom"),
      defaultArgs
    );

    expect(notification).not.toBeNull();
    expect(notification).not.toContain("Update available:");
  });

  test.each([
    ["ContextError", new ContextError("Organization", "sentry org list")],
    ["ValidationError", new ValidationError("bad input")],
    ["ApiError 404", new ApiError("not found", 404)],
  ])("returns standard update copy for user error %s", (_label, errorValue) => {
    setVersionCheckInfo("99.0.0");
    const notification = getErrorUpdateNotification(errorValue, defaultArgs);

    expect(notification).not.toBeNull();
    expect(notification).toContain("Update available:");
    expect(notification).not.toContain("Upgrading may resolve this");
  });

  test.each([
    ["ApiError 400", new ApiError("bad request", 400)],
    ["ApiError 500", new ApiError("server error", 500)],
    ["generic Error", new Error("boom")],
  ])("returns contextual update copy for non-user error %s", (_label, errorValue) => {
    setVersionCheckInfo("99.0.0");
    const notification = getErrorUpdateNotification(errorValue, defaultArgs);

    expect(notification).not.toBeNull();
    expect(notification).toContain("Upgrading may resolve this");
    expect(notification).not.toContain("Update available:");
  });

  test.each([
    ["json flag", ["issue", "list", "--json"]],
    ["init", ["init"]],
    ["upgrade", ["upgrade"]],
    ["cli setup", ["cli", "setup"]],
  ])("returns null for suppressed args: %s", (_label, args) => {
    setVersionCheckInfo("99.0.0");
    expect(getErrorUpdateNotification(new Error("boom"), args)).toBeNull();
  });

  test("returns null when stderr is not a TTY", () => {
    restoreTTY?.();
    restoreTTY = withStderrTTY(false);

    setVersionCheckInfo("99.0.0");
    expect(
      getErrorUpdateNotification(new Error("boom"), defaultArgs)
    ).toBeNull();
  });

  test("shares once-per-process latch with getUpdateNotification", () => {
    setVersionCheckInfo("99.0.0");

    // Error notification fires first
    const first = getErrorUpdateNotification(new Error("boom"), defaultArgs);
    expect(first).not.toBeNull();

    // Standard notification is suppressed (same latch)
    const second = getUpdateNotification();
    expect(second).toBeNull();
  });

  test("standard notification suppresses error notification too", () => {
    setVersionCheckInfo("99.0.0");

    const first = getUpdateNotification();
    expect(first).not.toBeNull();

    const second = getErrorUpdateNotification(new Error("boom"), defaultArgs);
    expect(second).toBeNull();
  });

  test("rate-limits across CLI invocations", () => {
    setVersionCheckInfo("99.0.0");

    const first = getErrorUpdateNotification(new Error("boom"), defaultArgs);
    expect(first).not.toBeNull();

    // Simulate fresh invocation
    resetUpdateNotificationState();

    // Still within 24h window
    const second = getErrorUpdateNotification(new Error("boom"), defaultArgs);
    expect(second).toBeNull();
  });
});

describe("abortPendingVersionCheck", () => {
  test("does not throw when no pending check", () => {
    // Should be safe to call even when nothing is pending
    expect(() => abortPendingVersionCheck()).not.toThrow();
  });

  test("does not throw when called multiple times", () => {
    // Should be safe to call multiple times
    expect(() => {
      abortPendingVersionCheck();
      abortPendingVersionCheck();
      abortPendingVersionCheck();
    }).not.toThrow();
  });
});

describe("maybeCheckForUpdateInBackground", () => {
  useTestConfigDir("test-version-bg-");
  let savedNoUpdateCheck: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // Save and clear the env var to test real implementation
    savedNoUpdateCheck = process.env.SENTRY_CLI_NO_UPDATE_CHECK;
    delete process.env.SENTRY_CLI_NO_UPDATE_CHECK;
    // Silence background fetch calls to GitHub API that would otherwise
    // hit the preload mock and produce "unexpected fetch" warnings.
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ tag_name: "v0.0.0-dev" }), {
          status: 200,
        })
    );
  });

  afterEach(() => {
    // Abort any pending check to clean up
    abortPendingVersionCheck();
    globalThis.fetch = originalFetch;
    // Restore the env var
    if (savedNoUpdateCheck !== undefined) {
      process.env.SENTRY_CLI_NO_UPDATE_CHECK = savedNoUpdateCheck;
    }
    vi.restoreAllMocks();
  });

  test("does not throw when called", () => {
    // This test verifies the function can be called without errors
    // The actual network call happens in the background and may fail,
    // but the function itself should not throw
    expect(() => maybeCheckForUpdateInBackground()).not.toThrow();
  });

  test("checks for update when never checked before", async () => {
    // With no lastChecked, shouldCheckForUpdate returns true
    // which means the background check should be initiated
    const infoBefore = getVersionCheckInfo();
    expect(infoBefore.lastChecked).toBeNull();

    // Start background check
    maybeCheckForUpdateInBackground();

    // Wait a bit for the background fetch to potentially complete
    // Note: The fetch may fail (network error), but the function should not throw
    await sleep(100);
    abortPendingVersionCheck();
  });

  test("respects probabilistic checking when recently checked", async () => {
    // Set a recent lastChecked time by calling setVersionCheckInfo
    // This will set lastChecked to "now"
    setVersionCheckInfo("1.0.0");

    const infoBefore = getVersionCheckInfo();
    expect(infoBefore.lastChecked).not.toBeNull();
    expect(infoBefore.latestVersion).toBe("1.0.0");

    // Call multiple times - with very recent check, probability is near 0
    // so it's unlikely to trigger a new check
    for (let i = 0; i < 5; i++) {
      maybeCheckForUpdateInBackground();
    }

    // Wait briefly
    await sleep(50);
    abortPendingVersionCheck();
  });

  test("aborts cleanly when abortPendingVersionCheck is called", async () => {
    // Start a background check
    maybeCheckForUpdateInBackground();

    // Immediately abort
    abortPendingVersionCheck();

    // Should not throw and should clean up properly
    await sleep(50);

    // Can start another check after aborting
    expect(() => maybeCheckForUpdateInBackground()).not.toThrow();
    abortPendingVersionCheck();
  });

  test("passes the Toolkit source from stable discovery to patch prefetch without legacy access", async () => {
    const toolkitSource = UPGRADE_SOURCES[0]!;
    const requestedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("getsentry/cli")) {
        throw new Error(`Unexpected legacy access: ${url}`);
      }
      return new Response(
        JSON.stringify([{ tag_name: "cli@99.0.0", draft: false }]),
        { status: 200 }
      );
    });
    const prefetch = vi
      .spyOn(deltaUpgrade, "prefetchStablePatches")
      .mockResolvedValue();

    maybeCheckForUpdateInBackground();

    await vi.waitFor(() => {
      expect(prefetch).toHaveBeenCalledWith(
        "99.0.0",
        expect.any(AbortSignal),
        toolkitSource
      );
    });
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100",
    ]);
  });

  test("keeps stable patch prefetch on the legacy source selected after a Toolkit 404", async () => {
    const legacySource = UPGRADE_SOURCES[1]!;
    const requestedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("getsentry/toolkit")) {
        return new Response("not found", { status: 404 });
      }
      if (
        url === "https://api.github.com/repos/getsentry/cli/releases/latest"
      ) {
        return new Response(JSON.stringify({ tag_name: "v99.0.0" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const prefetch = vi
      .spyOn(deltaUpgrade, "prefetchStablePatches")
      .mockResolvedValue();

    maybeCheckForUpdateInBackground();

    await vi.waitFor(() => {
      expect(prefetch).toHaveBeenCalledWith(
        "99.0.0",
        expect.any(AbortSignal),
        legacySource
      );
    });
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100",
      "https://api.github.com/repos/getsentry/cli/releases/latest",
    ]);
  });

  test("passes the Toolkit source from nightly discovery to patch prefetch without legacy access", async () => {
    setReleaseChannel("nightly");
    const toolkitSource = UPGRADE_SOURCES[0]!;
    const requestedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("getsentry/cli")) {
        throw new Error(`Unexpected legacy access: ${url}`);
      }
      if (url === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/token?scope=repository:getsentry/toolkit:pull")) {
        return new Response(JSON.stringify({ token: "toolkit-token" }), {
          status: 200,
        });
      }
      if (url.endsWith("/v2/getsentry/toolkit/manifests/nightly")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            layers: [],
            annotations: { version: "99.0.0-dev.200" },
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const prefetch = vi
      .spyOn(deltaUpgrade, "prefetchNightlyPatches")
      .mockResolvedValue();

    maybeCheckForUpdateInBackground();

    await vi.waitFor(() => {
      expect(prefetch).toHaveBeenCalledWith(
        "99.0.0-dev.200",
        expect.any(AbortSignal),
        toolkitSource
      );
    });
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/getsentry/toolkit",
      "https://ghcr.io/token?scope=repository:getsentry/toolkit:pull",
      "https://ghcr.io/v2/getsentry/toolkit/manifests/nightly",
    ]);
  });
});

describe("opt-out behavior", () => {
  test("functions are no-ops when SENTRY_CLI_NO_UPDATE_CHECK=1", () => {
    // We need to test this in a subprocess because the env var is checked
    // at module load time. The current process has already loaded the module.
    const { spawnSync } = require("node:child_process");
    const { join } = require("node:path");

    const testScript = `
      const { getUpdateNotification, maybeCheckForUpdateInBackground } = await import('./src/lib/version-check.js');
      
      // These should be no-ops
      maybeCheckForUpdateInBackground();
      const notification = getUpdateNotification();
      
      console.log(notification === null ? 'PASS' : 'FAIL');
    `;

    const cwd = join(import.meta.dirname, "../..");

    // Try bun first (native runtime), fall back to node --input-type=module.
    // Some Bun versions lack node:sqlite — skip the test when the subprocess fails
    // to load modules (exit code !== 0 and stdout is empty).
    const bunPath = spawnSync("which", ["bun"], {
      encoding: "utf-8",
    }).stdout?.trim();
    const proc = bunPath
      ? spawnSync(bunPath, ["-e", testScript], {
          cwd,
          env: { ...process.env, SENTRY_CLI_NO_UPDATE_CHECK: "1" },
          encoding: "utf-8",
        })
      : spawnSync("node", ["--input-type=module", "-e", testScript], {
          cwd,
          env: { ...process.env, SENTRY_CLI_NO_UPDATE_CHECK: "1" },
          encoding: "utf-8",
        });

    // Skip assertion when subprocess fails to load (e.g., missing node:sqlite in Bun)
    if (proc.status !== 0 && !proc.stdout.trim()) {
      return;
    }

    expect(proc.stdout.trim()).toBe("PASS");
  });
});
