import { attachmentBytes } from "@/lib/attachments.ts";
import { useEffect, useState } from "react";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
import { display, record, text } from "@/lib/inspection.ts";
import { JsonView } from "./json-view.tsx";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
export function AttachmentDetail({ item }: { item: LocalFeedItem }) {
  const [url, setUrl] = useState<string>();
  const name = text(item.itemHeader?.filename) ?? "Attachment";
  const attachment = attachmentBytes(item);
  useEffect(() => {
    const decoded = attachmentBytes(item);
    if (!decoded || typeof URL.createObjectURL !== "function") return;
    // Downloads stay inert even when the captured MIME type is HTML or SVG.
    const objectUrl = URL.createObjectURL(
      new Blob([decoded.bytes], {
        type: decoded.isText ? "text/plain" : decoded.contentType,
      }),
    );
    // Object URLs are browser resources: create after commit and revoke on cleanup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(undefined);
    };
  }, [item]);
  const content = attachment?.isText
    ? new TextDecoder().decode(attachment.bytes)
    : undefined;
  return (
    <section aria-label="Attachment" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="break-all text-sm font-medium">{name}</h3>
        {url ? (
          <a
            className="text-sm text-primary underline"
            href={url}
            download={name}
          >
            Download attachment
          </a>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {attachment?.contentType ??
          text(item.itemHeader?.content_type) ??
          "Unknown type"}
        {attachment
          ? ` · ${attachment.bytes.byteLength.toLocaleString()} bytes`
          : ""}
      </p>
      {!attachment ? (
        <p role="status" className="text-sm text-muted-foreground">
          This attachment could not be decoded. Its original payload is
          available in JSON.
        </p>
      ) : content !== undefined ? (
        attachment.contentType.includes("json") ? (
          <JsonView code={content} />
        ) : (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-muted/30 p-3 text-xs">
            {content}
          </pre>
        )
      ) : url && IMAGE_TYPES.has(attachment.contentType) ? (
        <img
          src={url}
          alt={name}
          className="max-h-96 max-w-full object-contain"
        />
      ) : url && VIDEO_TYPES.has(attachment.contentType) ? (
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-96 max-w-full"
        >
          <track kind="captions" />
        </video>
      ) : (
        <p className="text-sm text-muted-foreground">
          No preview available for this file type. Download it to inspect its
          contents.
        </p>
      )}
    </section>
  );
}
export function EnvelopeAttachments({ item }: { item: LocalFeedItem }) {
  const envelope = item.payload;
  if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return null;
  const attachments = envelope[1].flatMap((entry, index): LocalFeedItem[] =>
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
  if (!attachments.length) return null;
  return (
    <section aria-label="Envelope attachments" className="space-y-4">
      {attachments.map((attachment) => (
        <AttachmentDetail key={attachment.id} item={attachment} />
      ))}
    </section>
  );
}
