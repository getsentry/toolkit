import { describe, expect, test } from "vitest";
import { createAsyncChannel } from "../../src/lib/async-channel.js";

describe("createAsyncChannel", () => {
  test("push-then-pull: values are received in FIFO order", async () => {
    const ch = createAsyncChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.close();

    const results: number[] = [];
    for await (const v of ch) {
      results.push(v);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  test("pull-then-push: next() resolves when value is pushed later", async () => {
    const ch = createAsyncChannel<string>();
    const iter = ch[Symbol.asyncIterator]();

    // Start waiting before any value is pushed
    const promise = iter.next();
    ch.push("hello");

    const result = await promise;
    expect(result).toEqual({ value: "hello", done: false });
  });

  test("close: next() returns done after close", async () => {
    const ch = createAsyncChannel<number>();
    const iter = ch[Symbol.asyncIterator]();

    ch.close();

    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  test("close: pending next() resolves as done when close is called", async () => {
    const ch = createAsyncChannel<number>();
    const iter = ch[Symbol.asyncIterator]();

    const promise = iter.next();
    ch.close();

    const result = await promise;
    expect(result.done).toBe(true);
  });

  test("error: next() rejects after error", async () => {
    const ch = createAsyncChannel<number>();
    const iter = ch[Symbol.asyncIterator]();

    const err = new Error("boom");
    ch.error(err);

    await expect(iter.next()).rejects.toThrow("boom");
  });

  test("error: pending next() rejects when error is called", async () => {
    const ch = createAsyncChannel<number>();
    const iter = ch[Symbol.asyncIterator]();

    const promise = iter.next();
    ch.error(new Error("fail"));

    await expect(promise).rejects.toThrow("fail");
  });

  test("for-await-of: iterates buffered values then stops on close", async () => {
    const ch = createAsyncChannel<string>();
    ch.push("a");
    ch.push("b");
    ch.close();

    const results: string[] = [];
    for await (const v of ch) {
      results.push(v);
    }
    expect(results).toEqual(["a", "b"]);
  });

  test("for-await-of: break triggers onReturn callback", async () => {
    let returnCalled = false;
    const ch = createAsyncChannel<number>({
      onReturn: () => {
        returnCalled = true;
      },
    });

    ch.push(1);
    ch.push(2);
    ch.push(3);

    for await (const _v of ch) {
      break;
    }

    expect(returnCalled).toBe(true);
  });

  test("push after close is a silent no-op", async () => {
    const ch = createAsyncChannel<number>();
    ch.push(1);
    ch.close();

    // Should not throw
    ch.push(2);
    ch.push(3);

    const results: number[] = [];
    for await (const v of ch) {
      results.push(v);
    }
    // Only the value pushed before close should appear
    expect(results).toEqual([1]);
  });

  test("push after error is a silent no-op", async () => {
    const ch = createAsyncChannel<number>();
    const iter = ch[Symbol.asyncIterator]();

    ch.error(new Error("oops"));

    // Should not throw
    ch.push(42);

    await expect(iter.next()).rejects.toThrow("oops");
  });

  test("multiple close calls are idempotent", async () => {
    const ch = createAsyncChannel<number>();
    const iter = ch[Symbol.asyncIterator]();

    ch.close();
    ch.close();
    ch.close();

    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  test("interleaved push/pull: FIFO order preserved", async () => {
    const ch = createAsyncChannel<number>();
    const iter = ch[Symbol.asyncIterator]();

    ch.push(1);
    const r1 = await iter.next();
    expect(r1).toEqual({ value: 1, done: false });

    ch.push(2);
    const r2 = await iter.next();
    expect(r2).toEqual({ value: 2, done: false });

    ch.push(3);
    ch.push(4);
    const r3 = await iter.next();
    const r4 = await iter.next();
    expect(r3).toEqual({ value: 3, done: false });
    expect(r4).toEqual({ value: 4, done: false });
  });

  test("return() clears buffer and marks as done", async () => {
    const ch = createAsyncChannel<number>();
    const iter = ch[Symbol.asyncIterator]();

    ch.push(1);
    ch.push(2);

    const result = await iter.return!();
    expect(result.done).toBe(true);

    // Subsequent next() also returns done
    const after = await iter.next();
    expect(after.done).toBe(true);
  });

  test("for-await-of with error throws inside loop", async () => {
    const ch = createAsyncChannel<number>();
    ch.push(1);

    const results: number[] = [];
    await expect(async () => {
      for await (const v of ch) {
        results.push(v);
        if (v === 1) {
          // Simulate producer error after first value is consumed
          ch.error(new Error("stream failed"));
        }
      }
    }).rejects.toThrow("stream failed");

    expect(results).toEqual([1]);
  });
});
