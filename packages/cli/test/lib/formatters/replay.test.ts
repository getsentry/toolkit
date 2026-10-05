/**
 * Tests for shape-specific Session Replay activity extraction.
 */

import { describe, expect, test } from "vitest";
import { extractReplayActivityEvents } from "../../../src/lib/formatters/replay.js";

describe("extractReplayActivityEvents", () => {
  test("extracts page, click, performance, and breadcrumb shapes", () => {
    const events = extractReplayActivityEvents(
      [
        [
          { type: 4, timestamp: 1, data: { href: "/checkout" } },
          {
            type: 5,
            timestamp: 2,
            data: {
              tag: "breadcrumb",
              payload: { category: "ui.click", message: "#pay" },
            },
          },
          {
            type: 5,
            timestamp: 3,
            data: {
              tag: "performanceSpan",
              payload: {
                op: "resource.fetch",
                description: "GET /api/cart",
                data: { duration: 42 },
              },
            },
          },
          {
            type: 5,
            timestamp: 4,
            data: {
              tag: "breadcrumb",
              payload: {
                category: "navigation",
                message: "Visited checkout",
              },
            },
          },
        ],
      ],
      10
    );

    expect(events).toEqual([
      {
        timestampMs: 1,
        label: "page.view",
        details: ["href=/checkout"],
      },
      {
        timestampMs: 2,
        label: "ui.click",
        details: ["message=#pay"],
      },
      {
        timestampMs: 3,
        label: "resource.fetch",
        details: ["description=GET /api/cart", "duration_ms=42"],
      },
      {
        timestampMs: 4,
        label: "navigation",
        details: ["message=Visited checkout"],
      },
    ]);
  });

  test("ignores unknown event fields and keeps empty click payload behavior", () => {
    const events = extractReplayActivityEvents(
      [
        [
          { timestamp: 1 },
          { timestamp: 2, data: null },
          { timestamp: 3, data: { href: "" } },
          { timestamp: 4, data: { tag: "click", payload: {} } },
          {
            timestamp: 5,
            data: {
              tag: "performanceSpan",
              payload: { op: "db", data: { duration: "slow" } },
            },
          },
        ],
      ],
      10
    );

    expect(events).toEqual([
      { timestampMs: 4, label: "click", details: [] },
      { timestampMs: 5, label: "db", details: [] },
    ]);
  });
});
