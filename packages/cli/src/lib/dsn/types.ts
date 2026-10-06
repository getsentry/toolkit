/**
 * DSN Types
 *
 * All types related to DSN parsing, detection, and caching.
 */

import { array, number, object, optional, picklist, string } from "valibot";

/**
 * Source where DSN was detected from
 *
 * - env: SENTRY_DSN or framework-prefixed environment variable (e.g., NEXT_PUBLIC_SENTRY_DSN)
 * - env_file: .env file
 * - config: Language-specific config file (e.g., sentry.properties)
 * - code: Source code patterns (e.g., Sentry.init)
 * - inferred: Inferred from directory name matching project slugs
 */
export type DsnSource = "env" | "env_file" | "config" | "code" | "inferred";

/**
 * Parsed DSN components
 *
 * DSN Format: {PROTOCOL}://{PUBLIC_KEY}@{HOST}/{PROJECT_ID}
 * Example: https://abc123@o1169445.ingest.us.sentry.io/4505229541441536
 */
export type ParsedDsn = {
  protocol: string;
  publicKey: string;
  host: string;
  projectId: string;
  /** Extracted from oXXX.ingest... pattern in host (SaaS only) */
  orgId?: string;
};

/**
 * Detected DSN with source information
 */
export type DetectedDsn = ParsedDsn & {
  /** Original DSN string */
  raw: string;
  /** Where the DSN was found */
  source: DsnSource;
  /**
   * Context-dependent source identifier:
   * - For `"env"`: the env var name (e.g., `"NEXT_PUBLIC_SENTRY_DSN"`)
   * - For `"env_file"`, `"config"`, `"code"`: file path relative to cwd
   * - For `"inferred"`: undefined
   */
  sourcePath?: string;
  /** Package/app directory path for monorepo grouping (e.g., "packages/frontend", "apps/web") */
  packagePath?: string;
  /** Cached resolution info if available */
  resolved?: ResolvedProjectInfo;
};

/** Resolved project information from Sentry API */
export type ResolvedProjectInfo = {
  orgSlug: string;
  orgName: string;
  projectSlug: string;
  projectName: string;
};

/** Full resolved project with DSN and source info */
export type ResolvedProject = ResolvedProjectInfo & {
  dsn: DetectedDsn;
  /** Human-readable description of where DSN was found */
  sourceDescription: string;
};

/**
 * Cached DSN entry with full resolution info
 *
 * Stored in ~/.sentry/cli.db in the dsn_cache table
 */
export type CachedDsnEntry = {
  /** The raw DSN string */
  dsn: string;
  /** Project ID extracted from DSN */
  projectId: string;
  /** Org ID extracted from DSN (SaaS only) */
  orgId?: string;
  /** Where the DSN was found */
  source: DsnSource;
  /** Source identifier: env var name for `"env"`, relative file path for file-based sources */
  sourcePath?: string;
  /** Resolved project info (avoids API call on cache hit) */
  resolved?: ResolvedProjectInfo;
  /** All resolved targets (for inferred source with multiple matches) */
  allResolved?: ResolvedProjectInfo[];
  /** Timestamp when this entry was cached */
  cachedAt: number;
};

/** Valibot schema for ResolvedProjectInfo */
export const ResolvedProjectInfoSchema = object({
  orgSlug: string(),
  orgName: string(),
  projectSlug: string(),
  projectName: string(),
});

/** Valibot schema for cached DSN entries (for config validation) */
export const CachedDsnEntrySchema = object({
  dsn: string(),
  projectId: string(),
  orgId: optional(string()),
  source: picklist(["env", "env_file", "config", "code", "inferred"]),
  sourcePath: optional(string()),
  resolved: optional(ResolvedProjectInfoSchema),
  allResolved: optional(array(ResolvedProjectInfoSchema)),
  cachedAt: number(),
});

/**
 * Result of DSN detection with support for monorepos.
 *
 * In monorepos, multiple DSNs are valid (different packages/apps may have different Sentry projects).
 * The `primary` DSN is always the first one found, and `all` contains every detected DSN.
 */
export type DsnDetectionResult = {
  /** Primary DSN to use (first found, null only if none found) */
  primary: DetectedDsn | null;
  /** All detected DSNs across the codebase */
  all: DetectedDsn[];
  /** Whether multiple different DSNs were found (common in monorepos) */
  hasMultiple: boolean;
  /** Pre-computed fingerprint for alias validation (sorted org:project pairs) */
  fingerprint: string;
  /** Detected project language (for future use) */
  language?: string;
};

/**
 * Common monorepo root directories to scan for packages/apps with their own DSN.
 * Used by both env-file detection and package path inference.
 */
export const MONOREPO_ROOTS = [
  "packages",
  "apps",
  "libs",
  "services",
  "modules",
  "projects",
  "plugins",
  "sites",
  "workers",
  "functions",
] as const;
