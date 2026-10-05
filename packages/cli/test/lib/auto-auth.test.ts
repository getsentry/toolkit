/**
 * Unit tests for the auto-authentication recovery flow (`recoverWithAutoLogin`
 * and `shouldAutoAuth`), extracted from the CLI middleware so the host-trust
 * gate and login/retry behavior are testable without driving the whole CLI.
 *
 * The host-trust gate is the security-relevant part: auto-login must refuse an
 * unconfirmed self-hosted host (getsentry/cli#1121), exactly like `auth login`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assertAutoLoginHostTrusted,
  recoverWithAutoLogin,
  shouldAutoAuth,
} from "../../src/lib/auto-auth.js";
import { setDefaultUrl } from "../../src/lib/db/defaults.js";
import { AuthError, HostScopeError } from "../../src/lib/errors.js";
import { registerLoginTrustAnchor } from "../../src/lib/token-host.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

const noop = () => {
  // status-line sink for tests that don't assert on output
};

const ENV_KEYS = ["SENTRY_HOST", "SENTRY_URL"] as const;
const alwaysInteractive = () => true;

describe("shouldAutoAuth", () => {
  test("true for not_authenticated in an interactive TTY", () => {
    expect(shouldAutoAuth(new AuthError("not_authenticated"), () => true)).toBe(
      true
    );
  });

  test("true for expired in an interactive TTY", () => {
    expect(shouldAutoAuth(new AuthError("expired"), () => true)).toBe(true);
  });

  test("false when not interactive", () => {
    expect(shouldAutoAuth(new AuthError("expired"), () => false)).toBe(false);
  });

  test("false for non-recoverable auth reasons (invalid)", () => {
    expect(shouldAutoAuth(new AuthError("invalid"), () => true)).toBe(false);
  });

  test("false when the error opts out via skipAutoAuth", () => {
    const err = new AuthError("not_authenticated", undefined, {
      skipAutoAuth: true,
    });
    expect(shouldAutoAuth(err, () => true)).toBe(false);
  });

  test("false for non-AuthError values", () => {
    expect(shouldAutoAuth(new Error("boom"), () => true)).toBe(false);
    expect(shouldAutoAuth("nope", () => true)).toBe(false);
  });
});

describe("assertAutoLoginHostTrusted", () => {
  useTestConfigDir("auto-auth-assert-");
  useEnvSandbox(ENV_KEYS);

  beforeEach(async () => {
    await resetHostScopingState();
  });

  afterEach(async () => {
    await resetHostScopingState();
  });

  test("passes for SaaS (no env host)", () => {
    expect(() => assertAutoLoginHostTrusted()).not.toThrow();
  });

  test("throws for an unconfirmed self-hosted host", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    expect(() => assertAutoLoginHostTrusted()).toThrow(HostScopeError);
  });

  test("passes for a self-hosted host confirmed via default URL", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    setDefaultUrl("https://sentry.example.com");
    expect(() => assertAutoLoginHostTrusted()).not.toThrow();
  });

  test("passes for a self-hosted host with a process trust anchor", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    registerLoginTrustAnchor("https://sentry.example.com");
    expect(() => assertAutoLoginHostTrusted()).not.toThrow();
  });
});

describe("recoverWithAutoLogin", () => {
  useTestConfigDir("auto-auth-");
  useEnvSandbox(ENV_KEYS);

  beforeEach(async () => {
    await resetHostScopingState();
  });

  afterEach(async () => {
    await resetHostScopingState();
  });

  test("re-throws a non-auth error without attempting login", async () => {
    const runInteractiveLogin = vi.fn();
    const retry = vi.fn();
    const boom = new Error("boom");

    await expect(
      recoverWithAutoLogin(boom, retry, {
        runInteractiveLogin,
        isInteractive: alwaysInteractive,
      })
    ).rejects.toBe(boom);
    expect(runInteractiveLogin).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  test("re-throws when not in an interactive TTY (default probe)", async () => {
    // No isInteractive injected → falls back to isatty(0), which is false in
    // the test runner, so the error is re-thrown untouched.
    const runInteractiveLogin = vi.fn();
    const err = new AuthError("not_authenticated");

    await expect(
      recoverWithAutoLogin(err, vi.fn(), { runInteractiveLogin })
    ).rejects.toBe(err);
    expect(runInteractiveLogin).not.toHaveBeenCalled();
  });

  test("refuses an unconfirmed self-hosted host (the #1121 gate)", async () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    const runInteractiveLogin = vi.fn();
    const writes: string[] = [];

    await expect(
      recoverWithAutoLogin(new AuthError("not_authenticated"), vi.fn(), {
        runInteractiveLogin,
        isInteractive: alwaysInteractive,
        write: (m) => writes.push(m),
      })
    ).rejects.toBeInstanceOf(HostScopeError);

    // No login attempt, no browser, no status output.
    expect(runInteractiveLogin).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test("SaaS host: logs in, retries, returns undefined", async () => {
    const runInteractiveLogin = vi.fn().mockResolvedValue({ ok: true });
    const retry = vi.fn().mockResolvedValue(undefined);
    const writes: string[] = [];

    const exitCode = await recoverWithAutoLogin(
      new AuthError("not_authenticated"),
      retry,
      {
        runInteractiveLogin,
        isInteractive: alwaysInteractive,
        write: (m) => writes.push(m),
      }
    );

    expect(exitCode).toBeUndefined();
    expect(runInteractiveLogin).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(writes[0]).toContain("Authentication required");
    expect(writes.join("")).toContain("Retrying command");
  });

  test("expired reason uses the 'expired' status message", async () => {
    const writes: string[] = [];

    await recoverWithAutoLogin(new AuthError("expired"), vi.fn(), {
      runInteractiveLogin: vi.fn().mockResolvedValue(true),
      isInteractive: alwaysInteractive,
      write: (m) => writes.push(m),
    });

    expect(writes[0]).toContain("Authentication expired");
  });

  test("returns exit code 1 and skips retry when login fails", async () => {
    const retry = vi.fn();
    const writes: string[] = [];

    const exitCode = await recoverWithAutoLogin(
      new AuthError("expired"),
      retry,
      {
        runInteractiveLogin: vi.fn().mockResolvedValue(null),
        isInteractive: alwaysInteractive,
        write: (m) => writes.push(m),
      }
    );

    expect(exitCode).toBe(1);
    expect(retry).not.toHaveBeenCalled();
    expect(writes.join("")).not.toContain("Retrying command");
  });

  test("self-hosted host confirmed via persisted default URL proceeds", async () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    setDefaultUrl("https://sentry.example.com");
    const runInteractiveLogin = vi.fn().mockResolvedValue(true);
    const retry = vi.fn().mockResolvedValue(undefined);

    const exitCode = await recoverWithAutoLogin(
      new AuthError("expired"),
      retry,
      {
        runInteractiveLogin,
        isInteractive: alwaysInteractive,
        write: noop,
      }
    );

    expect(exitCode).toBeUndefined();
    expect(runInteractiveLogin).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("default write target is process.stderr", async () => {
    // Don't inject `write` → exercises the process.stderr fallback branch.
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await recoverWithAutoLogin(new AuthError("not_authenticated"), vi.fn(), {
        runInteractiveLogin: vi.fn().mockResolvedValue(true),
        isInteractive: alwaysInteractive,
      });
      const written = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain("Authentication required");
      expect(written).toContain("Retrying command");
    } finally {
      spy.mockRestore();
    }
  });
});
