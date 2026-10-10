import { expect, it, vi } from "vitest";
import { inspectDatasetSearchTool } from "../../test-utils/dataset-search-tool";
import searchReplays from "./search-replays";

// The shared handler is covered by search-events.test.ts.
vi.mock("../support/search-events/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../support/search-events/search")>()),
  runSearchEvents: vi.fn(async () => "ok"),
}));

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
      },
    }
  `);
});
