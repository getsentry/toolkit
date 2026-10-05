import { vi } from "vitest";
import { runSearchEvents } from "../tools/support/search-events/search";
import type { ServerContext } from "../types";
import { createTestContext } from "./context";

const params = {
  organizationSlug: "test-org",
  regionUrl: null,
  projectSlug: null,
  query: "anything",
  limit: 10,
  includeExplanation: false,
};

/**
 * Call a dataset-specific search tool and report what it passed to the shared
 * handler. The test file must mock `runSearchEvents`:
 *
 *   vi.mock("../support/search-events/search", async (importOriginal) => ({
 *     ...(await importOriginal<typeof import("../support/search-events/search")>()),
 *     runSearchEvents: vi.fn(async () => "ok"),
 *   }));
 */
export async function inspectDatasetSearchTool<P>(tool: {
  inputSchema: object;
  handler(params: P, context: ServerContext): Promise<unknown>;
}) {
  const run = vi.mocked(runSearchEvents);
  run.mockClear();
  await tool.handler(params as P, createTestContext());
  const [handlerParams, , options] = run.mock.calls[0] ?? [];
  return {
    dataset: handlerParams?.dataset,
    options,
    inputParams: Object.keys(tool.inputSchema),
  };
}
