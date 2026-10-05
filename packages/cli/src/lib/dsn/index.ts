// biome-ignore-all lint/performance/noBarrelFile: intentional public API
/**
 * DSN Detection Module
 *
 * Public API for detecting Sentry DSN in a project directory.
 *
 * @example
 * import { detectDsn, resolveProject } from "./lib/dsn/index.js";
 *
 * // Detect DSN (uses cache for speed)
 * const dsn = await detectDsn(process.cwd());
 *
 * // Resolve to project info
 * if (dsn) {
 *   const project = await resolveProject(process.cwd(), dsn);
 *   console.log(`Project: ${project.orgSlug}/${project.projectSlug}`);
 * }
 */

// Cache Management
export {
  clearDsnCache,
  disableDsnCache,
  enableDsnCache,
  getCachedDsn,
  setCachedDsn,
  updateCachedResolution,
} from "../db/dsn-cache.js";
// Code Scanner (for advanced use)
export type { CodeScanResult } from "./code-scanner.js";
export { scanCodeForDsns, scanCodeForFirstDsn } from "./code-scanner.js";
// Main Detection API
export {
  detectAllDsns,
  detectDsn,
  getDsnSourceDescription,
} from "./detector.js";
// Env File Scanner
export type { EnvFileScanResult } from "./env-file.js";
export { detectFromAllEnvFiles, detectFromEnvFiles } from "./env-file.js";
// Error Formatting
export {
  formatConflictError,
  formatMultipleProjectsFooter,
  formatNoDsnError,
  formatResolutionError,
} from "./errors.js";
// Utilities (for advanced use)
export {
  createDetectedDsn,
  createDsnFingerprint,
  extractOrgIdFromHost,
  inferPackagePath,
  isPlaceholderNumericId,
  isPlaceholderPublicKey,
  isValidDsn,
  parseDsn,
  stripDsnOrgPrefix,
} from "./parser.js";
// Project Root Detection
export type { ProjectRootReason, ProjectRootResult } from "./project-root.js";
export { findProjectRoot } from "./project-root.js";
// Project Resolution
export { getAccessibleProjects, resolveProject } from "./resolver.js";
// Types
export type {
  CachedDsnEntry,
  DetectedDsn,
  DsnDetectionResult,
  DsnSource,
  ParsedDsn,
  ResolvedProject,
  ResolvedProjectInfo,
} from "./types.js";
