/**
 * Replay → rrweb conversion tests
 */

import { describe, expect, test } from "vitest";
import {
  hasFullSnapshot,
  rrwebDurationMs,
  toRRWebEvents,
} from "../../src/lib/replay-rrweb.js";

const T0 = 1_787_282_938_000;

const meta = (timestamp: number, width: number, height: number) => ({
  type: 4,
  data: { href: "https://example.com/", width, height },
  timestamp,
});
const fullSnapshot = (timestamp: number) => ({
  type: 2,
  data: { node: { type: 0, childNodes: [], id: 1 } },
  timestamp,
});
const mouseMove = (timestamp: number, id: number) => ({
  type: 3,
  data: { source: 1, positions: [{ x: 1, y: 1, id, timeOffset: 0 }] },
  timestamp,
});
const breadcrumb = (timestamp: number) => ({
  type: 5,
  data: { tag: "breadcrumb", payload: { category: "ui.click" } },
  timestamp,
});

describe("toRRWebEvents", () => {
  test("flattens segments into one array", () => {
    const events = toRRWebEvents([
      [meta(T0, 800, 600), fullSnapshot(T0 + 1)],
      [],
      [mouseMove(T0 + 2, 1)],
    ]);

    expect(events.map((event) => event.type)).toEqual([4, 2, 3]);
  });

  test("keeps Sentry custom events", () => {
    const crumb = breadcrumb(T0 + 5);
    const events = toRRWebEvents([[fullSnapshot(T0), crumb]]);

    expect(events).toContainEqual(crumb);
  });

  test("sorts custom events appended out of order into place", () => {
    const events = toRRWebEvents([
      [fullSnapshot(T0), mouseMove(T0 + 100, 1), breadcrumb(T0 + 50)],
    ]);

    expect(events.map((event) => event.type)).toEqual([2, 5, 3]);
  });

  test("keeps recorded order for events sharing a timestamp", () => {
    const events = toRRWebEvents([
      [mouseMove(T0, 1), mouseMove(T0, 2)],
      [mouseMove(T0, 3)],
    ]);

    expect(events.map((event) => (event.data as any).positions[0].id)).toEqual([
      1, 2, 3,
    ]);
  });

  test("converts second-resolution timestamps to milliseconds", () => {
    const span = {
      type: 5,
      data: { tag: "performanceSpan", payload: { op: "resource.fetch" } },
      timestamp: (T0 + 500) / 1000,
    };
    const events = toRRWebEvents([
      [fullSnapshot(T0), mouseMove(T0 + 1000, 1), span],
    ]);

    expect(events.map((event) => event.timestamp)).toEqual([
      T0,
      T0 + 500,
      T0 + 1000,
    ]);
    expect(events[1]?.data).toEqual(span.data);
  });

  test("leaves event data untouched", () => {
    const emptyMeta = meta(T0, 0, 0);
    const events = toRRWebEvents([[emptyMeta, meta(T0 + 1, 1920, 874)]]);

    expect(events[0]).toBe(emptyMeta);
  });

  test("returns an empty array for no segments", () => {
    expect(toRRWebEvents([])).toEqual([]);
    expect(toRRWebEvents([[], []])).toEqual([]);
  });
});

describe("hasFullSnapshot", () => {
  test("detects a full snapshot", () => {
    expect(hasFullSnapshot([meta(T0, 1, 1), fullSnapshot(T0)])).toBe(true);
    expect(hasFullSnapshot([breadcrumb(T0)])).toBe(false);
  });
});

describe("rrwebDurationMs", () => {
  test("spans first to last event", () => {
    expect(rrwebDurationMs([fullSnapshot(T0), mouseMove(T0 + 2500, 1)])).toBe(
      2500,
    );
    expect(rrwebDurationMs([])).toBe(0);
  });
});
