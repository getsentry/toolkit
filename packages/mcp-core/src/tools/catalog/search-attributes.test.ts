import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getServerContext } from "../../test-setup.js";
import searchAttributes from "./search-attributes.js";

function search(params: Record<string, unknown>) {
  return searchAttributes.handler(
    z.object(searchAttributes.inputSchema).parse({
      organizationSlug: "sentry-mcp-evals",
      ...params,
    }),
    getServerContext(),
  );
}

describe("search_attributes", () => {
  it("applies defaults and leaves dataset unset when only the organization is given", async () => {
    expect(await search({})).toMatchInlineSnapshot(`
      "# Attribute Search in **sentry-mcp-evals**

      Not implemented yet. Parsed inputs:

      - Dataset: undefined (API item type: undefined)
      - Project: all projects
      - Query: none (list all attributes)
      - Period: not set
      - Limit: 10
      "
    `);
  });

  it("resolves the project and passes the remaining inputs through", async () => {
    expect(
      await search({
        projectSlug: "cloudflare-mcp",
        query: "  payment provider  ",
        dataset: "metrics",
        period: "7d",
        limit: 50,
      }),
    ).toMatchInlineSnapshot(`
      "# Attribute Search in **sentry-mcp-evals**

      Not implemented yet. Parsed inputs:

      - Dataset: metrics (API item type: tracemetrics)
      - Project: cloudflare-mcp (ID 4509109104082945)
      - Query: payment provider
      - Period: 7d
      - Limit: 50
      "
    `);
  });

  it("treats a blank query as no query", async () => {
    expect(await search({ query: "   ", dataset: "logs" }))
      .toMatchInlineSnapshot(`
        "# Attribute Search in **sentry-mcp-evals**

        Not implemented yet. Parsed inputs:

        - Dataset: logs (API item type: logs)
        - Project: all projects
        - Query: none (list all attributes)
        - Period: not set
        - Limit: 10
        "
      `);
  });

  it("rejects datasets other than spans, logs, and metrics", () => {
    expect(() =>
      z
        .object(searchAttributes.inputSchema)
        .parse({ organizationSlug: "sentry-mcp-evals", dataset: "errors" }),
    ).toThrow();
  });
});
