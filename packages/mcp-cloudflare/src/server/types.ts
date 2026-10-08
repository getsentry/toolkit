import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type {
  RateLimit,
  WorkerVersionMetadata,
} from "@cloudflare/workers-types";

/**
 * Props passed through OAuth and available via ExecutionContext.props
 *
 * These props are set in the OAuth callback and become available
 * to the MCP handler through ExecutionContext.props (set by OAuth provider).
 */
export type WorkerProps = {
  // OAuth standard fields
  id: string;

  // Sentry-specific fields
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: number; // Cached validity deadline; extended on successful probe.
  sessionStartedAt?: number;
  upstreamExpiresAt?: number;
  upstreamTokenInvalid?: boolean;
  clientId: string;
  clientName?: string;
  scope: string;
  /**
   * @deprecated grantedScopes is deprecated and will be removed on Jan 1, 2026.
   * Use grantedSkills instead. Skills are the primary authorization method.
   * This field exists only for backward compatibility during the transition period.
   */
  grantedScopes?: string[];
  /** Primary authorization method - array of skill strings */
  grantedSkills?: string[];

  /**
   * When the OAuth `resource` parameter scoped the grant to `/mcp/:org` (or
   * `/mcp/:org/:project`), persist those path constraints on the token. The
   * regional API host is resolved later from cached verification or lazy lookup.
   */
  constraintOrganizationSlug?: string | null;
  /**
   * When the `resource` URL included a project segment (`/mcp/:org/:project`),
   * the MCP handler requires the request path to use that same org and project.
   */
  constraintProjectSlug?: string | null;

  // Note: full URL constraints are still extracted per-request from the MCP path
  // Note: sentryHost and mcpUrl come from env, not OAuth props
};

export interface Env {
  NODE_ENV: string;
  ASSETS: Fetcher;
  OAUTH_KV: KVNamespace;
  MCP_CACHE: KVNamespace;
  COOKIE_SECRET: string;
  SENTRY_CLIENT_ID: string;
  SENTRY_CLIENT_SECRET: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_DSN?: string;
  SENTRY_HOST?: string;
  /** @deprecated Prefer OPENROUTER_API_KEY for hosted MCP AI features. */
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_REASONING_EFFORT?: string;
  EMBEDDED_AGENT_PROVIDER?: string;
  MCP_URL?: string;
  OAUTH_PROVIDER: OAuthHelpers;
  AI: Ai;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  CHAT_RATE_LIMITER?: RateLimit;
  SEARCH_RATE_LIMITER?: RateLimit;
  MCP_IP_RATE_LIMITER?: RateLimit;
  MCP_USER_RATE_LIMITER?: RateLimit;
  // Backward-compatible fallback while deployments roll out dedicated MCP limiters.
  MCP_RATE_LIMITER?: RateLimit;
  AUTORAG_INDEX_NAME?: string;
}
