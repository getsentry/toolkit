import { expect, it, vi } from "vitest";
import { inspectDatasetSearchTool } from "../../test-utils/dataset-search-tool";
import searchLogs from "./search-logs";

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

it("search_logs runs the shared handler locked to logs", async () => {
  expect(await inspectDatasetSearchTool(searchLogs)).toMatchInlineSnapshot(`
    {
      "dataset": "logs",
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
