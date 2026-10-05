/**
 * Language-agnostic DSN code scanner.
 *
 * Owns the DSN-specific policy (URL regex, comment-line filtering,
 * host validation, package-path inference). File walking, gitignore
 * handling, extension filtering, bounded concurrency, and worker-pool
 * dispatch are delegated to `src/lib/scan/`.
 *
 * ### Flow
 *
 * `scanCodeForDsns` routes through `collectGrep(DSN_PATTERN, ...)`.
 * Each emitted `GrepMatch` is one line containing a DSN-like URL;
 * the scanner post-filters matches on the main thread (comment-line
 * check, host validation, dedup). `sourceMtimes` / `dirMtimes` are
 * populated via `recordMtimes: true` + the `onDirectoryVisit` hook
 * in a single traversal.
 *
 * `scanCodeForFirstDsn` deliberately avoids the worker pool — the
 * pool's ~20ms startup cost dwarfs the work for a stop-on-first scan
 * that typically finds its target in the first few files. Uses a
 * direct `walkFiles` loop instead.
 *
 * Both the `CodeScanResult` shape and the result-map semantics are
 * cache-contract-stable — `src/lib/db/dsn-cache.ts` verifies entries
 * against the filesystem, so changing keys/values requires bumping
 * the cache schema.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SENTRY_HOST, getConfiguredSentryUrl } from "../constants.js";
import { ConfigError } from "../errors.js";
import { logger } from "../logger.js";
import { collectGrep, normalizePath, walkFiles } from "../scan/index.js";
import { withTracingSpan } from "../telemetry.js";
import { createDetectedDsn, inferPackagePath, parseDsn } from "./parser.js";
import { DSN_MAX_DEPTH, dsnScanOptions } from "./scan-options.js";
import type { DetectedDsn } from "./types.js";

const log = logger.withTag("dsn-scan");

/**
 * Result of scanning code for DSNs. Shape is cache-contract-stable
 * — `src/lib/db/dsn-cache.ts` uses it directly.
 */
export type CodeScanResult = {
  dsns: DetectedDsn[];
  /**
   * Map of source file paths (POSIX, relative to cwd) → mtime.
   * Only files containing at least one validated DSN. The cache
   * verifier uses this to detect "source file touched since last scan".
   */
  sourceMtimes: Record<string, number>;
  /**
   * Map of scanned directories (POSIX, relative to cwd; `.` for the
   * root) → floored `stat.mtimeMs`. The verifier uses this to detect
   * "files added to a scanned dir since last scan".
   */
  dirMtimes: Record<string, number>;
};

/** Comment prefixes — lines starting with any of these are ignored. */
const COMMENT_PREFIXES = ["//", "#", "--", "<!--", "/*", "*", "'''", '"""'];

/**
 * Sentry DSN URL pattern. Supports both formats:
 * - `https://{PUBLIC_KEY}@{HOST}/{PROJECT_ID}`
 * - `https://{PUBLIC_KEY}:{SECRET_KEY}@{HOST}/{PROJECT_ID}`
 *
 * Used with `String.matchAll`, which always iterates from the start
 * regardless of `lastIndex`.
 */
const DSN_PATTERN =
  /https?:\/\/[a-z0-9]+(?::[a-z0-9]+)?@[a-z0-9.-]+(?:\.[a-z]+|:[0-9]+)\/\d+/gi;

/**
 * Case-insensitive probe for the DSN scheme prefix. Every DSN starts
 * with some casing of `http`, so a file without the substring has
 * zero candidates and can skip the `matchAll` scan entirely. `/i` is
 * required for correctness: mixed-case schemes like `Https://` or
 * `hTtP://` would slip through a two-indexOf (lowercase + uppercase)
 * probe.
 */
const HTTP_SCHEME_PROBE = /http/i;

/**
 * Extract DSN URLs from file content, filtering out commented lines
 * and hosts that don't match the configured Sentry instance.
 *
 * @param content - File content to scan.
 * @param limit - Stop after this many unique DSNs. Unbounded when omitted.
 * @returns Unique DSN strings in file order.
 */
export function extractDsnsFromContent(
  content: string,
  limit?: number
): string[] {
  if (!HTTP_SCHEME_PROBE.test(content)) {
    return [];
  }

  const dsns = new Set<string>();
  for (const match of content.matchAll(DSN_PATTERN)) {
    const dsn = match[0];
    if (dsns.has(dsn)) {
      continue;
    }
    const matchIndex = match.index;
    const lineStart = content.lastIndexOf("\n", matchIndex) + 1;
    const lineEnd = content.indexOf("\n", matchIndex);
    const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (isCommentedLine(line.trim())) {
      continue;
    }
    if (isValidDsnHost(dsn)) {
      dsns.add(dsn);
      if (limit !== undefined && dsns.size >= limit) {
        break;
      }
    }
  }
  return [...dsns];
}

/**
 * Extract the first DSN from file content. Used by cache verification
 * to check if a DSN is still present in a file.
 */
export function extractFirstDsnFromContent(content: string): string | null {
  const dsns = extractDsnsFromContent(content, 1);
  return dsns[0] ?? null;
}

/**
 * Scan a directory for all DSNs in source code files. Respects nested
 * `.gitignore`, skips large files, and limits depth via
 * `dsnScanOptions()`. Returns unique DSNs plus mtime maps for cache
 * invalidation.
 */
export function scanCodeForDsns(cwd: string): Promise<CodeScanResult> {
  return scanDirectory(cwd);
}

/**
 * Scan a directory and return the first DSN found. Optimized for
 * single-project repositories — deliberately avoids the worker pool
 * (pool startup dwarfs the work on a stop-on-first scan).
 */
export function scanCodeForFirstDsn(cwd: string): Promise<DetectedDsn | null> {
  return withTracingSpan(
    "scanCodeForFirstDsn",
    "dsn.detect.code",
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: walker loop + read + extract + validate + span-status error branch is inherently branchy
    async (span) => {
      let filesScanned = 0;
      try {
        for await (const entry of walkFiles({
          cwd,
          ...dsnScanOptions(),
          // Early-exit consumer: we `return` on the first DSN-bearing
          // file. The parallel walker's channel adds ~7ms per-file
          // overhead; the serial walker uses a direct `yield` so
          // `break` cuts immediately. Measured 2ms (serial) vs ~75ms
          // (parallel) on the large bench fixture.
          concurrency: 1,
        })) {
          filesScanned += 1;
          let content: string;
          try {
            content = await readFile(entry.absolutePath, "utf-8");
          } catch {
            continue;
          }
          const raw = extractFirstDsnFromContent(content);
          if (raw === null) {
            continue;
          }
          const detected = createDetectedDsn(
            raw,
            "code",
            entry.relativePath,
            inferPackagePath(entry.relativePath)
          );
          if (detected !== null) {
            span.setAttribute("dsn.files_scanned", filesScanned);
            span.setAttribute("dsn.dsns_found", 1);
            return detected;
          }
        }
        span.setAttribute("dsn.files_scanned", filesScanned);
        span.setAttribute("dsn.dsns_found", 0);
        return null;
      } catch (error) {
        if (error instanceof ConfigError) {
          throw error;
        }
        span.setStatus({ code: 2, message: "Directory scan failed" });
        log.debug(`scanCodeForFirstDsn failed: ${String(error)}`);
        return null;
      }
    },
    {
      "dsn.scan_dir": cwd,
      "dsn.stop_on_first": true,
      "dsn.max_depth": DSN_MAX_DEPTH,
    }
  );
}

function isCommentedLine(trimmedLine: string): boolean {
  return COMMENT_PREFIXES.some((prefix) => trimmedLine.startsWith(prefix));
}

/**
 * Get the expected Sentry host for DSN validation.
 *
 * Self-hosted (SENTRY_URL set): only DSNs matching the configured
 * host are valid. SaaS: only `*.sentry.io` DSNs are valid.
 *
 * @throws {ConfigError} If SENTRY_URL is set but not a valid URL.
 */
function getExpectedHost(): string {
  const sentryUrl = getConfiguredSentryUrl();

  if (sentryUrl) {
    try {
      const url = new URL(sentryUrl);
      return url.host;
    } catch {
      throw new ConfigError(
        `SENTRY_HOST/SENTRY_URL "${sentryUrl}" is not a valid URL`,
        "Set SENTRY_HOST/SENTRY_URL to a valid URL (e.g., https://sentry.example.com) or unset it to use sentry.io"
      );
    }
  }

  return DEFAULT_SENTRY_HOST;
}

/**
 * Validate that a DSN has an acceptable Sentry host. Accepts exact
 * match or any subdomain. Prevents SaaS DSNs from being detected on
 * self-hosted instances (and vice versa).
 */
function isValidDsnHost(dsn: string): boolean {
  const parsed = parseDsn(dsn);
  if (!parsed) {
    return false;
  }
  const expectedHost = getExpectedHost();
  return (
    parsed.host === expectedHost || parsed.host.endsWith(`.${expectedHost}`)
  );
}

/**
 * Main full-scan implementation. Delegates the walker + grep work to
 * `collectGrep`; post-filters matches for comments and host validation
 * on the main thread.
 */
function scanDirectory(cwd: string): Promise<CodeScanResult> {
  return withTracingSpan(
    "scanCodeForDsns",
    "dsn.detect.code",
    async (span) => {
      const sourceMtimes: Record<string, number> = {};
      const dirMtimes: Record<string, number> = {};
      const seen = new Map<string, DetectedDsn>();
      // Dedup set for mtime recording. `grepFiles` emits one match
      // per line, so a file with 3 DSN-containing lines would trigger
      // 3 redundant writes to `sourceMtimes` without this gate.
      const filesSeenForMtime = new Set<string>();

      try {
        const { matches, stats } = await collectGrep({
          cwd,
          pattern: DSN_PATTERN,
          ...dsnScanOptions(),
          recordMtimes: true,
          onDirectoryVisit: (absDir, mtimeMs) => {
            const rel = normalizePath(path.relative(cwd, absDir)) || ".";
            dirMtimes[rel] = mtimeMs;
          },
          // Disable line truncation — the default (2000 chars) would
          // silently drop DSNs past column ~1900 on long minified
          // lines because `processMatch` re-runs `DSN_PATTERN` on
          // `match.line` and the pattern-terminating `/\d+` can't
          // survive a `…` suffix. Memory is bounded by the walker's
          // 256 KB `maxFileSize`.
          maxLineLength: Number.POSITIVE_INFINITY,
        });

        for (const match of matches) {
          processMatch(match, { seen, sourceMtimes, filesSeenForMtime });
        }

        span.setAttribute("dsn.files_collected", stats.filesRead);
        span.setAttributes({
          "dsn.files_scanned": stats.filesRead,
          "dsn.dsns_found": seen.size,
        });

        return { dsns: [...seen.values()], sourceMtimes, dirMtimes };
      } catch (error) {
        if (error instanceof ConfigError) {
          throw error;
        }
        // Unexpected walk failure: return empty maps so the cache
        // verifier forces a full rescan on next attempt. A partial
        // `dirMtimes` would silently bless unvisited dirs.
        span.setStatus({ code: 2, message: "Directory scan failed" });
        return { dsns: [], sourceMtimes: {}, dirMtimes: {} };
      }
    },
    {
      "dsn.scan_dir": cwd,
      "dsn.stop_on_first": false,
      "dsn.max_depth": DSN_MAX_DEPTH,
    }
  );
}

type MatchProcessingContext = {
  seen: Map<string, DetectedDsn>;
  sourceMtimes: Record<string, number>;
  filesSeenForMtime: Set<string>;
};

/**
 * Process one `GrepMatch`: skip commented lines, extract all DSNs on
 * the line, validate hosts, dedup into `seen`, and record the file's
 * mtime in `sourceMtimes` on first-match-per-file.
 */
function processMatch(
  match: {
    path: string;
    absolutePath: string;
    line: string;
    mtime?: number;
  },
  ctx: MatchProcessingContext
): void {
  if (isCommentedLine(match.line.trim())) {
    return;
  }
  const dsns = extractDsnsOnLine(match.line);
  if (dsns.length === 0) {
    return;
  }
  const packagePath = inferPackagePath(match.path);
  let fileHadValidDsn = false;
  for (const raw of dsns) {
    const detected = createDetectedDsn(raw, "code", match.path, packagePath);
    if (detected === null) {
      continue;
    }
    fileHadValidDsn = true;
    if (!ctx.seen.has(raw)) {
      ctx.seen.set(raw, detected);
    }
  }
  if (fileHadValidDsn && !ctx.filesSeenForMtime.has(match.absolutePath)) {
    ctx.filesSeenForMtime.add(match.absolutePath);
    if (match.mtime !== undefined) {
      ctx.sourceMtimes[match.path] = match.mtime;
    }
  }
}

/**
 * Extract DSN URLs from a single line's text. Mirrors
 * `extractDsnsFromContent` but without the file-level scheme probe
 * (grep already handles that).
 */
function extractDsnsOnLine(line: string): string[] {
  const dsns: string[] = [];
  for (const m of line.matchAll(DSN_PATTERN)) {
    const raw = m[0];
    if (!dsns.includes(raw) && isValidDsnHost(raw)) {
      dsns.push(raw);
    }
  }
  return dsns;
}
