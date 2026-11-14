import { describe, expect, test } from "vitest";
import { toArrayBufferBytes } from "../../src/lib/bytes.js";

describe("toArrayBufferBytes", () => {
  test("returns a view over a plain ArrayBuffer unchanged", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toArrayBufferBytes(bytes)).toBe(bytes);
  });

  test("copies a view over shared memory", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4), 1, 2);
    shared.set([7, 9]);

    const result = toArrayBufferBytes(shared);

    expect(result).not.toBe(shared);
    expect(result.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...result]).toEqual([7, 9]);
  });
});
