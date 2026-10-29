import { useMemo, useState } from "react";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
import type { TraceGroup } from "@/lib/trace-model.ts";
import {
  spanInsights,
  webVitalPages,
  VITALS,
  type VitalName,
} from "@/lib/performance.ts";
import { ResizableWorkspace } from "./resizable-workspace.tsx";
function ms(value?: number) {
  return value === undefined ? "—" : `${value.toFixed(1)} ms`;
}
function Empty({ children }: { children: string }) {
  return (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      {children}
    </p>
  );
}
export function SpanAnalysis({
  kind,
  traces,
  query,
  onSelectSpan,
}: {
  kind: "queries" | "resources";
  traces: readonly TraceGroup[];
  query: string;
  onSelectSpan: (trace: string, span: string) => void;
}) {
  const [sort, setSort] = useState<
    "name" | "count" | "totalMs" | "averageMs" | "averageBytes"
  >("totalMs");
  const [ascending, setAscending] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const groups = useMemo(
    () =>
      spanInsights(traces, kind)
        .filter((group) =>
          `${group.name} ${group.operation}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .sort(
          (a, b) =>
            (sort === "name"
              ? a.name.localeCompare(b.name)
              : (a[sort] ?? -Infinity) - (b[sort] ?? -Infinity)) *
            (ascending ? 1 : -1),
        ),
    [traces, kind, query, sort, ascending],
  );
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0];
  const label = kind === "queries" ? "Database queries" : "Resources";
  if (!selected)
    return (
      <Empty>
        {query
          ? `No matching ${label.toLowerCase()}. Clear the filter to see all groups.`
          : `No ${label.toLowerCase()} captured. Send ${kind === "queries" ? "database" : "resource loading"} spans through your SDK.`}
      </Empty>
    );
  const columns = [
    ["name", kind === "queries" ? "Query" : "Resource"],
    ["count", "Executions"],
    ["totalMs", "Total time"],
    ["averageMs", "Average"],
    ...(kind === "resources" ? [["averageBytes", "Average size"]] : []),
  ] as const;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-3">
        <h1 className="text-sm font-semibold">{label}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Grouped by captured operation and exact description. Durations and
          sizes use only executions that include those values.
        </p>
      </div>
      <ResizableWorkspace
        storageKey={`sentry.local.${kind}-width`}
        listLabel={label}
        list={
          <div className="min-h-0 overflow-auto">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
              <label>
                Sort by{" "}
                <select
                  className="ml-1 rounded border bg-background p-1"
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value as typeof sort);
                    setAscending(event.target.value === "name");
                  }}
                >
                  {columns.map(([key, title]) => (
                    <option key={key} value={key}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                aria-label={ascending ? "Sort descending" : "Sort ascending"}
                className="rounded border px-2 py-1"
                onClick={() => setAscending(!ascending)}
              >
                {ascending ? "↑" : "↓"}
              </button>
              <span className="ml-auto text-muted-foreground">
                {groups.length} groups
              </span>
            </div>
            <ol className="divide-y divide-border">
              {groups.map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    aria-label={group.name}
                    aria-pressed={selected.id === group.id}
                    className="w-full space-y-2 px-3 py-3 text-left hover:bg-muted aria-pressed:bg-muted"
                    onClick={() => setSelectedId(group.id)}
                  >
                    <span className="line-clamp-3 block whitespace-pre-wrap break-words font-mono text-xs">
                      {group.name}
                    </span>
                    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{group.count} executions</span>
                      <span>{ms(group.totalMs)} total</span>
                      <span>{ms(group.averageMs)} avg</span>
                      {kind === "resources" &&
                      group.averageBytes !== undefined ? (
                        <span>
                          {Math.round(group.averageBytes).toLocaleString()} B
                          avg
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        }
      >
        <section
          aria-label={`${label} executions`}
          className="min-h-0 overflow-auto p-4"
        >
          <p className="text-xs text-muted-foreground">{selected.operation}</p>
          <h2 className="mt-1 whitespace-pre-wrap break-words font-mono text-sm">
            {selected.name}
          </h2>
          <h3 className="mb-2 mt-5 text-sm font-medium">
            Captured executions · {selected.count}
          </h3>
          <ol className="divide-y divide-border">
            {selected.executions
              .toSorted(
                (a, b) => (b.span.durationMs ?? -1) - (a.span.durationMs ?? -1),
              )
              .map((entry) => (
                <li key={`${entry.traceId}:${entry.span.id}`}>
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-3 py-3 text-left text-sm hover:text-primary"
                    onClick={() => onSelectSpan(entry.traceId, entry.span.id)}
                  >
                    <span className="min-w-0 break-words">
                      {entry.traceTitle}
                      <code className="mt-1 block text-xs text-muted-foreground">
                        {entry.span.id}
                      </code>
                    </span>
                    <span className="shrink-0 font-mono text-xs">
                      {ms(entry.span.durationMs)}
                    </span>
                  </button>
                </li>
              ))}
          </ol>
        </section>
      </ResizableWorkspace>
    </div>
  );
}
export function WebVitalsWorkspace({
  items,
  query,
  onSelectItem,
}: {
  items: readonly LocalFeedItem[];
  query: string;
  onSelectItem: (item: LocalFeedItem) => void;
}) {
  const pages = useMemo(
    () =>
      webVitalPages(items).filter((page) =>
        page.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [items, query],
  );
  const [selectedName, setSelectedName] = useState<string>();
  const [chosenMetric, setChosenMetric] = useState<VitalName>("lcp");
  const selected = pages.find((page) => page.name === selectedName) ?? pages[0];
  if (!selected)
    return (
      <Empty>
        {query
          ? "No pages match this filter."
          : "No Web Vitals captured. Send browser pageload transactions with performance measurements."}
      </Empty>
    );
  const available = (Object.keys(VITALS) as VitalName[]).filter((name) =>
    selected.visits.some((visit) => visit.metrics[name]),
  );
  const metric = available.includes(chosenMetric)
    ? chosenMetric
    : available[0]!;
  const config = VITALS[metric];
  const max = Math.max(
    config.poor,
    ...selected.visits.map((visit) => visit.metrics[metric]?.value ?? 0),
  );
  const valueLabel = (value: number) =>
    `${value.toFixed(metric === "cls" ? 3 : 0)}${config.unit ? ` ${config.unit}` : ""}`;
  return (
    <ResizableWorkspace
      storageKey="sentry.local.vitals-width"
      listLabel="Web Vitals pages"
      list={
        <section className="flex min-h-0 flex-1 flex-col">
          <h1 className="shrink-0 border-b border-border p-3 text-sm font-semibold">
            Web Vitals
          </h1>
          <ol className="min-h-0 flex-1 overflow-y-auto">
            {pages.map((page) => (
              <li key={page.name}>
                <button
                  type="button"
                  aria-current={
                    page.name === selected.name ? "true" : undefined
                  }
                  className="w-full border-b border-border p-3 text-left text-sm hover:bg-muted aria-current:bg-muted"
                  onClick={() => setSelectedName(page.name)}
                >
                  <span className="block break-words">{page.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {page.visits.length} captured visit
                    {page.visits.length === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      }
    >
      <section
        aria-label="Page Web Vitals"
        className="min-h-0 overflow-auto p-4"
      >
        <h2 className="break-words text-sm font-semibold">{selected.name}</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Local measurements per visit. These are development samples, not a
          field percentile or a combined performance score.
        </p>
        <label className="my-4 flex items-center gap-2 text-sm">
          Measurement
          <select
            className="rounded border bg-background p-1"
            value={metric}
            onChange={(event) =>
              setChosenMetric(event.target.value as VitalName)
            }
          >
            {available.map((name) => (
              <option key={name} value={name}>
                {VITALS[name].label}
              </option>
            ))}
          </select>
        </label>
        <p className="mb-3 text-xs text-muted-foreground">
          Good ≤ {valueLabel(config.good)} · Poor &gt; {valueLabel(config.poor)}
        </p>
        <ol className="space-y-3">
          {selected.visits.map((visit, index) => {
            const measurement = visit.metrics[metric];
            return (
              <li key={visit.item.id} className="border-b border-border pb-3">
                <button
                  type="button"
                  className="mb-1 text-xs text-primary underline"
                  onClick={() => onSelectItem(visit.item)}
                >
                  Inspect visit {index + 1}
                </button>
                {measurement ? (
                  <>
                    <div className="flex justify-between gap-2 text-xs">
                      <span>{measurement.rating}</span>
                      <span className="font-mono">
                        {valueLabel(measurement.value)}
                      </span>
                    </div>
                    <div
                      role="img"
                      aria-label={`${config.label}: ${valueLabel(measurement.value)}, ${measurement.rating}`}
                      className="mt-1 h-3 bg-muted"
                    >
                      <div
                        className={`h-full ${measurement.rating === "Good" ? "bg-emerald-500" : measurement.rating === "Poor" ? "bg-red-500" : "bg-amber-500"}`}
                        style={{
                          width: `${Math.max(0.5, (measurement.value / max) * 100)}%`,
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Not captured for this visit
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </ResizableWorkspace>
  );
}
