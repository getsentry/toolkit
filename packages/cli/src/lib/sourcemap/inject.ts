/**
 * Directory-level debug ID injection.
 *
 * Scans a directory for JavaScript files and their companion sourcemaps,
 * then injects Sentry debug IDs into each pair.
 */

import { open, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve as resolvePath, sep } from "node:path";
import ignore from "ignore";
import { NODE_MODULES_DIRNAME } from "../constants.js";
import { ValidationError } from "../errors.js";
import { logger } from "../logger.js";
import { isLikelyBinary } from "../scan/binary.js";
import { walkFiles } from "../scan/index.js";
import {
  EXISTING_DEBUGID_RE,
  hasDebugIdRegistration,
  injectDebugId,
  injectInlineDebugId,
  readSourcemapDebugId,
} from "./debug-id.js";
import {
  type DecodedInlineMap,
  isInlineSourcemapUrl,
  tryDecodeInlineSourcemap,
} from "./inline-sourcemap.js";

const log = logger.withTag("sourcemap.inject");

/** Default JavaScript file extensions to scan. */
const DEFAULT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

/**
 * The location of a JavaScript file's sourcemap.
 *
 * - `external`: a companion `.map` file on disk (convention `<name>.map` or a
 *   relative `sourceMappingURL` directive).
 * - `inline`: a base64 data URL embedded in the JS file itself (no `.map` file).
 */
export type MapSource =
  | { kind: "external"; mapPath: string }
  | { kind: "inline"; jsPath: string; decoded: DecodedInlineMap };

/** Result of injecting a single file pair. */
export type InjectResult = {
  /** Path to the JavaScript file. */
  jsPath: string;
  /** Discriminated location of the sourcemap (external file vs inline data URL). */
  map: MapSource;
  /**
   * Path to the companion sourcemap on disk. Set only for external maps;
   * `undefined` for inline maps (which have no standalone file).
   */
  mapPath?: string;
  /** Whether injection changed the files (or would change them in dry-run mode). */
  injected: boolean;
  /** The debug ID (injected or pre-existing). */
  debugId: string;
  /**
   * The debug-ID-injected sourcemap content, as a Buffer. Populated only for
   * inline maps (which have no `.map` file on disk) so the upload path can
   * ship it as a standalone artifact. `undefined` for external maps — read
   * those from `mapPath` instead.
   */
  injectedMapContent?: Buffer;
};

/** Options for directory-level injection. */
export type InjectDirectoryOptions = {
  /** File extensions to process (default: .js, .cjs, .mjs). */
  extensions?: string[];
  /** If true, report what would be modified without writing. */
  dryRun?: boolean;
  /** Glob patterns (gitignore-style) to exclude from processing. */
  ignorePatterns?: string[];
  /** Pre-built ignore matcher (takes precedence over ignorePatterns). */
  ignoreMatcher?: ReturnType<typeof ignore>;
};

/**
 * Scan a directory for JS + sourcemap pairs and inject debug IDs.
 *
 * Recursively discovers `.js`/`.mjs`/`.cjs` files, checks for a
 * companion `.map` file, and injects debug IDs into each pair.
 *
 * @param dir - Directory to scan
 * @param options - Scanning options
 * @returns Array of results (one per file pair found)
 */
export async function injectDirectory(
  dir: string,
  options: InjectDirectoryOptions = {}
): Promise<InjectResult[]> {
  const extensions = options.extensions
    ? new Set(options.extensions.map((e) => (e.startsWith(".") ? e : `.${e}`)))
    : DEFAULT_EXTENSIONS;

  const ig =
    options.ignoreMatcher ?? (await buildIgnoreMatcher(options.ignorePatterns));
  const filePairs = await discoverFilePairs(dir, extensions, ig);

  const results: InjectResult[] = [];
  for (const { jsPath, map } of filePairs) {
    const mapPath = map.kind === "external" ? map.mapPath : undefined;
    if (options.dryRun) {
      // Match the real run's ID precedence and runtime registration check.
      const jsBytes = await readFile(jsPath);
      const js = jsBytes.toString("utf-8");
      const existing =
        js.match(EXISTING_DEBUGID_RE)?.[1] ?? (await readMapDebugId(map));
      results.push({
        jsPath,
        map,
        mapPath,
        injected: !(
          existing &&
          (isLikelyBinary(jsBytes) || hasDebugIdRegistration(js, existing))
        ),
        debugId: existing ?? "(pending)",
      });
      continue;
    }
    if (map.kind === "external") {
      const r = await injectDebugId(jsPath, map.mapPath);
      results.push({
        jsPath,
        map,
        mapPath,
        injected: r.wasInjected,
        debugId: r.debugId,
      });
    } else {
      const r = await injectInlineDebugId(jsPath, map.decoded);
      results.push({
        jsPath,
        map,
        mapPath,
        injected: r.wasInjected,
        debugId: r.debugId,
        injectedMapContent: r.injectedMapContent,
      });
    }
  }
  return results;
}

/**
 * Read a debug ID already present on a discovered sourcemap, if any.
 *
 * Non-fatal: an unreadable or malformed map yields `undefined`, so callers
 * fall through to minting a content-derived ID exactly as before.
 *
 * @param map - The discovered sourcemap location
 * @returns The map's debug ID, or `undefined` when it carries none
 */
async function readMapDebugId(map: MapSource): Promise<string | undefined> {
  if (map.kind === "inline") {
    return readSourcemapDebugId(map.decoded.map);
  }
  try {
    return readSourcemapDebugId(
      JSON.parse(await readFile(map.mapPath, "utf-8"))
    );
  } catch (err) {
    log.warn(
      `could not read a debug ID from ${map.mapPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
}

/** A discovered JS + sourcemap pair. */
export type FilePair = { jsPath: string; map: MapSource };

/**
 * Classification of a parsed `sourceMappingURL` directive.
 *
 * - `external`: a file path (relative or convention-based).
 * - `inline`: a base64 `data:` URL embedding the sourcemap.
 * - `remote`: an `http(s)://` URL.
 */
export type SourceMappingDirective = {
  kind: "external" | "inline" | "remote";
  /** The directive value (path or data/remote URL). */
  value: string;
};

/**
 * Maximum bytes to scan backward when locating the `sourceMappingURL`
 * directive. Inline data URLs embed the whole sourcemap, so the directive
 * line can be multiple megabytes; we must read it in full to rewrite it in
 * place. The cap guards against pathological single-line files while
 * comfortably covering real-world inline maps.
 */
const MAX_DIRECTIVE_SCAN_BYTES = 64 * 1024 * 1024;

/** Size of each backward read chunk. */
const DIRECTIVE_CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a; // "\n"
const CARRIAGE_RETURN = 0x0d; // "\r"

/**
 * Iterate the lines of a buffer from the end toward the start.
 *
 * Yields each line as a subarray (without the delimiting `\n`). A single
 * trailing newline at the very end is ignored so the first yielded line is
 * the last non-empty line.
 */
function* linesFromEnd(buf: Buffer): Generator<Buffer> {
  let end = buf.length;
  // Ignore one trailing newline (and CR) at EOF.
  if (end > 0 && buf[end - 1] === NEWLINE) {
    end -= 1;
    if (end > 0 && buf[end - 1] === CARRIAGE_RETURN) {
      end -= 1;
    }
  }
  while (end > 0) {
    const nlIdx = buf.lastIndexOf(NEWLINE, end - 1);
    const start = nlIdx + 1;
    yield buf.subarray(start, end);
    if (nlIdx === -1) {
      return;
    }
    end = nlIdx;
  }
}

/**
 * Read the tail of a file as a Buffer, scanning backward from EOF until the
 * `sourceMappingURL` directive line is captured in full (or the scan cap is
 * hit).
 *
 * A `sourceMappingURL` directive is always a single line, and base64 data
 * contains no newlines, so even a multi-megabyte inline data URL is a single
 * line. The authoritative directive is at (or near) the end of the file, but
 * may be followed by trailing content (an injected `//# debugId=` comment,
 * blank lines, a license banner, etc.) — so we read enough of the tail to
 * contain it.
 *
 * Returns the full buffered tail; callers locate the directive within it via
 * {@link findSourceMappingDirective}. To keep allocation linear, chunks are
 * accumulated without concatenation; we concatenate and re-scan **only** after
 * reading a chunk that contains a newline (a new line boundary may complete a
 * directive line). For a large inline map — a single newline-free line — this
 * means a single concat once the chunk holding the line's start is read,
 * rather than a quadratic concat-per-chunk.
 */
async function readDirectiveTail(filePath: string): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const fileSize = (await fh.stat()).size;
    if (fileSize === 0) {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let collected = 0;
    let end = fileSize;
    while (end > 0 && collected < MAX_DIRECTIVE_SCAN_BYTES) {
      const readSize = Math.min(DIRECTIVE_CHUNK_BYTES, end);
      const offset = end - readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, offset);
      chunks.unshift(buf);
      collected += readSize;
      end = offset;

      // A directive line is only "complete" once its leading newline is
      // buffered. Re-scanning is worthwhile only when the chunk we just read
      // introduced a new line boundary — otherwise (mid-blob of a giant inline
      // line) there is nothing new to find. This keeps allocation linear.
      if (buf.indexOf(NEWLINE) !== -1) {
        const combined = Buffer.concat(chunks);
        if (findSourceMappingDirective(combined)) {
          return combined;
        }
      }
    }
    return Buffer.concat(chunks);
  } finally {
    await fh.close();
  }
}

/**
 * Find and parse the authoritative `sourceMappingURL` directive within a
 * buffered file tail.
 *
 * Scans lines from the end and returns the **last** `sourceMappingURL`
 * directive (the source map spec says the last directive wins). Trailing
 * content after the directive — an injected `//# debugId=` comment, blank
 * lines, license banners, or other code — does not prevent discovery.
 *
 * Note: the first line yielded by {@link linesFromEnd} may be truncated if its
 * start is not yet buffered, but `parseSourceMappingDirective` requires the
 * line to *begin* with the directive marker, so a partially-buffered directive
 * line simply doesn't match until {@link readDirectiveTail} has read far
 * enough back to include its start.
 */
function findSourceMappingDirective(
  tail: Buffer
): SourceMappingDirective | undefined {
  for (const line of linesFromEnd(tail)) {
    const directive = parseSourceMappingDirective(line);
    if (directive) {
      return directive;
    }
  }
  return;
}

/** Whether `buf` contains the ASCII `prefix` starting at byte offset `from`. */
function bytesStartsWith(buf: Buffer, prefix: string, from: number): boolean {
  if (from + prefix.length > buf.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (buf[from + i] !== prefix.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/** Skip ASCII spaces/tabs starting at `from`; returns the new index. */
function skipSpaces(buf: Buffer, from: number): number {
  let i = from;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09)) {
    i += 1;
  }
  return i;
}

/**
 * Parse a `sourceMappingURL` directive from a single line (as bytes).
 *
 * Matches `//# sourceMappingURL=<value>` or `//@ sourceMappingURL=<value>`
 * with optional single spaces around the marker, tolerating a trailing CR.
 * Operates at the byte level so multi-megabyte inline lines are not converted
 * to strings until the (short) value is extracted.
 *
 * Whitespace handling matches real bundler output (esbuild/webpack/rollup/
 * terser); the pathological arbitrary-whitespace cases the old regex allowed
 * are intentionally not supported.
 *
 * @returns The classified directive, or `undefined` when the line is not a
 *   `sourceMappingURL` directive.
 */
export function parseSourceMappingDirective(
  line: Buffer
): SourceMappingDirective | undefined {
  // Trim trailing whitespace/CR at the byte level.
  let endIdx = line.length;
  while (
    endIdx > 0 &&
    (line[endIdx - 1] === 0x20 ||
      line[endIdx - 1] === 0x09 ||
      line[endIdx - 1] === CARRIAGE_RETURN ||
      line[endIdx - 1] === NEWLINE)
  ) {
    endIdx -= 1;
  }

  let i = 0;
  i = skipSpaces(line, i);
  // Require "//" then "#" or "@".
  if (!bytesStartsWith(line, "//", i)) {
    return;
  }
  i += 2;
  const marker = line[i];
  if (marker !== 0x23 /* # */ && marker !== 0x40 /* @ */) {
    return;
  }
  i += 1;
  i = skipSpaces(line, i);
  if (!bytesStartsWith(line, "sourceMappingURL", i)) {
    return;
  }
  i += "sourceMappingURL".length;
  i = skipSpaces(line, i);
  if (line[i] !== 0x3d /* = */) {
    return;
  }
  i += 1;
  i = skipSpaces(line, i);
  if (i >= endIdx) {
    return;
  }

  const value = line.toString("utf-8", i, endIdx);
  let kind: SourceMappingDirective["kind"] = "external";
  if (isInlineSourcemapUrl(value)) {
    kind = "inline";
  } else if (value.startsWith("http://") || value.startsWith("https://")) {
    kind = "remote";
  }
  return { kind, value };
}

/**
 * Extract and classify the authoritative `sourceMappingURL` directive from a
 * JS file.
 *
 * Reads the file tail (where the directive lives, possibly followed by an
 * injected `//# debugId=` comment) and parses the directive. Returns
 * `undefined` when no directive is present or the file cannot be read.
 */
async function extractSourceMappingDirective(
  jsPath: string
): Promise<SourceMappingDirective | undefined> {
  try {
    const tail = await readDirectiveTail(jsPath);
    return findSourceMappingDirective(tail);
  } catch (error) {
    log.debug(`failed to read directive tail from ${jsPath}`, error);
    return;
  }
}

/**
 * Check if a file exists and is a regular file.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch (error) {
    log.debug(`stat failed for ${path}`, error);
    return false;
  }
}

/**
 * Find the companion sourcemap for a JS file.
 *
 * Resolution order:
 * 1. Convention: `<jsPath>.map` on disk → external
 * 2. `//# sourceMappingURL=<value>` directive in the JS file:
 *    - inline `data:` URL → decoded inline map (non-fatal on decode failure)
 *    - relative file reference → external
 *    - remote `http(s)://` URL → skipped
 *
 * @returns A {@link MapSource} if a sourcemap is found, undefined otherwise.
 */
async function findCompanionMap(
  jsPath: string
): Promise<MapSource | undefined> {
  // Fast path: convention-based naming (most bundlers use this)
  const conventionPath = `${jsPath}.map`;
  if (await fileExists(conventionPath)) {
    return { kind: "external", mapPath: conventionPath };
  }

  // Slow path: parse the authoritative sourceMappingURL directive.
  const directive = await extractSourceMappingDirective(jsPath);
  if (!directive) {
    return;
  }

  // Inline data: URL — decode and inject in place. Decode failures are
  // non-fatal: bundled terser/babel output can contain template literals
  // that look like inline sourcemap directives but are not valid base64 JSON.
  if (directive.kind === "inline") {
    const decoded = tryDecodeInlineSourcemap(directive.value);
    if (!decoded) {
      log.warn(
        `skipping ${jsPath}: inline sourcemap is not valid base64 JSON; leaving file unmodified`
      );
      return;
    }
    return { kind: "inline", jsPath, decoded };
  }

  // Skip remote URLs (http/https) — can't inject into remote maps.
  if (directive.kind === "remote") {
    log.debug(`skipping remote sourcemap URL in ${jsPath}: ${directive.value}`);
    return;
  }

  // External relative reference. Strip query strings and fragments
  // (e.g. "app.js.map?v=abc123") that bundlers like Vite/Rollup may append.
  // indexOf returns -1 when no delimiter is found, and slice(0, -1) would
  // chop the last char — so only slice when the delimiter actually exists.
  let cleanUrl = directive.value;
  const qIdx = cleanUrl.indexOf("?");
  if (qIdx !== -1) {
    cleanUrl = cleanUrl.slice(0, qIdx);
  }
  const hIdx = cleanUrl.indexOf("#");
  if (hIdx !== -1) {
    cleanUrl = cleanUrl.slice(0, hIdx);
  }

  // Resolve relative path against the JS file's directory
  const jsDir = dirname(jsPath);
  const resolvedMapPath = resolvePath(jsDir, cleanUrl);
  if (await fileExists(resolvedMapPath)) {
    return { kind: "external", mapPath: resolvedMapPath };
  }

  return;
}

/**
 * Recursively discover JS files with companion .map files.
 *
 * Uses the shared `walkFiles` engine from `src/lib/scan/` for
 * directory traversal. Sourcemap injection targets build output
 * directories — so we:
 *
 * - Disable `respectGitignore` (build outputs like `dist/` are
 *   typically gitignored; the walker would otherwise prune them).
 * - Skip dotfiles + `node_modules` only (via `SOURCEMAP_SKIP_DIRS`);
 *   the walker's `DEFAULT_SKIP_DIRS` is too broad — it prunes
 *   `dist`/`build`/`.next` etc., which are exactly the dirs users
 *   want to scan into.
 * - Disable the `maxFileSize` cap. The walker defaults to 256 KB,
 *   but webpack / rollup / Next.js bundles routinely exceed that.
 *   The old hand-rolled `readdir` loop had no size limit; silently
 *   dropping large JS files would skip debug-ID injection on the
 *   exact bundles users care about most.
 */
const SOURCEMAP_SKIP_DIRS: readonly string[] = [NODE_MODULES_DIRNAME];

/**
 * Build an `ignore` matcher from user-provided patterns and/or an
 * ignore-file path. Returns `undefined` when no patterns are active.
 */
export async function buildIgnoreMatcher(
  patterns?: string[],
  ignoreFilePath?: string
): Promise<ReturnType<typeof ignore> | undefined> {
  const hasPatterns = patterns && patterns.length > 0;
  if (!(hasPatterns || ignoreFilePath)) {
    return;
  }
  const ig = ignore();
  if (hasPatterns) {
    ig.add(patterns);
  }
  if (ignoreFilePath) {
    try {
      const content = await readFile(ignoreFilePath, "utf-8");
      ig.add(content);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new ValidationError(
          `Ignore file '${ignoreFilePath}' does not exist.`,
          "ignore-file"
        );
      }
      throw err;
    }
  }
  return ig;
}

/**
 * Read-only discovery pass — returns the list of JS + sourcemap pairs
 * without injecting debug IDs. Used as a pre-check by the upload
 * command so the directory isn't mutated when the upload won't
 * proceed (empty dir, missing credentials, etc.).
 */
export async function discoverFilePairs(
  dir: string,
  extensions: Set<string> = DEFAULT_EXTENSIONS,
  ignoreMatcher?: ReturnType<typeof ignore>
): Promise<FilePair[]> {
  // `walkFiles` requires an absolute cwd. CLI callers pass
  // user-supplied positional args like `./dist` directly through to
  // `injectDirectory`, so we resolve here rather than push the
  // requirement up to every caller.
  const absDir = resolvePath(dir);
  const pairs: FilePair[] = [];
  for await (const entry of walkFiles({
    cwd: absDir,
    extensions,
    alwaysSkipDirs: SOURCEMAP_SKIP_DIRS,
    hidden: false,
    respectGitignore: false,
    maxFileSize: Number.POSITIVE_INFINITY,
  })) {
    if (ignoreMatcher) {
      // Use POSIX relative path for gitignore-style matching
      const rel = relative(absDir, entry.absolutePath).replaceAll("\\", "/");
      if (ignoreMatcher.ignores(rel)) {
        continue;
      }
    }
    const map = await findCompanionMap(entry.absolutePath);
    if (map && isMapInsideDir(map, absDir, entry.absolutePath)) {
      pairs.push({ jsPath: entry.absolutePath, map });
    }
  }
  return pairs;
}

/**
 * Whether a resolved {@link MapSource} is safe to include — i.e. an external
 * map resolves inside the upload directory.
 *
 * Guards against `sourceMappingURL` directives that resolve outside the
 * upload directory (e.g. `"../../other/app.js.map"`). Convention-based maps
 * (`foo.js.map`) are always adjacent and inline maps live inside the JS file,
 * so both are inherently in-dir. The trailing separator prevents prefix
 * collisions (e.g. `/dist` vs `/dist-backup`); `path.sep` keeps it correct on
 * Windows.
 */
function isMapInsideDir(
  map: MapSource,
  absDir: string,
  jsPath: string
): boolean {
  if (map.kind === "inline") {
    return true;
  }
  const dirPrefix = absDir.endsWith(sep) ? absDir : `${absDir}${sep}`;
  if (map.mapPath.startsWith(dirPrefix)) {
    return true;
  }
  log.debug(
    `skipping sourcemap outside directory: ${map.mapPath} (resolved from ${jsPath})`
  );
  return false;
}

/**
 * Throw {@link ValidationError} if `dir` doesn't exist or isn't a
 * readable directory. Distinct messages per failure mode so the user
 * gets a useful pointer instead of "no sourcemaps found".
 */
export async function assertDirectoryReadable(dir: string): Promise<void> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) {
      throw new ValidationError(
        `Path '${dir}' is not a directory.`,
        "directory"
      );
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      throw err;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ValidationError(
        `Directory '${dir}' does not exist.`,
        "directory"
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `Cannot read directory '${dir}': ${msg}`,
      "directory"
    );
  }
}

/**
 * Counts of JS and `.map` files in a directory, used by
 * {@link buildEmptyDiscoveryError} to tailor the zero-pairs error.
 */
export type DiscoveryDiagnostic = {
  jsFiles: number;
  mapFiles: number;
};

/**
 * Count JS and `.map` files in a single walker pass. Only called on
 * the zero-pairs error path.
 */
export async function diagnoseEmptyDiscovery(
  dir: string,
  options: InjectDirectoryOptions = {}
): Promise<DiscoveryDiagnostic> {
  // Build one set covering JS extensions + `.map` so the walker visits
  // both in a single pass.
  const extensions = options.extensions
    ? new Set(options.extensions.map((e) => (e.startsWith(".") ? e : `.${e}`)))
    : new Set(DEFAULT_EXTENSIONS);
  extensions.add(".map");

  const absDir = resolvePath(dir);
  let jsFiles = 0;
  let mapFiles = 0;
  for await (const entry of walkFiles({
    cwd: absDir,
    extensions,
    alwaysSkipDirs: SOURCEMAP_SKIP_DIRS,
    hidden: false,
    respectGitignore: false,
    maxFileSize: Number.POSITIVE_INFINITY,
  })) {
    if (entry.absolutePath.endsWith(".map")) {
      mapFiles += 1;
    } else {
      jsFiles += 1;
    }
  }
  return { jsFiles, mapFiles };
}

/**
 * Read-only resolution result for a single JavaScript file, produced by
 * {@link resolveDirectorySourcemaps}. Mirrors the legacy `sentry-cli
 * sourcemaps resolve` diagnostic output without mutating any files.
 */
export type SourcemapResolution = {
  /** Absolute path to the JavaScript file. */
  jsPath: string;
  /**
   * Absolute path to the resolved companion sourcemap, or `undefined`
   * when no external `.map` file could be located on disk.
   */
  mapPath?: string;
  /**
   * Raw value of the last `//# sourceMappingURL=` directive in the file,
   * or `undefined` when no directive is present.
   */
  sourceMappingUrl?: string;
  /**
   * True when the `sourceMappingURL` is an inline `data:` URL (embedded
   * base64 sourcemap) rather than an external file reference.
   */
  inline: boolean;
  /**
   * True when the `sourceMappingURL` is a remote `http(s)://` reference.
   */
  remote: boolean;
  /**
   * The embedded `//# debugId=<uuid>` value, or `undefined` when the
   * file has not been injected yet.
   */
  debugId?: string;
};

/**
 * Byte-wise (code-unit) comparison of two strings for `Array.prototype.sort`.
 *
 * Used to order discovered paths deterministically without the locale-dependent
 * (and slower) `localeCompare`. Returns a negative, zero, or positive number.
 *
 * @param a - First string
 * @param b - Second string
 * @returns `-1` if `a < b`, `1` if `a > b`, `0` if equal
 */
function compareByteWise(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Read-only diagnostic pass over a build directory.
 *
 * For every discovered JavaScript file this reports how its sourcemap
 * resolves (convention `<name>.map`, an external `sourceMappingURL`
 * directive, an inline `data:` URL, or none) and whether a Sentry debug
 * ID has been injected. Unlike {@link discoverFilePairs}, files **without**
 * a companion map are still included so the user can see what is missing.
 *
 * Never mutates files — this powers `sentry sourcemap resolve`.
 *
 * @param dir - Directory to scan (resolved to an absolute path internally)
 * @param extensions - JS extensions to consider
 * @param ignoreMatcher - Optional gitignore-style matcher
 * @returns One {@link SourcemapResolution} per JS file, sorted by path
 */
export async function resolveDirectorySourcemaps(
  dir: string,
  extensions: Set<string> = DEFAULT_EXTENSIONS,
  ignoreMatcher?: ReturnType<typeof ignore>
): Promise<SourcemapResolution[]> {
  const absDir = resolvePath(dir);
  const results: SourcemapResolution[] = [];
  for await (const entry of walkFiles({
    cwd: absDir,
    extensions,
    alwaysSkipDirs: SOURCEMAP_SKIP_DIRS,
    hidden: false,
    respectGitignore: false,
    maxFileSize: Number.POSITIVE_INFINITY,
  })) {
    const jsPath = entry.absolutePath;
    if (ignoreMatcher) {
      const rel = relative(absDir, jsPath).replaceAll("\\", "/");
      if (ignoreMatcher.ignores(rel)) {
        continue;
      }
    }

    const directive = await extractSourceMappingDirective(jsPath);
    const sourceMappingUrl = directive?.value;
    const inline = directive?.kind === "inline";
    const remote = directive?.kind === "remote";
    const map = await findCompanionMap(jsPath);
    const mapPath = map?.kind === "external" ? map.mapPath : undefined;

    let debugId: string | undefined;
    try {
      const js = await readFile(jsPath, "utf-8");
      debugId = js.match(EXISTING_DEBUGID_RE)?.[1];
    } catch (err) {
      log.debug(`failed to read JS file for debug ID: ${jsPath}`, err);
    }
    // No comment in the JS: the linked map may still carry the ID a bundler
    // plugin stamped at build time, which injection would adopt rather than
    // replace.
    if (!debugId && map) {
      debugId = await readMapDebugId(map);
    }

    results.push({
      jsPath,
      mapPath,
      sourceMappingUrl,
      inline,
      remote,
      debugId,
    });
  }

  // Byte-wise comparison is sufficient and stable for filesystem paths; the
  // locale-aware `localeCompare` is unnecessary (and slower) here. Matches the
  // plain `.sort()` used for paths in `upload.ts`.
  results.sort((a, b) => compareByteWise(a.jsPath, b.jsPath));
  return results;
}

/**
 * Build an actionable error for the zero-pairs case, tailored to
 * which side of the JS/map pairing is missing.
 */
export function buildEmptyDiscoveryError(
  dir: string,
  diag: DiscoveryDiagnostic
): ValidationError {
  const { jsFiles, mapFiles } = diag;
  if (jsFiles === 0 && mapFiles === 0) {
    return new ValidationError(
      `Directory '${dir}' contains no JS or sourcemap files. ` +
        "Check the path points at your build output, or pass " +
        "--allow-empty to suppress this error.",
      "directory"
    );
  }
  if (jsFiles > 0 && mapFiles === 0) {
    return new ValidationError(
      `Found ${jsFiles} JS file(s) in '${dir}' but no companion .map ` +
        "files. Your bundler is not emitting sourcemaps. For Vite/Astro: " +
        "`vite.environments.client.build.sourcemap: 'hidden'`. For webpack: " +
        "`devtool: 'hidden-source-map'`. Pass --allow-empty to suppress.",
      "directory"
    );
  }
  if (mapFiles > 0 && jsFiles === 0) {
    return new ValidationError(
      `Found ${mapFiles} .map file(s) in '${dir}' but no companion JS ` +
        "files. Ensure your build emits both JS and maps to the same " +
        "directory. Pass --allow-empty to suppress.",
      "directory"
    );
  }
  return new ValidationError(
    `Found ${jsFiles} JS and ${mapFiles} .map file(s) in '${dir}' but ` +
      "no JS file has a matching `<name>.map` companion. Check that your " +
      "bundler emits JS and sourcemaps with matching basenames. Pass " +
      "--allow-empty to suppress.",
    "directory"
  );
}
