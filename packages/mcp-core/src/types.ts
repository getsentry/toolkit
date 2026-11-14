/**
 * Core type system for MCP tools.
 *
 * Defines TypeScript types derived from tool definitions, handler signatures,
 * and server context. Uses advanced TypeScript patterns for type-safe parameter
 * extraction and handler registration.
 */
import type { Skill } from "./skills";

/**
 * Project capabilities indicating what data types the project has
 */
export type ProjectCapabilities = {
  profiles?: boolean;
  replays?: boolean;
  logs?: boolean;
  traces?: boolean;
};

/**
 * Constraints that restrict the MCP session scope
 */
export type Constraints = {
  organizationSlug?: string | null;
  projectSlug?: string | null;
  regionUrl?: string | null;
  projectCapabilities?: ProjectCapabilities | null;
};

/**
 * Tool parameter keys that can be auto-injected from constraints.
 * These are filtered from tool schemas when constraints are active.
 */
export const CONSTRAINT_PARAMETER_KEYS = new Set<string>([
  "organizationSlug",
  "projectSlug",
  "projectSlugOrId", // Alias for projectSlug
  "regionUrl",
]);

export type TransportType = "stdio" | "http";
export type SentryProtocol = "http" | "https";

/**
 * One upstream Sentry credential a {@link CredentialRouter} hands out.
 */
export type RoutedCredential = {
  /** Stable, non-secret id of the account behind the credential. */
  id: string;
  accessToken: string;
  /**
   * Fetch a fresh token for this same account after an upstream 401. It must
   * never return another account's token. Omitted for credentials that
   * cannot be refreshed.
   */
  refresh?: () => Promise<string>;
};

/**
 * Picks the credential for each tool call, for hosts that hold several
 * logins on the same Sentry server (the CLI's stdio server). The hosted MCP
 * has one grant per session and does not set it.
 */
export type CredentialRouter = {
  /**
   * The credential for a tool call that targets `organizationSlug`, or the
   * default credential when the call targets no organization or the router
   * does not know it.
   */
  resolve(target: {
    organizationSlug: string | null;
  }): Promise<RoutedCredential>;
  /**
   * Every usable credential, the default first, for tools that span
   * organizations (`find_organizations`, `whoami`).
   */
  list(): Promise<RoutedCredential[]>;
};

export type ServerContext = {
  sentryHost?: string;
  sentryProtocol?: SentryProtocol;
  mcpUrl?: string;
  accessToken: string;
  /** DCR-registered client name (freeform, as provided during Dynamic Client Registration) */
  clientName?: string | null;
  /** Bucketed client family (e.g. "claude-code", "cursor") resolved from User-Agent */
  clientFamily?: string | null;
  /** Sanitized MCP request attribution source forwarded to Sentry API requests */
  utmSource?: string | null;
  openaiBaseUrl?: string;
  userId?: string | null;
  userIpAddress?: string | null;
  clientId?: string;
  /** Primary authorization method - granted skills for tool access control */
  grantedSkills?: Set<Skill> | ReadonlySet<Skill>;
  // URL-based session constraints
  constraints: Constraints;
  /** Whether experimental tools are enabled */
  experimentalMode?: boolean;
  /** Tool names available after mode, skill, constraint, and capability filters */
  availableToolNames?: ReadonlySet<string>;
  /** Tool names registered directly in the current MCP tools/list surface */
  directToolNames?: ReadonlySet<string>;
  /** Transport type - affects error message formatting */
  transport?: TransportType;
  /**
   * Invoked when a tool call surfaces an upstream 401. Transports wire this
   * to revoke the MCP grant so the session doesn't keep getting wrapper
   * tokens backed by an upstream token Sentry has already rejected. Hosts
   * that can refresh their credential return the new token, which later tool
   * calls use. Callback errors are swallowed.
   */
  onUpstreamUnauthorized?: () => void | string | Promise<void | string>;
  /**
   * Routes each tool call to the credential that can reach its organization.
   * When set, a call runs with the routed credential's `accessToken`, and an
   * upstream 401 refreshes only that credential. `accessToken` stays the
   * default credential's token.
   */
  credentialRouter?: CredentialRouter;
};
