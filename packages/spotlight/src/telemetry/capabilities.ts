/** Wire formats understood by the portable SDK. This describes processing, not transport codecs. */
export const SDK_CAPABILITIES = Object.freeze({
  schemaVersion: 1 as const,
  spanFormats: Object.freeze(["legacy", "v2"] as const),
  profileFormats: Object.freeze(["v1", "v2"] as const),
  itemTypes: Object.freeze([
    "event",
    "error",
    "transaction",
    "span",
    "log",
    "profile",
    "profile_chunk",
    "feedback",
    "attachment",
  ] as const),
  timestampUnit: "unix-milliseconds" as const,
});
