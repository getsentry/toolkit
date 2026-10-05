/**
 * Shared concurrency helper for grep + DSN scanner.
 *
 * Implements the "bounded parallelism with cooperative early exit"
 * pattern from `src/lib/dsn/code-scanner.ts::scanFilesForDsns`,
 * extracted so PR 2's grep engine and PR 3's DSN scanner can share
 * one tested implementation.
 *
 * ### Why not `pLimit.clearQueue()`
 *
 * `pLimit` exposes a `clearQueue()` method that cancels still-queued
 * tasks — but it does so by silently dropping the unresolved promises,
 * which means the outer `Promise.all` never settles. The DSN scanner
 * has a multi-line comment about this (`code-scanner.ts:634`). We use
 * a shared `earlyExit` boolean instead: queued tasks peek at it in
 * their first statement and return immediately.
 */

import pLimit from "p-limit";
import { CONCURRENCY_LIMIT } from "./constants.js";

/** Common options for the two concurrent helpers. */
export type ConcurrentOptions = {
  /** Max in-flight tasks. Default: `CONCURRENCY_LIMIT` (50). */
  concurrency?: number;
  /**
   * Abort mid-stream. When aborted, the next `yield` (stream variant)
   * or the `await` inside `mapFilesConcurrent` throws an
   * `AbortError`. In-flight tasks are left to settle on their own.
   */
  signal?: AbortSignal;
};

/**
 * Options for the gather-all `mapFilesConcurrent`.
 *
 * The optional `onResult` callback is invoked synchronously in the
 * coordinator after each per-item result is pushed. Returning
 * `{ done: true }` raises the shared early-exit flag — queued tasks
 * bail and `mapFilesConcurrent` resolves with whatever has been
 * collected so far.
 */
export type MapFilesOptions<T> = ConcurrentOptions & {
  onResult?: (result: T) => { done: boolean } | undefined;
};

/**
 * Run `fn` on every item from `source` with bounded concurrency,
 * collect all results into an array, and resolve when every task has
 * settled OR an early-exit signal has been raised and all in-flight
 * tasks have completed.
 *
 * Result order is completion order, NOT source order — if you need
 * source-order output, sort after. `null` returns from `fn` are
 * filtered out of the result array.
 */
export async function mapFilesConcurrent<TIn, TOut>(
  source: AsyncIterable<TIn>,
  fn: (item: TIn) => Promise<TOut | null>,
  opts: MapFilesOptions<TOut> = {}
): Promise<TOut[]> {
  const limit = pLimit(opts.concurrency ?? CONCURRENCY_LIMIT);
  const results: TOut[] = [];
  const state = { earlyExit: false };
  const tasks: Promise<void>[] = [];

  try {
    for await (const item of source) {
      if (state.earlyExit) {
        break;
      }
      throwIfAborted(opts.signal);
      tasks.push(
        limit(async () => {
          if (state.earlyExit) {
            return;
          }
          const out = await fn(item);
          if (state.earlyExit || out === null) {
            return;
          }
          results.push(out);
          const verdict = opts.onResult?.(out);
          if (verdict?.done) {
            state.earlyExit = true;
          }
        })
      );
    }
  } finally {
    // Always wait for in-flight tasks — otherwise a thrown AbortError
    // mid-iteration would leave orphans running against closed state.
    await Promise.all(tasks);
  }

  return results;
}

/**
 * Streaming counterpart to `mapFilesConcurrent`. Yields each non-null
 * result as soon as its producing task settles — useful when the
 * consumer wants to display matches progressively or terminate early
 * via `break`.
 *
 * `fn` returns `TOut[]` (or `null` for no output), which lets per-item
 * work emit multiple results (e.g., multiple grep matches per file).
 *
 * Consumer-initiated `break` drains the queue then stops pumping;
 * in-flight workers run to completion off the main path.
 */
export async function* mapFilesConcurrentStream<TIn, TOut>(
  source: AsyncIterable<TIn>,
  fn: (item: TIn) => Promise<TOut[] | null>,
  opts: ConcurrentOptions = {}
): AsyncGenerator<TOut> {
  const limit = pLimit(opts.concurrency ?? CONCURRENCY_LIMIT);
  const state = { earlyExit: false };

  // Producer-consumer buffer. Workers push into `queue`; the generator
  // drains it between awaits on `awake`. When `awake` resolves, it's
  // replaced in one atomic step so subsequent notifications don't
  // deadlock. We build the first promise inline so the TS flow
  // analyzer sees both variables as assigned before any use.
  const queue: TOut[] = [];
  let wakeUp: () => void = () => {
    /* reassigned by resetAwake below */
  };
  let awake: Promise<void> = new Promise<void>((r) => {
    wakeUp = r;
  });
  const resetAwake = () => {
    awake = new Promise<void>((r) => {
      wakeUp = r;
    });
  };

  let producerDone = false;
  let producerError: unknown = null;
  const tasks: Promise<void>[] = [];

  const producer = (async () => {
    try {
      for await (const item of source) {
        if (state.earlyExit) {
          break;
        }
        throwIfAborted(opts.signal);
        tasks.push(
          limit(async () => {
            if (state.earlyExit) {
              return;
            }
            const out = await fn(item);
            if (state.earlyExit || out === null || out.length === 0) {
              return;
            }
            for (const entry of out) {
              queue.push(entry);
            }
            wakeUp();
          })
        );
      }
      await Promise.all(tasks);
    } catch (error) {
      producerError = error;
    } finally {
      producerDone = true;
      wakeUp();
    }
  })();

  try {
    while (true) {
      if (queue.length > 0) {
        // Drain everything already queued before we yield control,
        // so fast consumers don't spin one microtask per result.
        while (queue.length > 0) {
          yield queue.shift() as TOut;
          throwIfAborted(opts.signal);
        }
        continue;
      }
      if (producerDone) {
        break;
      }
      await awake;
      resetAwake();
    }
  } finally {
    // Consumer-initiated break — stop pumping new tasks; in-flight
    // tasks still run to completion because we don't clearQueue().
    state.earlyExit = true;
    // Make sure the producer has exited before returning (it might
    // still be blocked on awake). We rely on the finally-block above
    // flipping `producerDone` + calling `wakeUp()`.
    await producer;
    // Propagate producer errors from inside the `finally` so they
    // surface on both paths: normal drain-to-completion AND
    // consumer-initiated `break`. Code *after* a generator's
    // try/finally is unreachable when the consumer breaks (the
    // runtime's `return()` resolves the iterator without executing
    // the post-try body), so an error thrown outside this block
    // would be silently lost on the break path.
    if (producerError) {
      // biome-ignore lint/correctness/noUnsafeFinally: intentional — this is the only path to surface producer errors on the break path
      throw producerError;
    }
  }
}

/**
 * Mirror Node's `AbortSignal.throwIfAborted` for Bun targets that
 * don't expose it.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException(
      signal.reason instanceof Error ? signal.reason.message : "Aborted",
      "AbortError"
    );
  }
}
