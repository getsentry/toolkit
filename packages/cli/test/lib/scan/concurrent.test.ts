/**
 * Unit tests for `src/lib/scan/concurrent.ts`.
 *
 * Pins down the invariants grep + DSN scanner rely on:
 *   1. Bounded parallelism — never more than `concurrency` tasks in flight.
 *   2. Early-exit via `onResult.done: true` halts queued tasks.
 *   3. AbortSignal propagates through both helpers.
 *   4. Streaming variant yields in completion order and buffers correctly.
 *   5. Consumer-initiated `break` halts the producer cleanly.
 */

import { describe, expect, test } from "vitest";
import {
  mapFilesConcurrent,
  mapFilesConcurrentStream,
} from "../../../src/lib/scan/concurrent.js";

/** Helper: emit n items through an async generator. */
async function* emitRange(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i += 1) {
    yield i;
  }
}

describe("mapFilesConcurrent — gather variant", () => {
  test("runs fn on every item and collects results", async () => {
    const out = await mapFilesConcurrent(emitRange(5), async (i) => i * 2);
    expect(out.sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8]);
  });

  test("null return values are filtered out", async () => {
    const out = await mapFilesConcurrent<number, number>(
      emitRange(5),
      async (i) => (i % 2 === 0 ? i : null)
    );
    expect(out.sort((a, b) => a - b)).toEqual([0, 2, 4]);
  });

  test("respects concurrency limit", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    await mapFilesConcurrent(
      emitRange(20),
      async () => {
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return 1;
      },
      { concurrency: 3 }
    );
    expect(maxSeen).toBeLessThanOrEqual(3);
    expect(maxSeen).toBeGreaterThanOrEqual(1);
  });

  test("onResult done:true raises early-exit flag", async () => {
    let processed = 0;
    await mapFilesConcurrent(
      emitRange(100),
      async (i) => {
        processed += 1;
        return i;
      },
      {
        onResult: (result) => ({ done: result === 3 }),
      }
    );
    // With concurrency 50 and `done` on hit 4, we expect well under
    // all 100 items to have been processed before the flag stopped
    // further queueing. Loose bound — just assert we didn't process
    // every single item.
    expect(processed).toBeLessThan(100);
    expect(processed).toBeGreaterThanOrEqual(1);
  });

  test("aborted signal throws AbortError synchronously on next iteration", async () => {
    const controller = new AbortController();
    controller.abort();
    let threw: unknown = null;
    try {
      await mapFilesConcurrent(emitRange(10), async (i) => i, {
        signal: controller.signal,
      });
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(DOMException);
    expect((threw as DOMException).name).toBe("AbortError");
  });
});

describe("mapFilesConcurrentStream — streaming variant", () => {
  test("yields every non-null entry from fn's result arrays", async () => {
    const collected: number[] = [];
    for await (const item of mapFilesConcurrentStream(
      emitRange(5),
      async (i) => [i, i + 10]
    )) {
      collected.push(item);
    }
    // 5 items * 2 entries = 10 total, any order.
    expect(collected.length).toBe(10);
    expect(collected.sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 10, 11, 12, 13, 14,
    ]);
  });

  test("null or empty array skips emission", async () => {
    const collected: number[] = [];
    for await (const item of mapFilesConcurrentStream(
      emitRange(5),
      async (i) => (i % 2 === 0 ? [i] : null)
    )) {
      collected.push(item);
    }
    expect(collected.sort((a, b) => a - b)).toEqual([0, 2, 4]);
  });

  test("consumer break halts the producer cleanly", async () => {
    let produced = 0;
    const consumed: number[] = [];
    for await (const item of mapFilesConcurrentStream(
      emitRange(100),
      async (i) => {
        produced += 1;
        return [i];
      },
      { concurrency: 4 }
    )) {
      consumed.push(item);
      if (consumed.length === 2) {
        break;
      }
    }
    expect(consumed.length).toBe(2);
    // Producer ran at most a handful of extras past the break point
    // (the queue size + in-flight tasks). Don't pin an exact number —
    // that's flaky. Just assert it's well short of all 100.
    expect(produced).toBeLessThan(100);
  });

  test("signal propagates in stream variant when provided", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const iter = mapFilesConcurrentStream(
      slowRange(200),
      async (i) => {
        await new Promise((r) => setTimeout(r, 20));
        return [i];
      },
      { signal: controller.signal, concurrency: 2 }
    );
    let threw: unknown = null;
    try {
      for await (const _ of iter) {
        // drain
      }
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(DOMException);
    expect((threw as DOMException).name).toBe("AbortError");
  });

  test("producer errors surface even when consumer breaks early", async () => {
    // Regression test for PR 791 review finding: the producer-error
    // rethrow was placed after the generator's `try/finally`. When a
    // consumer `break`s early, the runtime's `return()` resolves the
    // iterator after the `finally` runs but does NOT execute code
    // after the try block — so a producer error would be silently
    // swallowed. The fix moves the rethrow inside the `finally`.
    const erroringSource = (async function* () {
      yield 1;
      yield 2;
      throw new Error("producer exploded");
    })();

    let caught: unknown = null;
    try {
      for await (const _ of mapFilesConcurrentStream(
        erroringSource,
        async (i) => [i * 2],
        { concurrency: 1 }
      )) {
        // break immediately — the error hasn't been observed yet.
        break;
      }
    } catch (error) {
      caught = error;
    }
    // Without the fix: caught stays null (error lost).
    // With the fix: the error propagates via the generator's
    // `return()` -> finally path and surfaces at the consumer.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("producer exploded");
  });
});

/**
 * Slow generator that yields one item every 1ms — gives the signal
 * time to fire mid-stream.
 */
async function* slowRange(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
    yield i;
  }
}
