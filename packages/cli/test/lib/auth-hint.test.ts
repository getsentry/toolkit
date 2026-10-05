/**
 * Tests for the one-shot env-token-ignored hint
 * (`maybeWarnEnvTokenIgnored`).
 *
 * Covers:
 * - Hint fires when env token + stored OAuth coexist.
 * - Hint does NOT fire without an env token, without a stored login,
 *   or when SENTRY_FORCE_ENV_TOKEN is set.
 * - Repeat calls in the same process are silent.
 * - User label preference order (username > email > name > fallback).
 * - Names the `.sentryclirc` source when the token came from the rc shim.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  maybeWarnEnvTokenIgnored,
  resetAuthHintState,
} from "../../src/lib/auth-hint.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setUserInfo } from "../../src/lib/db/user.js";
import {
  applySentryCliRcEnvShim,
  CONFIG_FILENAME,
  clearSentryCliRcCache,
} from "../../src/lib/sentryclirc.js";
import { useTestConfigDir } from "../helpers.js";

const getConfigDir = useTestConfigDir("auth-hint-");

let savedAuthToken: string | undefined;
let savedSentryToken: string | undefined;
let savedForceEnv: string | undefined;

beforeEach(() => {
  savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
  savedSentryToken = process.env.SENTRY_TOKEN;
  savedForceEnv = process.env.SENTRY_FORCE_ENV_TOKEN;
  delete process.env.SENTRY_AUTH_TOKEN;
  delete process.env.SENTRY_TOKEN;
  delete process.env.SENTRY_FORCE_ENV_TOKEN;
  clearSentryCliRcCache();
  resetAuthHintState();
});

afterEach(() => {
  if (savedAuthToken !== undefined) {
    process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
  } else {
    delete process.env.SENTRY_AUTH_TOKEN;
  }
  if (savedSentryToken !== undefined) {
    process.env.SENTRY_TOKEN = savedSentryToken;
  } else {
    delete process.env.SENTRY_TOKEN;
  }
  if (savedForceEnv !== undefined) {
    process.env.SENTRY_FORCE_ENV_TOKEN = savedForceEnv;
  } else {
    delete process.env.SENTRY_FORCE_ENV_TOKEN;
  }
  clearSentryCliRcCache();
});

/**
 * Capture stderr output from consola's default reporter.
 *
 * We can't reliably spy on `logger.withTag("auth").info` from a test
 * because each `withTag()` call returns a fresh consola instance — the
 * spy target and the instance used inside `auth-hint.ts` are
 * different objects. Hooking `process.stderr.write` captures the final
 * rendered output regardless of which instance emitted it.
 */
function captureStderr() {
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  return {
    /** Number of calls whose first argument contained the env-hint body. */
    hintCalls: () =>
      stderrSpy.mock.calls.filter((call) =>
        String(call[0] ?? "").includes("SENTRY_FORCE_ENV_TOKEN=1")
      ).length,
    /** Flattened first-arg text across all calls (for substring assertions). */
    text: () =>
      stderrSpy.mock.calls.map((call) => String(call[0] ?? "")).join(""),
    restore: () => stderrSpy.mockRestore(),
  };
}

describe("maybeWarnEnvTokenIgnored", () => {
  test("does nothing when no env token is set", () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.hintCalls()).toBe(0);
    } finally {
      cap.restore();
    }
  });

  test("does nothing when no stored OAuth login exists", () => {
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.hintCalls()).toBe(0);
    } finally {
      cap.restore();
    }
  });

  test("does nothing when SENTRY_FORCE_ENV_TOKEN is set", () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    process.env.SENTRY_AUTH_TOKEN = "env_token";
    process.env.SENTRY_FORCE_ENV_TOKEN = "1";
    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.hintCalls()).toBe(0);
    } finally {
      cap.restore();
    }
  });

  test("fires once when env token collides with stored OAuth", () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    setUserInfo({
      userId: "u-1",
      username: "alice",
      email: "alice@example.com",
    });
    process.env.SENTRY_AUTH_TOKEN = "env_token";

    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.hintCalls()).toBe(1);
      const text = cap.text();
      expect(text).toContain("SENTRY_AUTH_TOKEN env var");
      expect(text).toContain("stored login for alice");
      expect(text).toContain("SENTRY_FORCE_ENV_TOKEN=1");
    } finally {
      cap.restore();
    }
  });

  test("names the .sentryclirc source when the token came from the rc shim", async () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    setUserInfo({ userId: "u-1", username: "alice" });

    // The shim reads $SENTRY_CONFIG_DIR/.sentryclirc as a global fallback
    // and copies its token into SENTRY_AUTH_TOKEN, recording the source.
    const rcPath = join(getConfigDir(), CONFIG_FILENAME);
    writeFileSync(rcPath, "[auth]\ntoken = rc-token\n", "utf-8");
    await applySentryCliRcEnvShim(getConfigDir());

    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.hintCalls()).toBe(1);
      const text = cap.text();
      expect(text).toContain(`Detected a token in .sentryclirc (${rcPath})`);
      expect(text).not.toContain("env var");
      expect(text).toContain("stored login for alice");
    } finally {
      cap.restore();
    }
  });

  test("is silent on repeat calls within the same process", () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    process.env.SENTRY_AUTH_TOKEN = "env_token";

    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      maybeWarnEnvTokenIgnored();
      maybeWarnEnvTokenIgnored();
      expect(cap.hintCalls()).toBe(1);
    } finally {
      cap.restore();
    }
  });

  test("uses SENTRY_TOKEN when only that legacy var is set", () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    process.env.SENTRY_TOKEN = "legacy_token";

    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.hintCalls()).toBe(1);
      expect(cap.text()).toContain("SENTRY_TOKEN env var");
    } finally {
      cap.restore();
    }
  });

  test("falls back to email when username is unavailable", () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    setUserInfo({
      userId: "u-1",
      email: "alice@example.com",
    });
    process.env.SENTRY_AUTH_TOKEN = "env_token";

    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.text()).toContain("stored login for alice@example.com");
    } finally {
      cap.restore();
    }
  });

  test("falls back to name when username and email are unavailable", () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    setUserInfo({ userId: "u-1", name: "Alice Wonderland" });
    process.env.SENTRY_AUTH_TOKEN = "env_token";

    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.text()).toContain("stored login for Alice Wonderland");
    } finally {
      cap.restore();
    }
  });

  test("uses a neutral label when no user info is cached", () => {
    setAuthToken("stored_oauth", 3600, "refresh_a");
    // No setUserInfo — user_info table is empty.
    process.env.SENTRY_AUTH_TOKEN = "env_token";

    const cap = captureStderr();
    try {
      maybeWarnEnvTokenIgnored();
      expect(cap.text()).toContain("stored login for stored OAuth user");
    } finally {
      cap.restore();
    }
  });
});
