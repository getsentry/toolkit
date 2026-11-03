import type { LocalFeedItem } from "@/lib/spotlight.ts";
import {
  defaultEventFilters,
  loggerForItem,
  type EventFilters,
  type EventColumn,
} from "@/lib/event-filters.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Button } from "./ui/button.tsx";
function toggle(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}
export function EventFilterControls({
  items,
  filters,
  onChange,
  showLogger,
}: {
  items: readonly LocalFeedItem[];
  filters: EventFilters;
  onChange: (filters: EventFilters) => void;
  showLogger: boolean;
}) {
  const levels = [
    ...new Set(items.map((item) => item.metadata?.level ?? "unknown")),
  ].sort();
  const loggers = [
    ...new Set(items.map((item) => loggerForItem(item) ?? "unknown")),
  ].sort();
  const count = filters.levels.length + filters.loggers.length;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="h-7 px-2 text-xs">
            Filters{count ? ` (${count})` : ""}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="max-h-80 w-64 space-y-3 overflow-auto"
        >
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-semibold">Severity</legend>
            {levels.map((level) => (
              <label key={level} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.levels.includes(level)}
                  onChange={() =>
                    onChange({
                      ...filters,
                      levels: toggle(filters.levels, level),
                    })
                  }
                />
                {level}
              </label>
            ))}
          </fieldset>
          {showLogger ? (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-semibold">Logger</legend>
              {loggers.map((logger) => (
                <label
                  key={logger}
                  className="flex items-start gap-2 break-all text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={filters.loggers.includes(logger)}
                    onChange={() =>
                      onChange({
                        ...filters,
                        loggers: toggle(filters.loggers, logger),
                      })
                    }
                  />
                  {logger}
                </label>
              ))}
            </fieldset>
          ) : null}
        </PopoverContent>
      </Popover>
      <label className="flex items-center gap-1">
        Sort
        <select
          className="h-7 rounded border bg-background px-1"
          value={filters.sort}
          onChange={(event) =>
            onChange({
              ...filters,
              sort: event.target.value as EventFilters["sort"],
            })
          }
        >
          <option value="received">Received order</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="duration">Longest duration</option>
        </select>
      </label>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" className="h-7 px-2 text-xs">
            Columns
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 space-y-2">
          <p className="text-xs text-muted-foreground">
            Message is always shown.
          </p>
          {(
            [
              "time",
              "type",
              "level",
              ...(showLogger ? ["logger"] : []),
              "duration",
            ] as EventColumn[]
          ).map((column) => (
            <label
              key={column}
              className="flex items-center gap-2 text-sm capitalize"
            >
              <input
                type="checkbox"
                checked={filters.columns.includes(column)}
                onChange={() =>
                  onChange({
                    ...filters,
                    columns: toggle(filters.columns, column) as EventColumn[],
                  })
                }
              />
              {column}
            </label>
          ))}
        </PopoverContent>
      </Popover>
      {count ? (
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() =>
            onChange({
              ...defaultEventFilters,
              sort: filters.sort,
              columns: filters.columns,
            })
          }
        >
          Clear {count} filter{count === 1 ? "" : "s"}
        </Button>
      ) : null}
      {count ? (
        <p className="text-muted-foreground">
          {[...filters.levels, ...filters.loggers].join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
