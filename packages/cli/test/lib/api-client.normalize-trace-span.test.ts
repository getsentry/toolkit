import { describe, expect, test } from "vitest";
import { normalizeTraceSpan } from "../../src/lib/api-client.js";

describe("normalizeTraceSpan", () => {
  test("copies event_id to span_id when span_id is missing", () => {
    const span = { event_id: "abc123", start_timestamp: 0 } as Parameters<
      typeof normalizeTraceSpan
    >[0];
    const result = normalizeTraceSpan(span);
    expect(result.span_id).toBe("abc123");
  });

  test("preserves existing span_id", () => {
    const result = normalizeTraceSpan({
      span_id: "existing",
      event_id: "other",
      start_timestamp: 0,
    });
    expect(result.span_id).toBe("existing");
  });

  test("recurses into children", () => {
    const result = normalizeTraceSpan({
      span_id: "parent",
      start_timestamp: 0,
      children: [{ event_id: "child1", start_timestamp: 1 } as any],
    });
    expect(result.children?.[0]?.span_id).toBe("child1");
  });
});
