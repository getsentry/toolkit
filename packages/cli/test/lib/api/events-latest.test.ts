import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/api/explore.js", () => ({
  queryEvents: vi.fn(),
}));

import { findLatestProjectEventId } from "../../../src/lib/api/events.js";
import { queryEvents } from "../../../src/lib/api/explore.js";

describe("findLatestProjectEventId", () => {
  beforeEach(() => vi.mocked(queryEvents).mockReset());

  test("selects the project by numeric ID, not a project:<slug> filter (#1317)", async () => {
    vi.mocked(queryEvents).mockResolvedValue({
      data: { data: [{ id: "abc123", timestamp: "2026-11-02T10:00:00Z" }] },
    } as never);

    await expect(findLatestProjectEventId("my-org", 42)).resolves.toBe(
      "abc123",
    );

    const [org, options] = vi.mocked(queryEvents).mock.calls[0] ?? [];
    expect(org).toBe("my-org");
    expect(options).toMatchObject({
      dataset: "errors",
      project: [42],
      sort: "-timestamp",
      limit: 1,
      statsPeriod: "14d",
    });
    expect(options?.query ?? "").not.toContain("project:");
  });

  test("returns undefined when the project has no events", async () => {
    vi.mocked(queryEvents).mockResolvedValue({
      data: { data: [] },
    } as never);

    await expect(
      findLatestProjectEventId("my-org", 42),
    ).resolves.toBeUndefined();
  });
});
