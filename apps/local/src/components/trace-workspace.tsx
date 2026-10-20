import type { TraceGroup } from "../lib/trace-model";
import { TraceWaterfall } from "./trace-waterfall";

type TraceWorkspaceProps = {
  emptyState?: { title: string; description: string };
  onSelect: (traceId: string) => void;
  selectedTraceId?: string;
  traces: TraceGroup[];
};

function formatDuration(durationMs: number | undefined) {
  if (durationMs === undefined) {
    return "—";
  }

  if (durationMs < 1_000) {
    return `${Math.round(durationMs)} ms`;
  }

  return `${(durationMs / 1_000).toFixed(2)} s`;
}

export function TraceWorkspace({
  emptyState = {
    title: "No traces captured",
    description:
      "Transactions and spans from your receiver will appear here as a single trace.",
  },
  onSelect,
  selectedTraceId,
  traces,
}: TraceWorkspaceProps) {
  const selectedTrace =
    traces.find((trace) => trace.id === selectedTraceId) ?? traces[0];

  if (!selectedTrace) {
    return (
      <section
        className="flex min-h-0 flex-1 items-center justify-center p-6"
        aria-label="Traces"
      >
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-foreground">
            {emptyState.title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {emptyState.description}
          </p>
        </div>
      </section>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside
        aria-label="Trace list"
        className="flex min-h-0 w-80 shrink-0 flex-col border-r border-border bg-muted/30"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
          <h2
            id="trace-list-heading"
            className="text-sm font-semibold text-foreground"
          >
            Traces
          </h2>
          <span className="font-mono text-xs text-muted-foreground">
            {traces.length} trace{traces.length === 1 ? "" : "s"}
          </span>
        </header>

        <ol
          className="min-h-0 flex-1 space-y-px overflow-y-auto"
          aria-labelledby="trace-list-heading"
        >
          {traces.map((trace) => {
            const isSelected = trace.id === selectedTrace.id;

            return (
              <li key={trace.id}>
                <button
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  aria-label={`View trace ${trace.title}`}
                  className={`flex w-full items-center justify-between gap-3 px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                    isSelected
                      ? "bg-muted text-foreground"
                      : "text-foreground hover:bg-muted/60"
                  }`}
                  onClick={() => onSelect(trace.id)}
                >
                  <div className="min-w-0 space-y-1">
                    <span className="block truncate font-mono text-sm">
                      {trace.title}
                    </span>
                    <div className="flex gap-2 text-xs text-muted-foreground">
                      <span>{trace.spans.length} spans</span>
                      {trace.errorCount > 0 ? (
                        <span className="text-red-500 dark:text-red-400">
                          {trace.errorCount} errors
                        </span>
                      ) : null}
                      {trace.logCount > 0 ? (
                        <span>{trace.logCount} logs</span>
                      ) : null}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-sm text-muted-foreground">
                    {formatDuration(trace.durationMs)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </aside>

      <div className="min-w-0 flex-1 overflow-auto bg-card">
        <TraceWaterfall trace={selectedTrace} />
      </div>
    </div>
  );
}
