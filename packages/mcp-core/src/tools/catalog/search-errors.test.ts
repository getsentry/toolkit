import { expect, it, vi } from "vitest";
import { inspectDatasetSearchTool } from "../../test-utils/dataset-search-tool";
import searchErrors from "./search-errors";

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

it("search_errors runs the shared handler locked to errors", async () => {
  expect(await inspectDatasetSearchTool(searchErrors)).toMatchInlineSnapshot(`
    {
      "dataset": "errors",
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
