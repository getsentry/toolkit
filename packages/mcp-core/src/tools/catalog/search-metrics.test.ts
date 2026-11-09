import { expect, it, vi } from "vitest";
import { inspectDatasetSearchTool } from "../../test-utils/dataset-search-tool";
import searchMetrics from "./search-metrics";

// The shared handler is covered by search-events.test.ts.
vi.mock("../support/search-events/search", async (importOriginal) => {
  const { SEARCH_EVENTS_STUB } =
    await import("../../test-utils/search-events-stub");
  return {
    ...(await importOriginal<
      typeof import("../support/search-events/search")
    >()),
    runSearchEvents: vi.fn(async () => SEARCH_EVENTS_STUB),
  };
});

it("search_metrics runs the shared handler locked to metrics", async () => {
  expect(await inspectDatasetSearchTool(searchMetrics)).toMatchInlineSnapshot(`
    {
      "dataset": "metrics",
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
        "output": "structured",
      },
    }
  `);
});
