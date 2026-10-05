/**
 * JVM Source Bundle Builder
 *
 * Walks a directory for JVM source files (Java, Kotlin, Scala, Groovy,
 * Clojure), strips source-set prefixes, and writes a ZIP source bundle
 * compatible with Sentry's symbolicator.
 *
 * The bundle is purely local — no API calls. Upload is a separate step
 * via `debug-files upload --type jvm`.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { logger } from "./logger.js";
import { ZipWriter } from "./sourcemap/zip.js";

const log = logger.withTag("jvm-bundle");

/** JVM source file extensions (lowercase, without dot). */
const JVM_EXTENSIONS = new Set([
  "java",
  "kt",
  "scala",
  "sc",
  "groovy",
  "gvy",
  "gy",
  "gsh",
  "clj",
  "cljc",
]);

/**
 * Directories that are always excluded during traversal.
 * IDE and build tool directories that can never be valid JVM package names.
 */
const SAFE_EXCLUDES = new Set([
  ".cxx",
  ".eclipse",
  ".fleet",
  ".gradle",
  ".idea",
  ".kotlin",
  ".mvn",
  ".settings",
  ".vscode",
  "node_modules",
]);

/**
 * Directories excluded unless they are under a `src/` ancestor.
 *
 * `build/generated/Foo.java` → excluded (no `src/` above `build/`).
 * `src/main/java/com/example/build/Builder.java` → kept (`build` under `src/`).
 * `build/src/main/java/Foo.java` → excluded (`src` is inside `build`, not above it).
 */
const AMBIGUOUS_EXCLUDES = new Set(["bin", "build", "out", "target"]);

/**
 * Matches `[module/]src/<sourceset>/<jvm-lang>/` prefix and captures
 * the package-relative tail.
 *
 * Examples:
 * - `src/main/java/io/sentry/core/Foo.java` → `io/sentry/core/Foo.java`
 * - `sentry-core/src/main/kotlin/io/sentry/Foo.kt` → `io/sentry/Foo.kt`
 * - `just/a/file.java` → no match (keep as-is)
 */
const SOURCE_SET_RE =
  /(?:^|[/\\])src[/\\][^/\\]+[/\\](?:java|kotlin|scala|groovy|clojure)[/\\](.+)$/;

/** Splits a path on forward or back slashes. */
const PATH_SEP_RE = /[/\\]/;

/** Strips a trailing file extension (e.g., `.java`). */
const FILE_EXT_RE = /\.[^.]+$/;

/** Strips the `~/` URL prefix. */
const URL_PREFIX_RE = /^~\//;

/** Manifest shape expected by Sentry's symbolicator (symbolic source bundle). */
type SourceBundleManifest = {
  debug_id: string;
  type: "source_bundle";
  attributes: Record<string, string>;
  files: Record<
    string,
    { url: string; type: "source"; headers: Record<string, string> }
  >;
};

/** Options for {@link buildJvmBundle}. */
export type JvmBundleOptions = {
  /** Directory containing JVM source files. */
  sourcePath: string;
  /** Output path for the ZIP bundle (full path including filename). */
  outputPath: string;
  /** Debug ID (UUID) to stamp on the bundle. */
  debugId: string;
  /** Additional directory names to exclude during traversal. */
  excludePatterns?: string[];
};

/** Result of {@link buildJvmBundle}. */
export type JvmBundleResult = {
  /** Number of source files included in the bundle. */
  fileCount: number;
  /** Number of files skipped due to URL collisions. */
  collisionCount: number;
  /** Output path of the written ZIP bundle. */
  outputPath: string;
  /** Included files: URL → relative source path. */
  files: Map<string, string>;
};

/**
 * Check if a relative path passes through an ambiguous build directory
 * that is NOT under a `src/` ancestor.
 *
 * For each path component matching an ambiguous name, we check whether
 * ANY ancestor ABOVE it is named `src`. If no `src` above → exclude.
 */
function isInAmbiguousBuildDir(relativePath: string): boolean {
  const parts = relativePath.split(PATH_SEP_RE);

  // Only check directory components (skip the filename at the end)
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part && AMBIGUOUS_EXCLUDES.has(part)) {
      let hasSrcAbove = false;
      for (let j = 0; j < i; j++) {
        if (parts[j] === "src") {
          hasSrcAbove = true;
          break;
        }
      }
      if (!hasSrcAbove) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a directory entry should be excluded during traversal.
 * Excludes safe IDE/build dirs, hidden directories (dot-prefix),
 * and user-specified names.
 */
function shouldExcludeDir(name: string, userExcludes: Set<string>): boolean {
  if (SAFE_EXCLUDES.has(name)) {
    return true;
  }
  if (name.startsWith(".")) {
    return true;
  }
  if (userExcludes.has(name)) {
    return true;
  }
  return false;
}

/**
 * Strip the source-set prefix from a relative path.
 *
 * `sentry-core/src/main/java/io/sentry/Foo.java` → `io/sentry/Foo.java`
 * `src/main/kotlin/com/example/Bar.kt` → `com/example/Bar.kt`
 * `just/Foo.java` → `just/Foo.java` (no match, keep as-is)
 */
function stripSourceSetPrefix(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const match = normalized.match(SOURCE_SET_RE);
  if (match?.[1]) {
    return match[1];
  }
  return normalized;
}

/**
 * Build the Sentry source URL from a package-relative path.
 *
 * Replaces the file extension with `.jvm` and prefixes with `~/`.
 * `io/sentry/core/Foo.java` → `~/io/sentry/core/Foo.jvm`
 */
function buildSourceUrl(packagePath: string): string {
  const withoutExt = packagePath.replace(FILE_EXT_RE, "");
  return `~/${withoutExt}.jvm`;
}

/**
 * Check if a file (by name and relative path) is a JVM source file that
 * should be included.
 *
 * The caller is responsible for determining that the entry resolves to a
 * regular file (following symlinks if necessary), since this only inspects
 * the name and path.
 *
 * @returns `true` if the name has a JVM extension and the path is not inside
 *   an ambiguous build directory.
 */
function isJvmSourceFile(name: string, relPath: string): boolean {
  const ext = extname(name).slice(1).toLowerCase();
  if (!JVM_EXTENSIONS.has(ext)) {
    return false;
  }
  if (isInAmbiguousBuildDir(relPath)) {
    log.debug(`Skipping build output: ${relPath}`);
    return false;
  }
  return true;
}

/**
 * Resolve whether a directory entry is ultimately a directory or a regular
 * file, following symbolic links.
 *
 * `Dirent.isDirectory()` / `isFile()` both return `false` for symlinks, so
 * symlinked sources would otherwise be silently dropped. For symlinks we
 * `stat` the target (which follows the link) to recover its real type.
 *
 * @returns `"dir"`, `"file"`, or `"other"` (sockets, FIFOs, broken/unreadable
 *   symlinks, etc.).
 */
async function resolveEntryKind(
  entry: import("node:fs").Dirent,
  fullPath: string
): Promise<"dir" | "file" | "other"> {
  if (entry.isDirectory()) {
    return "dir";
  }
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isSymbolicLink()) {
    try {
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        return "dir";
      }
      if (stats.isFile()) {
        return "file";
      }
    } catch (err) {
      // Broken or unreadable symlink — warn so the omission isn't silent.
      log.warn(`Skipping unresolvable symlink: ${fullPath}`, err);
      return "other";
    }
  }
  return "other";
}

/**
 * Recursively collect JVM source files from a directory.
 *
 * Respects safe excludes, ambiguous build directory filtering,
 * and user-provided exclude patterns. Symbolic links to files and
 * directories are followed, with cycle protection via a set of visited
 * real (canonicalized) directory paths. Results are sorted for
 * deterministic output.
 *
 * @returns Map of relative path → absolute path
 */
async function collectJvmSources(
  rootDir: string,
  userExcludes: Set<string>,
  rootIsSrc: boolean
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  // Track canonicalized directory paths already visited so that symlink
  // cycles (e.g. a/link -> a) don't cause infinite recursion.
  const visitedDirs = new Set<string>();

  /**
   * Determine the canonical path of `dir`, returning `null` (and logging) when
   * it's unreadable or has already been visited via another symlink path.
   */
  async function claimDir(dir: string): Promise<string | null> {
    let realDir: string;
    try {
      realDir = await realpath(dir);
    } catch (err) {
      log.warn(`Skipping unreadable directory: ${dir}`, err);
      return null;
    }
    if (visitedDirs.has(realDir)) {
      log.debug(`Skipping already-visited directory (symlink cycle): ${dir}`);
      return null;
    }
    visitedDirs.add(realDir);
    return realDir;
  }

  /** Process a single directory entry: recurse into dirs, collect source files. */
  async function processEntry(
    entry: import("node:fs").Dirent,
    dir: string
  ): Promise<void> {
    const fullPath = join(dir, entry.name);
    const kind = await resolveEntryKind(entry, fullPath);

    if (kind === "dir") {
      if (!shouldExcludeDir(entry.name, userExcludes)) {
        await walk(fullPath);
      }
      return;
    }

    if (kind !== "file") {
      return;
    }

    const relPath = relative(rootDir, fullPath);
    // When the scan root is a src/ directory, relative paths lack the
    // src/ prefix that isInAmbiguousBuildDir needs to recognise packages
    // named "build" etc. as legitimate source (not build output).
    const checkPath = rootIsSrc ? `src/${relPath}` : relPath;
    if (isJvmSourceFile(entry.name, checkPath)) {
      files.set(relPath, fullPath);
    }
  }

  async function walk(dir: string): Promise<void> {
    if ((await claimDir(dir)) === null) {
      return;
    }

    const entries = await readdir(dir, { withFileTypes: true });
    // Sort for deterministic ordering
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      await processEntry(entry, dir);
    }
  }

  await walk(rootDir);
  return files;
}

/** Entry that passed UTF-8 validation and is ready for bundling. */
type ValidatedEntry = {
  url: string;
  bundlePath: string;
  content: Buffer;
};

/**
 * Read and validate source files, skipping non-UTF-8 and unreadable files.
 *
 * @returns Array of validated entries suitable for ZIP inclusion.
 */
async function readAndValidateFiles(
  urlToAbsPath: Map<string, string>
): Promise<ValidatedEntry[]> {
  const validated: ValidatedEntry[] = [];

  for (const [url, absPath] of urlToAbsPath) {
    const bundlePath = `files/_/${url.replace(URL_PREFIX_RE, "")}`;
    try {
      const content = await readFile(absPath);
      // Skip non-UTF-8 files (binary files that happen to have JVM extensions)
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        log.debug(`Skipping non-UTF-8 file: ${absPath}`);
        continue;
      }
      validated.push({ url, bundlePath, content });
    } catch (err) {
      log.debug(`Failed to read source file: ${absPath}`, err);
    }
  }

  return validated;
}

/**
 * Write the source bundle ZIP using ZipWriter (includes SYSB magic header).
 *
 * Cleans up the file handle on error to prevent handle leaks.
 */
async function writeBundle(
  outputPath: string,
  manifest: SourceBundleManifest,
  validatedFiles: ValidatedEntry[]
): Promise<void> {
  const zip = await ZipWriter.create(outputPath);
  try {
    await zip.addEntry(
      "manifest.json",
      Buffer.from(JSON.stringify(manifest, null, 2), "utf-8")
    );

    for (const { bundlePath, content } of validatedFiles) {
      await zip.addEntry(bundlePath, content);
    }

    await zip.finalize();
  } catch (err) {
    await zip.close();
    log.debug("Failed to write JVM source bundle", err);
    throw err;
  }
}

/**
 * Build a JVM source bundle ZIP.
 *
 * Walks `sourcePath` for JVM source files, strips source-set prefixes,
 * deduplicates by URL (first-seen wins), and writes a ZIP source bundle
 * with the `SYSB` magic header expected by Sentry's symbolicator.
 *
 * @param options - Bundle configuration
 * @returns Result with file count and output path
 */
export async function buildJvmBundle(
  options: JvmBundleOptions
): Promise<JvmBundleResult> {
  const { sourcePath, outputPath, debugId, excludePatterns = [] } = options;

  const userExcludes = new Set(excludePatterns);

  // When the scan root is a "src" directory itself, relative paths won't
  // contain the src/ prefix that the source-set regex expects. We prepend
  // it for matching so that stripSourceSetPrefix and isInAmbiguousBuildDir
  // still work correctly.
  const rootName =
    sourcePath.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
  const prependSrc = rootName === "src";

  // 1. Collect JVM source files
  const sourceFiles = await collectJvmSources(
    sourcePath,
    userExcludes,
    prependSrc
  );
  log.debug(`Found ${sourceFiles.size} JVM source files`);

  // 2. Build URL map and deduplicate (first-seen wins)
  const urlToRelPath = new Map<string, string>();
  const urlToAbsPath = new Map<string, string>();
  let collisionCount = 0;

  for (const [relPath, absPath] of sourceFiles) {
    const matchPath = prependSrc ? `src/${relPath}` : relPath;
    const packagePath = stripSourceSetPrefix(matchPath);
    const url = buildSourceUrl(packagePath);

    const existingRel = urlToRelPath.get(url);
    if (existingRel !== undefined) {
      log.warn(
        `URL collision on ${url}: skipping '${relPath}' (already bundled from '${existingRel}'). ` +
          "Use --exclude to drop the unwanted source set."
      );
      collisionCount += 1;
      continue;
    }

    urlToRelPath.set(url, relPath);
    urlToAbsPath.set(url, absPath);
  }

  // 3. Read and validate all source files (skip non-UTF-8 and unreadable)
  const validatedFiles = await readAndValidateFiles(urlToAbsPath);

  // 4. Build manifest from validated files only
  const manifest: SourceBundleManifest = {
    debug_id: debugId,
    type: "source_bundle",
    attributes: {},
    files: {},
  };

  for (const { url, bundlePath } of validatedFiles) {
    manifest.files[bundlePath] = {
      url,
      type: "source",
      headers: {},
    };
  }

  // 5. Write ZIP bundle
  await writeBundle(outputPath, manifest, validatedFiles);

  // Rebuild the files map from validated entries only — urlToRelPath may
  // contain entries that were dropped during UTF-8 validation (step 3).
  const validatedUrlToRelPath = new Map<string, string>();
  for (const { url } of validatedFiles) {
    const relPath = urlToRelPath.get(url);
    if (relPath) {
      validatedUrlToRelPath.set(url, relPath);
    }
  }

  return {
    fileCount: validatedFiles.length,
    collisionCount,
    outputPath,
    files: validatedUrlToRelPath,
  };
}

// Exported for testing
export {
  isInAmbiguousBuildDir as _isInAmbiguousBuildDir,
  stripSourceSetPrefix as _stripSourceSetPrefix,
  buildSourceUrl as _buildSourceUrl,
  JVM_EXTENSIONS as _JVM_EXTENSIONS,
};
