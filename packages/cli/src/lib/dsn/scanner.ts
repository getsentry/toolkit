/**
 * File Scanner Utilities
 *
 * Shared utilities for scanning specific files and extracting DSNs.
 * Used by env-file detection for scanning .env file variants.
 */

import { open } from "node:fs/promises";
import { join } from "node:path";
import { handleFileError, isRegularFile } from "./fs-utils.js";
import type { DetectedDsn } from "./types.js";

/** Result of processing a single file for DSN extraction. */
export type FileProcessResult = {
  /** Extracted DSN string (null if not found) */
  dsn: string | null;
  /** Additional metadata to attach to the DetectedDsn */
  metadata?: {
    packagePath?: string;
  };
};

/** Result of scanning specific files, including mtimes for caching. */
export type SpecificFileScanResult = {
  /** Detected DSNs */
  dsns: DetectedDsn[];
  /** Map of source file paths to their mtimes (only files containing DSNs) */
  sourceMtimes: Record<string, number>;
};

/**
 * Function that processes file content and extracts DSN.
 *
 * @param relativePath - Path relative to scan root
 * @param content - File content
 * @returns Extraction result or null to skip this file
 */
export type FileProcessor = (
  relativePath: string,
  content: string
) => FileProcessResult | null;

/**
 * Scan specific files (not glob) and extract DSNs.
 *
 * Used when scanning a known list of files (e.g., .env variants).
 *
 * @param cwd - Root directory
 * @param filenames - List of filenames to check (relative to cwd)
 * @param options - Processing options
 * @returns Object with detected DSNs and source file mtimes
 */
export async function scanSpecificFiles(
  cwd: string,
  filenames: string[],
  options: {
    stopOnFirst?: boolean;
    processFile: FileProcessor;
    createDsn: (
      raw: string,
      relativePath: string,
      metadata?: { packagePath?: string }
    ) => DetectedDsn | null;
  }
): Promise<SpecificFileScanResult> {
  const { stopOnFirst = false, processFile, createDsn } = options;
  const dsns: DetectedDsn[] = [];
  const sourceMtimes: Record<string, number> = {};

  for (const filename of filenames) {
    const filepath = join(cwd, filename);

    try {
      // Guard: skip non-regular files (FIFOs, sockets, etc.) that would block.
      // 1Password streams secrets via symlinked named pipes; open() on a FIFO
      // blocks indefinitely waiting for a writer.
      if (!(await isRegularFile(filepath, "scanSpecificFiles.stat"))) {
        continue;
      }

      // Use a single file handle for atomic read + stat to avoid TOCTOU:
      // reading content and mtime from the same open handle ensures they
      // correspond to the same file version.
      const fh = await open(filepath, "r");
      try {
        const [content, stats] = await Promise.all([
          fh.readFile("utf-8"),
          fh.stat(),
        ]);
        const result = processFile(filename, content);

        if (result?.dsn) {
          const detected = createDsn(result.dsn, filename, result.metadata);
          if (detected) {
            dsns.push(detected);
            // Record mtime for cache invalidation (from same handle as content).
            // Floor to integer — all mtime comparisons in dsn-cache.ts use Math.floor.
            sourceMtimes[filename] = Math.floor(stats.mtimeMs);

            if (stopOnFirst) {
              return { dsns, sourceMtimes };
            }
          }
        }
      } finally {
        await fh.close();
      }
    } catch (error) {
      handleFileError(error, {
        operation: "scanSpecificFiles",
        path: filepath,
      });
    }
  }

  return { dsns, sourceMtimes };
}
