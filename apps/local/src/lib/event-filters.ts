import type { LocalFeedItem } from "./spotlight.ts";
import { spanData, text } from "./inspection.ts";
export type EventColumn = "time" | "type" | "level" | "logger" | "duration";
export type EventFilters = {
  levels: string[];
  loggers: string[];
  sort: "received" | "newest" | "oldest" | "duration";
  columns: EventColumn[];
};
export const defaultEventFilters: EventFilters = {
  levels: [],
  loggers: [],
  sort: "received",
  columns: ["time", "type", "level", "logger", "duration"],
};
export function loggerForItem(item: LocalFeedItem): string | undefined {
  return text(spanData(item.payload)["sentry.logger.name"]);
}
function timestamp(item: LocalFeedItem): number {
  const value = item.timestamp;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return -Infinity;
}
export function filterEvents(
  items: readonly LocalFeedItem[],
  filters: EventFilters,
): LocalFeedItem[] {
  const filtered = items.filter(
    (item) =>
      (!filters.levels.length ||
        filters.levels.includes(item.metadata?.level ?? "unknown")) &&
      (!filters.loggers.length ||
        filters.loggers.includes(loggerForItem(item) ?? "unknown")),
  );
  if (filters.sort === "received") return filtered;
  return filtered.sort((a, b) =>
    filters.sort === "duration"
      ? (b.metadata?.durationMs ?? -Infinity) -
        (a.metadata?.durationMs ?? -Infinity)
      : (timestamp(b) - timestamp(a)) * (filters.sort === "oldest" ? -1 : 1),
  );
}
