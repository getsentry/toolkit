import { vListOrganizationReplaysData } from "@sentry/api/valibot";
import { describe, expect, test } from "vitest";
import {
  getReplayFieldValue,
  getReplayRequestFields,
  isSupportedReplayField,
  listSupportedReplayFields,
} from "../../src/lib/replay-search.js";

const requestableRoots = new Set<string>(
  vListOrganizationReplaysData.entries.query.wrapped.entries.field.wrapped.item
    .options,
);

describe("getReplayRequestFields", () => {
  test("normalizes replay field aliases for API requests", () => {
    expect(getReplayRequestFields(["url", "trace_id"])).toEqual([
      "id",
      "urls",
      "trace_ids",
    ]);
  });

  test("requests backing array fields for convenience replay columns", () => {
    expect(getReplayRequestFields(["error_id", "release", "screen"])).toEqual([
      "id",
      "error_ids",
      "releases",
      "urls",
    ]);
  });

  test("requests the root of nested API fields", () => {
    expect(
      getReplayRequestFields(["user.geo.city", "browser.version"]),
    ).toEqual(["id", "user", "browser"]);
  });

  test("maps user.display to the user API root field", () => {
    expect(getReplayRequestFields(["user.display"])).toEqual(["id", "user"]);
  });

  test("only requests roots the published schema accepts", () => {
    const roots = getReplayRequestFields(listSupportedReplayFields());
    expect(roots.filter((root) => !requestableRoots.has(root))).toEqual([]);
  });
});

describe("isSupportedReplayField", () => {
  test("accepts nested fields from the published replay schema", () => {
    expect(isSupportedReplayField("user.geo.country_code")).toBe(true);
    expect(isSupportedReplayField("user.display_name")).toBe(true);
  });

  test("recognizes user.display as a supported replay field", () => {
    expect(isSupportedReplayField("user.display")).toBe(true);
  });

  test("rejects fields missing from the published replay schema", () => {
    expect(isSupportedReplayField("device.model_id")).toBe(false);
    expect(isSupportedReplayField("warning_ids")).toBe(false);
  });

  test("rejects response fields the replay index does not accept", () => {
    expect(isSupportedReplayField("replay_type")).toBe(false);
  });
});

describe("getReplayFieldValue", () => {
  const replay = {
    id: "abc123",
    urls: ["https://example.com/a", "https://example.com/b"],
    user: {
      display_name: "Jane Doe",
      username: "jane",
      email: "jane@example.com",
      id: "1",
      ip: "1.2.3.4",
      geo: { city: "Vienna" },
    },
  } as Parameters<typeof getReplayFieldValue>[0];

  test("resolves user.display to the best available user label", () => {
    expect(getReplayFieldValue(replay, "user.display")).toBe("Jane Doe");
  });

  test("reads nested API fields by path", () => {
    expect(getReplayFieldValue(replay, "user.geo.city")).toBe("Vienna");
    expect(getReplayFieldValue(replay, "browser.name")).toBeUndefined();
  });

  test("resolves convenience columns from their backing field", () => {
    expect(getReplayFieldValue(replay, "url")).toBe("https://example.com/a");
  });
});
