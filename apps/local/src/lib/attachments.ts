import type { LocalFeedItem } from "./spotlight.ts";
import { record, text } from "./inspection.ts";

const TEXT_TYPES = new Set([
  "application/json",
  "text/json",
  "application/ld+json",
  "application/javascript",
  "application/xml",
  "application/x-javascript",
  "text/x-json",
]);

/** Spotlight's receiver sends text as UTF-8 and all other raw item types as base64. */
export function attachmentBytes(
  item: LocalFeedItem,
):
  | { bytes: Uint8Array<ArrayBuffer>; contentType: string; isText: boolean }
  | undefined {
  const wireType =
    text(item.itemHeader?.content_type) ?? "application/octet-stream";
  const contentType = wireType.split(";")[0]!.trim().toLowerCase();
  const payload = record(item.payload),
    raw = payload.data ?? item.payload;
  const isText = contentType.startsWith("text/") || TEXT_TYPES.has(contentType);
  if (typeof raw !== "string") return;
  try {
    return {
      contentType,
      isText,
      bytes: new Set([
        "text/plain",
        "text/css",
        "text/csv",
        "text/html",
        "text/javascript",
        "text/json",
        "text/x-json",
        "application/json",
        "application/ld+json",
      ]).has(wireType)
        ? new TextEncoder().encode(raw)
        : Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
    };
  } catch {
    return;
  }
}
