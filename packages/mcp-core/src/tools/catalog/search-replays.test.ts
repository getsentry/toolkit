import { expect, it, vi } from "vitest";
import { inspectDatasetSearchTool } from "../../test-utils/dataset-search-tool";
import searchReplays from "./search-replays";

// The shared handler is covered by search-events.test.ts.
vi.mock("../support/search-events/search", async (importOriginal) => {
  const { SEARCH_REPLAYS_STUB } =
    await import("../../test-utils/search-events-stub");
  return {
    ...(await importOriginal<
      typeof import("../support/search-events/search")
    >()),
    runSearchEvents: vi.fn(async () => SEARCH_REPLAYS_STUB),
  };
});

it("search_replays runs the shared handler locked to replays", async () => {
  expect(await inspectDatasetSearchTool(searchReplays)).toMatchInlineSnapshot(`
    {
      "dataset": "replays",
      "inputParams": [
        "organizationSlug",
        "query",
        "sort",
        "projectSlug",
        "environment",
        "period",
        "regionUrl",
        "limit",
        "includeExplanation",
      ],
      "options": {
        "lockDataset": true,
        "output": "structured",
      },
    }
  `);
});
