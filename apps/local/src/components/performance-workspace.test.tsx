import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { buildTraceGroups } from "@/test-fixtures/trace-groups.ts";
import { SpanAnalysis, WebVitalsWorkspace } from "./performance-workspace.tsx";
import { ProfileWorkspace } from "./profile-workspace.tsx";
afterEach(cleanup);
const item = (type: string, payload: unknown) =>
  decodeEnvelope(JSON.stringify([{}, [[{ type }, payload]]]), "sample")[0]!;
test("resource groups sort and open the selected execution in its trace", async () => {
  const traces = await buildTraceGroups([
    item("transaction", {
      transaction: "Page",
      contexts: { trace: { trace_id: "t", span_id: "root" } },
      spans: [
        {
          span_id: "one",
          op: "resource.script",
          description: "app.js",
          start_timestamp: 1,
          timestamp: 1.2,
          data: { "http.response_content_length": 100 },
        },
        {
          span_id: "two",
          op: "resource.img",
          description: "logo.png",
          start_timestamp: 1,
          timestamp: 1.1,
        },
      ],
    }),
  ]);
  const onSelect = vi.fn();
  render(
    <SpanAnalysis
      kind="resources"
      traces={traces}
      query=""
      onSelectSpan={onSelect}
    />,
  );
  fireEvent.change(screen.getByLabelText("Sort by"), {
    target: { value: "name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "logo.png" }));
  fireEvent.click(screen.getByRole("button", { name: /Page.*two.*100.0 ms/ }));
  expect(onSelect).toHaveBeenCalledWith("t", "two");
});
test("Web Vitals metric switching displays captured INP without fabricating missing visits", () => {
  render(
    <WebVitalsWorkspace
      items={[
        item("transaction", {
          transaction: "/orders",
          measurements: { lcp: { value: 2400 }, inp: { value: 350 } },
        }),
      ]}
      query=""
      onSelectItem={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Measurement"), {
    target: { value: "inp" },
  });
  expect(
    screen.getByRole("img", { name: "INP: 350 ms, Needs improvement" }),
  ).toBeDefined();
});
test("profile chart supports zoom, visualization switching and independent thread samples", () => {
  const profile = item("profile", {
    profile: {
      frames: [{ function: "mainWork" }, { function: "workerWork" }],
      stacks: [[0], [1]],
      samples: [
        { thread_id: "main", stack_id: 0, elapsed_since_start_ns: "0" },
        { thread_id: "worker", stack_id: 1, elapsed_since_start_ns: "0" },
      ],
      thread_metadata: { main: { name: "Main" }, worker: { name: "Worker" } },
    },
  });
  render(
    <ProfileWorkspace
      items={[profile]}
      traces={[]}
      query=""
      onSelect={() => {}}
      onSelectTrace={() => {}}
    />,
  );
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Zoom to mainWork, 1 samples" }),
    { key: "Enter" },
  );
  expect(screen.getByRole("button", { name: "Reset zoom" })).toBeDefined();
  fireEvent.change(screen.getByLabelText("Visualization"), {
    target: { value: "treemap" },
  });
  expect(
    screen.getByRole("group", { name: "treemap profile visualization" }),
  ).toBeDefined();
  fireEvent.change(screen.getByLabelText("Thread"), {
    target: { value: "worker" },
  });
  expect(screen.queryByRole("button", { name: "Reset zoom" })).toBeNull();
  expect(
    screen.getByRole("table", { name: "Profile functions" }).textContent,
  ).toContain("workerWork");
  expect(
    screen.getByRole("table", { name: "Profile functions" }).textContent,
  ).not.toContain("mainWork");
});
