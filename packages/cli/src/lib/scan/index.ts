// biome-ignore-all lint/performance/noBarrelFile: intentional public API
/**
 * Scan module — pure-TS ripgrep-compatible file scanner.
 *
 * PR 1 exports the file-walking foundation. PR 2 adds the grep and
 * glob engines (`grepFiles`, `globFiles` + collect helpers). PR 3
 * will migrate the DSN scanner to this module.
 *
 * @example
 * ```ts
 * import { walkFiles, TEXT_EXTENSIONS } from "./lib/scan/index.js";
 *
 * for await (const entry of walkFiles({ cwd, extensions: TEXT_EXTENSIONS })) {
 *   if (!entry.isBinary) console.log(entry.relativePath);
 * }
 * ```
 *
 * @example
 * ```ts
 * import { collectGrep } from "./lib/scan/index.js";
 *
 * const { matches, stats } = await collectGrep({
 *   cwd: "/path/to/repo",
 *   pattern: "(?i)TODO",
 *   include: "*.ts",
 *   maxResults: 100,
 * });
 * ```
 */

export {
  classifyByExtension,
  isLikelyBinary,
  readHeadAndSniff,
} from "./binary.js";
export type { ConcurrentOptions, MapFilesOptions } from "./concurrent.js";
export {
  mapFilesConcurrent,
  mapFilesConcurrentStream,
} from "./concurrent.js";
export {
  BINARY_SNIFF_BYTES,
  CONCURRENCY_LIMIT,
  DEFAULT_SKIP_DIRS,
  DSN_ADDITIONAL_SKIP_DIRS,
  isMonorepoPackageDir,
  MAX_FILE_SIZE,
  MONOREPO_ROOTS,
  normalizePath,
  TEXT_EXTENSIONS,
} from "./constants.js";
export { collectGlob, globFiles } from "./glob.js";
export { collectGrep, grepFiles } from "./grep.js";
export type { IgnoreStackOptions } from "./ignore.js";
export { IgnoreStack } from "./ignore.js";
export type { CompilePatternOptions } from "./regex.js";
export {
  compilePattern,
  ensureGlobalFlag,
  extractInlineFlags,
} from "./regex.js";
export type {
  GlobOptions,
  GlobResult,
  GrepMatch,
  GrepOptions,
  GrepResult,
  GrepStats,
  IgnoreMatcher,
  WalkEntry,
  WalkOptions,
} from "./types.js";
export { bulkConcurrency, walkFiles } from "./walker.js";
