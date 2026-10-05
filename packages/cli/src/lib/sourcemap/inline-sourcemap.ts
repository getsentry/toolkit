/**
 * Inline (data: URL) sourcemap decoding and encoding.
 *
 * Bundlers can embed a sourcemap directly in a JavaScript file as a base64
 * data URL (in a `sourceMappingURL` comment) instead of emitting a companion
 * `.map` file. The directive value looks like:
 *
 *   data:application/json;base64,<base64-json-map>
 *   data:application/json;charset=utf-8;base64,<base64-json-map>
 *
 * This module decodes such URLs into a parsed sourcemap object (for debug-ID
 * injection) and re-encodes a mutated map back into a data URL, preserving the
 * original charset prefix.
 *
 * Decoding is **non-fatal**: malformed base64 or non-JSON payloads return
 * `undefined` rather than throwing. Bundled terser/babel output can contain
 * template literals that look like `sourceMappingURL=data:...` directives but
 * are not valid sourcemaps — these must be skipped, never crash the run.
 */

import { logger } from "../logger.js";

const log = logger.withTag("sourcemap.inline");

/**
 * Matches a sourcemap `data:` URL, capturing the optional charset and the
 * base64 blob. Anchored so the entire value must be a well-formed data URL.
 */
const INLINE_SOURCEMAP_DATA_URL_RE =
  /^data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)$/;

/** ASCII prefix shared by all inline sourcemap data URLs. */
const INLINE_SOURCEMAP_PREFIX = "data:application/json";

/** A decoded inline sourcemap and the metadata needed to re-encode it. */
export type DecodedInlineMap = {
  /** Parsed sourcemap JSON object (mutated in place during injection). */
  map: Record<string, unknown>;
  /**
   * The decoded JSON string. Hashed to derive the debug ID so the value is
   * byte-consistent with the on-disk (external) sourcemap case.
   */
  json: string;
  /**
   * The directive prefix up to and including `base64,`, e.g.
   * `"data:application/json;charset=utf-8;base64,"`. Preserved on re-encode so
   * the charset is not lost.
   */
  dataUrlPrefix: string;
};

/**
 * True when a `sourceMappingURL` value is an inline base64 data URL.
 *
 * Uses a cheap ASCII prefix check; full validation happens in
 * {@link tryDecodeInlineSourcemap}.
 *
 * @param url - The raw `sourceMappingURL` directive value
 */
export function isInlineSourcemapUrl(url: string): boolean {
  return url.startsWith(INLINE_SOURCEMAP_PREFIX);
}

/**
 * Decode an inline base64 data URL into its JSON sourcemap.
 *
 * **Never throws.** Returns `undefined` on a base64-decode or `JSON.parse`
 * failure so callers can warn and skip the file. Node's
 * `Buffer.from(_, "base64")` silently drops invalid characters rather than
 * throwing, so the real guard is the `JSON.parse` — garbage base64 decodes to
 * non-JSON bytes and is rejected here.
 *
 * @param url - The raw `sourceMappingURL` directive value
 * @returns The decoded map plus re-encode metadata, or `undefined` on failure
 */
export function tryDecodeInlineSourcemap(
  url: string
): DecodedInlineMap | undefined {
  const match = url.match(INLINE_SOURCEMAP_DATA_URL_RE);
  if (!match) {
    return;
  }
  const blob = match[1];
  if (!blob) {
    return;
  }
  const dataUrlPrefix = url.slice(0, url.length - blob.length);
  try {
    const json = Buffer.from(blob, "base64").toString("utf-8");
    const map = JSON.parse(json) as Record<string, unknown>;
    return { map, json, dataUrlPrefix };
  } catch (error) {
    log.debug("inline sourcemap decode/parse failed", error);
    return;
  }
}

/**
 * Re-encode a (mutated) sourcemap object back into a base64 data URL,
 * preserving the original prefix (and thus charset).
 *
 * @param map - The sourcemap object to encode
 * @param dataUrlPrefix - The prefix captured by {@link tryDecodeInlineSourcemap}
 * @returns A `data:application/json...;base64,<...>` URL
 */
export function encodeInlineSourcemap(
  map: unknown,
  dataUrlPrefix: string
): string {
  const base64 = Buffer.from(JSON.stringify(map)).toString("base64");
  return `${dataUrlPrefix}${base64}`;
}
