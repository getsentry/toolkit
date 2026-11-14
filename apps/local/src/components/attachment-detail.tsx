import { attachmentBytes } from "@/lib/attachments.ts";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
import { text } from "@/lib/inspection.ts";
import { JsonView } from "./json-view.tsx";

/**
 * Render one attachment. Collapsible attachments stay undecoded until the user
 * opens their preview, so envelopes with many or large files render cheaply.
 */
export function AttachmentDetail({
  item,
  collapsible = false,
}: {
  item: LocalFeedItem;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(!collapsible);
  const [url, setUrl] = useState<string>();
  const name = text(item.itemHeader?.["filename"]) ?? "Attachment";
  const attachment = useMemo(
    () => (expanded ? attachmentBytes(item) : undefined),
    [expanded, item],
  );
  useEffect(() => {
    if (!attachment || typeof URL.createObjectURL !== "function") return;
    // Downloads stay inert even when the captured MIME type is HTML or SVG.
    const objectUrl = URL.createObjectURL(
      new Blob([attachment.bytes], {
        type: attachment.downloadType,
      }),
    );
    // Object URLs are browser resources: create after commit and revoke on cleanup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(undefined);
    };
  }, [attachment]);
  const content = useMemo(
    () =>
      attachment?.isText
        ? new TextDecoder().decode(attachment.bytes)
        : undefined,
    [attachment],
  );
  const headerLength = item.itemHeader?.["length"];
  const byteLength =
    attachment?.bytes.byteLength ??
    (typeof headerLength === "number" && Number.isFinite(headerLength)
      ? headerLength
      : undefined);
  return (
    <section aria-label="Attachment" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="break-all text-sm font-medium">{name}</h3>
        <div className="flex items-center gap-3">
          {url ? (
            <a
              className="text-sm text-primary underline"
              href={url}
              download={name}
            >
              Download attachment
            </a>
          ) : null}
          {collapsible ? (
            // Keep one mounted toggle so keyboard focus survives expanding and collapsing.
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} ${name} preview`}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Hide preview" : "Show preview"}
              <ChevronDown
                aria-hidden="true"
                className={`size-3.5 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {attachment?.contentType ??
          text(item.itemHeader?.["content_type"]) ??
          "Unknown type"}
        {byteLength === undefined
          ? ""
          : ` · ${byteLength.toLocaleString()} bytes`}
      </p>
      {!expanded ? null : !attachment ? (
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
      ) : url && attachment.preview === "image" ? (
        <img
          src={url}
          alt={name}
          className="max-h-96 max-w-full object-contain"
        />
      ) : url && attachment.preview === "video" ? (
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
export function AttachmentList({
  label,
  attachments,
}: {
  label: string;
  attachments: readonly LocalFeedItem[];
}) {
  if (!attachments.length) return null;
  return (
    <section aria-label={label} className="space-y-4">
      {attachments.map((attachment) => (
        <AttachmentDetail key={attachment.id} item={attachment} collapsible />
      ))}
    </section>
  );
}
