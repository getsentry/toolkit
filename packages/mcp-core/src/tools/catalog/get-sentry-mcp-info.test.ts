import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils/context.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { LIB_VERSION, setServerVersion } from "../../version.js";
import getSentryMcpInfo, {
  getSentryMcpInfoOutputSchema,
} from "./get-sentry-mcp-info.js";

describe("get_sentry_mcp_info", () => {
  afterEach(() => {
    setServerVersion(undefined);
  });

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

  it("reports the host's version when it sets one", async () => {
    setServerVersion("9.9.9-test");
    const result = await getSentryMcpInfo.handler({}, createTestContext());

    expect(getStructuredContent<{ version: string }>(result)).toEqual({
      version: "9.9.9-test",
    });
  });
});
