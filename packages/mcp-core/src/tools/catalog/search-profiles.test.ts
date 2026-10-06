import { expect, it, vi } from "vitest";
import { inspectDatasetSearchTool } from "../../test-utils/dataset-search-tool";
import searchProfiles from "./search-profiles";

// The shared handler is covered by search-events.test.ts.
vi.mock("../support/search-events/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../support/search-events/search")>()),
  runSearchEvents: vi.fn(async () => "ok"),
}));

it("search_profiles runs the shared handler locked to profiles", async () => {
  expect(await inspectDatasetSearchTool(searchProfiles)).toMatchInlineSnapshot(`
    {
      "dataset": "profiles",
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
