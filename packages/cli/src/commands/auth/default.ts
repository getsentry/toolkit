/**
 * Bare `sentry auth` dispatcher.
 *
 * Routes to login when logged out (or when login-only flags are present),
 * and to status when already authenticated.
 *
 * Dispatches into the *unwrapped* login/status generators so the command
 * pipeline (auth guard, rc-URL trust check, telemetry, output rendering)
 * runs exactly once under this command's settings.
 */

import type { Command } from "@stricli/core";
import type { SentryContext } from "../../context.js";
import { buildCommand, numberParser } from "../../lib/command.js";
import { isAuthenticated } from "../../lib/db/auth.js";
import { formatAuthStatus } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import type { LoginResult } from "../../lib/interactive-login.js";
import { FRESH_ALIASES, FRESH_FLAG } from "../../lib/list-command.js";
import { formatLoginResult, loginCommand, parseLoginUrl } from "./login.js";
import { type AuthStatusData, statusCommand } from "./status.js";

type AuthDefaultFlags = {
  readonly token?: string;
  readonly timeout: number;
  readonly force: boolean;
  readonly url?: string;
  readonly "read-only": boolean;
  readonly scope?: readonly string[];
  readonly "show-token": boolean;
  readonly fresh: boolean;
};

/** Login-only flags that force the bare command into the login path. */
const LOGIN_ONLY_FLAGS = [
  "token",
  "force",
  "url",
  "read-only",
  "scope",
] as const;

/**
 * Choose login vs status for bare `sentry auth`.
 *
 * - Login-only flags always select login (even when already authenticated).
 * - Otherwise: logged out → login, logged in → status.
 */
export function resolveAuthDefaultTarget(
  flags: Readonly<Partial<AuthDefaultFlags>>,
  authenticated = isAuthenticated()
): "login" | "status" {
  for (const name of LOGIN_ONLY_FLAGS) {
    const value = flags[name];
    if (value === undefined || value === false) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    return "login";
  }
  return authenticated ? "status" : "login";
}

type RawCommandFunc = (
  this: SentryContext,
  flags: Record<string, unknown>,
  ...args: unknown[]
) => AsyncGenerator<unknown, unknown, undefined>;

/** Read the unwrapped generator attached by {@link buildCommand}. */
function getRawFunc(command: Command<SentryContext>): RawCommandFunc {
  const raw = (command as unknown as { __rawFunc?: RawCommandFunc }).__rawFunc;
  if (!raw) {
    throw new Error(
      "Command is missing __rawFunc; expected buildCommand output"
    );
  }
  return raw;
}

function isLoginResult(data: unknown): data is LoginResult {
  return (
    !!data &&
    typeof data === "object" &&
    "method" in data &&
    "configPath" in data
  );
}

function formatAuthDefaultOutput(data: LoginResult | AuthStatusData): string {
  if (isLoginResult(data)) {
    return formatLoginResult(data);
  }
  return formatAuthStatus(data);
}

/**
 * Hidden default for bare `sentry auth`.
 *
 * Accepts the union of login and status flags so either path works without
 * an explicit subcommand. Renders through this command's single pipeline.
 */
export const authDefaultCommand = buildCommand({
  auth: false,
  // Login must run even with a poisoned .sentryclirc URL. Status is also
  // reached through this path when already authenticated — matching the
  // onboarding intent of bare `sentry auth` rather than re-applying the
  // stricter explicit-status rc gate via a nested wrapper.
  skipRcUrlCheck: true,
  docs: {
    brief: "Authenticate with Sentry or show auth status",
    fullDescription:
      "When not authenticated, starts the login flow. When already authenticated, shows auth status. " +
      "Equivalent to `sentry auth login` or `sentry auth status` depending on current credentials. " +
      "Login-only flags (e.g. --token, --url) force the login path.",
  },
  parameters: {
    flags: {
      token: {
        kind: "parsed",
        parse: String,
        brief: "Authenticate using an API token instead of OAuth",
        optional: true,
      },
      timeout: {
        kind: "parsed",
        parse: numberParser,
        brief: "Timeout for OAuth flow in seconds (default: 900)",
        default: "900",
      },
      force: {
        kind: "boolean",
        brief: "Re-authenticate without prompting",
        default: false,
      },
      url: {
        kind: "parsed",
        parse: parseLoginUrl,
        brief:
          "Sentry instance URL to authenticate against (e.g. https://sentry.example.com). " +
          "Required for self-hosted; defaults to SaaS (https://sentry.io).",
        optional: true,
      },
      "read-only": {
        kind: "boolean",
        brief:
          "Request only read-only OAuth scopes (project:read, org:read, event:read, member:read, team:read). " +
          "Useful for handing tokens to AI agents or CI jobs that should not be able to mutate Sentry state.",
        default: false,
      },
      scope: {
        kind: "parsed",
        parse: String,
        brief:
          "Request specific OAuth scopes (repeatable, comma-separated). " +
          "E.g. --scope project:read --scope org:read. Overrides the default scope set.",
        variadic: true,
        optional: true,
      },
      "show-token": {
        kind: "boolean",
        brief: "Show the stored token (masked by default)",
        default: false,
      },
      fresh: FRESH_FLAG,
    },
    aliases: { s: "scope", ...FRESH_ALIASES },
  },
  output: { human: formatAuthDefaultOutput },
  async *func(this: SentryContext, flags: AuthDefaultFlags) {
    const target = resolveAuthDefaultTarget(flags);
    const command = target === "login" ? loginCommand : statusCommand;
    const raw = getRawFunc(command as Command<SentryContext>);
    const generator = raw.call(
      this,
      flags as unknown as Record<string, unknown>
    );

    // Re-yield CommandOutput values so this command's wrapper renders once.
    let step = await generator.next();
    while (!step.done) {
      if (step.value instanceof CommandOutput) {
        yield step.value;
      }
      step = await generator.next();
    }
    return step.value as { hint?: string } | undefined;
  },
});
