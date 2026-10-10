import { expect, it, vi } from "vitest";
import { inspectDatasetSearchTool } from "../../test-utils/dataset-search-tool";
import searchTraces from "./search-traces";

// The shared handler is covered by search-events.test.ts.
vi.mock("../support/search-events/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../support/search-events/search")>()),
  runSearchEvents: vi.fn(async () => "ok"),
}));

it("search_traces runs the shared handler locked to spans", async () => {
  expect(await inspectDatasetSearchTool(searchTraces)).toMatchInlineSnapshot(`
    {
      "dataset": "spans",
      "inputParams": [
        "organizationSlug",
        "query",
        "fields",
        "sort",
        "projectSlug",
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
