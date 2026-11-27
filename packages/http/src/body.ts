/**
 * The shape of a stored response body and of the codec that produces it.
 * The compressing codec in `@sentry/http/codec` needs `node:zlib`, so it is
 * a separate entry point and the cache policy and stores stay portable.
 */

/** How an entry's body bytes are encoded. */
export type BodyEncoding = "zstd" | "br" | "identity";

/** A body as stored: its bytes plus what is needed to decode them. */
export type EncodedBody = {
  bytes: Uint8Array;
  encoding: BodyEncoding;
  /**
   * Compression dictionary the bytes need. Never set today; recorded so a
   * later dictionary rollout can tell its entries apart from plain ones.
   */
  dictId?: string;
  /** Size of the original body, which bounds decompression. */
  rawSize: number;
};

/** Encodes and decodes cached bodies. */
export type BodyCodec = {
  /** Compress a body for storage. */
  encode(raw: Uint8Array): Promise<EncodedBody>;
  /**
   * Restore a stored body. Returns `undefined` when this runtime cannot read
   * the entry (zstd on Node < 22.15, or a dictionary it does not have), so the
   * caller treats it as a miss. Throws when the bytes are corrupt or do not
   * decode to `rawSize` bytes.
   */
  decode(body: EncodedBody): Promise<Uint8Array | undefined>;
};

/**
 * A codec that stores bodies as they are, for runtimes without `node:zlib`
 * and for tests. It still skips entries that another codec compressed.
 */
export const identityCodec: BodyCodec = {
  async encode(raw) {
    return { bytes: raw, encoding: "identity", rawSize: raw.byteLength };
  },
  async decode(body) {
    if (body.dictId !== undefined || body.encoding !== "identity") {
      return;
    }
    if (body.bytes.byteLength !== body.rawSize) {
      throw new Error(
        `Cached body has ${body.bytes.byteLength} bytes, expected ${body.rawSize}`,
      );
    }
    return body.bytes;
  },
};
