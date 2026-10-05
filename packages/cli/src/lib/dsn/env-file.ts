/**
 * Environment File Detection
 *
 * Detects DSN from .env files in the project directory.
 * Supports various .env file variants in priority order.
 *
 * For monorepos, also scans common package directories (packages/, apps/, etc.)
 * to find DSNs in individual packages/apps.
 */

import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { withTracingSpan } from "../telemetry.js";
import { FRAMEWORK_ENV_PREFIXES } from "./env.js";
import { createDetectedDsn } from "./parser.js";
import { scanSpecificFiles } from "./scanner.js";
import type { DetectedDsn } from "./types.js";
import { MONOREPO_ROOTS } from "./types.js";

/**
 * Result of scanning env files, including mtimes for caching.
 */
export type EnvFileScanResult = {
  /** All detected DSNs from env files */
  dsns: DetectedDsn[];
  /** Map of source file paths to their mtimes (only files containing DSNs) */
  sourceMtimes: Record<string, number>;
  /** Number of package directories scanned for env files (monorepo scan only) */
  packagesScanned?: number;
};

/**
 * .env file names to search (in priority order).
 *
 * More specific files (.env.local, .env.development.local) are checked first
 * as they typically contain environment-specific overrides.
 */
export const ENV_FILES = [
  ".env.local",
  ".env.development.local",
  ".env.production.local",
  ".env",
  ".env.development",
  ".env.production",
] as const;

/**
 * Pattern to match Sentry DSN variables in .env files.
 * Matches the canonical `SENTRY_DSN` plus framework-prefixed variants
 * from the shared {@link FRAMEWORK_ENV_PREFIXES} allowlist:
 *   NEXT_PUBLIC_SENTRY_DSN, REACT_APP_SENTRY_DSN, VITE_SENTRY_DSN,
 *   EXPO_PUBLIC_SENTRY_DSN, NUXT_PUBLIC_SENTRY_DSN.
 *
 * Handles: VAR=value, VAR="value", VAR='value'
 * Also handles trailing comments: VAR=value # comment
 */
const TRAILING_UNDERSCORE = /_$/;
const ENV_DSN_PREFIXES = FRAMEWORK_ENV_PREFIXES.map((p) =>
  p.replace(TRAILING_UNDERSCORE, "")
).join("|");
const ENV_DSN_PATTERN = new RegExp(
  `^(?:(?:${ENV_DSN_PREFIXES})_)?SENTRY_DSN\\s*=\\s*(['"]?)(.+?)\\1\\s*(?:#.*)?$`
);

/**
 * Extract SENTRY_DSN value from .env file content.
 *
 * Parses the content line by line, skipping comments and empty lines.
 * Handles quoted values and trailing comments.
 *
 * @param content - Raw file content
 * @returns DSN string or null if not found
 *
 * @example
 * ```typescript
 * extractDsnFromEnvContent('SENTRY_DSN="https://key@sentry.io/123"')
 * // Returns: "https://key@sentry.io/123"
 * ```
 */
export function extractDsnFromEnvContent(content: string): string | null {
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Match SENTRY_DSN=value or SENTRY_DSN="value" or SENTRY_DSN='value'
    const match = trimmed.match(ENV_DSN_PATTERN);
    if (match?.[2]) {
      return match[2];
    }
  }

  return null;
}

// Legacy alias for backwards compatibility
export const parseEnvFile = extractDsnFromEnvContent;
export const extractDsnFromEnvFile = extractDsnFromEnvContent;

/**
 * Detect DSN from .env files in the given directory.
 *
 * Searches files in priority order and returns the first valid DSN found.
 * Does NOT scan monorepo subdirectories - use detectFromAllEnvFiles for that.
 *
 * @param cwd - Directory to search in
 * @returns First detected DSN or null if not found
 */
export async function detectFromEnvFiles(
  cwd: string
): Promise<DetectedDsn | null> {
  return await withTracingSpan(
    "detectFromEnvFiles",
    "dsn.detect.env",
    async (span) => {
      const { dsns } = await scanSpecificFiles(cwd, [...ENV_FILES], {
        stopOnFirst: true,
        processFile: (_relativePath, content) => {
          const dsn = extractDsnFromEnvContent(content);
          return dsn ? { dsn } : null;
        },
        createDsn: (raw, relativePath) =>
          createDetectedDsn(raw, "env_file", relativePath),
      });

      span.setAttribute("dsn.env_files_checked", ENV_FILES.length);
      span.setAttribute("dsn.env_dsn_found", dsns.length > 0);
      return dsns[0] ?? null;
    }
  );
}

/**
 * Detect DSN from ALL .env files including monorepo packages.
 *
 * Searches:
 * 1. Root .env files (.env.local, .env, etc.)
 * 2. Monorepo package directories (packages/star/.env, apps/star/.env, etc.)
 *
 * @param cwd - Directory to search in
 * @returns Object with all detected DSNs and source file mtimes
 */
export async function detectFromAllEnvFiles(
  cwd: string
): Promise<EnvFileScanResult> {
  return await withTracingSpan(
    "detectFromAllEnvFiles",
    "dsn.detect.env",
    async (span) => {
      const allDsns: DetectedDsn[] = [];
      const allMtimes: Record<string, number> = {};

      // 1. Check root .env files (all of them, not just first)
      const { dsns: rootDsns, sourceMtimes: rootMtimes } =
        await scanSpecificFiles(cwd, [...ENV_FILES], {
          stopOnFirst: false,
          processFile: (_relativePath, content) => {
            const dsn = extractDsnFromEnvContent(content);
            return dsn ? { dsn } : null;
          },
          createDsn: (raw, relativePath) =>
            createDetectedDsn(raw, "env_file", relativePath),
        });
      allDsns.push(...rootDsns);
      Object.assign(allMtimes, rootMtimes);

      // 2. Check monorepo package directories
      const {
        dsns: monorepoDsns,
        sourceMtimes: monorepoMtimes,
        packagesScanned = 0,
      } = await detectFromMonorepoEnvFiles(cwd);
      allDsns.push(...monorepoDsns);
      Object.assign(allMtimes, monorepoMtimes);

      // Root checks ENV_FILES.length names; each monorepo package also checks ENV_FILES.length
      const filesChecked = ENV_FILES.length * (1 + packagesScanned);
      span.setAttribute("dsn.env_files_checked", filesChecked);
      span.setAttribute("dsn.env_dsn_found", allDsns.length > 0);
      return { dsns: allDsns, sourceMtimes: allMtimes };
    }
  );
}

/**
 * Detect DSN from .env files in monorepo package directories.
 *
 * Scans common monorepo patterns like packages/*, apps/*, etc.
 * for .env files containing SENTRY_DSN.
 *
 * @param cwd - Root directory to search from
 * @returns Object with detected DSNs (with packagePath set) and source file mtimes
 */
export async function detectFromMonorepoEnvFiles(
  cwd: string
): Promise<EnvFileScanResult> {
  const dsns: DetectedDsn[] = [];
  const sourceMtimes: Record<string, number> = {};
  let packagesScanned = 0;

  for (const monorepoRoot of MONOREPO_ROOTS) {
    const rootDir = join(cwd, monorepoRoot);

    // Bun's opendir() may not throw on a missing directory — the error
    // surfaces when iterating. Wrap the full open+iterate in one try/catch.
    // No explicit handle.close() needed: for-await-of auto-closes the Dir
    // handle when the loop exits (including early return or break).
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      for await (const entry of await opendir(rootDir)) {
        // Skip hidden dirs (.git, .cache) and non-directories. Accept
        // symlinks too — pnpm/Yarn workspaces can symlink packages, and
        // detectDsnInPackage gracefully handles non-directory targets.
        if (
          entry.name.startsWith(".") ||
          !(entry.isDirectory() || entry.isSymbolicLink())
        ) {
          continue;
        }

        packagesScanned += 1;
        const pkgDir = join(rootDir, entry.name);
        const packagePath = `${monorepoRoot}/${entry.name}`;

        const result = await detectDsnInPackage(pkgDir, packagePath);
        if (result.dsn) {
          dsns.push(result.dsn);
          Object.assign(sourceMtimes, result.sourceMtimes);
        }
      }
    } catch {
      // Directory doesn't exist or scan failed, skip this monorepo root
    }
  }

  return { dsns, sourceMtimes, packagesScanned };
}

/** Result of detecting DSN in a single package */
type PackageDsnResult = {
  dsn: DetectedDsn | null;
  sourceMtimes: Record<string, number>;
};

/**
 * Detect DSN from .env files in a specific package directory.
 *
 * @param pkgDir - Full path to the package directory
 * @param packagePath - Relative package path (e.g., "packages/frontend")
 * @returns Object with detected DSN (or null) and source file mtimes
 */
async function detectDsnInPackage(
  pkgDir: string,
  packagePath: string
): Promise<PackageDsnResult> {
  const { dsns, sourceMtimes: rawMtimes } = await scanSpecificFiles(
    pkgDir,
    [...ENV_FILES],
    {
      stopOnFirst: true,
      processFile: (_relativePath, content) => {
        const dsn = extractDsnFromEnvContent(content);
        return dsn ? { dsn, metadata: { packagePath } } : null;
      },
      createDsn: (raw, relativePath, metadata) => {
        const sourcePath = `${packagePath}/${relativePath}`;
        return createDetectedDsn(
          raw,
          "env_file",
          sourcePath,
          metadata?.packagePath
        );
      },
    }
  );

  // Prefix mtimes with package path for uniqueness
  const sourceMtimes: Record<string, number> = {};
  for (const [file, mtime] of Object.entries(rawMtimes)) {
    sourceMtimes[`${packagePath}/${file}`] = mtime;
  }

  return { dsn: dsns[0] ?? null, sourceMtimes };
}

// Legacy export name for backwards compatibility with detector.ts
export const detectEnvFilesInMonorepo = detectFromMonorepoEnvFiles;
