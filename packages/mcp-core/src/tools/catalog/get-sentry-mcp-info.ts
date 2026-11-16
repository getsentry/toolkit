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
  description:
    "Get the version and details of the running Sentry MCP server, e.g. to check compatibility with a skill or integration.",
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
