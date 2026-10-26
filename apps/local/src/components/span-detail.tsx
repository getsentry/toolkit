import { AiInspector } from "./ai-inspector.tsx";
import { useCopyToClipboard } from "@uidotdev/usehooks";
import { Check, Copy, ChevronLeft } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
import type { TraceGroup, TraceSpan } from "@/lib/trace-model.ts";
import { isErrorEvent } from "@/lib/workspace.ts";
import { JsonView } from "./json-view.tsx";

import {
  attributeFields,
  detailRecord,
  type DetailField,
} from "./inspector-data.ts";

export function DetailFields({
  label,
  fields,
}: {
  label: string;
  fields: DetailField[];
}) {
  const [copiedField, setCopiedField] = useState<string>();
  const [, copy] = useCopyToClipboard();
  if (!fields.length) return null;
  return (
    <>
      <table aria-label={label} className="w-full text-left text-sm">
        <caption className="sr-only">{label}</caption>
        <tbody className="divide-y divide-border">
          {fields.map((field) => (
            <tr key={field.label}>
              <th
                scope="row"
                className="w-28 py-2 pr-3 align-top font-medium text-muted-foreground sm:w-36"
              >
                {field.label}
              </th>
              <td className="group py-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span
                    className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${field.code ? "font-mono text-xs" : ""}`}
                  >
                    {field.value}
                  </span>
                  <button
                    type="button"
                    aria-label={`Copy ${field.label}`}
                    className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      void copy(field.value);
                      setCopiedField(field.label);
                    }}
                  >
                    {copiedField === field.label ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

/** Both inspectors share the same keyboard tab behavior and labelled panels. */
export function InspectorTabs({
  initialTab = "overview",
  overview,
  json,
}: {
  initialTab?: "overview" | "json";
  overview: ReactNode;
  json: string;
}) {
  const [tab, setTab] = useState(initialTab);
  const id = useId();
  const tabs = ["overview", "json"] as const;
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const next =
      event.key === "ArrowRight" || event.key === "ArrowLeft"
        ? tab === "overview"
          ? "json"
          : "overview"
        : event.key === "End"
          ? "json"
          : event.key === "Home"
            ? "overview"
            : undefined;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`${id}-${next}`)?.focus();
  }
  return (
    <>
      <div
        role="tablist"
        aria-label="Event detail view"
        className="flex shrink-0 border-b border-border px-3"
      >
        {tabs.map((value) => (
          <button
            key={value}
            id={`${id}-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`${id}-panel`}
            tabIndex={tab === value ? 0 : -1}
            className={`px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === value ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab(value)}
            onKeyDown={handleKeyDown}
          >
            {value === "json" ? "JSON" : "Overview"}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${tab}`}
        className="min-h-0 flex-1 overflow-auto"
      >
        {tab === "json" ? (
          <JsonView code={json} />
        ) : (
          <div className="space-y-4 p-3 sm:p-4">{overview}</div>
        )}
      </div>
    </>
  );
}

export function RelatedTelemetry({
  trace,
  currentItemId,
  onSelect,
}: {
  trace: TraceGroup;
  currentItemId?: string;
  onSelect?: (item: LocalFeedItem) => void;
}) {
  const items = trace.items.filter(
    (item) =>
      item.id !== currentItemId && (item.type === "log" || isErrorEvent(item)),
  );
  if (!items.length) return null;
  return (
    <section
      aria-label="Related errors and logs"
      className="space-y-2 border-t border-border pt-3"
    >
      <h3 className="text-sm font-medium">Errors and logs in this trace</h3>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            {onSelect ? (
              <button
                type="button"
                aria-label={`View ${item.type} ${item.metadata?.title ?? item.type}`}
                className="w-full break-words px-1 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(item)}
              >
                <span className="mr-2 text-xs text-muted-foreground">
                  {item.type}
                </span>
                {item.metadata?.title ?? item.type}
              </button>
            ) : (
              <p className="break-words text-sm">
                {item.metadata?.title ?? item.type}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SpanDetail({
  span,
  trace,
  onBack,
  onSelectRelatedItem,
}: {
  span: TraceSpan;
  trace: TraceGroup;
  onBack?: () => void;
  onSelectRelatedItem?: (item: LocalFeedItem) => void;
}) {
  const payload = detailRecord(span.payload);
  const context = detailRecord(detailRecord(payload.contexts).trace);
  const fields: DetailField[] = [
    ...(span.durationMs === undefined
      ? []
      : [
          {
            label: "Duration",
            value: `${span.durationMs.toFixed(span.durationMs < 10 ? 2 : 0)}ms`,
            code: true,
          },
        ]),
    ...(span.startTimestamp === undefined
      ? []
      : [
          {
            label: "Start timestamp",
            value: String(span.startTimestamp),
            code: true,
          },
        ]),
    ...(span.endTimestamp === undefined
      ? []
      : [
          {
            label: "End timestamp",
            value: String(span.endTimestamp),
            code: true,
          },
        ]),
    ...(span.operation
      ? [{ label: "Operation", value: span.operation, code: true }]
      : []),
    ...(span.metadata.spanStatus
      ? [{ label: "Status", value: span.metadata.spanStatus }]
      : []),
    { label: "Span ID", value: span.id, code: true },
    ...(span.parentId
      ? [{ label: "Parent span ID", value: span.parentId, code: true }]
      : []),
    { label: "Trace ID", value: trace.id, code: true },
  ];
  const attributes = attributeFields({
    ...detailRecord(context.data),
    ...detailRecord(payload.data),
    ...detailRecord(payload.attributes),
  });
  return (
    <section
      aria-label="Span detail"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="space-y-2 border-b border-border px-3 py-3 sm:px-4">
        <button
          type="button"
          data-span-back
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" />
          Back to trace
        </button>
        <p className="break-words text-xs text-muted-foreground">
          Trace · {trace.title}
        </p>
        <h2 className="whitespace-pre-wrap break-words text-sm font-semibold">
          {span.description}
        </h2>
      </header>
      <InspectorTabs
        key={`${trace.id}:${span.id}`}
        json={JSON.stringify(span.payload, null, 2) ?? "null"}
        overview={
          <>
            <AiInspector payload={span.payload} steps={span.children} />
            <DetailFields label="Span details" fields={fields} />
            {attributes.length ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Attributes</h3>
                <DetailFields label="Span attributes" fields={attributes} />
              </section>
            ) : null}
            <RelatedTelemetry trace={trace} onSelect={onSelectRelatedItem} />
          </>
        }
      />
    </section>
  );
}
