/**
 * sentry auth status
 *
 * Display authentication status and verify credentials.
 */

import type { SentryContext } from "../../context.js";
import { listOrganizationsUncached } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  type AuthConfig,
  type AuthSource,
  ENV_SOURCE_PREFIX,
  getActiveEnvVarName,
  getAuthConfig,
  getAuthToken,
  getRawEnvToken,
  isAuthenticated,
} from "../../lib/db/auth.js";
import {
  getDefaultOrganization,
  getDefaultProject,
} from "../../lib/db/defaults.js";
import { getDbPath } from "../../lib/db/index.js";
import { getUserInfo } from "../../lib/db/user.js";
import { AuthError, stringifyUnknown } from "../../lib/errors.js";
import { formatAuthStatus, maskToken } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { classifySentryToken } from "../../lib/token-type.js";

type StatusFlags = {
  readonly "show-token": boolean;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/** Check if the auth source is an environment variable */
function isEnvSource(source: AuthSource): boolean {
  return source.startsWith(ENV_SOURCE_PREFIX);
}

/**
 * Structured data representing the full auth status.
 * Serves as both the JSON output shape and input to the human formatter.
 */
export type AuthStatusData = {
  /** Whether the user is currently authenticated */
  authenticated: boolean;
  /** Auth source: "oauth" or "env:SENTRY_AUTH_TOKEN" etc. */
  source: string;
  /** Path to the SQLite config database (only for non-env tokens) */
  configPath?: string;
  /** User identity from cached user info */
  user?: { name?: string; email?: string; username?: string };
  /** Token display and metadata */
  token?: {
    /** Masked or full token string depending on --show-token */
    display: string;
    /** Expiration timestamp (ms since epoch), if available */
    expiresAt?: number;
    /** Whether auto-refresh via refresh token is enabled */
    refreshEnabled: boolean;
  };
  /** Default org/project settings */
  defaults?: {
    organization?: string;
    project?: string;
  };
  /** Credential verification results */
  verification?: {
    /** Whether the API call succeeded */
    success: boolean;
    /** Organizations accessible with the current token */
    organizations?: Array<{ name: string; slug: string }>;
    /** Error message if verification failed */
    error?: string;
  };
  /** Environment variable token info (present when SENTRY_AUTH_TOKEN or SENTRY_TOKEN is set) */
  envToken?: {
    /** Name of the env var (e.g., "SENTRY_AUTH_TOKEN") */
    envVar: string;
    /** Whether the env token is the effective auth source (vs bypassed for OAuth) */
    active: boolean;
  };
};

/**
 * Collect token information into the data structure.
 */
function collectTokenInfo(
  auth: AuthConfig | undefined,
  showToken: boolean
): AuthStatusData["token"] | undefined {
  if (!auth?.token) {
    return;
  }

  const display = showToken ? auth.token : maskToken(auth.token);
  const fromEnv = isEnvSource(auth.source);

  return {
    display,
    // Env var tokens have no expiry or refresh
    expiresAt: fromEnv ? undefined : auth.expiresAt,
    refreshEnabled: fromEnv ? false : Boolean(auth.refreshToken),
  };
}

/**
 * Collect default org/project into the data structure.
 */
function collectDefaults(): AuthStatusData["defaults"] {
  const org = getDefaultOrganization();
  const project = getDefaultProject();

  if (!(org || project)) {
    return;
  }

  return {
    organization: org ?? undefined,
    project: project ?? undefined,
  };
}

/**
 * Verify credentials by fetching organizations.
 * Captures success/failure into data rather than throwing.
 */
async function verifyCredentials(): Promise<AuthStatusData["verification"]> {
  try {
    const orgs = await listOrganizationsUncached();
    return {
      success: true,
      organizations: orgs.map((o) => ({ name: o.name, slug: o.slug })),
    };
  } catch (err) {
    return {
      success: false,
      error: stringifyUnknown(err),
    };
  }
}

export const statusCommand = buildCommand({
  auth: false,
  docs: {
    brief: "View authentication status",
    fullDescription:
      "Display information about your current authentication status, " +
      "including whether you're logged in and your default organization/project settings.",
  },
  output: { human: formatAuthStatus },
  parameters: {
    flags: {
      "show-token": {
        kind: "boolean",
        brief: "Show the stored token (masked by default)",
        default: false,
      },
      fresh: FRESH_FLAG,
    },
    aliases: FRESH_ALIASES,
  },
  async *func(this: SentryContext, flags: StatusFlags) {
    applyFreshFlag(flags);

    const auth = getAuthConfig();
    const authenticated = isAuthenticated();
    const fromEnv = auth ? isEnvSource(auth.source) : false;

    if (!authenticated) {
      // Skip auto-login - user explicitly ran status to check auth state
      throw new AuthError("not_authenticated", undefined, {
        skipAutoAuth: true,
      });
    }

    // Env var tokens may belong to a different user/instance than the cached
    // user_info (populated by a prior login or whoami). Skip the cache for env
    // sources to avoid displaying stale identity.
    let user: AuthStatusData["user"];
    if (!fromEnv) {
      const userInfo = getUserInfo();
      user = userInfo
        ? {
            name: userInfo.name,
            email: userInfo.email,
            username: userInfo.username,
          }
        : undefined;
    }

    // Check for env token regardless of whether it's the active source
    // (it may be set but bypassed because stored OAuth takes priority)
    const rawEnv = getRawEnvToken();
    const envTokenData: AuthStatusData["envToken"] = rawEnv
      ? { envVar: getActiveEnvVarName(), active: fromEnv }
      : undefined;

    const data: AuthStatusData = {
      authenticated: true,
      source: auth?.source ?? "oauth",
      configPath: fromEnv ? undefined : getDbPath(),
      user,
      token: collectTokenInfo(auth, flags["show-token"]),
      defaults: collectDefaults(),
      verification: await verifyCredentials(),
      envToken: envTokenData,
    };

    yield new CommandOutput(data);

    if (fromEnv) {
      const effectiveToken = getAuthToken();
      const isOrgToken =
        effectiveToken &&
        classifySentryToken(effectiveToken) === "org-auth-token";
      return {
        hint: isOrgToken
          ? "Run `sentry auth whoami` to see which organization this token belongs to"
          : "Run `sentry auth whoami` to see which user this token belongs to",
      };
    }
  },
});
