import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/lib/trace-model.ts";
import { TraceWaterfall } from "./trace-waterfall.tsx";

afterEach(cleanup);

test.each(["internal_error", "error"])(
  "styles status-only %s failures without affecting healthy children",
  (status) => {
    const items = decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "GET /failed",
              start_timestamp: 1,
              timestamp: 2,
              contexts: {
                trace: { trace_id: "trace", span_id: "root", status },
              },
              spans: [
                {
                  span_id: "healthy",
                  parent_span_id: "root",
                  op: "db.query",
                  status: "ok",
                  start_timestamp: 1.1,
                  timestamp: 1.2,
                },
                {
                  span_id: "failed",
                  parent_span_id: "root",
                  op: "db.query",
                  status,
                  start_timestamp: 1.3,
                  timestamp: 1.4,
                },
              ],
            },
          ],
        ],
      ]),
      "envelope",
    );
    const trace = buildTraceGroups(items)[0];
    expect(trace).toBeDefined();
    if (!trace) throw new Error("Expected trace");
    render(<TraceWaterfall trace={trace} />);
    expect(screen.getByTestId("waterfall-bar-root").className).toContain(
      "bg-red-500",
    );
    expect(screen.getByTestId("waterfall-bar-failed").className).toContain(
      "bg-red-500",
    );
    expect(screen.getByTestId("waterfall-bar-healthy").className).not.toContain(
      "bg-red-500",
    );
  },
);
