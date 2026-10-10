/**
 * Configuration Types
 *
 * Types and Valibot schemas for the Sentry CLI configuration file.
 */

import {
  type InferOutput,
  number,
  object,
  optional,
  record,
  string,
} from "valibot";
import { CachedDsnEntrySchema } from "../lib/dsn/types.js";

/**
 * Schema for cached project information
 */
export const CachedProjectSchema = object({
  orgSlug: string(),
  orgName: string(),
  projectSlug: string(),
  projectName: string(),
  projectId: optional(string()),
  cachedAt: number(),
});

export type CachedProject = InferOutput<typeof CachedProjectSchema>;

/**
 * Schema for project alias entry (used for short issue ID resolution)
 */
export const ProjectAliasEntrySchema = object({
  orgSlug: string(),
  projectSlug: string(),
});

export type ProjectAliasEntry = InferOutput<typeof ProjectAliasEntrySchema>;

/**
 * Schema for cached project aliases (A, B, C... -> org/project mapping).
 * Scoped by DSN fingerprint to prevent cross-project conflicts in monorepos.
 */
export const ProjectAliasesSchema = object({
  /** Map of alias letter to project info */
  aliases: record(string(), ProjectAliasEntrySchema),
  /** Timestamp when aliases were set */
  cachedAt: number(),
  /**
   * Fingerprint of detected DSNs for validation.
   * Format: sorted comma-separated list of "orgId:projectId" pairs.
   * Aliases only valid when current DSN detection matches this fingerprint.
   */
  dsnFingerprint: optional(string()),
});

export type ProjectAliases = InferOutput<typeof ProjectAliasesSchema>;

/**
 * Schema for authentication configuration
 */
export const AuthConfigSchema = object({
  token: optional(string()),
  refreshToken: optional(string()),
  expiresAt: optional(number()),
  issuedAt: optional(number()),
});

/**
 * Schema for default organization/project settings
 */
export const DefaultsConfigSchema = object({
  organization: optional(string()),
  project: optional(string()),
});

/**
 * Schema for the full Sentry CLI configuration file
 */
export const SentryConfigSchema = object({
  auth: optional(AuthConfigSchema),
  defaults: optional(DefaultsConfigSchema),
  /**
   * Cache of DSN -> project info mappings
   * Key format: "{orgId}:{projectId}"
   */
  projectCache: optional(record(string(), CachedProjectSchema)),
  /**
   * Cache of detected DSNs per directory
   * Key: absolute directory path
   * Value: cached DSN entry with source and resolution info
   */
  dsnCache: optional(record(string(), CachedDsnEntrySchema)),
  /**
   * Cached project aliases for short issue ID resolution.
   * Scoped by DSN fingerprint to prevent cross-project conflicts.
   * Set by `issue list` when multiple projects are detected.
   */
  projectAliases: optional(ProjectAliasesSchema),
});

export type SentryConfig = InferOutput<typeof SentryConfigSchema>;
