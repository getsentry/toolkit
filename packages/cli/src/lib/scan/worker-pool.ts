/**
 * Worker pool for parallel file-grep work.
 *
 * Lazy-initialized singleton. Workers are spawned unref'd and ref'd
 * per-dispatch so the process exits cleanly once all dispatches
 * settle — no explicit shutdown is required from callers.
 *
 * Feature-gated on `isWorkerSupported()`. On runtimes without
 * `Worker` / `Blob` / `URL.createObjectURL` (older Node), callers
 * fall back to the async `mapFilesConcurrent` path.
 */

import { availableParallelism } from "node:os";
// Worker source loaded as a string. At dev/test time, the module reads
// the file from disk via readFileSync. At build time, esbuild's
// text-import-plugin replaces the module with an inlined string constant.
import GREP_WORKER_SOURCE from "./grep-worker-source.js";
import type { GrepMatch } from "./types.js";

/** Batch dispatched to a worker. */
export type WorkerGrepRequest = {
  paths: string[];
  patternSource: string;
  flags: string;
  maxLineLength: number;
  maxMatchesPerFile: number;
  literal: string | null;
};

/** Packed result from a single worker batch. Rehydrate via `decodeWorkerMatches`. */
export type WorkerGrepResult = {
  /** Packed 4-u32-per-match (pathIdx, lineNum, lineOffset, lineLength). */
  ints: Uint32Array;
  /**
   * Concatenated line text as UTF-8 bytes. Decoded on the main side;
   * `ints[i*4 + 2]` / `+3` index into the decoded string.
   */
  linePoolBytes: Uint8Array;
};

/**
 * Per-worker state.
 *
 * Each worker has one `onmessage` handler and a FIFO `pending`
 * queue of result resolvers. `addEventListener`-per-dispatch would
 * cause every listener to fire on every `result` message — FIFO
 * shifting matches the order in which the worker processes requests.
 */
type PooledWorker = {
  worker: Worker;
  ready: Promise<void>;
  /** Number of dispatches currently in flight to this worker. */
  inflight: number;
  pending: Array<{
    resolve: (r: WorkerGrepResult) => void;
    reject: (e: unknown) => void;
  }>;
  /** Flipped to false on the first `error` event; dispatch skips dead workers. */
  alive: boolean;
};

type WorkerPool = {
  workers: PooledWorker[];
  dispatch(request: WorkerGrepRequest): Promise<WorkerGrepResult>;
  terminate(): void;
};

let pool: WorkerPool | null = null;

/**
 * True when the runtime supports `new Worker(url)` with a Blob-URL
 * source. Covers Bun (dev + single-file binary) and Node 22+ with
 * the DOM Worker shim.
 */
export function isWorkerSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

/**
 * Default pool size: `availableParallelism()` clamped to `[2, 8]`.
 * Bench (10k files, `import.*from`): 4 workers hits the knee
 * (~180ms p50 vs 316ms for 2; 8 workers saves ~10ms). Clamping
 * prevents over-spawn on high-core boxes where stat/read
 * contention dominates.
 */
export function getPoolSize(): number {
  return Math.max(2, Math.min(8, availableParallelism()));
}

/**
 * `.ref()` / `.unref()` on a Bun/Node worker if available. DOM
 * Worker shims may not expose them — guarded.
 *
 * Both calls are **idempotent booleans, not reference-counted** —
 * one `.unref()` releases the event-loop hold regardless of how
 * many `.ref()` calls preceded it. Call sites must guard on
 * `inflight === 0` to avoid premature unref.
 */
function refWorker(w: Worker): void {
  (w as unknown as { ref?: () => void }).ref?.();
}
function unrefWorker(w: Worker): void {
  (w as unknown as { unref?: () => void }).unref?.();
}

let cachedBlobUrl: string | null = null;
function getWorkerBlobUrl(): string {
  if (cachedBlobUrl !== null) {
    return cachedBlobUrl;
  }
  const blob = new Blob([GREP_WORKER_SOURCE], {
    type: "application/javascript",
  });
  cachedBlobUrl = URL.createObjectURL(blob);
  return cachedBlobUrl;
}

/**
 * Get or lazily create the worker pool. Throws if
 * `isWorkerSupported()` is false.
 */
export function getWorkerPool(): WorkerPool {
  if (pool !== null) {
    return pool;
  }
  if (!isWorkerSupported()) {
    throw new Error(
      "Worker pool requested but Workers are unavailable in this runtime"
    );
  }

  const size = getPoolSize();
  const url = getWorkerBlobUrl();
  const workers: PooledWorker[] = [];

  for (let i = 0; i < size; i += 1) {
    const w = new Worker(url);
    unrefWorker(w);
    const pw: PooledWorker = {
      worker: w,
      ready: new Promise<void>((resolve) => {
        const readyHandler = (event: MessageEvent) => {
          if (event.data?.type === "ready") {
            w.removeEventListener("message", readyHandler);
            resolve();
          }
        };
        w.addEventListener("message", readyHandler);
      }),
      inflight: 0,
      pending: [],
      alive: true,
    };
    w.addEventListener("message", (event) => {
      const data = event.data as { type?: string } & WorkerGrepResult;
      if (data.type !== "result") {
        return;
      }
      const next = pw.pending.shift();
      if (!next) {
        return;
      }
      pw.inflight -= 1;
      if (pw.inflight === 0) {
        unrefWorker(pw.worker);
      }
      next.resolve({ ints: data.ints, linePoolBytes: data.linePoolBytes });
    });
    w.addEventListener("error", (err) => {
      pw.alive = false;
      const errMsg = err.message ?? String(err);
      let slot = pw.pending.shift();
      while (slot !== undefined) {
        slot.reject(new Error(`worker error: ${errMsg}`));
        slot = pw.pending.shift();
      }
      pw.inflight = 0;
      unrefWorker(pw.worker);
    });
    workers.push(pw);
  }

  pool = {
    workers,
    dispatch(request: WorkerGrepRequest): Promise<WorkerGrepResult> {
      // Pick least-loaded live worker. Dead workers (error event fired)
      // are skipped — their `inflight` was reset to 0, which would
      // otherwise make them look "least loaded" and silently capture
      // all new dispatches.
      let best: PooledWorker | null = null;
      for (const pw of workers) {
        if (!pw.alive) {
          continue;
        }
        if (best === null || pw.inflight < best.inflight) {
          best = pw;
        }
      }
      if (best === null) {
        return Promise.reject(new Error("worker pool: all workers dead"));
      }
      const chosen = best;
      chosen.inflight += 1;
      refWorker(chosen.worker);

      // `ourSlot` is held by the closure so a readiness-failure
      // can remove THIS dispatch's slot by identity, not `pop()` /
      // `shift()` which would misassign errors to siblings.
      let ourSlot: PooledWorker["pending"][number];
      const result = new Promise<WorkerGrepResult>((resolve, reject) => {
        ourSlot = { resolve, reject };
        chosen.pending.push(ourSlot);
      });
      chosen.ready.then(
        () => {
          chosen.worker.postMessage(request);
        },
        (err) => {
          const idx = chosen.pending.indexOf(ourSlot);
          if (idx !== -1) {
            chosen.pending.splice(idx, 1);
            chosen.inflight -= 1;
            if (chosen.inflight === 0) {
              unrefWorker(chosen.worker);
            }
            ourSlot.reject(err);
          }
        }
      );
      return result;
    },
    terminate(): void {
      for (const pw of workers) {
        pw.alive = false;
        let slot = pw.pending.shift();
        while (slot !== undefined) {
          slot.reject(new Error("worker pool terminated"));
          slot = pw.pending.shift();
        }
        pw.inflight = 0;
        unrefWorker(pw.worker);
        // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
        try {
          pw.worker.terminate();
        } catch {
          // Already-terminated workers throw in Bun — ignore.
        }
      }
    },
  };

  return pool;
}

/**
 * Tear down the singleton pool. Primarily for tests; the singleton
 * is otherwise kept alive for the process lifetime.
 */
export function terminatePool(): void {
  if (pool !== null) {
    pool.terminate();
    pool = null;
  }
  if (cachedBlobUrl !== null) {
    URL.revokeObjectURL(cachedBlobUrl);
    cachedBlobUrl = null;
  }
}

// `ignoreBOM: true` is load-bearing: without it the decoder silently
// strips a leading U+FEFF, which desynchronises every `lineOffset` /
// `lineLength` index the worker stored against the pre-encode pool
// length. A BOM-prefixed source file lands a U+FEFF at pool index 0,
// and with default (BOM-eating) decode the whole batch's lines would
// shift left by one code unit. `fatal: false` (default) keeps
// replacement-char behavior intact for any invalid sequences — the
// worker's round-trip can't produce them, but it's the safer default.
const LINE_POOL_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Decode a worker's packed `{ints, linePoolBytes}` into `GrepMatch[]`,
 * reconstructing path fields from the caller's `paths` / `relPaths`.
 *
 * Optional `mtimes` is a parallel per-path array; when provided,
 * each match gets `mtime` attached via its `pathIdx`. Walker-side
 * knowledge, not worker-side.
 */
export function decodeWorkerMatches(
  result: WorkerGrepResult,
  paths: readonly string[],
  relPaths: readonly string[],
  mtimes: readonly number[] | null = null
): GrepMatch[] {
  const { ints, linePoolBytes } = result;
  const linePool = LINE_POOL_DECODER.decode(linePoolBytes);
  const matches: GrepMatch[] = [];
  const count = Math.floor(ints.length / 4);
  for (let i = 0; i < count; i += 1) {
    const base = i * 4;
    const pathIdx = ints[base] ?? 0;
    const lineNum = ints[base + 1] ?? 0;
    const lineOffset = ints[base + 2] ?? 0;
    const lineLength = ints[base + 3] ?? 0;
    const absolutePath = paths[pathIdx] ?? "";
    const relativePath = relPaths[pathIdx] ?? absolutePath;
    const line = linePool.slice(lineOffset, lineOffset + lineLength);
    const match: GrepMatch = {
      path: relativePath,
      absolutePath,
      lineNum,
      line,
    };
    if (mtimes !== null) {
      match.mtime = mtimes[pathIdx];
    }
    matches.push(match);
  }
  return matches;
}
