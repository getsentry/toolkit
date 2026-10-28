/**
 * Compression for cached response bodies: zstd level 3 where the runtime has
 * it, brotli quality 4 otherwise, and no compression for small bodies. Each
 * entry records how it was encoded, so entries written by one runtime stay
 * readable (or are cleanly skipped) on another.
 *
 * Uses `node:zlib`, which Node and Cloudflare Workers (`nodejs_compat`)
 * provide; zstd needs Node 22.15+ and is detected at runtime.
 */

// A namespace import, so a missing `zstdCompress` (Node < 22.15) is
// `undefined` rather than a link error.
import * as nodeZlib from "node:zlib";

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

/** Bodies smaller than this are stored uncompressed. */
export const MIN_COMPRESSED_BYTES = 256;

const ZSTD_LEVEL = 3;
const BROTLI_QUALITY = 4;

type Callback = (error: Error | null, result: Buffer) => void;
type Transform<Options> = (
  input: Uint8Array,
  options: Options,
  callback: Callback,
) => void;

/** The `node:zlib` functions the codec uses; zstd is optional. */
export type ZlibRuntime = {
  constants: Pick<
    typeof nodeZlib.constants,
    "BROTLI_PARAM_QUALITY" | "ZSTD_c_compressionLevel"
  >;
  brotliCompress: Transform<nodeZlib.BrotliOptions>;
  brotliDecompress: Transform<nodeZlib.BrotliOptions>;
  zstdCompress?: Transform<nodeZlib.ZstdOptions>;
  zstdDecompress?: Transform<nodeZlib.ZstdOptions>;
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

function run<Options>(
  transform: Transform<Options>,
  input: Uint8Array,
  options: Options,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    transform(input, options, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(
          new Uint8Array(result.buffer, result.byteOffset, result.length),
        );
      }
    });
  });
}

/**
 * Create a codec for a `node:zlib`-compatible runtime.
 *
 * @param zlib - Defaults to `node:zlib`; tests pass one without zstd
 */
export function createBodyCodec(
  zlib: ZlibRuntime = nodeZlib as ZlibRuntime,
): BodyCodec {
  const zstd =
    typeof zlib.zstdCompress === "function" &&
    typeof zlib.zstdDecompress === "function"
      ? { compress: zlib.zstdCompress, decompress: zlib.zstdDecompress }
      : undefined;

  async function compress(raw: Uint8Array): Promise<EncodedBody> {
    const rawSize = raw.byteLength;
    if (zstd) {
      const bytes = await run(zstd.compress, raw, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
      });
      return { bytes, encoding: "zstd", rawSize };
    }
    const bytes = await run(zlib.brotliCompress, raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
    });
    return { bytes, encoding: "br", rawSize };
  }

  async function decompress(
    body: EncodedBody,
  ): Promise<Uint8Array | undefined> {
    // Never more than the recorded size, so a damaged entry cannot balloon.
    const options = { maxOutputLength: Math.max(1, body.rawSize) };
    switch (body.encoding) {
      case "identity":
        return body.bytes;
      case "br":
        return await run(zlib.brotliDecompress, body.bytes, options);
      case "zstd":
        return zstd
          ? await run(zstd.decompress, body.bytes, options)
          : undefined;
      default:
        return undefined;
    }
  }

  return {
    async encode(raw) {
      if (raw.byteLength < MIN_COMPRESSED_BYTES) {
        return { bytes: raw, encoding: "identity", rawSize: raw.byteLength };
      }
      return await compress(raw);
    },

    async decode(body) {
      if (body.dictId !== undefined) {
        return;
      }
      const raw = await decompress(body);
      if (raw && raw.byteLength !== body.rawSize) {
        throw new Error(
          `Cached body decoded to ${raw.byteLength} bytes, expected ${body.rawSize}`,
        );
      }
      return raw;
    },
  };
}
