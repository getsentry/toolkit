/** The same text/binary representation is used for parsed and serialized opaque items. */
const TEXT_CONTENT_TYPES = new Set([
  "text/plain",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/json",
  "text/x-json",
  "application/json",
  "application/ld+json",
]);

export function opaquePayload(
  payload: string | Uint8Array,
  contentType?: string,
): { data: string } {
  const bytes =
    typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  if (TEXT_CONTENT_TYPES.has(contentType ?? "")) {
    return {
      data: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    };
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { data: btoa(binary) };
}
