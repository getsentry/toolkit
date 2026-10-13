import type { TraceGroup, TraceSpan } from "@/lib/trace-model.ts";

type TraceWaterfallProps = {
  compact?: boolean;
  trace: TraceGroup;
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

function flattenSpans(spans: TraceSpan[], depth = 0): PositionedSpan[] {
  return spans.flatMap((span, index) => [
    { span, depth, isLastChild: index === spans.length - 1 },
    ...flattenSpans(span.children, depth + 1),
  ]);
}

function isFailingSpan(span: TraceSpan): boolean {
  const { level, statusCode } = span.item.metadata ?? {};
  return (
    level === "error" ||
    level === "fatal" ||
    (statusCode !== undefined && statusCode >= 500)
  );
}

function SpanRow({
  positionedSpan,
  trace,
  index,
}: {
  positionedSpan: PositionedSpan;
  trace: TraceGroup;
  index: number;
}) {
  const { span, depth, isLastChild } = positionedSpan;
  const position = getSpanPosition(span, trace);
  const failed = isFailingSpan(span);

  return (
    <div
      role="row"
      className={`group grid min-w-[48rem] grid-cols-[minmax(18rem,38%)_minmax(18rem,1fr)_6.5rem] border-b border-border transition-colors hover:bg-muted/45 ${index % 2 === 1 ? "bg-muted/15" : ""}`}
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
              style={{ left: `${0.95 + (depth - 1) * 1.05}rem` }}
            />
            <span
              aria-hidden="true"
              className="absolute top-1/2 h-px w-[0.85rem] -translate-y-1/2 bg-border/70"
              style={{ left: `${0.95 + (depth - 1) * 1.05}rem` }}
            />
          </>
        ) : null}
        <span
          aria-hidden="true"
          className={`relative size-1.5 shrink-0 ${failed ? "bg-red-500" : depth === 0 ? "bg-primary" : "bg-muted-foreground"}`}
          style={{ marginLeft: `${depth * 1.05}rem` }}
        />
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={`shrink-0 font-mono text-xs font-medium ${failed ? "text-red-500 dark:text-red-400" : "text-primary"}`}
          >
            {span.operation ?? "span"}
          </span>
          <span className="truncate text-sm" title={span.description}>
            {span.description}
          </span>
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
        className="flex items-center justify-end px-3 py-2 font-mono text-xs font-medium tabular-nums text-foreground"
      >
        {formatDuration(span.durationMs)}
      </div>
    </div>
  );
}

/** A compact, read-only timeline for the spans contained in one local trace. */
export function TraceWaterfall({
  compact = false,
  trace,
}: TraceWaterfallProps) {
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
              <h2 className="font-mono text-sm font-medium">{trace.title}</h2>
              <span className="font-mono text-sm tabular-nums text-foreground">
                {formatDuration(trace.durationMs)}
              </span>
            </div>
            <div
              aria-label="Trace summary"
              className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
            >
              <span>{capturedItemLabel}</span>
              <span>Trace ID {trace.id.slice(0, 8)}</span>
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

  const spans = flattenSpans(trace.roots);

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
            <h2 className="font-mono text-sm font-medium">{trace.title}</h2>
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
            <span>Trace ID {trace.id.slice(0, 8)}</span>
          </div>
        </header>
      )}
      <div role="table" aria-label="Trace spans" className="min-w-max">
        <div
          role="row"
          className="grid min-w-[48rem] grid-cols-[minmax(18rem,38%)_minmax(18rem,1fr)_6.5rem] border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground"
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
        {spans.map((positionedSpan, index) => (
          <SpanRow
            key={positionedSpan.span.id}
            positionedSpan={positionedSpan}
            trace={trace}
            index={index}
          />
        ))}
      </div>
    </section>
  );
}
