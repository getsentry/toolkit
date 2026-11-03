import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TraceGroup, TraceSpan } from "@/lib/trace-model.ts";

type TraceWaterfallProps = {
  compact?: boolean;
  trace: TraceGroup;
  selectedSpanId?: string;
  onSelectSpan?: (spanId: string) => void;
};

type PositionedSpan = {
  span: TraceSpan;
  depth: number;
  isLastChild: boolean;
};

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—";
  return `${durationMs.toFixed(durationMs < 10 ? 2 : 0)}ms`;
}

function getSpanPosition(
  span: TraceSpan,
  trace: TraceGroup,
): { left: string; width: string } | undefined {
  if (
    trace.startTimestamp === undefined ||
    trace.durationMs === undefined ||
    trace.durationMs <= 0 ||
    span.startTimestamp === undefined
  ) {
    return undefined;
  }

  const elapsedMs = (span.startTimestamp - trace.startTimestamp) * 1_000;
  const left = Math.max(0, Math.min(100, (elapsedMs / trace.durationMs) * 100));
  const width = Math.max(
    1,
    Math.min(100 - left, ((span.durationMs ?? 0) / trace.durationMs) * 100),
  );

  return { left: `${left}%`, width: `${width}%` };
}

function flattenSpans(spans: TraceSpan[]): PositionedSpan[] {
  const pending: PositionedSpan[] = spans
    .map((span, index) => ({
      span,
      depth: 0,
      isLastChild: index === spans.length - 1,
    }))
    .reverse();
  const positioned: PositionedSpan[] = [];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (visited.has(current.span.id)) continue;
    visited.add(current.span.id);
    positioned.push(current);
    const children = current.span.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child)
        pending.push({
          span: child,
          depth: current.depth + 1,
          isLastChild: index === children.length - 1,
        });
    }
  }
  return positioned;
}

function isFailingSpan(span: TraceSpan): boolean {
  const { level, statusCode, spanStatus } = span.metadata;
  return (
    level === "error" ||
    level === "fatal" ||
    (statusCode !== undefined && statusCode >= 500) ||
    (spanStatus !== undefined && spanStatus !== "ok")
  );
}

function SpanRow({
  positionedSpan,
  trace,
  index,
  selectedSpanId,
  onSelectSpan,
  collapsed,
  onToggle,
  treeWidth,
  matched,
}: {
  collapsed: boolean;
  onToggle: () => void;
  treeWidth: number;
  matched: boolean;
  positionedSpan: PositionedSpan;
  trace: TraceGroup;
  index: number;
  selectedSpanId?: string;
  onSelectSpan?: (spanId: string) => void;
}) {
  const { span, depth, isLastChild } = positionedSpan;
  const position = getSpanPosition(span, trace);
  const visualDepth = Math.min(depth, 4);
  const failed = isFailingSpan(span);

  return (
    <div
      role="row"
      style={{
        gridTemplateColumns: `minmax(0,${treeWidth}%) minmax(0,1fr) 5.5rem`,
      }}
      data-search-match={matched || undefined}
      className={`group grid min-w-0 w-full grid-cols-[minmax(0,40%)_minmax(0,1fr)_5.5rem] border-b border-border transition-colors hover:bg-muted/45 ${index % 2 === 1 ? "bg-muted/15" : ""}`}
    >
      <div
        role="cell"
        className="relative flex min-w-0 items-center gap-2 border-r border-border px-3 py-2"
      >
        {depth > 0 ? (
          <>
            <span
              aria-hidden="true"
              className={`absolute border-l border-border/70 ${isLastChild ? "top-0 h-1/2" : "inset-y-0"}`}
              style={{ left: `${0.95 + (visualDepth - 1) * 0.65}rem` }}
            />
            <span
              aria-hidden="true"
              className="absolute top-1/2 h-px w-[0.85rem] -translate-y-1/2 bg-border/70"
              style={{ left: `${0.95 + (visualDepth - 1) * 0.65}rem` }}
            />
          </>
        ) : null}
        {span.children.length ? (
          <button
            type="button"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${span.description}`}
            aria-expanded={!collapsed}
            className="relative z-10 shrink-0 text-muted-foreground"
            onClick={onToggle}
          >
            {collapsed ? (
              <ChevronRight className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
          </button>
        ) : null}
        <span
          aria-hidden="true"
          className={`relative size-1.5 shrink-0 ${failed ? "bg-red-500" : depth === 0 ? "bg-primary" : "bg-muted-foreground"}`}
          style={{ marginLeft: `${visualDepth * 0.65}rem` }}
        />
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span
            className={`max-w-full break-all font-mono text-xs font-medium ${failed ? "text-red-500 dark:text-red-400" : "text-primary"}`}
          >
            {span.operation ?? "span"}
          </span>
          {onSelectSpan ? (
            <button
              type="button"
              data-span-id={span.id}
              aria-label={`Inspect span ${span.description}`}
              aria-pressed={selectedSpanId === span.id}
              className="w-full whitespace-pre-wrap break-words text-left text-sm outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring aria-pressed:font-semibold aria-pressed:text-primary data-[matched=true]:bg-amber-500/15"
              data-matched={matched || undefined}
              onClick={() => onSelectSpan(span.id)}
            >
              {span.description}
            </button>
          ) : (
            <span className="whitespace-pre-wrap break-words text-sm">
              {span.description}
            </span>
          )}
        </div>
      </div>
      <div
        role="cell"
        aria-label={`${span.description} timeline`}
        className="relative min-w-0 overflow-hidden border-r border-border px-3 py-1.5"
      >
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-3 right-3 opacity-55"
          style={{
            backgroundImage:
              "linear-gradient(to right, transparent 24.8%, var(--border) 25%, transparent 25.2%, transparent 49.8%, var(--border) 50%, transparent 50.2%, transparent 74.8%, var(--border) 75%, transparent 75.2%)",
          }}
        />
        {position ? (
          <div
            data-testid={`waterfall-bar-${span.id}`}
            className={`absolute top-1/2 h-3 min-w-1 -translate-y-1/2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_65%,transparent)] ${failed ? "bg-red-500/80 shadow-[inset_0_0_0_1px_color-mix(in_oklab,#ef4444_65%,transparent)]" : "bg-primary/75"}`}
            style={position}
            title={formatDuration(span.durationMs)}
          />
        ) : null}
      </div>
      <div
        role="cell"
        aria-label={`Duration ${formatDuration(span.durationMs)}`}
        className="flex min-w-0 items-center justify-end break-all px-3 py-2 text-right font-mono text-xs font-medium tabular-nums text-foreground"
      >
        {formatDuration(span.durationMs)}
      </div>
    </div>
  );
}

/** A compact, selectable timeline for the spans contained in one local trace. */
export function TraceWaterfall({
  compact = false,
  trace,
  selectedSpanId,
  onSelectSpan,
}: TraceWaterfallProps) {
  const [query, setQuery] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [treeWidth, setTreeWidth] = useState(40);
  const allSpans = useMemo(() => flattenSpans(trace.roots), [trace]);
  const matching = useMemo(
    () =>
      new Set(
        allSpans
          .filter(({ span }) =>
            `${span.description} ${span.operation ?? ""} ${span.id}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
          )
          .map(({ span }) => span.id),
      ),
    [allSpans, query],
  );
  const capturedItemLabel = `${trace.itemCount} captured item${trace.itemCount === 1 ? "" : "s"} in this trace`;

  if (trace.spans.length === 0) {
    return (
      <section aria-label="Trace waterfall" className="min-h-0 overflow-auto">
        {compact ? null : (
          <header className="border-b border-border px-3 py-3 sm:px-4">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Trace
            </p>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2 className="whitespace-pre-wrap break-words text-sm font-medium">
                {trace.title}
              </h2>
              <span className="font-mono text-sm tabular-nums text-foreground">
                {formatDuration(trace.durationMs)}
              </span>
            </div>
            <div
              aria-label="Trace summary"
              className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
            >
              <span>{capturedItemLabel}</span>
              <span>
                Trace ID <code>{trace.id.slice(0, 8)}</code>
              </span>
            </div>
          </header>
        )}
        {compact ? (
          <p
            aria-label="Trace relationship"
            className="border-b border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {capturedItemLabel}
          </p>
        ) : null}
        <p className="p-4 text-sm text-muted-foreground">
          This trace has no timestamped spans to display yet.
        </p>
      </section>
    );
  }

  const spans: PositionedSpan[] = [];
  let hiddenBelow: number | undefined;
  for (const entry of allSpans) {
    if (!query.trim()) {
      if (hiddenBelow !== undefined && entry.depth > hiddenBelow) continue;
      hiddenBelow = collapsed.has(entry.span.id) ? entry.depth : undefined;
    }
    if (!query.trim() || !onlyMatches || matching.has(entry.span.id))
      spans.push(entry);
  }

  return (
    <section aria-label="Trace waterfall" className="min-h-0 overflow-auto">
      {compact ? (
        <p
          aria-label="Trace relationship"
          className="border-b border-border px-3 py-2 text-xs text-muted-foreground"
        >
          {capturedItemLabel}
        </p>
      ) : (
        <header className="border-b border-border px-3 py-3 sm:px-4">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Trace
          </p>
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2 className="whitespace-pre-wrap break-words text-sm font-medium">
              {trace.title}
            </h2>
            <span className="font-mono text-sm tabular-nums text-foreground">
              {formatDuration(trace.durationMs)}
            </span>
          </div>
          <div
            aria-label="Trace summary"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
          >
            <span>
              {trace.spans.length} span{trace.spans.length === 1 ? "" : "s"}
            </span>
            {trace.errorCount > 0 ? (
              <span className="text-red-500 dark:text-red-400">
                {trace.errorCount} error{trace.errorCount === 1 ? "" : "s"}
              </span>
            ) : null}
            {trace.logCount > 0 ? (
              <span>
                {trace.logCount} log{trace.logCount === 1 ? "" : "s"}
              </span>
            ) : null}
            <span>
              Trace ID <code>{trace.id.slice(0, 8)}</code>
            </span>
          </div>
        </header>
      )}
      {!compact ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-xs">
          <input
            type="search"
            aria-label="Search in trace"
            placeholder="Search in trace"
            className="h-7 min-w-0 flex-1 rounded border bg-background px-2"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={onlyMatches}
              onChange={(event) => setOnlyMatches(event.target.checked)}
            />
            Only show matches
          </label>
          <label className="flex items-center gap-2">
            Tree width
            <input
              type="range"
              min={25}
              max={70}
              value={treeWidth}
              onChange={(event) => setTreeWidth(Number(event.target.value))}
              className="w-20"
            />
          </label>
          {query.trim() ? (
            <span role="status">
              {matching.size} matches · branches expanded while searching
            </span>
          ) : null}
        </div>
      ) : null}
      <div role="table" aria-label="Trace spans" className="w-full">
        <div
          role="row"
          style={{
            gridTemplateColumns: `minmax(0,${treeWidth}%) minmax(0,1fr) 5.5rem`,
          }}
          className="grid min-w-0 w-full grid-cols-[minmax(0,40%)_minmax(0,1fr)_5.5rem] border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground"
        >
          <div
            role="columnheader"
            aria-label="Span"
            className="border-r border-border px-3 py-2"
          >
            Span
          </div>
          <div
            role="columnheader"
            aria-label={`Timeline from 0ms to ${formatDuration(trace.durationMs)}`}
            className="border-r border-border px-3 py-1.5"
          >
            <span className="block text-[10px] font-semibold tracking-wide uppercase">
              Timeline
            </span>
            <span
              aria-hidden="true"
              className="mt-0.5 flex justify-between font-mono text-[10px] font-normal tabular-nums text-muted-foreground/75"
            >
              <span>0</span>
              <span>{formatDuration(trace.durationMs)}</span>
            </span>
          </div>
          <div
            role="columnheader"
            aria-label="Duration"
            className="px-3 py-2 text-right"
          >
            Duration
          </div>
        </div>
        {spans.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No spans match this search.
          </p>
        ) : null}
        {spans.map((positionedSpan, index) => (
          <SpanRow
            key={positionedSpan.span.id}
            positionedSpan={positionedSpan}
            trace={trace}
            index={index}
            selectedSpanId={selectedSpanId}
            onSelectSpan={onSelectSpan}
            treeWidth={treeWidth}
            matched={
              Boolean(query.trim()) && matching.has(positionedSpan.span.id)
            }
            collapsed={!query.trim() && collapsed.has(positionedSpan.span.id)}
            onToggle={() =>
              setCollapsed((previous) => {
                const next = new Set(previous);
                if (next.has(positionedSpan.span.id))
                  next.delete(positionedSpan.span.id);
                else next.add(positionedSpan.span.id);
                return next;
              })
            }
          />
        ))}
      </div>
    </section>
  );
}
