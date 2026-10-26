import { useCopyToClipboard } from "@uidotdev/usehooks";
import { useId, useState } from "react";
import {
  attributeFields,
  detailRecord,
  type DetailField,
} from "./inspector-data.ts";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
import { getEventMetadata } from "@/lib/spotlight.ts";
import { getEventExceptions } from "@/lib/exceptions.ts";
import type { TraceGroup } from "@/lib/trace-model.ts";
import { Badge } from "./ui/badge.tsx";
import { ExceptionOverview } from "./exception-overview.tsx";
import { TraceWaterfall } from "./trace-waterfall.tsx";
import {
  DetailFields,
  InspectorTabs,
  RelatedTelemetry,
} from "./span-detail.tsx";

type EventDetailProps = {
  item: LocalFeedItem;
  trace?: TraceGroup;
  onSelectSpan?: (traceId: string, spanId: string) => void;
  onSelectRelatedItem?: (item: LocalFeedItem) => void;
};

function formatTimestamp(timestamp: LocalFeedItem["timestamp"]) {
  if (timestamp === undefined) return "unknown time";
  const date = new Date(
    typeof timestamp === "number" && timestamp < 1_000_000_000_000
      ? timestamp * 1_000
      : timestamp,
  );
  return Number.isNaN(date.getTime())
    ? String(timestamp)
    : date.toLocaleTimeString();
}

function CompactSummary({
  label,
  fields,
}: {
  label: string;
  fields: DetailField[];
}) {
  const [copiedField, setCopiedField] = useState<string>();
  const [, copy] = useCopyToClipboard();
  const id = useId();
  if (!fields.length) return null;
  return (
    <>
      <dl aria-label={label} className="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
        {fields.map((field, index) => (
          <div
            key={field.label}
            className={`min-w-0 ${field.label === "URL" ? "basis-full" : ""}`}
          >
            <dt className="text-xs text-muted-foreground">{field.label}</dt>
            <dd className="mt-0.5 min-w-0 font-mono text-xs tabular-nums">
              <button
                type="button"
                aria-label={`Copy ${field.label}`}
                aria-describedby={`${id}-value-${index}`}
                title={`Copy ${field.label}`}
                className="max-w-full cursor-copy break-all text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  void copy(field.value);
                  setCopiedField(field.label);
                }}
              >
                <span id={`${id}-value-${index}`}>{field.value}</span>
              </button>
            </dd>
          </div>
        ))}
      </dl>
      {copiedField ? (
        <span
          role="status"
          aria-label={`${copiedField} copied`}
          className="sr-only"
        >
          {copiedField} copied
        </span>
      ) : null}
    </>
  );
}

/** Prefer the useful view for each telemetry type; keep its full original JSON one tab away. */
export function EventDetail({
  item,
  trace,
  onSelectSpan,
  onSelectRelatedItem,
}: EventDetailProps) {
  const metadata = item.metadata ?? getEventMetadata(item.payload, item.type);
  const payload = detailRecord(item.payload);
  const exceptions =
    item.type === "event" ? getEventExceptions(item.payload) : [];
  const hasOverview = [
    "event",
    "log",
    "transaction",
    "span",
    "feedback",
  ].includes(item.type);
  const message =
    metadata.message ??
    (item.type === "log"
      ? typeof payload.body === "string"
        ? payload.body
        : metadata.title
      : undefined);
  const fields: DetailField[] = [
    ...(message ? [{ label: "Message", value: message }] : []),
    ...(item.type === "log" && metadata.level
      ? [{ label: "Level", value: metadata.level }]
      : []),
    ...(metadata.statusCode === undefined
      ? []
      : [{ label: "Status", value: String(metadata.statusCode) }]),
    ...(metadata.durationMs === undefined
      ? []
      : [
          {
            label: "Duration",
            value: `${metadata.durationMs.toFixed(metadata.durationMs < 10 ? 2 : 0)}ms`,
          },
        ]),
    ...(metadata.origin
      ? [{ label: "Origin", value: metadata.origin, code: true }]
      : []),
  ];
  const isRequestOrSpan = item.type === "transaction" || item.type === "span";
  const request = detailRecord(payload.request);
  const traceData = detailRecord(
    detailRecord(detailRecord(payload.contexts).trace).data,
  );
  const data = detailRecord(payload.data);
  const urlAttribute = detailRecord(payload.attributes)["url.full"];
  const capturedURL = [
    request.url,
    traceData["http.url"],
    data["http.url"],
    detailRecord(urlAttribute).value,
    urlAttribute,
  ].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const summaryFields: DetailField[] = [
    ...(metadata.method ? [{ label: "Method", value: metadata.method }] : []),
    ...fields.filter((field) => field.label !== "Message"),
    ...(capturedURL ? [{ label: "URL", value: capturedURL }] : []),
  ];
  const detailFields = isRequestOrSpan
    ? fields.filter((field) => field.label === "Message")
    : fields;
  const attributes = attributeFields(payload.attributes);
  return (
    <section
      data-testid="event-detail"
      aria-label={
        item.type === "envelope" ? "Raw envelope detail" : "Event detail"
      }
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Badge>
            {item.type === "envelope"
              ? "Envelope"
              : (metadata.operation ?? item.type)}
          </Badge>
          <h2 className="min-w-0 whitespace-pre-wrap break-words text-sm font-medium">
            {item.type === "envelope" ? "Raw envelope" : metadata.title}
          </h2>
        </div>
        <time className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {formatTimestamp(item.timestamp)}
        </time>
      </header>
      <InspectorTabs
        key={`${item.id}:${item.type}`}
        initialTab={hasOverview ? "overview" : "json"}
        json={item.text}
        overview={
          <>
            {exceptions.length ? (
              <ExceptionOverview exceptions={exceptions} />
            ) : null}
            {isRequestOrSpan ? (
              <CompactSummary
                key={`summary:${item.id}`}
                label={
                  item.type === "span" ? "Span summary" : "Request summary"
                }
                fields={summaryFields}
              />
            ) : null}
            <DetailFields
              key={`details:${item.id}`}
              label="Event details"
              fields={detailFields}
            />
            {attributes.length ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Attributes</h3>
                <DetailFields
                  label={
                    item.type === "log" ? "Log attributes" : "Event attributes"
                  }
                  fields={attributes}
                />
              </section>
            ) : null}
            {!fields.length &&
            !(isRequestOrSpan && summaryFields.length) &&
            !exceptions.length &&
            !attributes.length ? (
              <p className="text-sm text-muted-foreground">
                No additional event details.
              </p>
            ) : null}
            {trace ? (
              <>
                <TraceWaterfall
                  compact
                  trace={trace}
                  onSelectSpan={
                    onSelectSpan
                      ? (spanId) => onSelectSpan(trace.id, spanId)
                      : undefined
                  }
                />
                <RelatedTelemetry
                  trace={trace}
                  currentItemId={item.id}
                  onSelect={onSelectRelatedItem}
                />
              </>
            ) : null}
          </>
        }
      />
    </section>
  );
}
