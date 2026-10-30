import { isatty } from "node:tty";
import { getCurrentAuthScopes } from "./api/auth.js";
import { SENTRY_SCOPES } from "./api-scope.js";
import { assertAutoLoginHostTrusted } from "./auto-auth.js";
import {
  type AuthSource,
  getAuthConfig,
  getReauthorizationAccountId,
} from "./db/auth.js";
import { ApiError, AuthError } from "./errors.js";
import type {
  InteractiveLoginOptions,
  LoginResult,
} from "./interactive-login.js";
import { interactivePromptsAllowed } from "./interactive-prompts.js";
import { logger } from "./logger.js";
import { OAUTH_SCOPES } from "./oauth.js";

type InteractiveLogin = (
  options?: InteractiveLoginOptions,
) => Promise<LoginResult | null>;

type OAuthScopeState =
  | { kind: "current" }
  | { kind: "invalid" }
  | { kind: "missing"; scopes: string[] };

export type ScopeRecoveryRuntime = {
  assertTrustedHost: () => void;
  getAuthScopes: () => Promise<readonly string[] | null>;
  getAuthSource: () => AuthSource | undefined;
  inputIsTty: () => boolean;
  promptsAllowed: () => boolean;
  write: (message: string) => void;
  /**
   * The stored account to re-authorize when it isn't the active one (the
   * account the invocation picked for its target org). Optional so test
   * runtimes default to re-authorizing the active account.
   */
  getReauthorizationAccountId?: () => string | undefined;
};

const defaultRuntime: ScopeRecoveryRuntime = {
  assertTrustedHost: assertAutoLoginHostTrusted,
  getAuthScopes: getCurrentAuthScopes,
  getAuthSource: () => getAuthConfig()?.source,
  inputIsTty: () => isatty(0),
  promptsAllowed: interactivePromptsAllowed,
  write: (message) => process.stderr.write(message),
  getReauthorizationAccountId,
};

/**
 * Run the login that re-authorizes the account in effect. When that is an
 * account the invocation picked for its target org, the new grant must
 * replace that account's credentials: a plain login replaces the active
 * account, so the retried command would pick the unchanged account again.
 */
function reauthorize(
  runInteractiveLogin: InteractiveLogin,
  runtime: ScopeRecoveryRuntime,
  scope?: string,
): Promise<LoginResult | null> {
  const accountId = runtime.getReauthorizationAccountId?.();
  const options: InteractiveLoginOptions = {
    ...(accountId && { accountId }),
    ...(scope && { scope }),
  };
  return Object.keys(options).length > 0
    ? runInteractiveLogin(options)
    : runInteractiveLogin();
}

const DEFAULT_SCOPE_SET = new Set(OAUTH_SCOPES);
const KNOWN_SCOPE_SET = new Set<string>(SENTRY_SCOPES);

/**
 * Scope string for an elevation that needs scopes outside the CLI's defaults.
 *
 * Opt-in scopes such as `org:tokens` stay out of {@link OAUTH_SCOPES} because
 * Sentry rejects the whole device-flow request when it doesn't know one of the
 * requested scopes, which would break `sentry auth login` on older self-hosted
 * servers. Keeping the opt-in scopes the grant already holds means elevating
 * for one action doesn't take away what an earlier elevation added.
 *
 * @returns `undefined` when `required` only names default scopes, so the
 *   device flow requests the defaults as usual
 */
function elevationScopeString(
  granted: ReadonlySet<string>,
  required: readonly string[],
): string | undefined {
  if (required.every((scope) => DEFAULT_SCOPE_SET.has(scope))) {
    return;
  }
  const scopes = new Set<string>(OAUTH_SCOPES);
  for (const scope of granted) {
    if (KNOWN_SCOPE_SET.has(scope)) {
      scopes.add(scope);
    }
  }
  for (const scope of required) {
    scopes.add(scope);
  }
  return [...scopes].join(" ");
}

async function inspectOAuthScopes(
  runtime: ScopeRecoveryRuntime,
  startedWithOAuth = false,
): Promise<OAuthScopeState | undefined> {
  try {
    const source = runtime.getAuthSource();
    if (source !== "oauth") {
      if (startedWithOAuth) {
        return { kind: "invalid" };
      }
      return;
    }
    const granted = await runtime.getAuthScopes();
    if (!granted) {
      return { kind: "invalid" };
    }
    const grantedSet = new Set(granted);
    const missing = OAUTH_SCOPES.filter((scope) => !grantedSet.has(scope));
    return missing.length > 0
      ? { kind: "missing", scopes: missing }
      : { kind: "current" };
  } catch (error) {
    if (
      (error instanceof ApiError && error.status === 401) ||
      (error instanceof AuthError &&
        (error.reason === "expired" || error.reason === "not_authenticated"))
    ) {
      return { kind: "invalid" };
    }
    return;
  }
}

/** Whether the active stored OAuth token is invalid or lacks a current CLI scope. */
async function currentOAuthGrantNeedsRefresh(
  runtime: ScopeRecoveryRuntime,
  startedWithOAuth: boolean,
): Promise<boolean> {
  const state = await inspectOAuthScopes(runtime, startedWithOAuth);
  return Boolean(state && state.kind !== "current");
}

function hasActiveOAuthGrant(
  runtime: ScopeRecoveryRuntime = defaultRuntime,
): boolean {
  try {
    return runtime.getAuthSource() === "oauth";
  } catch (error) {
    logger.debug("Failed to read auth source for OAuth grant check", error);
    return false;
  }
}

export type OAuthScopeRecoveryGate = {
  readonly shouldDelegate: (
    error: unknown,
    options: { unattended: boolean },
  ) => Promise<boolean>;
};

/** Preserve command-specific fallbacks unless central OAuth recovery can own the error. */
export function captureOAuthScopeRecoveryGate(
  runtime: ScopeRecoveryRuntime = defaultRuntime,
): OAuthScopeRecoveryGate {
  const startedWithOAuth = hasActiveOAuthGrant(runtime);
  return {
    shouldDelegate: async (error, options) => {
      if (
        !(error instanceof ApiError) ||
        (error.status !== 401 && error.status !== 403) ||
        options.unattended ||
        !runtime.inputIsTty() ||
        !runtime.promptsAllowed()
      ) {
        return false;
      }
      return await currentOAuthGrantNeedsRefresh(runtime, startedWithOAuth);
    },
  };
}

async function refreshOAuthScopes(
  state: Exclude<OAuthScopeState, { kind: "current" }>,
  runInteractiveLogin: InteractiveLogin,
  runtime: ScopeRecoveryRuntime,
): Promise<boolean> {
  if (!(runtime.inputIsTty() && runtime.promptsAllowed())) {
    return false;
  }

  runtime.assertTrustedHost();
  if (state.kind === "missing") {
    runtime.write(
      `Your CLI authorization is missing ${state.scopes.join(", ")}. Starting authorization...\n\n`,
    );
  } else {
    runtime.write(
      "Your CLI authorization is no longer valid. Starting authorization...\n\n",
    );
  }
  return Boolean(await reauthorize(runInteractiveLogin, runtime));
}

/** Refresh a stored OAuth grant when it lacks any scope requested by this CLI. */
export async function ensureCurrentOAuthScopes(
  runInteractiveLogin: InteractiveLogin,
  runtime: ScopeRecoveryRuntime = defaultRuntime,
): Promise<boolean> {
  const state = await inspectOAuthScopes(runtime);
  if (!state || state.kind === "current") {
    return false;
  }
  return await refreshOAuthScopes(state, runInteractiveLogin, runtime);
}

/**
 * Outcome of {@link ensureScopesForAction}.
 *
 * - `ready`: the token already has the scopes, or it isn't a stored OAuth
 *   grant the CLI can elevate (env/auth tokens), or the check itself failed.
 *   Callers proceed and let the API decide.
 * - `elevated`: the user re-authorized and the new grant is stored.
 * - `unavailable`: elevation is needed but prompts aren't possible here: no
 *   TTY, or the run is unattended (`--yes`/`--json`), which must never block
 *   on the device flow.
 * - `declined`: the authorization flow failed or was cancelled.
 */
export type ScopeElevationResult =
  | "ready"
  | "elevated"
  | "unavailable"
  | "declined";

/**
 * Make sure the stored OAuth grant has `required` before running an action.
 *
 * Commands that need a default scope older logins may lack call this before
 * any confirmation prompt, so the user authorizes once instead of hitting a
 * 403 and re-running the command (and its prompts) through
 * {@link runWithScopeRecovery}. When `required` only names default scopes,
 * the device flow requests the defaults. Otherwise it requests the defaults,
 * the opt-in scopes the grant already has, and `required`.
 *
 * @param required - Scopes the action needs
 * @param action - Human description for the prompt, e.g. "Removing an integration"
 */
export async function ensureScopesForAction(
  required: readonly string[],
  action: string,
  runInteractiveLogin: InteractiveLogin,
  runtime: ScopeRecoveryRuntime = defaultRuntime,
): Promise<ScopeElevationResult> {
  let missing: string[];
  let granted: Set<string>;
  try {
    if (runtime.getAuthSource() !== "oauth") {
      return "ready";
    }
    granted = new Set((await runtime.getAuthScopes()) ?? []);
    missing = required.filter((scope) => !granted.has(scope));
  } catch (error) {
    logger.debug("Could not inspect OAuth scopes before action", error);
    return "ready";
  }
  if (missing.length === 0) {
    return "ready";
  }
  if (!(runtime.inputIsTty() && runtime.promptsAllowed())) {
    return "unavailable";
  }

  runtime.assertTrustedHost();
  runtime.write(
    `${action} needs elevated permissions (${missing.join(", ")}). Starting authorization...\n\n`,
  );
  const scope = elevationScopeString(granted, required);
  return (await reauthorize(runInteractiveLogin, runtime, scope))
    ? "elevated"
    : "declined";
}

/** Check an OAuth token after a 401/403, re-authorize if needed, and retry once. */
export async function runWithScopeRecovery(
  proceed: (commandArgs: string[]) => Promise<void>,
  argv: string[],
  runInteractiveLogin: InteractiveLogin,
  runtime: ScopeRecoveryRuntime = defaultRuntime,
): Promise<void> {
  const startedWithOAuth = hasActiveOAuthGrant(runtime);
  try {
    await proceed(argv);
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      (error.status !== 401 && error.status !== 403)
    ) {
      throw error;
    }

    const state = await inspectOAuthScopes(runtime, startedWithOAuth);
    if (
      !state ||
      state.kind === "current" ||
      !(await refreshOAuthScopes(state, runInteractiveLogin, runtime))
    ) {
      throw error;
    }

    runtime.write("\nRetrying command...\n\n");
    await proceed(argv);
  }
}
