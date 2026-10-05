import { createRequire } from "node:module";
import { logger } from "./logger.js";

const _require = createRequire(import.meta.url);
const log = logger.withTag("sea-assets");

/**
 * Return bytes embedded in a Node single-executable application, if any.
 *
 * `node:sea` cannot be imported in ordinary Node processes, so load it lazily
 * and let callers use their normal package/development fallback when absent.
 */
export function getSeaRawAsset(key: string): Uint8Array | undefined {
  let sea: {
    isSea?: () => boolean;
    getRawAsset?: (key: string) => ArrayBuffer;
  };
  try {
    sea = _require("node:sea") as typeof sea;
  } catch (error) {
    log.debug("node:sea unavailable; treating as non-SEA runtime", error);
    return;
  }
  if (!(sea.isSea?.() && sea.getRawAsset)) {
    return;
  }
  return new Uint8Array(sea.getRawAsset(key));
}
