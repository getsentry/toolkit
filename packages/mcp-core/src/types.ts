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
   * tokens backed by an upstream token Sentry has already rejected. Callback
   * errors are swallowed.
   */
  onUpstreamUnauthorized?: () => void | Promise<void>;
};
