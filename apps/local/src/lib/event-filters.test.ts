import { expect, test } from "vitest";
import { defaultEventFilters, filterEvents } from "./event-filters.ts";
import type { LocalFeedItem } from "./spotlight.ts";

const item = (id: string, timestamp?: number | string): LocalFeedItem => ({
  id,
  type: "transaction",
  timestamp,
  text: "{}",
  payload: {},
});

test("sorts epoch-second and ISO 8601 timestamps on one timeline", () => {
  const items = [
    item("python-late", "2026-11-17T20:25:07.000000Z"),
    item("js-early", Date.UTC(2026, 10, 17, 20, 25, 5) / 1000),
    item("unknown"),
    item("python-mid", "2026-11-17T20:25:06.425134Z"),
  ];
  const sorted = (sort: "newest" | "oldest") =>
    filterEvents(items, { ...defaultEventFilters, sort }).map(
      (entry) => entry.id,
    );
  expect(sorted("newest")).toEqual([
    "python-late",
    "python-mid",
    "js-early",
    "unknown",
  ]);
  expect(sorted("oldest")).toEqual([
    "unknown",
    "js-early",
    "python-mid",
    "python-late",
  ]);
});
