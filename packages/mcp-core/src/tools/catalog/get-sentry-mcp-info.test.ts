import { describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils/context.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { LIB_VERSION } from "../../version.js";
import getSentryMcpInfo, {
  getSentryMcpInfoOutputSchema,
} from "./get-sentry-mcp-info.js";

describe("get_sentry_mcp_info", () => {
  it("returns the Sentry MCP server information", async () => {
    const result = await getSentryMcpInfo.handler({}, createTestContext());

    assertStructuredOnlyResult(result);
    const content = getStructuredContent<{ version: string }>(result);

    expect(getSentryMcpInfo.outputSchema).toBe(getSentryMcpInfoOutputSchema);
    expect(getSentryMcpInfoOutputSchema.safeParse(content).success).toBe(true);
    expect(content).toEqual({ version: LIB_VERSION });
    expect({ ...content, version: "<version>" }).toMatchInlineSnapshot(`
      {
        "version": "<version>",
      }
    `);
  });

  it("reports the host's version when the context sets one", async () => {
    const result = await getSentryMcpInfo.handler(
      {},
      createTestContext({ serverVersion: "9.9.9-test" }),
    );

    expect(getStructuredContent<{ version: string }>(result)).toEqual({
      version: "9.9.9-test",
    });
  });
});
