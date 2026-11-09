import { describe, expect, it } from "vitest";
import { z } from "zod";
import catalogTools from "../tools/catalog";
import { prepareToolParams } from "../tools/catalog-runtime/availability";
import type { ToolConfig } from "../tools/types";
import { createTestContext } from "../test-utils/context";
import { isFreshRead, withFreshReadInput } from "./fresh-reads";

function probeTool() {
  const calls: { params: Record<string, unknown>; fresh: boolean }[] = [];
  const tool = withFreshReadInput({
    name: "probe",
    title: "Probe",
    description: "Probe",
    inputSchema: { id: z.string() },
    skills: ["inspect"],
    requiredScopes: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async handler(params, _context) {
      // Read after an await, as the transport does mid-request.
      await Promise.resolve();
      calls.push({ params, fresh: isFreshRead() });
      return "ok";
    },
  } satisfies ToolConfig<any>);
  return { tool, calls };
}

describe("withFreshReadInput", () => {
  it("runs the handler in a fresh scope only when fresh is true", async () => {
    const { tool, calls } = probeTool();
    const context = createTestContext();

    for (const args of [{ id: "a", fresh: true }, { id: "b" }]) {
      await tool.handler(
        prepareToolParams({ tool, params: args, context }) as never,
        context,
      );
    }

    expect(calls).toEqual([
      { params: { id: "a" }, fresh: true },
      { params: { id: "b" }, fresh: false },
    ]);
    expect(isFreshRead()).toBe(false);
  });

  it("rejects a non-boolean fresh", () => {
    const { tool } = probeTool();
    expect(() =>
      prepareToolParams({
        tool,
        params: { id: "a", fresh: "yes" },
        context: createTestContext(),
      }),
    ).toThrow(/fresh/);
  });
});

describe("catalog fresh input", () => {
  it("is on read tools that call the Sentry API, and nowhere else", () => {
    const withFresh = Object.values(catalogTools as Record<string, ToolConfig>)
      .filter((tool) => "fresh" in tool.inputSchema)
      .map((tool) => tool.name);

    expect(withFresh).toContain("get_issue_details");
    expect(withFresh).toContain("search_issues");
    expect(withFresh).not.toContain("update_issue");
    expect(withFresh).not.toContain("search_docs");
    expect(withFresh).not.toContain("get_doc");
    expect(withFresh).not.toContain("get_sentry_mcp_info");
  });
});
