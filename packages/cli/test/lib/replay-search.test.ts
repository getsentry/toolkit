import { describe, expect, test } from "vitest";
import {
  getReplayFieldValue,
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
      ]),
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

  test("recognizes user.display as a supported replay field", () => {
    expect(isSupportedReplayField("user.display")).toBe(true);
  });
});

describe("getReplayRequestFields", () => {
  test("maps user.display to the user API root field", () => {
    expect(getReplayRequestFields(["user.display"])).toEqual(["id", "user"]);
  });
});

describe("getReplayFieldValue", () => {
  test("resolves user.display to the best available user label", () => {
    const replay = {
      id: "abc123",
      user: {
        display_name: "Jane Doe",
        username: "jane",
        email: "jane@example.com",
        id: "1",
        ip: "1.2.3.4",
      },
    } as Parameters<typeof getReplayFieldValue>[0];
    expect(getReplayFieldValue(replay, "user.display")).toBe("Jane Doe");
  });
});
