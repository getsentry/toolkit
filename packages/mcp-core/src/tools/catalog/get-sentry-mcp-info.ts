import { z } from "zod";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ALL_SKILLS } from "../../skills";
import { getServerVersion } from "../../version";

export const getSentryMcpInfoOutputSchema = z.object({
  version: z.string().describe("The Sentry MCP server version."),
});

export default defineTool({
  name: "get_sentry_mcp_info",
  title: "Get Sentry MCP Info",
  description: [
    "Get information about the running Sentry MCP server.",
    "",
    "Use this tool when you need to:",
    "- Check the Sentry MCP server version",
    "- Verify compatibility with a Skill or integration",
  ].join("\n"),
  inputSchema: {},
  outputSchema: getSentryMcpInfoOutputSchema,
  skills: ALL_SKILLS,
  requiredScopes: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler() {
    return structuredResult({
      version: getServerVersion(),
    });
  },
});
