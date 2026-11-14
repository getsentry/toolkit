/**
 * Byte Buffer Utilities
 *
 * `Uint8Array` defaults to `Uint8Array<ArrayBufferLike>`, which may view a
 * `SharedArrayBuffer`. lib DOM's `BlobPart` and `BodyInit` accept only views
 * over a plain `ArrayBuffer`. Dependencies such as `@sentry/core` and
 * `@sentry/symbolic` return plain-buffer bytes but declare the default type.
 */

/**
 * Return `bytes` typed as a view over a plain `ArrayBuffer`, copying only
 * when it views shared memory.
 *
 * @param bytes - Bytes from an API that declares `Uint8Array`
 * @returns `bytes` itself, or a copy over a new `ArrayBuffer`
 */
export function toArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return isArrayBufferBacked(bytes) ? bytes : new Uint8Array(bytes);
}

function isArrayBufferBacked(
  bytes: Uint8Array,
): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}
