/**
 * Pure-TS grep engine.
 *
 * Layers regex matching onto `walkFiles`:
 *   1. Walk cwd with the caller's filters (extensions, depth, gitignore).
 *   2. Post-filter yields by `isBinary` + include/exclude globs.
 *   3. Read each surviving file, optionally gate via an extracted
 *      literal, run the regex across the full buffer.
 *   4. Emit one `GrepMatch` per matching line.
 *
 * The public entry points are `grepFiles` (streaming) and
 * `collectGrep` (drained + sorted). Both share `setupGrepPipeline`
 * so defaults/compilation/matching are configured in one place.
 *
 * File reads use `readFile(path, "utf-8")`; the walker's `maxFileSize`
 * (default 256 KB) caps the blast radius. CRLF is preserved verbatim.
 *
 * Matching uses whole-buffer `regex.exec` iteration with the per-file
 * regex cloned so `lastIndex` is local. A literal extracted from the
 * compiled regex source (via `extractInnerLiteral`) is used as a
 * cheap `indexOf` file-level gate before the regex runs. Inline flags
 * (`(?i)` / `(?im)` / `(?i:...)`) are translated to JS flags by
 * `compilePattern`.
 *
 * When the runtime supports `new Worker(url)`, batches of file paths
 * are dispatched to a worker pool; otherwise the pipeline falls back
 * to main-thread `mapFilesConcurrent`. Disable workers for tests or
 * debugging via `SENTRY_SCAN_DISABLE_WORKERS=1`.
 */

import { readFile } from "node:fs/promises";
import { handleFileError } from "../dsn/fs-utils.js";
import {
  type ConcurrentOptions,
  mapFilesConcurrentStream,
} from "./concurrent.js";
import { extractInnerLiteral } from "./literal-extract.js";
import {
  basenameOf,
  type CompiledMatcher,
  compileMatchers,
  joinPosix,
  matchesAny,
  walkerRoot,
} from "./path-utils.js";
import {
  compilePattern,
  ensureGlobalFlag,
  ensureGlobalMultilineFlags,
} from "./regex.js";
import type {
  GrepMatch,
  GrepOptions,
  GrepResult,
  GrepStats,
  WalkEntry,
  WalkOptions,
} from "./types.js";
import { walkFiles } from "./walker.js";
import {
  decodeWorkerMatches,
  getWorkerPool,
  isWorkerSupported,
} from "./worker-pool.js";

/** Default line-truncation length for the init-wizard wire shape. */
const DEFAULT_MAX_LINE_LENGTH = 2000;

function createStats(): GrepStats {
  return {
    filesConsidered: 0,
    filesRead: 0,
    filesSkippedBinary: 0,
    matchesEmitted: 0,
    truncated: false,
  };
}

async function* tapWalkerStats<T extends WalkEntry>(
  source: AsyncIterable<T>,
  stats: GrepStats
): AsyncGenerator<T> {
  for await (const item of source) {
    stats.filesConsidered += 1;
    yield item;
  }
}

async function* applyGrepFilters(
  source: AsyncIterable<WalkEntry>,
  opts: {
    includes: CompiledMatcher[];
    excludes: CompiledMatcher[];
    includeBinary: boolean;
    stats: GrepStats;
  }
): AsyncGenerator<WalkEntry> {
  for await (const entry of source) {
    if (entry.isBinary && !opts.includeBinary) {
      opts.stats.filesSkippedBinary += 1;
      continue;
    }
    const base = basenameOf(entry.relativePath);
    if (
      opts.includes.length > 0 &&
      !matchesAny(opts.includes, entry.relativePath, base)
    ) {
      continue;
    }
    if (
      opts.excludes.length > 0 &&
      matchesAny(opts.excludes, entry.relativePath, base)
    ) {
      continue;
    }
    yield entry;
  }
}

type PerFileOptions = {
  regex: RegExp;
  multiline: boolean;
  maxLineLength: number;
  maxMatchesPerFile: number;
  pathPrefix: string;
  /**
   * Pre-extracted literal for the file-level prefilter. Null when
   * the pattern has no safe extractable literal (top-level
   * alternation, all-metachar, etc.).
   *
   * The gate is file-level only — we never use the literal to
   * locate individual matches. Patterns that can match across
   * newlines or whose literal differs from the compiled form would
   * both produce silent misses under a per-line verify.
   */
  literal: string | null;
  /** When true, emitted `GrepMatch` entries carry `mtime`. */
  recordMtimes: boolean;
};

/**
 * Read one file and emit one `GrepMatch` per matching line.
 * Applies the literal-prefilter gate when available, then runs the
 * whole-buffer regex.
 */
async function readAndGrep(
  entry: WalkEntry,
  opts: PerFileOptions
): Promise<GrepMatch[] | null> {
  let content: string;
  try {
    content = await readFile(entry.absolutePath, "utf-8");
  } catch (error) {
    handleFileError(error, {
      operation: "scan.grep.readFile",
      path: entry.absolutePath,
    });
    return null;
  }

  if (opts.literal !== null) {
    // Case-insensitive search: lowercase the haystack for the gate.
    // This may change string length (e.g., Turkish `İ` → `i` + U+0307),
    // but we only use the result as a boolean "does the literal exist?"
    // — the returned position is never used as a content offset.
    const haystack = opts.regex.flags.includes("i")
      ? content.toLowerCase()
      : content;
    if (haystack.indexOf(opts.literal) === -1) {
      return [];
    }
  }

  return grepByWholeBuffer(content, entry, opts);
}

/**
 * Whole-buffer regex iteration. Clones the compiled regex so each
 * invocation has its own `lastIndex`. `/g` is always applied;
 * `/m` is applied when the caller opted into line-boundary
 * anchoring (the default — see `GrepOptions.multiline`).
 */
function grepByWholeBuffer(
  content: string,
  entry: WalkEntry,
  opts: PerFileOptions
): GrepMatch[] {
  const ensured = opts.multiline
    ? ensureGlobalMultilineFlags(opts.regex)
    : ensureGlobalFlag(opts.regex);
  const regex = new RegExp(ensured.source, ensured.flags);
  const ctx: MatchContext = { entry, opts, content };

  const matches: GrepMatch[] = [];
  // Track line numbers by jumping newline-to-newline with `indexOf`
  // — faster than a `charCodeAt` walk (V8 optimizes `indexOf` in C++).
  let lineNum = 1;
  let cursor = 0;
  let match = regex.exec(content);
  while (match !== null) {
    const matchIndex = match.index;
    let nl = content.indexOf("\n", cursor);
    while (nl !== -1 && nl < matchIndex) {
      lineNum += 1;
      nl = content.indexOf("\n", nl + 1);
    }
    cursor = matchIndex;
    const lineStart = content.lastIndexOf("\n", matchIndex) + 1;
    const lineEndRaw = content.indexOf("\n", matchIndex);
    const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
    matches.push(buildMatch(ctx, { lineNum, lineStart, lineEnd }));
    if (matches.length >= opts.maxMatchesPerFile) {
      break;
    }
    if (lineEndRaw === -1) {
      break;
    }
    // Advance past the line so we emit at most one match per line.
    regex.lastIndex = lineEnd + 1;
    match = regex.exec(content);
  }
  return matches;
}

type MatchContext = {
  entry: WalkEntry;
  opts: PerFileOptions;
  content: string;
};

type LineBounds = {
  lineNum: number;
  lineStart: number;
  lineEnd: number;
};

function buildMatch(ctx: MatchContext, bounds: LineBounds): GrepMatch {
  const rawLine = ctx.content.slice(bounds.lineStart, bounds.lineEnd);
  const line =
    rawLine.length > ctx.opts.maxLineLength
      ? `${rawLine.slice(0, ctx.opts.maxLineLength - 1)}…`
      : rawLine;
  const match: GrepMatch = {
    path: ctx.opts.pathPrefix
      ? joinPosix(ctx.opts.pathPrefix, ctx.entry.relativePath)
      : ctx.entry.relativePath,
    absolutePath: ctx.entry.absolutePath,
    lineNum: bounds.lineNum,
    line,
  };
  if (ctx.opts.recordMtimes) {
    match.mtime = ctx.entry.mtime;
  }
  return match;
}

function buildWalkOptions(opts: GrepOptions, root: string): WalkOptions {
  return {
    cwd: root,
    extensions: opts.extensions,
    alwaysSkipDirs: opts.alwaysSkipDirs,
    respectGitignore: opts.respectGitignore,
    nestedGitignore: opts.nestedGitignore,
    hidden: opts.hidden,
    maxDepth: opts.maxDepth,
    minDepth: opts.minDepth,
    maxFileSize: opts.maxFileSize,
    descentHook: opts.descentHook,
    followSymlinks: opts.followSymlinks,
    recordMtimes: opts.recordMtimes,
    onDirectoryVisit: opts.onDirectoryVisit,
    signal: opts.signal,
    timeBudgetMs: opts.timeBudgetMs,
  };
}

type GrepPipelineOptions = {
  regex: RegExp;
  perFile: PerFileOptions;
  walkSource: AsyncIterable<WalkEntry>;
  stats: GrepStats;
  concurrent: ConcurrentOptions;
  maxResults: number;
  stopOnFirst: boolean;
};

/**
 * Batch size for worker dispatch. Bench (synthetic/large, 10k files):
 * 100 → 420ms, 200 → 275ms (plateau), 400 → 290ms. Too small and
 * `postMessage` overhead dominates; too large and we lose parallelism
 * because the walker finishes before workers return.
 */
const WORKER_BATCH_SIZE = 200;

// biome-ignore lint/suspicious/useAwait: yield* delegates to sub-generators
async function* grepFilesInternal(
  opts: GrepPipelineOptions
): AsyncGenerator<GrepMatch> {
  if (shouldUseWorkers()) {
    yield* grepViaWorkers(opts);
    return;
  }
  yield* grepViaAsyncMain(opts);
}

function shouldUseWorkers(): boolean {
  if (process.env.SENTRY_SCAN_DISABLE_WORKERS === "1") {
    return false;
  }
  return isWorkerSupported();
}

/**
 * Main-thread fallback. Identical semantics to the worker path;
 * ~4× slower on 10k-file many-match workloads.
 */
async function* grepViaAsyncMain(
  opts: GrepPipelineOptions
): AsyncGenerator<GrepMatch> {
  for await (const match of mapFilesConcurrentStream(
    opts.walkSource,
    async (entry) => {
      const matches = await readAndGrep(entry, opts.perFile);
      // Only count `filesRead` on successful read — a null return
      // means the open failed.
      if (matches !== null) {
        opts.stats.filesRead += 1;
      }
      return matches;
    },
    opts.concurrent
  )) {
    opts.stats.matchesEmitted += 1;
    yield match;
    if (opts.stopOnFirst) {
      opts.stats.truncated = true;
      return;
    }
    if (opts.stats.matchesEmitted >= opts.maxResults) {
      opts.stats.truncated = true;
      return;
    }
  }
}

/**
 * Worker pipeline. Walker streams paths on the main thread; paths
 * are batched, each batch dispatches round-robin to the pool,
 * workers return packed results via transferable `Uint32Array`.
 * Main thread decodes and yields in worker-completion order.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: producer/consumer pattern with early exit, batch dispatch, and abort-signal propagation is inherently branchy
async function* grepViaWorkers(
  opts: GrepPipelineOptions
): AsyncGenerator<GrepMatch> {
  const pool = getWorkerPool();

  const pending: GrepMatch[][] = [];
  // Consumer wait state. `notifyPending` is set when `wakeConsumer`
  // fires before the consumer is waiting, so the consumer picks it
  // up on the next loop iteration instead of missing the wakeup.
  let pendingNotify: (() => void) | null = null;
  let notifyPending = false;
  const wakeConsumer = () => {
    if (pendingNotify) {
      const fn = pendingNotify;
      pendingNotify = null;
      fn();
    } else {
      notifyPending = true;
    }
  };

  let earlyExit = false;
  let walkerDone = false;
  let inflightCount = 0;

  // Track dispatch outcomes so the consumer's `finally` can detect
  // a pipeline-wide failure. `dispatchPromises` is awaited to ensure
  // `failedBatches` is final before we check it (otherwise an
  // early-exit could race the in-flight `.catch()` handlers).
  let dispatchedBatches = 0;
  let failedBatches = 0;
  const dispatchPromises: Promise<unknown>[] = [];

  const dispatchBatch = (
    paths: string[],
    rels: string[],
    mtimes: readonly number[] | null
  ): void => {
    opts.stats.filesRead += paths.length;
    inflightCount += 1;
    dispatchedBatches += 1;
    const dispatchP = pool
      .dispatch({
        paths,
        patternSource: opts.perFile.regex.source,
        flags: resolveWorkerFlags(opts.perFile),
        maxLineLength: opts.perFile.maxLineLength,
        maxMatchesPerFile: Number.isFinite(opts.perFile.maxMatchesPerFile)
          ? opts.perFile.maxMatchesPerFile
          : 0xff_ff_ff_ff,
        literal: opts.perFile.literal,
      })
      .then(
        (result) => {
          pending.push(decodeWorkerMatches(result, paths, rels, mtimes));
        },
        () => {
          failedBatches += 1;
        }
      )
      .finally(() => {
        inflightCount -= 1;
        wakeConsumer();
      });
    dispatchPromises.push(dispatchP);
  };

  let producerError: unknown = null;
  const recordMtimes = opts.perFile.recordMtimes;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: walker drain + path-prefix handling + batch flush + error capture is inherently branchy
  const producer = (async () => {
    let batch: string[] = [];
    let batchRel: string[] = [];
    // Per-batch mtime array, parallel to `batch`. Allocated only
    // when the caller opted into `recordMtimes`.
    let batchMtimes: number[] | null = recordMtimes ? [] : null;
    try {
      for await (const entry of opts.walkSource) {
        if (earlyExit) {
          break;
        }
        batch.push(entry.absolutePath);
        batchRel.push(
          opts.perFile.pathPrefix
            ? joinPosix(opts.perFile.pathPrefix, entry.relativePath)
            : entry.relativePath
        );
        if (batchMtimes !== null) {
          batchMtimes.push(entry.mtime);
        }
        if (batch.length >= WORKER_BATCH_SIZE) {
          dispatchBatch(batch, batchRel, batchMtimes);
          batch = [];
          batchRel = [];
          batchMtimes = recordMtimes ? [] : null;
        }
      }
      if (batch.length > 0) {
        dispatchBatch(batch, batchRel, batchMtimes);
      }
    } catch (error) {
      producerError = error;
    } finally {
      walkerDone = true;
      wakeConsumer();
    }
  })();

  // `walkFiles` throws `DOMException("AbortError")` on the next
  // yield after the signal fires; mirror that in the consumer.
  const checkAborted = (): void => {
    const signal = opts.concurrent.signal;
    if (signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
  };

  try {
    while (!earlyExit) {
      checkAborted();
      while (pending.length > 0) {
        checkAborted();
        const matches = pending.shift();
        if (!matches) {
          continue;
        }
        for (const m of matches) {
          if (opts.stats.matchesEmitted >= opts.maxResults) {
            opts.stats.truncated = true;
            earlyExit = true;
            break;
          }
          opts.stats.matchesEmitted += 1;
          yield m;
          checkAborted();
          if (opts.stopOnFirst) {
            opts.stats.truncated = true;
            earlyExit = true;
            break;
          }
        }
        if (earlyExit) {
          break;
        }
      }
      if (earlyExit) {
        break;
      }
      if (walkerDone && inflightCount === 0) {
        break;
      }
      // Wait for something to happen. Check for a pre-arrived
      // notification first to avoid missing wakeups that fired while
      // we were draining `pending`.
      if (notifyPending) {
        notifyPending = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        if (notifyPending) {
          notifyPending = false;
          resolve();
        } else {
          pendingNotify = resolve;
        }
      });
    }
  } finally {
    earlyExit = true;
    wakeConsumer();
    await producer;
    // Await every dispatched batch so `failedBatches` is final
    // before the pipeline-failure check. Without this the failure
    // check can race in-flight `.catch()` handlers on early exit.
    if (dispatchPromises.length > 0) {
      await Promise.allSettled(dispatchPromises);
    }
    if (producerError !== null) {
      // biome-ignore lint/correctness/noUnsafeFinally: re-raising walker error (e.g. AbortError) so callers see it
      throw producerError;
    }
    // If every dispatched batch failed, the "no matches" result is
    // a pipeline failure, not a genuine zero-match. Surface it so
    // callers (notably the DSN cache layer) don't persist a
    // false-negative empty result.
    if (dispatchedBatches > 0 && failedBatches === dispatchedBatches) {
      // biome-ignore lint/correctness/noUnsafeFinally: surfacing pipeline-wide failure so false-negative empty result doesn't leak upstream
      throw new Error(
        `worker pipeline: all ${dispatchedBatches} dispatched batch(es) failed`
      );
    }
  }
}

function resolveWorkerFlags(opts: PerFileOptions): string {
  const ensured = opts.multiline
    ? ensureGlobalMultilineFlags(opts.regex)
    : ensureGlobalFlag(opts.regex);
  return ensured.flags;
}

type GrepPipelineSetup = {
  regex: RegExp;
  multiline: boolean;
  literal: string | null;
  recordMtimes: boolean;
  stats: GrepStats;
  walkSource: AsyncIterable<WalkEntry>;
  maxResults: number;
  stopOnFirst: boolean;
  maxLineLength: number;
  maxMatchesPerFile: number;
  pathPrefix: string;
  concurrency: number | undefined;
  signal: AbortSignal | undefined;
};

/**
 * Resolve defaults, compile the regex, extract a literal prefilter,
 * compile include/exclude matchers, and wire the walker. Shared by
 * `grepFiles` and `collectGrep` — divergence between the two would
 * be a silent correctness bug.
 *
 * Literal extraction runs on `regex.source` (the compiled form), not
 * the raw user pattern. `compilePattern` rewrites scoped inline flags
 * like `(?i:foo|bar)baz` into `foo|barbaz` + `i` flag — extracting
 * from the original would miss the top-level alternation and pick a
 * bogus required literal, silently dropping one branch of matches.
 */
function setupGrepPipeline(opts: GrepOptions): GrepPipelineSetup {
  const multiline = opts.multiline ?? true;
  const regex = compilePattern(opts.pattern, {
    caseSensitive: opts.caseSensitive,
    multiline,
  });
  const literal = extractInnerLiteral(regex.source, regex.flags);

  const includes = compileMatchers(opts.include);
  const excludes = compileMatchers(opts.exclude);
  const includeBinary = opts.includeBinary ?? false;

  const root = walkerRoot(opts.cwd, opts.path);
  const walkOpts = buildWalkOptions(opts, root);

  const stats = createStats();
  const walkSource = applyGrepFilters(
    tapWalkerStats(walkFiles(walkOpts), stats),
    { includes, excludes, includeBinary, stats }
  );

  return {
    regex,
    multiline,
    literal,
    recordMtimes: opts.recordMtimes ?? false,
    stats,
    walkSource,
    maxResults: opts.maxResults ?? Number.POSITIVE_INFINITY,
    stopOnFirst: opts.stopOnFirst ?? false,
    maxLineLength: opts.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH,
    maxMatchesPerFile: opts.maxMatchesPerFile ?? Number.POSITIVE_INFINITY,
    pathPrefix: opts.path ?? "",
    concurrency: opts.concurrency,
    signal: opts.signal,
  };
}

/**
 * Stream one `GrepMatch` per matching line under `opts.cwd`.
 * Consumer `break` halts in-flight work. Throws `ValidationError`
 * on bad regex input; propagates `AbortError` from `opts.signal`.
 */
// biome-ignore lint/suspicious/useAwait: yield* delegates to async generator
export async function* grepFiles(opts: GrepOptions): AsyncGenerator<GrepMatch> {
  const setup = setupGrepPipeline(opts);

  yield* grepFilesInternal({
    regex: setup.regex,
    perFile: {
      regex: setup.regex,
      multiline: setup.multiline,
      maxLineLength: setup.maxLineLength,
      maxMatchesPerFile: setup.maxMatchesPerFile,
      pathPrefix: setup.pathPrefix,
      literal: setup.literal,
      recordMtimes: setup.recordMtimes,
    },
    walkSource: setup.walkSource,
    stats: setup.stats,
    concurrent: {
      concurrency: setup.concurrency,
      signal: setup.signal,
    },
    maxResults: setup.maxResults,
    stopOnFirst: setup.stopOnFirst,
  });
}

/**
 * Drain `grepFiles` into a sorted-by-[path, lineNum] array plus
 * aggregate stats. Primary entry point for Promise-returning callers
 * (init wizard, diagnostic scripts).
 */
export async function collectGrep(opts: GrepOptions): Promise<GrepResult> {
  const setup = setupGrepPipeline(opts);

  // Probe for one extra match past `maxResults` so we can distinguish
  // "exactly N matches existed" from "more existed but we stopped."
  // Without the +1 probe the iterator flips `truncated = true` the
  // moment it emits the N-th match, regardless of whether an (N+1)-th
  // was available.
  const probeLimit = Number.isFinite(setup.maxResults)
    ? Math.min(Number.MAX_SAFE_INTEGER, setup.maxResults + 1)
    : Number.POSITIVE_INFINITY;

  const matches: GrepMatch[] = [];
  let truncated = false;
  for await (const match of grepFilesInternal({
    regex: setup.regex,
    perFile: {
      regex: setup.regex,
      multiline: setup.multiline,
      maxLineLength: setup.maxLineLength,
      maxMatchesPerFile: setup.maxMatchesPerFile,
      pathPrefix: setup.pathPrefix,
      literal: setup.literal,
      recordMtimes: setup.recordMtimes,
    },
    walkSource: setup.walkSource,
    stats: setup.stats,
    concurrent: {
      concurrency: setup.concurrency,
      signal: setup.signal,
    },
    maxResults: probeLimit,
    stopOnFirst: setup.stopOnFirst,
  })) {
    if (matches.length >= setup.maxResults) {
      truncated = true;
      break;
    }
    matches.push(match);
  }
  matches.sort(compareMatches);
  // Preserve stopOnFirst-path flag (iterator already set it in that
  // case); otherwise reflect the collector-level truncation.
  if (truncated) {
    setup.stats.truncated = true;
  }
  return { matches, stats: setup.stats };
}

function compareMatches(a: GrepMatch, b: GrepMatch): number {
  if (a.path < b.path) {
    return -1;
  }
  if (a.path > b.path) {
    return 1;
  }
  return a.lineNum - b.lineNum;
}
