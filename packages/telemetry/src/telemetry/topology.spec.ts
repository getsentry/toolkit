import { expect, test } from "vitest";
import { createTelemetryStore } from "../sdk/core.ts";

test("a self-parented span remains visible as a tree root", async () => {
  const telemetry = createTelemetryStore();
  try {
    const result = await telemetry.ingestEnvelope([
      {},
      [
        [
          { type: "span" },
          {
            version: 2,
            items: [
              {
                trace_id: "trace",
                span_id: "self",
                parent_span_id: "self",
                start_timestamp: 1,
                end_timestamp: 2,
              },
              {
                trace_id: "trace",
                span_id: "child",
                parent_span_id: "self",
                start_timestamp: 1.1,
                end_timestamp: 1.5,
              },
            ],
          },
        ],
      ],
    ]);
    expect(result.status).toBe("processed");
    const trace = telemetry.getTrace("trace")!;
    expect(trace.spans.size).toBe(2);
    expect(trace.spanTree.map((span) => span.span_id)).toEqual(["self"]);
    expect(trace.spanTree[0].children?.map((span) => span.span_id)).toEqual([
      "child",
    ]);
  } finally {
    telemetry.dispose();
  }
});
