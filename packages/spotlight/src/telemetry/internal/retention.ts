import type { RetentionOptions } from "../public.ts";

/** Copy and validate the complete partial update before any live limits change. */
export function validateRetention(options: RetentionOptions): RetentionOptions {
  const { maxEnvelopes, maxBytes, maxAgeMs } = options;
  for (const [name, value] of [
    ["maxEnvelopes", maxEnvelopes],
    ["maxBytes", maxBytes],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new RangeError(`retention.${name} must be a positive safe integer`);
  }
  if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0))
    throw new RangeError("retention.maxAgeMs must be a positive finite number");
  return { maxEnvelopes, maxBytes, maxAgeMs };
}
