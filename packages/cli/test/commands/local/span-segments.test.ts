import { describe, expect, test } from "vitest";
import { summarizeEnvelope } from "../../../src/commands/local/event-summary.js";
import { formatItem } from "../../../src/lib/formatters/local.js";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";

const pageloadId = "a39103452fcf4abc";

/** A web vital span the browser SDK sends after its pageload segment. */
function vital(span_id: string, name: string, op: string) {
  return {
    trace_id: "3deb203c4ee144c8bb6104076eabc7f4",
    span_id,
    parent_span_id: pageloadId,
    name,
    is_segment: false,
    start_timestamp: 1_794_949_298.4,
    end_timestamp: 1_794_949_298.6,
    attributes: {
      "sentry.op": { type: "string", value: op },
      "sentry.segment.id": { type: "string", value: pageloadId },
      "sentry.segment.name": { type: "string", value: "/client" },
    },
  };
}

describe("span segments", () => {
  test("event list and the tail name a late web vitals batch the same way", () => {
    const payload = {
      items: [
        vital(
          "938bffa38304c5e3",
          "Largest contentful paint",
          "ui.webvital.lcp",
        ),
        vital("9f85c8bac4e3ddc2", "Layout shift", "ui.webvital.cls"),
        vital("884777f7b416aa02", "Click", "ui.interaction.click"),
      ],
    };
    const header = {
      sdk: { name: "sentry.javascript.nextjs", version: "11.14.0" },
    };
    const { title } = summarizeEnvelope({
      envelope: [header, [[{ type: "span" }, payload]]],
    });
    const [line] = formatItem("span", payload, header, "span").map((l) =>
      stripAnsi(l),
    );
    expect(title).toBe("/client");
    expect(line).toContain(`${title} [+3 spans]`);
  });
});
