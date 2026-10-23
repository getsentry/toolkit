import { act, renderHook } from "@testing-library/react";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { describe, expect, test, vi } from "vitest";
import { useWorkspaceQueryState } from "./workspace-query.ts";

describe("useWorkspaceQueryState", () => {
  test("hydrates typed state and uses replace history for list controls", async () => {
    const onUrlUpdate = vi.fn();
    const { result } = renderHook(() => useWorkspaceQueryState(), {
      wrapper: withNuqsTestingAdapter({
        hasMemory: true,
        onUrlUpdate,
        searchParams: "?event=event-1&trace=trace-1&q=checkout",
      }),
    });

    expect(result.current).toMatchObject({
      eventId: "event-1",
      query: "checkout",
      traceId: "trace-1",
    });

    await act(() => result.current.setSearchQuery("orders"));

    expect(onUrlUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ history: "replace" }),
        queryString: "?event=event-1&trace=trace-1&q=orders",
      }),
    );
  });

  test("uses push history for selected events and traces", async () => {
    const onUrlUpdate = vi.fn();
    const { result } = renderHook(() => useWorkspaceQueryState(), {
      wrapper: withNuqsTestingAdapter({ hasMemory: true, onUrlUpdate }),
    });

    await act(() => result.current.selectEvent("event-1"));
    expect(onUrlUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ history: "push" }),
        queryString: "?event=event-1",
      }),
    );

    await act(() => result.current.selectTrace("trace-1"));
    expect(onUrlUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ history: "push" }),
        queryString: "?trace=trace-1",
      }),
    );
  });
});
