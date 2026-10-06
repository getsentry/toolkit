import { describe, expect, test } from "vitest";
import {
  getReplayRequestFields,
  isSupportedReplayField,
} from "../../src/lib/replay-search.js";

describe("getReplayRequestFields", () => {
  test("normalizes replay field aliases for API requests", () => {
    expect(getReplayRequestFields(["url", "trace_id"])).toEqual([
      "id",
      "urls",
      "trace_ids",
    ]);
  });

  test("requests backing array fields for convenience replay columns", () => {
    expect(
      getReplayRequestFields([
        "error_id",
        "info_id",
        "release",
        "screen",
        "warning_id",
      ])
    ).toEqual([
      "id",
      "error_ids",
      "info_ids",
      "releases",
      "urls",
      "warning_ids",
    ]);
  });
});

describe("isSupportedReplayField", () => {
  test("does not expose replay detail-only fields in replay explore", () => {
    expect(isSupportedReplayField("replay_type")).toBe(false);
  });
});
