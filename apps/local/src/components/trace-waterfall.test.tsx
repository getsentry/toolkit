import { afterEach, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/test-fixtures/trace-groups.ts";
import { TraceWaterfall } from "./trace-waterfall.tsx";

afterEach(cleanup);

test.each(["internal_error", "error"])(
  "styles status-only %s failures without affecting healthy children",
  async (status) => {
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
    const trace = (await buildTraceGroups(items))[0];
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

test("renders a deeply nested valid span chain without overflowing the stack", async () => {
  const count = 4000;
  const items = decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          { type: "transaction" },
          {
            transaction: "deep trace",
            start_timestamp: 0,
            timestamp: count + 1,
            contexts: { trace: { trace_id: "deep", span_id: "root" } },
            spans: Array.from({ length: count }, (_, index) => ({
              span_id: `span-${index}`,
              parent_span_id: index === 0 ? "root" : `span-${index - 1}`,
              description: `deep-${index}`,
              start_timestamp: index,
              timestamp: index + 1,
            })),
          },
        ],
      ],
    ]),
    "deep-envelope",
  );
  const trace = (await buildTraceGroups(items))[0];
  if (!trace) throw new Error("Expected deep trace");
  const markup = renderToStaticMarkup(<TraceWaterfall trace={trace} />);
  expect(markup).toContain(`waterfall-bar-span-${count - 1}`);
  expect(markup.indexOf("deep-0")).toBeLessThan(
    markup.indexOf(`deep-${count - 1}`),
  );
});

test("span descriptions are keyboard-selectable and expose selected state", async () => {
  const [trace] = await buildTraceGroups(
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "GET /orders",
              start_timestamp: 1,
              timestamp: 2,
              contexts: { trace: { trace_id: "trace", span_id: "root" } },
            },
          ],
        ],
      ]),
      "select",
    ),
  );
  if (!trace) throw new Error("Expected trace");
  let selected: string | undefined;
  render(
    <TraceWaterfall
      trace={trace}
      selectedSpanId="root"
      onSelectSpan={(spanId) => {
        selected = spanId;
      }}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Inspect span GET /orders",
  });
  expect(button.getAttribute("aria-pressed")).toBe("true");
  button.click();
  expect(selected).toBe("root");
});
