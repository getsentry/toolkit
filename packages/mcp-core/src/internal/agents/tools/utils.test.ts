import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiPermissionError } from "../../../api-client";
import { agentTool } from "./utils";

function failingTool(error: unknown) {
  return agentTool({
    description: "Fails",
    parameters: z.object({}),
    execute: async () => {
      throw error;
    },
  });
}

describe("agentTool errors", () => {
  it("names the accepted scopes for a missing-scope 403 without retry advice", async () => {
    const detail = "You do not have permission to perform this action.";
    const tool = failingTool(
      new ApiPermissionError(detail, detail, { detail }, [
        "event:write",
        "seer:write",
      ]),
    );

    const response = await tool.execute?.(
      {},
      { toolCallId: "1", messages: [] },
    );

    expect(response).toEqual({
      error: `Missing Permission: API error (403): ${detail} The access token is missing the scope this endpoint requires; it needs one of: event:write, seer:write. Retrying with the same token will not help.`,
    });
  });
});
