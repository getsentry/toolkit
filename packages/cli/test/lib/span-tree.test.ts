/**
 * Tests for getSpanTreeLines time-window wiring into getDetailedTrace.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../src/lib/api-client.js";
import { getSpanTreeLines } from "../../src/lib/span-tree.js";
import type { SentryEvent } from "../../src/types/index.js";

const TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";

function eventWithTrace(overrides: Partial<SentryEvent> = {}): SentryEvent {
  return {
    eventID: "event-1",
    contexts: { trace: { trace_id: TRACE_ID } },
    ...overrides,
  };
}

describe("getSpanTreeLines", () => {
  let getDetailedTraceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getDetailedTraceSpy = vi.spyOn(apiClient, "getDetailedTrace");
    getDetailedTraceSpy.mockResolvedValue([]);
  });

  afterEach(() => {
    getDetailedTraceSpy.mockRestore();
  });

  test("passes dateCreated as unix timestamp when the event time is known", async () => {
    const dateCreated = "2026-09-13T22:00:00.000Z";
    await getSpanTreeLines("my-org", eventWithTrace({ dateCreated }), 3);

    expect(getDetailedTraceSpy).toHaveBeenCalledWith("my-org", TRACE_ID, {
      timestamp: Date.parse(dateCreated) / 1000,
    });
  });

  test("omits timestamp when dateCreated is missing so lookup can widen", async () => {
    await getSpanTreeLines("my-org", eventWithTrace(), 3);

    expect(getDetailedTraceSpy).toHaveBeenCalledWith("my-org", TRACE_ID, {});
  });

  test("does not fetch when the event has no trace id", async () => {
    await getSpanTreeLines("my-org", { eventID: "event-1" }, 3);

    expect(getDetailedTraceSpy).not.toHaveBeenCalled();
  });
});
