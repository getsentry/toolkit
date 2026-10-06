/**
 * Streaming DFS directory walker with time-budgeted exploration.
 *
 * ### Contract
 *
 * `walkFiles(opts)` returns an `AsyncIterable<WalkEntry>` yielding one
 * entry per regular file under `opts.cwd`. Directories are traversed
 * but never yielded. Symbolic links are skipped unless
 * `followSymlinks: true`. Paths are POSIX-normalized.
 *
 * ### Depth + time budget
 *
 * The walker visits every directory at depth ≤ `minDepth` regardless
 * of wall-clock — that's the exhaustive-scan guarantee. Beyond
 * `minDepth`, each candidate descent is gated on
 * `clock() - startedAt ≤ timeBudgetMs`. When the budget is blown,
 * already-queued directories at any depth still drain (their contents
 * are yielded) but no new dirs at `depth > minDepth` are pushed.
 *
 * Traversal is DFS. Entries within a directory are sorted
 * lexicographically so yield order is deterministic across
 * filesystems — tests depend on this.
 *
 * ### Ignore integration
 *
 * The walker consults the provided `IgnoreMatcher` before descending
 * into a directory (so `node_modules` et al. are never opened) and
 * before yielding each file. Nested `.gitignore` files are loaded
 * lazily: after `readdir`, the walker scans the dentry list for a
 * `.gitignore` file and only calls `matcher.loadFromDir(absDir)`
 * when one is present. This avoids a failing `Bun.file(...).text()`
 * on every subdirectory without a `.gitignore` — the dominant cost
 * we found in PR 1's benchmark.
 *
 * ### AbortSignal
 *
 * When `signal.aborted` becomes true, the generator throws a
 * `DOMException("Walk aborted", "AbortError")` on its next advance.
 * Entries already yielded remain valid.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { handleFileError } from "../dsn/fs-utils.js";
import { logger } from "../logger.js";
import { classifyByExtension, readHeadAndSniff } from "./binary.js";
import {
  DEFAULT_SKIP_DIRS,
  MAX_FILE_SIZE,
  TEXT_EXTENSIONS,
} from "./constants.js";
import { IgnoreStack } from "./ignore.js";
import type { IgnoreMatcher, WalkEntry, WalkOptions } from "./types.js";

const log = logger.withTag("scan-walk");

/**
 * Native path separator cached to avoid `path.sep` property lookup
 * on every entry in the hot loop. `/` on POSIX, `\` on Windows.
 */
const NATIVE_SEP = path.sep;
/** True when the native separator is POSIX (`/`) — skip normalizePath. */
const POSIX_NATIVE = NATIVE_SEP === path.posix.sep;

/** Entry on the walker's DFS stack. */
type DirFrame = {
  absDir: string;
  /** Depth of this directory. Files inside it are at `depth + 1`. */
  depth: number;
};

/** Telemetry-ish counters collected over a single walk. */
type WalkStats = {
  filesYielded: number;
  dirsVisited: number;
  filesSkippedBySize: number;
  filesSkippedByBinary: number;
  hitTimeBudget: boolean;
  maxDepthReached: number;
};

/**
 * Aggregate of everything the per-entry helpers need. Collecting these
 * into one record keeps each helper's arity small — Biome's
 * `useMaxParams` rule caps us at 4 (plus `this`), and individually
 * passing cfg/matcher/stats/stack/budget state would blow past that.
 */
type WalkContext = {
  cfg: NormalizedOptions;
  matcher: IgnoreMatcher;
  stats: WalkStats;
  startedAt: number;
  /**
   * LIFO work stack of directory frames. Use `pushFrame` (below) to
   * enqueue — it exists so the parallel walker can hook into new
   * descents and wake idle workers. `stack.pop` is the only read
   * path; both walkers use it directly.
   *
   * LIFO preserves DFS semantics, which early-exit callers
   * (`scanCodeForFirstDsn`) rely on to reach DSN-bearing files
   * quickly. Under high concurrency the traversal is effectively
   * interleaved DFS per worker, which still reaches depth quickly.
   */
  stack: DirFrame[];
  /**
   * Enqueue a directory frame for later processing. Abstracted from
   * the raw `stack.push` so the parallel walker can signal idle
   * workers on every new descent without monkey-patching the Array
   * prototype. The serial walker's default is a plain `stack.push`.
   */
  pushFrame: (frame: DirFrame) => void;
  visitedInodes: Set<string>;
  /**
   * Precomputed `cfg.cwd.length + 1` — used to slice the cwd prefix
   * off absolute paths to produce relative paths. Cached on the
   * context so the hot loop doesn't recompute.
   */
  cwdPrefixLen: number;
};

/**
 * Walk `opts.cwd` recursively and yield every file that passes the
 * extension + size + ignore filters, up to the configured depth / time
 * budget.
 */
export function walkFiles(opts: WalkOptions): AsyncIterable<WalkEntry> {
  return {
    [Symbol.asyncIterator]() {
      return walkFilesImpl(opts);
    },
  };
}

/**
 * Process one directory frame: readdir, load nested `.gitignore`,
 * fire `onDirectoryVisit`, then dispatch to `processEntry` for each
 * dirent. `processEntry` pushes child dirs via `ctx.pushFrame` and
 * returns a `WalkEntry` when a file should be emitted via `push`.
 *
 * Used by `walkParallel` (N workers call this concurrently).
 * `walkSerial` inlines the same logic with a direct `yield` for
 * lower per-dir overhead on short walks.
 *
 * `isCancelled()` is polled at every await boundary AND between
 * per-entry iterations of the final for-loop, so a
 * consumer-initiated `break` (e.g. a capped `collectGrep` hitting
 * `maxResults`) cuts short the remaining work in the current
 * directory — crucial because one slow `readdir` on a big
 * directory would otherwise commit the worker to finishing every
 * entry before noticing.
 */
async function processDir(
  frame: DirFrame,
  ctx: WalkContext,
  push: (entry: WalkEntry) => void,
  isCancelled: () => boolean
): Promise<void> {
  const { cfg, matcher, stats } = ctx;
  stats.dirsVisited += 1;
  stats.maxDepthReached = Math.max(stats.maxDepthReached, frame.depth);

  const entries = await listDirEntries(frame.absDir, cfg.concurrency);
  if (isCancelled()) {
    return;
  }

  // Dentry-driven nested .gitignore loading: ONLY call loadFromDir
  // when a .gitignore file is actually present. Load sequentially
  // BEFORE processing children so per-entry `isIgnored` checks see
  // this directory's rules.
  if (
    cfg.nestedGitignore &&
    frame.absDir !== cfg.cwd &&
    hasGitignore(entries)
  ) {
    await matcher.loadFromDir(frame.absDir);
    if (isCancelled()) {
      return;
    }
  }

  // onDirectoryVisit hook fires after the dir's rules are loaded but
  // before any of its entries are processed — matches the pre-parallel
  // contract tests depend on.
  if (cfg.onDirectoryVisit) {
    await notifyDirectoryVisit(frame.absDir, cfg.onDirectoryVisit);
    if (isCancelled()) {
      return;
    }
  }

  // Process entries serially within the directory. Parallelism
  // happens at the directory level — we have dozens-to-thousands of
  // dirs in flight; within each dir the per-entry work is cheap
  // (classify, stat, push). `isCancelled` is polled between entries
  // so a consumer-initiated `break` cuts the loop promptly — the
  // `await processEntry` itself can't be interrupted.
  for (const entry of entries) {
    if (isCancelled()) {
      return;
    }
    const result = await processEntry(entry, frame, ctx);
    if (result !== null) {
      push(result);
    }
  }
}

/**
 * Dispatch to the serial or parallel walker based on `cfg.concurrency`.
 *
 * Serial (`concurrency === 1`) is optimal for early-exit consumers:
 * each per-entry `yield` is direct (no channel hop) and uses sync
 * `readdirSync`, so `scanCodeForFirstDsn` reaches the first DSN in
 * ~2 ms on the synthetic/large fixture. The parallel path has a
 * ~7 ms per-file channel-coordination overhead that dominates for
 * short walks.
 *
 * Parallel (`concurrency > 1`) overlaps async `readdir` across
 * directories, halving exhaustive scan times on fixtures with
 * thousands of dirs (e.g. `scanCodeForDsns`: 238 → 175 ms).
 */
async function* walkFilesImpl(opts: WalkOptions): AsyncGenerator<WalkEntry> {
  const cfg = normalizeOptions(opts);
  const matcher = await buildMatcher(cfg);
  const stats: WalkStats = {
    filesYielded: 0,
    dirsVisited: 0,
    filesSkippedBySize: 0,
    filesSkippedByBinary: 0,
    hitTimeBudget: false,
    maxDepthReached: 0,
  };
  const startedAt = cfg.clock();
  const visitedInodes = new Set<string>();
  // Seed the root's inode so a descendant symlink pointing back at the scan
  // root is treated as a cycle. The root frame is pushed directly (below)
  // rather than through `maybeDescend`, which is the only place inodes are
  // otherwise recorded — so without this seed a symlink → root would re-list
  // the root's entire subtree under a second path prefix. Only relevant when
  // following symlinks; the default walk never re-enters a directory.
  if (cfg.followSymlinks) {
    const rootKey = await inodeKey(cfg.cwd);
    if (rootKey) {
      visitedInodes.add(rootKey);
    }
  }
  const stack: DirFrame[] = [{ absDir: cfg.cwd, depth: 0 }];
  const ctx: WalkContext = {
    cfg,
    matcher,
    stats,
    startedAt,
    stack,
    // Default for the serial walker — a plain push. The parallel
    // walker reassigns this inside its generator to also signal
    // idle workers.
    pushFrame: (frame: DirFrame) => {
      stack.push(frame);
    },
    visitedInodes,
    cwdPrefixLen: cfg.cwd.length + 1,
  };

  try {
    if (cfg.concurrency <= 1) {
      yield* walkSerial(ctx);
    } else {
      yield* walkParallel(ctx);
    }
  } finally {
    log.debug(
      "walk done: yielded=%d dirs=%d hitBudget=%s maxDepth=%d elapsed=%dms concurrency=%d",
      stats.filesYielded,
      stats.dirsVisited,
      stats.hitTimeBudget,
      stats.maxDepthReached,
      Math.round(cfg.clock() - startedAt),
      cfg.concurrency
    );
  }
}

/**
 * Serial DFS walker — the fast path for early-exit consumers.
 *
 * Direct `yield` per entry (no producer-consumer channel) means a
 * generator `break` stops everything immediately. `listDirEntries`
 * uses sync `readdirSync` when `cfg.concurrency === 1`, trading away
 * async I/O overlap (unused here) for lower per-call latency.
 *
 * This path is byte-for-byte the pre-parallel walker's body; the
 * parallel path adds a different coordinator on top of the same
 * per-entry helpers (`processEntry`, `maybeDescend`, `tryYieldFile`).
 */
async function* walkSerial(ctx: WalkContext): AsyncGenerator<WalkEntry> {
  const { cfg, matcher, stack } = ctx;
  while (stack.length > 0) {
    checkAborted(cfg.signal);
    const frame = stack.pop() as DirFrame;
    ctx.stats.dirsVisited += 1;
    ctx.stats.maxDepthReached = Math.max(
      ctx.stats.maxDepthReached,
      frame.depth
    );

    const entries = await listDirEntries(frame.absDir, cfg.concurrency);

    if (
      cfg.nestedGitignore &&
      frame.absDir !== cfg.cwd &&
      hasGitignore(entries)
    ) {
      await matcher.loadFromDir(frame.absDir);
    }
    if (cfg.onDirectoryVisit) {
      await notifyDirectoryVisit(frame.absDir, cfg.onDirectoryVisit);
    }
    for (const entry of entries) {
      const result = await processEntry(entry, frame, ctx);
      if (result !== null) {
        yield result;
      }
    }
  }
}

/**
 * Parallel walker — N workers pull from a shared LIFO stack,
 * overlapping async `readdir` across directories. A producer-
 * consumer channel buffers emits so the generator can yield in
 * completion order.
 *
 * Adds ~7 ms per-file channel overhead vs the serial walker, so
 * it's only worth using for bulk scans (dozens-plus of dirs).
 * Callers that early-exit should use `concurrency: 1`.
 */
async function* walkParallel(ctx: WalkContext): AsyncGenerator<WalkEntry> {
  const { cfg, stack } = ctx;

  // --- Two coordination channels ---
  //
  // Consumer channel: workers push WalkEntry objects via `push(entry)`,
  // the generator drains them between awaits on `consumerAwake`.
  //
  // Worker channel: idle workers park on `workerAwake` until
  // `signalWorkers()` fires — either because a `maybeDescend` pushed
  // a new frame, a peer worker completed (activeWorkers changed), or
  // cancellation is requested. `signalWorkers` uses the swap-then-
  // resolve pattern (see its definition below) so a late awaiter
  // can't latch onto a stale resolved Promise and miss the next
  // state transition.
  //
  // The two-channel design avoids the busy-spin (N-1 workers
  // `setImmediate`ing every tick while one peer holds the stack
  // empty during `await readdir`) that a single shared channel
  // would produce.

  const pending: WalkEntry[] = [];
  let wakeConsumer: () => void = () => {
    /* reassigned below */
  };
  let consumerAwake: Promise<void> = new Promise<void>((r) => {
    wakeConsumer = r;
  });
  const resetConsumerAwake = () => {
    consumerAwake = new Promise<void>((r) => {
      wakeConsumer = r;
    });
  };
  const push = (entry: WalkEntry): void => {
    pending.push(entry);
    wakeConsumer();
  };

  // Worker wake channel. All idle workers await the same Promise;
  // `signalWorkers()` replaces it with a fresh unresolved one and
  // resolves the old one, which wakes every current awaiter in the
  // same microtask batch. The "swap before resolve" order matters:
  // a worker that starts awaiting between the resolve and a later
  // signal would otherwise latch onto a stale resolved Promise and
  // miss the state transition it was waiting for.
  //
  // Every state transition that could unblock a waiting worker
  // — a new frame pushed via `pushFrame`, a peer worker exiting
  // that leaves `activeWorkers === 0`, or cancellation — calls
  // `signalWorkers()`. Workers re-check `stack`/`activeWorkers`/
  // `cancelled` at the top of every loop iteration, so a missed
  // wake would be a deadlock — there's no other mechanism to
  // un-park them.
  let wakeWorkers: () => void = () => {
    /* reassigned below */
  };
  let workerAwake: Promise<void> = new Promise<void>((r) => {
    wakeWorkers = r;
  });
  const signalWorkers = (): void => {
    const resolve = wakeWorkers;
    workerAwake = new Promise<void>((r) => {
      wakeWorkers = r;
    });
    resolve();
  };

  // Plumbing: `maybeDescend` pushes directly to `ctx.stack`. The
  // serial walker's behavior is unchanged (stack is literal). The
  // parallel walker needs to notice new frames and signal idle
  // workers. Rather than overload `stack.push` (monkey-patching an
  // Array instance is fragile), we route ALL descents through a
  // dedicated `pushFrame` on the context. Both serial and parallel
  // use it; parallel adds the `signalWorkers()` hook.
  //
  // The `ctx` object is local to `walkFilesImpl` and is GC'd after
  // the generator exits, so we don't bother restoring the original
  // `pushFrame` on shutdown.
  ctx.pushFrame = (frame: DirFrame): void => {
    stack.push(frame);
    signalWorkers();
  };

  let activeWorkers = 0;
  let producerError: unknown = null;
  let cancelled = false;
  const workerCount = cfg.concurrency;
  const workers: Promise<void>[] = [];

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: worker lifecycle (cancelled, abort, idle-wait, error path, wake coordination) is inherently branchy
  const runWorker = async (): Promise<void> => {
    while (true) {
      // Outer try catches:
      //   - AbortError from `checkAborted` (crucially including the
      //     first iteration when the signal was pre-fired);
      //   - any thrown error from `processDir` (both FS and
      //     non-FS bubbling past `handleFileError`).
      // Without catching here, a pre-fired abort would propagate
      // out of the worker before `activeWorkers` is ever
      // incremented and before `producerError`/`cancelled` are
      // set — the consumer would then hang on `consumerAwake`
      // because the termination predicate never sees a producer
      // error and the worker never decrements counters.
      try {
        if (cancelled) {
          return;
        }
        checkAborted(cfg.signal);
        // Pop (LIFO/DFS) rather than shift (FIFO/BFS) — matches the
        // serial walker's traversal order so early-exit behavior is
        // comparable at any concurrency setting.
        const frame = stack.pop();
        if (!frame) {
          // Stack empty — exit only if no other worker is processing
          // (i.e. nobody can `maybeDescend` new work). Otherwise park
          // on the worker channel until a descent or cancellation
          // fires. `signalWorkers` swaps in a fresh unresolved
          // Promise before resolving the old one, so late awaiters
          // can't latch onto a stale resolution.
          if (activeWorkers === 0) {
            return;
          }
          await workerAwake;
          continue;
        }
        activeWorkers += 1;
        try {
          await processDir(frame, ctx, push, () => cancelled);
        } finally {
          activeWorkers -= 1;
          // If we were the last active worker with an empty stack,
          // nobody else can enqueue work — wake any idle peers so
          // they observe `activeWorkers === 0` and exit.
          if (activeWorkers === 0 && stack.length === 0) {
            signalWorkers();
          }
          // Always wake the consumer so it can detect "all workers
          // done" and terminate.
          wakeConsumer();
        }
      } catch (error) {
        // FS errors are swallowed inside `listDirEntries` /
        // `notifyDirectoryVisit` via `handleFileError`. Anything
        // reaching here is either (a) a pre-fired or mid-walk
        // `AbortError` from `checkAborted`, or (b) a genuinely
        // unexpected non-FS error.
        producerError = error;
        // Cascade: peers can't do useful work, so short-circuit
        // them. The consumer sees `producerError` and throws.
        cancelled = true;
        signalWorkers();
        wakeConsumer();
        return;
      }
    }
  };

  for (let i = 0; i < workerCount; i += 1) {
    workers.push(runWorker());
  }

  // If every worker throws synchronously before entering its
  // try/finally (e.g. a pre-fired `signal.aborted` hits the
  // `checkAborted` at the top of the loop), their per-worker
  // `finally` wakeConsumer never fires. This outer chain guarantees
  // the consumer observes the "all done" state regardless.
  const allWorkersDone = Promise.all(workers).finally(() => {
    wakeConsumer();
  });

  try {
    while (true) {
      if (pending.length > 0) {
        while (pending.length > 0) {
          yield pending.shift() as WalkEntry;
          checkAborted(cfg.signal);
        }
        continue;
      }
      if (producerError !== null) {
        throw producerError;
      }
      if (stack.length === 0 && activeWorkers === 0) {
        break;
      }
      await consumerAwake;
      resetConsumerAwake();
    }
  } finally {
    // Stop pumping. Workers exit naturally once they notice
    // `cancelled` on their next loop iteration; we await them so
    // any lingering FS operations complete before returning
    // control to the caller.
    cancelled = true;
    signalWorkers();
    wakeConsumer();
    await allWorkersDone;
  }
}

/**
 * Process a single directory entry: skip / descend / yield.
 *
 * Extracted from the generator body purely to keep cognitive complexity
 * under Biome's ceiling. Mutates `ctx.stats`, pushes directories onto
 * `ctx.stack`, and returns a `WalkEntry` when a file should be yielded.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: filter cascade (hidden, symlink, dir, file, ignore, ext) is inherently branchy
async function processEntry(
  entry: Dirent,
  frame: DirFrame,
  ctx: WalkContext
): Promise<WalkEntry | null> {
  const { cfg, matcher } = ctx;
  if (!cfg.hidden && entry.name.startsWith(".")) {
    return null;
  }
  if (entry.isSymbolicLink() && !cfg.followSymlinks) {
    return null;
  }
  // String-concat `abs` rather than `path.join` — measured ~10× faster
  // in V8 (no normalization pass on inputs we already know are clean:
  // `frame.absDir` is absolute-and-unslashed, `entry.name` has no
  // separators per POSIX dirent semantics).
  const abs = frame.absDir + NATIVE_SEP + entry.name;
  // Slice under `cwd` rather than `path.relative` — measured ~11×
  // faster. Safe here because every `abs` is guaranteed to be under
  // `cfg.cwd` by construction (we only descend from `cwd`). On
  // Windows, convert native `\` to POSIX `/` for downstream
  // consumers (the `ignore` package requires POSIX paths).
  const relNative = abs.slice(ctx.cwdPrefixLen);
  const rel = POSIX_NATIVE ? relNative : relNative.replaceAll(NATIVE_SEP, "/");

  // For regular dirs/files, the Dirent already tells us the type.
  // For symlinks (when `followSymlinks: true`), we need to `stat()`
  // the target to learn whether it resolves to a file or a directory.
  // `readdir({withFileTypes})` uses lstat semantics: `isSymbolicLink`
  // returns true while `isFile`/`isDirectory` are both false. Without
  // this extra stat, symlinks would fall through `isDirectory()` +
  // `isFile()` and be silently dropped.
  let isDir: boolean;
  let isFile: boolean;
  if (entry.isSymbolicLink() && cfg.followSymlinks) {
    const resolved = await statSymlinkTarget(abs);
    if (!resolved) {
      // Broken symlink or stat error — skip (matches rg's behavior).
      return null;
    }
    isDir = resolved.isDirectory;
    isFile = resolved.isFile;
  } else {
    isDir = entry.isDirectory();
    isFile = entry.isFile();
  }

  if (isDir) {
    await maybeDescend(abs, rel, frame.depth, ctx);
    return null;
  }
  if (!isFile) {
    return null;
  }
  // `maxDepth` controls directory descent, not file yield. Once the
  // walker has entered a dir, every file inside it is eligible —
  // matches Unix `find -maxdepth` semantics.
  const fileDepth = frame.depth + 1;
  if (matcher.isIgnored(rel, false)) {
    return null;
  }
  if (cfg.extensions !== undefined) {
    // Manual extname — `path.extname + toLowerCase` costs ~9ms for
    // 13k calls in V8 (lots of branches checking for . and
    // separator boundaries); `lastIndexOf + slice + toLowerCase`
    // costs ~7ms. Not a huge win per-call but adds up on hot walks.
    const name = entry.name;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) {
      return null;
    }
    const ext = name.slice(dot).toLowerCase();
    if (!cfg.extensions.has(ext)) {
      return null;
    }
  }
  return tryYieldFile(
    { absPath: abs, relPath: rel, fileDepth },
    cfg,
    ctx.stats
  );
}

/** Push a child directory onto the stack if filters allow. */
async function maybeDescend(
  abs: string,
  rel: string,
  parentDepth: number,
  ctx: WalkContext
): Promise<void> {
  const { cfg, matcher } = ctx;
  // Default descent is depth + 1; callers (e.g. DSN scanner) can
  // override via `descentHook` to reset depth at monorepo package
  // boundaries. The hook receives the PARENT's depth, not the child's.
  const nextDepth = cfg.descentHook(rel, parentDepth);
  if (nextDepth > cfg.maxDepth) {
    return;
  }
  if (matcher.isIgnored(rel, true)) {
    return;
  }
  // Time-budget check: the walker guarantees every directory at depth
  // ≤ `minDepth` is fully explored regardless of wall-clock. Beyond
  // that, we skip new descents once the budget is blown. `nextDepth`
  // (not parentDepth) is what matters — we're deciding whether to
  // visit the child at nextDepth.
  if (
    nextDepth > cfg.minDepth &&
    cfg.clock() - ctx.startedAt > cfg.timeBudgetMs
  ) {
    ctx.stats.hitTimeBudget = true;
    return;
  }
  if (cfg.followSymlinks) {
    const key = await inodeKey(abs);
    if (key && ctx.visitedInodes.has(key)) {
      return;
    }
    if (key) {
      ctx.visitedInodes.add(key);
    }
  }
  // Nested-.gitignore loading is done by `processDir` based on the
  // child's dentry list — not here. See the `hasGitignore` call.
  ctx.pushFrame({ absDir: abs, depth: nextDepth });
}

/**
 * True if the dentry list contains a regular file named `.gitignore`.
 * A cheap dentry scan avoids the failing `Bun.file().text()` attempt
 * on every directory that doesn't have one — the dominant cost in
 * PR 1's benchmark.
 */
function hasGitignore(entries: readonly Dirent[]): boolean {
  for (const entry of entries) {
    if (entry.name === ".gitignore" && entry.isFile()) {
      return true;
    }
  }
  return false;
}

/** Loose bundle of path + depth for `tryYieldFile`. */
type FileCoords = {
  absPath: string;
  relPath: string;
  fileDepth: number;
};

/**
 * Classify, stat, and build a `WalkEntry`. Returns null on fs errors.
 *
 * Uses `statSync` rather than `Bun.file(absPath).size` / `.lastModified`.
 * Measured ~15% faster per call (30ms vs 36ms for 10k files in the
 * synthetic/large fixture) because it avoids the `Bun.file()` handle
 * allocation when we only want stat data. When `recordMtimes: false`
 * (the grep default), the same single `statSync` call serves both
 * the size check and the stat read — no extra syscall needed.
 */
async function tryYieldFile(
  coords: FileCoords,
  cfg: NormalizedOptions,
  stats: WalkStats
): Promise<WalkEntry | null> {
  let statResult: { size: number; mtimeMs: number };
  try {
    const s = statSync(coords.absPath);
    statResult = { size: s.size, mtimeMs: s.mtimeMs };
  } catch (error) {
    handleFileError(error, {
      operation: "scan.walk.stat",
      path: coords.absPath,
    });
    return null;
  }

  if (statResult.size > cfg.maxFileSize) {
    stats.filesSkippedBySize += 1;
    return null;
  }

  try {
    const isBinary = await classifyFile(coords.absPath, statResult.size, cfg);
    stats.filesYielded += 1;
    return {
      absolutePath: coords.absPath,
      relativePath: coords.relPath,
      size: statResult.size,
      // Floor mtimeMs so DSN cache keys (which compare on floored
      // values — see `code-scanner.ts::sourceMtimes` docs) stay
      // stable across invocations. Raw mtimeMs is a float that can
      // differ by ~1e-6 between reads of the same inode.
      mtime: cfg.recordMtimes ? Math.floor(statResult.mtimeMs) : 0,
      isBinary,
      depth: coords.fileDepth,
    };
  } catch (error) {
    handleFileError(error, {
      operation: "scan.walk.readFile",
      path: coords.absPath,
    });
    return null;
  }
}

/**
 * Classify a file as binary via extension fast-path or 8 KB NUL sniff.
 *
 * Skip the sniff for:
 *   (a) callers that opted out via `classifyBinary: false` — they ignore
 *       `isBinary`, so no read is worth doing;
 *   (b) callers that provided an `extensions` allowlist — the file
 *       already passed it, so by construction the caller considers
 *       its extension text-bearing;
 *   (c) known text extensions (`TEXT_EXTENSIONS`);
 *   (d) empty files.
 *
 * Ordering matters: (a)/(b) run first so we never read file contents (or
 * even re-compute `path.extname` + `Set.has`) for the hot DSN-scan path
 * where `processEntry` has already matched the extension.
 */
async function classifyFile(
  absPath: string,
  size: number,
  cfg: NormalizedOptions
): Promise<boolean> {
  if (!cfg.classifyBinary) {
    // (a) caller ignores `isBinary` — skip all classification work.
    return false;
  }
  if (cfg.extensions !== undefined) {
    // (b) caller filtered — skip re-classification.
    return false;
  }
  const byExt = classifyByExtension(absPath, TEXT_EXTENSIONS);
  if (byExt !== null) {
    return byExt.isBinary;
  }
  if (size === 0) {
    return false;
  }
  try {
    const result = await readHeadAndSniff(absPath);
    return result.isBinary;
  } catch (error) {
    handleFileError(error, {
      operation: "scan.walk.classifyFile",
      path: absPath,
    });
    // Fail closed: treat as binary when we can't read, so callers that
    // ignore binaries won't trip on an unreadable file.
    return true;
  }
}

/** Lexicographic compare on `entry.name` for stable iteration order. */
function compareByName(a: Dirent, b: Dirent): number {
  if (a.name < b.name) {
    return -1;
  }
  if (a.name > b.name) {
    return 1;
  }
  return 0;
}

/**
 * Read all entries in a directory, sorted by name.
 *
 * Async `readdir` lets the concurrent walker overlap many calls across
 * the worker pool (~5× faster than sync on cold-cache scans) but is
 * ~2.5× slower than sync `readdirSync` per-call. At `concurrency === 1`
 * there's no overlap to exploit, so we switch to the sync variant —
 * which is the serial fast-path for early-exit consumers like
 * `scanCodeForFirstDsn`.
 *
 * Sort keeps per-directory yield order filesystem-independent. Inter-
 * directory yield order is nondeterministic across concurrent runs;
 * tests that compare against fixtures should sort the collected paths.
 */
async function listDirEntries(
  dir: string,
  concurrency: number
): Promise<Dirent[]> {
  try {
    const entries =
      concurrency === 1
        ? readdirSync(dir, { withFileTypes: true })
        : await readdir(dir, { withFileTypes: true });
    entries.sort(compareByName);
    return entries;
  } catch (error) {
    handleFileError(error, { operation: "scan.walk.readdir", path: dir });
    return [];
  }
}

/**
 * Fire the `onDirectoryVisit` observer with the directory's
 * `Math.floor(stat.mtimeMs)`. Errors are routed through
 * `handleFileError` and swallowed — a stat failure shouldn't abort
 * the walk.
 *
 * Uses `node:fs.stat` because `Bun.file()` doesn't support
 * directories. Flooring matches `src/lib/db/dsn-cache.ts`'s
 * `validateDirMtime`.
 */
async function notifyDirectoryVisit(
  absDir: string,
  hook: (dir: string, mtimeMs: number) => void
): Promise<void> {
  try {
    const s = await stat(absDir);
    hook(absDir, Math.floor(s.mtimeMs));
  } catch (error) {
    handleFileError(error, {
      operation: "scan.walk.dirMtime",
      path: absDir,
    });
  }
}

/** stat-based `dev:ino` key for symlink cycle detection. */
async function inodeKey(absPath: string): Promise<string | null> {
  try {
    const s = await stat(absPath);
    return `${s.dev}:${s.ino}`;
  } catch (error) {
    handleFileError(error, { operation: "scan.walk.inodeKey", path: absPath });
    return null;
  }
}

/**
 * Resolve what a symlink points to. Returns `null` when the target
 * is missing (broken symlink) or the stat otherwise fails — in both
 * cases the caller should skip the entry the way ripgrep does.
 *
 * Uses `stat` (which follows symlinks) rather than `lstat` so we see
 * the target's true kind. Cycle detection happens later in
 * `maybeDescend` via `inodeKey`.
 */
async function statSymlinkTarget(
  absPath: string
): Promise<{ isFile: boolean; isDirectory: boolean } | null> {
  try {
    const s = await stat(absPath);
    return { isFile: s.isFile(), isDirectory: s.isDirectory() };
  } catch (error) {
    // ENOENT (broken symlink) is the expected failure case — swallow.
    // Other errors go through handleFileError so Sentry sees them.
    handleFileError(error, {
      operation: "scan.walk.statSymlinkTarget",
      path: absPath,
    });
    return null;
  }
}

/** Throw an AbortError if the caller's signal has fired. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // DOMException is available in Bun and Node >= 17.
    throw new DOMException("Walk aborted", "AbortError");
  }
}

type NormalizedOptions = {
  cwd: string;
  extensions: ReadonlySet<string> | undefined;
  alwaysSkipDirs: readonly string[];
  hidden: boolean;
  respectGitignore: boolean;
  nestedGitignore: boolean;
  maxFileSize: number;
  minDepth: number;
  maxDepth: number;
  descentHook: (relPath: string, currentDepth: number) => number;
  followSymlinks: boolean;
  signal: AbortSignal | undefined;
  concurrency: number;
  timeBudgetMs: number;
  clock: () => number;
  recordMtimes: boolean;
  classifyBinary: boolean;
  onDirectoryVisit: ((absDir: string, mtimeMs: number) => void) | undefined;
};

/** Default descent: linear depth counting. */
const defaultDescentHook = (_relPath: string, currentDepth: number): number =>
  currentDepth + 1;

function normalizeOptions(opts: WalkOptions): NormalizedOptions {
  if (!path.isAbsolute(opts.cwd)) {
    throw new Error(`walkFiles: cwd must be absolute, got ${opts.cwd}`);
  }
  return {
    cwd: opts.cwd,
    extensions: opts.extensions,
    alwaysSkipDirs: opts.alwaysSkipDirs ?? DEFAULT_SKIP_DIRS,
    hidden: opts.hidden ?? true,
    respectGitignore: opts.respectGitignore ?? true,
    nestedGitignore: opts.nestedGitignore ?? true,
    maxFileSize: opts.maxFileSize ?? MAX_FILE_SIZE,
    minDepth: opts.minDepth ?? 0,
    maxDepth: opts.maxDepth ?? Number.POSITIVE_INFINITY,
    descentHook: opts.descentHook ?? defaultDescentHook,
    followSymlinks: opts.followSymlinks ?? false,
    signal: opts.signal,
    concurrency: normalizeConcurrency(opts.concurrency),
    timeBudgetMs: opts.timeBudgetMs ?? Number.POSITIVE_INFINITY,
    clock: opts.clock ?? (() => performance.now()),
    recordMtimes: opts.recordMtimes ?? false,
    classifyBinary: opts.classifyBinary ?? true,
    onDirectoryVisit: opts.onDirectoryVisit,
  };
}

/**
 * Default walker concurrency — overlaps async `readdir` I/O across
 * directories for bulk-scan speedups. Matches the
 * `CONCURRENCY_LIMIT` pattern used elsewhere (≥2, capped by CPU
 * count).
 *
 * Early-exit consumers that `break` after a few files should pass
 * `concurrency: 1` explicitly — the parallel walker's per-file
 * channel overhead costs more than an early-exit consumer saves;
 * the serial path uses direct `yield` and `readdirSync` instead.
 * See `walkFilesImpl`'s dispatch for the trade-off.
 */
export function bulkConcurrency(): number {
  return Math.max(2, availableParallelism());
}

/**
 * Clamp a user-supplied `concurrency` to a finite integer ≥ 1.
 * Treats `undefined`, `null`, `NaN`, `Infinity`, and ≤ 0 as "use
 * the default" so the dispatch in `walkFilesImpl` can't hang on
 * pathological inputs (e.g. `concurrency: NaN` → zero workers
 * spawned but `stack.length > 0` → consumer parks forever).
 */
function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return bulkConcurrency();
  }
  return Math.max(1, Math.floor(value));
}

function buildMatcher(cfg: NormalizedOptions): Promise<IgnoreMatcher> {
  return IgnoreStack.create({
    cwd: cfg.cwd,
    alwaysSkipDirs: cfg.alwaysSkipDirs,
    respectGitignore: cfg.respectGitignore,
    // Only relevant when respectGitignore: true; IgnoreStack handles
    // the gate internally but we pass an explicit value for clarity.
    includeGitInfoExclude: cfg.respectGitignore,
  });
}
