import type { LocalFeedItem } from "./spotlight.ts";
import { record, text, parsed, display } from "./inspection.ts";

const TEXT_TYPES = new Set([
  "application/json",
  "text/json",
  "application/ld+json",
  "application/javascript",
  "application/xml",
  "application/x-javascript",
  "text/x-json",
]);

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
// The installed receiver uses an exact MIME match for wire encoding, including parameters.
const RECEIVER_TEXT_TYPES = new Set([
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

/** Spotlight's receiver sends text as UTF-8 and all other raw item types as base64. */
export function attachmentBytes(item: LocalFeedItem):
  | {
      bytes: Uint8Array<ArrayBuffer>;
      contentType: string;
      isText: boolean;
      downloadType: string;
      preview?: "image" | "video";
    }
  | undefined {
  const wireType =
    text(item.itemHeader?.content_type) ?? "application/octet-stream";
  const contentType = wireType.split(";")[0]!.trim().toLowerCase();
  const payload = record(item.payload),
    raw = payload.data ?? item.payload;
  const isText = contentType.startsWith("text/") || TEXT_TYPES.has(contentType);
  if (typeof raw !== "string") return;
  const preview = IMAGE_TYPES.has(contentType)
    ? "image"
    : VIDEO_TYPES.has(contentType)
      ? "video"
      : undefined;
  try {
    return {
      preview,
      // Untrusted document MIME types must stay inert even if a Blob URL is opened in a tab.
      downloadType: preview
        ? contentType
        : isText
          ? "text/plain"
          : "application/octet-stream",
      contentType,
      isText,
      bytes: RECEIVER_TEXT_TYPES.has(wireType)
        ? new TextEncoder().encode(raw)
        : Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
    };
  } catch {
    return;
  }
}

export function envelopeAttachments(item: LocalFeedItem): LocalFeedItem[] {
  const envelope = parsed(item.payload);
  if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return [];
  return envelope[1].flatMap((entry, index): LocalFeedItem[] =>
    Array.isArray(entry) && record(entry[0]).type === "attachment"
      ? [
          {
            id: `${item.id}:${index}`,
            type: "attachment",
            itemHeader: record(entry[0]),
            payload: entry[1],
            text: display(entry[1]),
          },
        ]
      : [],
  );
}
