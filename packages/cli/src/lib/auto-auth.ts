/**
 * Auto-authentication recovery for the CLI error-recovery middleware chain.
 *
 * Extracted from `cli.ts` so the host-trust gate and the login/retry flow are
 * unit-testable without driving the whole CLI. The `autoAuthMiddleware` in
 * `cli.ts` is a thin wrapper that injects `runInteractiveLogin` and applies
 * the returned exit code.
 */

import { isatty } from "node:tty";
import { AuthError, HostScopeError } from "./errors.js";
import {
  buildHostRefusalMessage,
  isAutoLoginHostTrusted,
  resolveEffectiveLoginHost,
} from "./login-host-guard.js";

/** Injected collaborators (defaulted to the real process/TTY in production). */
export type AutoAuthDeps = {
  /** Run the interactive OAuth device flow; resolves truthy on success. */
  runInteractiveLogin: () => Promise<unknown>;
  /** Emit a status line. Defaults to writing to `process.stderr`. */
  write?: (message: string) => void;
  /** Whether stdin is an interactive TTY. Defaults to `isatty(0)`. */
  isInteractive?: () => boolean;
};

/**
 * Whether a caught error should trigger interactive auto-login: a
 * `not_authenticated`/`expired` {@link AuthError} that hasn't opted out
 * (`skipAutoAuth`), in an interactive TTY. `process.stdin.isTTY` can be
 * undefined in Bun, so callers pass an explicit `isInteractive` probe.
 */
export function shouldAutoAuth(
  err: unknown,
  isInteractive: () => boolean
): err is InstanceType<typeof AuthError> {
  return (
    err instanceof AuthError &&
    (err.reason === "not_authenticated" || err.reason === "expired") &&
    !err.skipAutoAuth &&
    isInteractive()
  );
}

/**
 * Throw a {@link HostScopeError} if an OAuth device flow would target an
 * unconfirmed self-hosted host — the same gate `auth login` enforces (see
 * {@link isAutoLoginHostTrusted}). Shared by both interactive re-auth paths
 * (first-time/expired auto-login and 403 scope recovery) so neither can be
 * steered to an attacker host by a `.sentryclirc`-injected `env.SENTRY_URL`.
 */
export function assertAutoLoginHostTrusted(): void {
  const effectiveHost = resolveEffectiveLoginHost();
  if (!isAutoLoginHostTrusted(effectiveHost)) {
    throw new HostScopeError(buildHostRefusalMessage(effectiveHost));
  }
}

/**
 * Recover from an auth error by running the login flow and retrying.
 *
 * - Re-throws non-recoverable errors unchanged.
 * - Throws {@link HostScopeError} when auto-login would target an unconfirmed
 *   self-hosted host — the same gate `auth login` enforces (see
 *   {@link isAutoLoginHostTrusted}). This stops a `.sentryclirc`-injected host
 *   from steering the OAuth device flow to an attacker's login page.
 * - On a successful login, runs `retry()` and resolves to `undefined`.
 * - On a failed/cancelled login, resolves to exit code `1`.
 *
 * @returns the process exit code to apply, or `undefined` to leave it as-is.
 */
export async function recoverWithAutoLogin(
  err: unknown,
  retry: () => Promise<void>,
  deps: AutoAuthDeps
): Promise<number | undefined> {
  const isInteractive = deps.isInteractive ?? (() => isatty(0));
  if (!shouldAutoAuth(err, isInteractive)) {
    throw err;
  }

  // Never start an OAuth device flow against an unconfirmed self-hosted host.
  assertAutoLoginHostTrusted();

  const write =
    deps.write ??
    ((message: string) => {
      process.stderr.write(message);
    });
  write(
    err.reason === "expired"
      ? "Authentication expired. Starting login flow...\n\n"
      : "Authentication required. Starting login flow...\n\n"
  );

  const loginSuccess = await deps.runInteractiveLogin();
  if (loginSuccess) {
    write("\nRetrying command...\n\n");
    await retry();
    return;
  }

  // Login failed or was cancelled.
  return 1;
}
