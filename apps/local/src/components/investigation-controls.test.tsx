import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/test-fixtures/trace-groups.ts";
import { TraceWaterfall } from "./trace-waterfall.tsx";
import { filterEvents, defaultEventFilters } from "@/lib/event-filters.ts";
afterEach(cleanup);
const events = decodeEnvelope(
  JSON.stringify([
    {},
    [
      [
        { type: "log" },
        {
          items: [
            {
              body: "first",
              level: "info",
              timestamp: 10,
              attributes: { "sentry.logger.name": { value: "orders" } },
            },
            {
              body: "second",
              level: "error",
              timestamp: 20,
              attributes: { "sentry.logger.name": { value: "payments" } },
            },
          ],
        },
      ],
    ],
  ]),
  "logs",
);
test("log filters combine severity and logger and sort timestamps without changing captured data", () => {
  expect(
    filterEvents(events, {
      ...defaultEventFilters,
      levels: ["error"],
      loggers: ["payments"],
      sort: "newest",
    }).map((item) => item.metadata?.title),
  ).toEqual(["second"]);
  expect(
    filterEvents(events, { ...defaultEventFilters, sort: "newest" })[0]
      ?.timestamp,
  ).toBe(20);
  expect(events[0]?.timestamp).toBe(10);
});
test("trace search reveals matching descendants and branch collapse is reversible", async () => {
  const [trace] = await buildTraceGroups(
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "Checkout",
              contexts: { trace: { trace_id: "t", span_id: "root" } },
              spans: [
                {
                  span_id: "query",
                  parent_span_id: "root",
                  op: "db.query",
                  description: "select orders",
                },
                {
                  span_id: "cache",
                  parent_span_id: "root",
                  op: "cache",
                  description: "cache lookup",
                },
              ],
            },
          ],
        ],
      ]),
      "trace",
    ),
  );
  render(<TraceWaterfall trace={trace!} onSelectSpan={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Collapse Checkout" }));
  expect(
    screen.queryByRole("button", { name: "Inspect span select orders" }),
  ).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search in trace" }), {
    target: { value: "orders" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Only show matches" }));
  expect(
    screen.getByRole("button", { name: "Inspect span select orders" }),
  ).toBeDefined();
  expect(
    screen.queryByRole("button", { name: "Inspect span cache lookup" }),
  ).toBeNull();
});
