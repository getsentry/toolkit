/**
 * Minimal push/pull async channel for streaming SDK results.
 *
 * Producer calls `push(value)` for each item, `close()` when done,
 * or `error(err)` on failure. Consumer iterates with `for await...of`.
 *
 * Backpressure is not implemented — producers push freely. This is
 * acceptable for streaming commands (bounded by poll interval).
 *
 * @module
 */

/** Options for creating an async channel. */
export type AsyncChannelOptions = {
  /**
   * Called when the consumer calls `return()` on the iterator
   * (e.g., `break` in a `for await...of` loop). Use this to signal
   * the producer to stop.
   */
  onReturn?: () => void;
};

/**
 * A push/pull async channel that implements `AsyncIterable<T>`.
 *
 * The producer side pushes values, the consumer side iterates.
 * When the producer is done, it calls `close()`. On error, `error(err)`.
 * Push after close is a silent no-op.
 */
export type AsyncChannel<T> = AsyncIterable<T> & {
  /** Push a value to the consumer. Buffers if no one is waiting. No-op after close/error. */
  push(value: T): void;
  /** Signal normal completion. Consumer's next() returns { done: true }. */
  close(): void;
  /** Signal an error. Consumer's next() rejects with this error. */
  error(err: Error): void;
};

/**
 * Create a new async channel.
 *
 * Uses a dual-queue pattern: a buffer for values pushed before `next()`
 * is called, and a pending resolver for when `next()` is called first.
 */
export function createAsyncChannel<T>(
  options?: AsyncChannelOptions
): AsyncChannel<T> {
  const buffer: T[] = [];
  let pending:
    | {
        resolve: (result: IteratorResult<T>) => void;
        reject: (err: Error) => void;
      }
    | undefined;
  let closed = false;
  let errorValue: Error | undefined;

  function push(value: T): void {
    if (closed || errorValue) {
      return;
    }
    if (pending) {
      const p = pending;
      pending = undefined;
      p.resolve({ value, done: false });
    } else {
      buffer.push(value);
    }
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    if (pending) {
      const p = pending;
      pending = undefined;
      p.resolve({ value: undefined as T, done: true });
    }
  }

  function error(err: Error): void {
    if (closed || errorValue) {
      return;
    }
    errorValue = err;
    closed = true;
    if (pending) {
      const p = pending;
      pending = undefined;
      p.reject(err);
    }
  }

  function next(): Promise<IteratorResult<T>> {
    if (buffer.length > 0) {
      const value = buffer.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (errorValue) {
      return Promise.reject(errorValue);
    }
    if (closed) {
      return Promise.resolve({ value: undefined as T, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      pending = { resolve, reject };
    });
  }

  const iterator: AsyncIterator<T> = {
    next,
    return(): Promise<IteratorResult<T>> {
      closed = true;
      buffer.length = 0;
      if (pending) {
        const p = pending;
        pending = undefined;
        p.resolve({ value: undefined as T, done: true });
      }
      options?.onReturn?.();
      return Promise.resolve({ value: undefined as T, done: true });
    },
  };

  return {
    push,
    close,
    error,
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iterator;
    },
  };
}
