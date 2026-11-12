import { describe, expect, it } from "vitest";
import { ReplayTimelineBuilder } from "./replay-timeline";

function breadcrumb(timestamp: number, payload: Record<string, unknown>) {
  return {
    type: 5,
    timestamp: timestamp * 1000,
    data: { tag: "breadcrumb", payload: { timestamp, ...payload } },
  };
}

function build(events: unknown[]) {
  const builder = new ReplayTimelineBuilder();
  builder.addSegment(events);
  return builder.build();
}

describe("ReplayTimelineBuilder", () => {
  it("labels slow clicks by how the SDK classified them", () => {
    const node = { tagName: "button", textContent: "Save" };
    const events = build([
      breadcrumb(10, {
        category: "ui.slowClickDetected",
        message: "button.save",
        data: {
          node,
          endReason: "timeout",
          timeAfterClickMs: 7000,
          clickCount: 6,
        },
      }),
      breadcrumb(20, {
        category: "ui.slowClickDetected",
        message: "div.card",
        data: {
          node: { tagName: "div" },
          endReason: "mutation",
          timeAfterClickMs: 3200,
        },
      }),
      breadcrumb(30, {
        category: "ui.multiClick",
        message: "a.next",
        data: { clickCount: 3 },
      }),
    ]);

    expect(events.map(({ label, details }) => ({ label, details }))).toEqual([
      {
        label: "rage click",
        details: [
          { label: "text", value: "Save" },
          { label: "no response after", value: "7.0s" },
          { label: "clicks", value: "6" },
        ],
      },
      {
        label: "slow click",
        details: [
          { label: "response after", value: "3.2s" },
          { label: "ended by", value: "mutation" },
        ],
      },
    ]);
  });

  it("treats requests that never completed as failed", () => {
    const [event] = build([
      {
        type: 5,
        timestamp: 1000,
        data: {
          tag: "performanceSpan",
          payload: {
            op: "resource.xhr",
            description: "https://example.com/api",
            startTimestamp: 1,
            endTimestamp: 1.25,
            data: { method: "GET", statusCode: 0 },
          },
        },
      },
    ]);

    expect(event).toMatchObject({
      category: "network",
      target: "GET https://example.com/api",
      notable: true,
      problem: "failed request",
      details: [
        { label: "status", value: "0" },
        { label: "duration", value: "250ms" },
      ],
    });
  });

  it("formats key presses with their modifiers", () => {
    const events = build([
      breadcrumb(1, {
        category: "ui.keyDown",
        message: "div.modal",
        data: { key: "Escape" },
      }),
      breadcrumb(2, {
        category: "ui.keyDown",
        message: "textarea",
        data: { key: "Enter", ctrlKey: true },
      }),
      breadcrumb(3, {
        category: "ui.keyDown",
        message: "body",
        data: { key: "Alt", altKey: true },
      }),
      breadcrumb(4, {
        category: "ui.keyDown",
        message: "body",
        data: { key: " ", ctrlKey: true },
      }),
    ]);

    expect(events.map((event) => event.details[0]?.value)).toEqual([
      "Escape",
      "Ctrl+Enter",
      "Alt",
      "Ctrl+Space",
    ]);
  });

  it("sorts events across segments and keeps mobile taps", () => {
    const builder = new ReplayTimelineBuilder();
    builder.addSegment([
      breadcrumb(20, { category: "ui.tap", message: "Pay" }),
    ]);
    builder.addSegment([
      breadcrumb(10, { category: "auth", message: "Signed in" }),
      breadcrumb(15, { category: "ui.focus" }),
    ]);

    expect(
      builder.build().map(({ label, target }) => `${label}:${target}`),
    ).toEqual(["auth:Signed in", "tap:Pay"]);
  });
});
