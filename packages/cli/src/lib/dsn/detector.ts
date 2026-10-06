/**
 * DSN Detector
 *
 * Detects Sentry DSN with GitHub CLI-style caching and project root detection.
 *
 * Detection algorithm:
 * 1. Find project root by walking up from cwd (checks .env for DSN at each level)
 * 2. If DSN found during walk-up, return immediately (fast path)
 * 3. Check cache for project root
 * 4. Full scan from project root with depth limiting
 *
 * Priority: .env with SENTRY_DSN > code > .env files > SENTRY_DSN env var
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getCachedDetection,
  getCachedDsn,
  setCachedDetection,
  setCachedDsn,
} from "../db/dsn-cache.js";
import {
  getCachedProjectRoot,
  setCachedProjectRoot,
} from "../db/project-root-cache.js";
import {
  extractFirstDsnFromContent,
  scanCodeForDsns,
  scanCodeForFirstDsn,
} from "./code-scanner.js";
import { detectFromEnv, SENTRY_DSN_ENV } from "./env.js";
import {
  detectFromAllEnvFiles,
  detectFromEnvFiles,
  extractDsnFromEnvContent,
} from "./env-file.js";
import { isRegularFile } from "./fs-utils.js";
import { createDetectedDsn, createDsnFingerprint, parseDsn } from "./parser.js";
import { findProjectRoot, isHomeOrAncestor } from "./project-root.js";
import type {
  CachedDsnEntry,
  DetectedDsn,
  DsnDetectionResult,
  DsnSource,
} from "./types.js";

/**
 * Detect DSN with project root detection and caching support.
 *
 * Algorithm:
 * 1. Find project root by walking up from cwd (checks .env for SENTRY_DSN to stop walk)
 * 2. Check cache for project root (fast path)
 * 3. Full scan from project root with depth limiting (slow path)
 *
 * Priority: code > .env files > SENTRY_DSN env var
 *
 * Note: Finding a DSN in .env during walk-up stops the walk (determines project root)
 * but does NOT short-circuit detection - we still scan for code DSNs which have
 * higher priority.
 *
 * @param cwd - Directory to start searching from
 * @returns Detected DSN with source info, or null if not found
 */
export async function detectDsn(cwd: string): Promise<DetectedDsn | null> {
  // 1. Find project root (may find DSN in .env along the way, but we don't
  //    return it immediately - code DSNs take priority)
  const { projectRoot, reason } = await findProjectRoot(cwd);

  // When project root detection fell back to the home directory (or an
  // ancestor of it), a downward scan would reach OS app-data and credential
  // directories (~/Library, ~/.ssh, ~/.aws, …). Skip the filesystem scan
  // entirely in that case and only consult the SENTRY_DSN env var.
  if (reason === "fallback" && isHomeOrAncestor(projectRoot)) {
    return detectFromEnv();
  }

  // 2. Check cache for project root (fast path)
  const cached = getCachedDsn(projectRoot);

  if (cached) {
    const verified = await verifyCachedDsn(projectRoot, cached);
    if (verified) {
      // Check if DSN changed
      if (verified.raw !== cached.dsn) {
        // DSN changed - update cache
        setCachedDsn(projectRoot, {
          dsn: verified.raw,
          projectId: verified.projectId,
          orgId: verified.orgId,
          source: verified.source,
          sourcePath: verified.sourcePath,
        });
        return verified;
      }

      // Cache hit! Return with resolved info if available
      return {
        ...verified,
        resolved: cached.resolved,
      };
    }
    // Cache invalid, fall through to full scan
  }

  // 3. Full scan from project root (slow path)
  const detected = await fullScanFirst(projectRoot);

  if (detected) {
    // Cache for next time (without resolved info yet)
    setCachedDsn(projectRoot, {
      dsn: detected.raw,
      projectId: detected.projectId,
      orgId: detected.orgId,
      source: detected.source,
      sourcePath: detected.sourcePath,
    });
  }

  return detected;
}

/**
 * Detect all DSNs in a directory (supports monorepos)
 *
 * Unlike detectDsn, this finds ALL DSNs from all sources.
 * Uses SQLite caching with mtime-based validation for fast repeated lookups.
 *
 * Algorithm:
 * 1. Try cached project root, or walk up to find it
 * 2. Try cached detection result (validates mtimes)
 * 3. Full scan if cache miss, then store in cache
 *
 * Collection order matches priority: code > .env files > env var
 *
 * @param cwd - Directory to search in
 * @returns Detection result with all found DSNs, fingerprint, and hasMultiple flag
 */
export async function detectAllDsns(cwd: string): Promise<DsnDetectionResult> {
  // 1. Get project root (cached or walk-up)
  let projectRoot: string;
  let reason: string;
  const cachedRoot = await getCachedProjectRoot(cwd);

  if (cachedRoot) {
    projectRoot = cachedRoot.projectRoot;
    reason = cachedRoot.reason;
  } else {
    const rootResult = await findProjectRoot(cwd);
    projectRoot = rootResult.projectRoot;
    reason = rootResult.reason;
    // Cache the project root lookup
    await setCachedProjectRoot(cwd, {
      projectRoot: rootResult.projectRoot,
      reason: rootResult.reason,
    });
  }

  // When project root detection fell back to the home directory (or an
  // ancestor of it), a downward scan would reach OS app-data and credential
  // directories (~/Library, ~/.ssh, ~/.aws, …). Skip the filesystem scan
  // entirely and only report the SENTRY_DSN env var, if any.
  if (reason === "fallback" && isHomeOrAncestor(projectRoot)) {
    const envDsn = detectFromEnv();
    const all = envDsn ? [envDsn] : [];
    return {
      primary: all[0] ?? null,
      all,
      hasMultiple: false,
      fingerprint: createDsnFingerprint(all),
    };
  }

  // 2. Try cached detection result
  const cachedDetection = await getCachedDetection(projectRoot);

  if (cachedDetection) {
    // Cache hit! Return cached result
    return {
      primary: cachedDetection.allDsns[0] ?? null,
      all: cachedDetection.allDsns,
      hasMultiple: cachedDetection.allDsns.length > 1,
      fingerprint: cachedDetection.fingerprint,
    };
  }

  // 3. Full scan (cache miss)
  const allDsns: DetectedDsn[] = [];
  const seenRawDsns = new Set<string>();
  const allSourceMtimes: Record<string, number> = {};
  const allDirMtimes: Record<string, number> = {};

  // Helper to add DSN if not duplicate
  const addDsn = (dsn: DetectedDsn) => {
    if (!seenRawDsns.has(dsn.raw)) {
      allDsns.push(dsn);
      seenRawDsns.add(dsn.raw);
    }
  };

  // 3a. Check all code files from project root (highest priority)
  const {
    dsns: codeDsns,
    sourceMtimes: codeMtimes,
    dirMtimes: codeDirMtimes,
  } = await scanCodeForDsns(projectRoot);
  for (const dsn of codeDsns) {
    addDsn(dsn);
  }
  Object.assign(allSourceMtimes, codeMtimes);
  Object.assign(allDirMtimes, codeDirMtimes);

  // 3b. Check all .env files from project root (includes monorepo packages/apps)
  const { dsns: envFileDsns, sourceMtimes: envMtimes } =
    await detectFromAllEnvFiles(projectRoot);
  for (const dsn of envFileDsns) {
    addDsn(dsn);
  }
  Object.assign(allSourceMtimes, envMtimes);

  // 3c. Check env var (lowest priority) - no mtime for env vars
  const envDsn = detectFromEnv();
  if (envDsn) {
    addDsn(envDsn);
  }

  // 4. Compute fingerprint and cache result
  const fingerprint = createDsnFingerprint(allDsns);

  // Get project root directory mtime for quick invalidation
  // when files are added/removed at root level
  let rootDirMtime = 0;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const stats = await stat(projectRoot);
    rootDirMtime = Math.floor(stats.mtimeMs);
  } catch {
    // Can't stat - still cache but validation will fail on next lookup
  }

  // Store in cache
  setCachedDetection(projectRoot, {
    fingerprint,
    allDsns,
    sourceMtimes: allSourceMtimes,
    dirMtimes: allDirMtimes,
    rootDirMtime,
  });

  // Multiple DSNs is valid in monorepos (different packages/apps)
  const hasMultiple = allDsns.length > 1;

  return {
    primary: allDsns[0] ?? null,
    all: allDsns,
    hasMultiple,
    fingerprint,
  };
}

/**
 * Check if a higher-priority code DSN exists.
 * Used to invalidate low-priority cached DSNs when code is added.
 */
function checkForHigherPriorityCodeDsn(
  cwd: string
): Promise<DetectedDsn | null> {
  return scanCodeForFirstDsn(cwd);
}

/**
 * Verify cached env var DSN is still valid.
 * Also checks for higher-priority code and env_file DSNs.
 *
 * Priority: code > env_file > env_var
 */
async function verifyEnvVarCache(
  cwd: string,
  cached: CachedDsnEntry
): Promise<DetectedDsn | null> {
  // First check if a code DSN exists (highest priority)
  const codeDsn = await checkForHigherPriorityCodeDsn(cwd);
  if (codeDsn) {
    return codeDsn;
  }

  // Check for env_file DSN (medium priority)
  const envFileDsn = await detectFromEnvFiles(cwd);
  if (envFileDsn) {
    return envFileDsn;
  }

  // No code or env_file DSN, verify the env var is still set
  const envDsn = detectFromEnv();
  if (envDsn?.raw === cached.dsn) {
    return envDsn; // Same DSN - cache valid
  }
  return envDsn; // DSN changed or removed - return new value (may be null)
}

/**
 * Verify cached file-based DSN is still valid.
 */
async function verifyFileDsnCache(
  cwd: string,
  cached: CachedDsnEntry
): Promise<DetectedDsn | null> {
  if (!cached.sourcePath) {
    return null;
  }

  const filePath = join(cwd, cached.sourcePath);

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // Guard: skip non-regular files (FIFOs, sockets, etc.) that would block.
    // 1Password streams secrets via symlinked named pipes; Bun.file().text()
    // blocks indefinitely on these.
    if (!(await isRegularFile(filePath, "verifyFileDsnCache.stat"))) {
      return null;
    }
    const content = await readFile(filePath, "utf-8");
    const foundDsn = extractDsnFromContent(content, cached.source);

    if (foundDsn === cached.dsn) {
      return createDetectedDsn(cached.dsn, cached.source, cached.sourcePath);
    }

    if (foundDsn && parseDsn(foundDsn)) {
      return createDetectedDsn(foundDsn, cached.source, cached.sourcePath);
    }
  } catch {
    // File doesn't exist or can't read
  }

  return null;
}

/**
 * Verify cached DSN is still valid.
 *
 * For low-priority sources (env, env_file), also checks if higher-priority
 * code DSNs have been added since caching to maintain correct priority order.
 *
 * @param cwd - Directory
 * @param cached - Cached DSN entry
 * @returns Verified DSN or null if cache is invalid
 */
async function verifyCachedDsn(
  cwd: string,
  cached: CachedDsnEntry
): Promise<DetectedDsn | null> {
  // Env var source (lowest priority) - check for higher-priority sources
  if (cached.source === "env") {
    return verifyEnvVarCache(cwd, cached);
  }

  // Env file source - check for higher-priority code DSNs first
  if (cached.source === "env_file") {
    const codeDsn = await checkForHigherPriorityCodeDsn(cwd);
    if (codeDsn) {
      return codeDsn;
    }
  }

  // Verify file-based sources (code, env_file, config)
  return verifyFileDsnCache(cwd, cached);
}

/**
 * Extract DSN from content based on source type.
 *
 * @param content - File content
 * @param source - Source type (env_file, code, etc.)
 */
function extractDsnFromContent(
  content: string,
  source: DsnSource
): string | null {
  switch (source) {
    case "env_file":
      return extractDsnFromEnvContent(content);
    case "code": {
      // Use language-agnostic DSN extraction
      return extractFirstDsnFromContent(content);
    }
    default:
      return null;
  }
}

/**
 * Full scan to find first DSN (cache miss path)
 *
 * Searches in priority order:
 * 1. Source code (explicit DSN takes highest priority)
 * 2. .env files
 * 3. SENTRY_DSN environment variable (lowest priority)
 */
async function fullScanFirst(cwd: string): Promise<DetectedDsn | null> {
  // 1. Search source code first (explicit DSN = highest priority)
  const codeDsn = await scanCodeForFirstDsn(cwd);
  if (codeDsn) {
    return codeDsn;
  }

  // 2. Check .env files
  const envFileDsn = await detectFromEnvFiles(cwd);
  if (envFileDsn) {
    return envFileDsn;
  }

  // 3. Check SENTRY_DSN environment variable (lowest priority)
  const envDsn = detectFromEnv();
  if (envDsn) {
    return envDsn;
  }

  return null;
}

/**
 * Get a human-readable description of where DSN was found
 *
 * @param dsn - Detected DSN
 * @returns Description string for display
 */
export function getDsnSourceDescription(dsn: DetectedDsn): string {
  switch (dsn.source) {
    case "env":
      return `${dsn.sourcePath ?? SENTRY_DSN_ENV} environment variable`;
    case "env_file":
      return dsn.sourcePath ?? ".env file";
    case "config":
      return dsn.sourcePath ?? "config file";
    case "code":
      return dsn.sourcePath ?? "source code";
    case "inferred":
      return "directory name inference";
    default:
      return "unknown source";
  }
}
