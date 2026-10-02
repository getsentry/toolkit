import { setAttributes, setTags } from "@sentry/core";
import { z } from "zod";
import { ApiError } from "../../api-client/index";
import { UserInputError } from "../../errors";
import { fetchWithTimeout } from "../../internal/fetch-utils";
import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import { USER_AGENT } from "../../version";

export default defineTool({
  name: "get_doc",
  skills: ["inspect", "docs"], // Docs is retained for legacy docs-only grants.
  requiredScopes: [],
  description: [
    "Fetch the full markdown content of a Sentry documentation page.",
    "",
    "Use this tool when you need to:",
    "- Read the complete documentation for a specific topic",
    "- Get detailed implementation examples or code snippets",
    "- Access the full context of a documentation page",
    "- Extract specific sections from documentation",
    "",
    "<examples>",
    "### Get the Next.js integration guide",
    "",
    "```",
    "get_doc(path='/platforms/javascript/guides/nextjs.md')",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- Use the path from search_docs results for accurate fetching",
    "- Paths should end with .md extension",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    path: z
      .string()
      .trim()
      .describe(
        "The documentation path (e.g., '/platforms/javascript/guides/nextjs.md'). Get this from search_docs results.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const docContext = { "doc.path": params.path };
    setTags(docContext);
    setAttributes(docContext);

    let output = `# Documentation Content\n\n`;
    output += `**Path**: ${params.path}\n\n`;

    // Validate path format
    if (!params.path.endsWith(".md")) {
      throw new UserInputError(
        "Invalid documentation path. Path must end with .md extension.",
      );
    }

    // Use docs.sentry.io for now - will be configurable via flag in the future
    const baseUrl = "https://docs.sentry.io";

    // Construct the full URL for the markdown file
    const docUrl = new URL(params.path, baseUrl);

    // Validate domain whitelist for security
    const allowedDomains = ["docs.sentry.io", "develop.sentry.io"];
    if (!allowedDomains.includes(docUrl.hostname)) {
      throw new UserInputError(
        `Invalid domain. Documentation can only be fetched from allowed domains: ${allowedDomains.join(", ")}`,
      );
    }

    const response = await fetchWithTimeout(
      docUrl.toString(),
      {
        headers: {
          Accept: "text/plain, text/markdown",
          "User-Agent": USER_AGENT,
        },
      },
      15000, // 15 second timeout
    );

    if (!response.ok) {
      if (response.status === 404) {
        output += `**Error**: Documentation not found at this path.\n\n`;
        output += `Please verify the path is correct. Common issues:\n`;
        output += `- Path should start with / (e.g., /platforms/javascript/guides/nextjs.md)\n`;
        output += `- Path should match exactly what's shown in search_docs results\n`;
        output += `- Some pages may have been moved or renamed\n\n`;
        output += `Try searching again with \`search_docs()\` to find the correct path.\n`;
        return output;
      }

      throw new ApiError(
        `Failed to fetch documentation: ${response.statusText}`,
        response.status,
      );
    }

    const content = await response.text();

    // Check if we got HTML instead of markdown (wrong path format)
    if (
      content.trim().startsWith("<!DOCTYPE") ||
      content.trim().startsWith("<html")
    ) {
      output += `> **Error**: Received HTML instead of markdown. The path may be incorrect.\n\n`;
      output += `Make sure to use the .md extension in the path.\n`;
      output += `Example: /platforms/javascript/guides/nextjs.md\n`;
      return output;
    }

    // Add the markdown content
    output += "---\n\n";
    output += content;
    output += "\n\n---\n\n";

    output += "## Using this documentation\n\n";
    output +=
      "- This is the raw markdown content from Sentry's documentation\n";
    output +=
      "- Code examples and configuration snippets can be copied directly\n";
    output +=
      "- Links in the documentation are relative to https://docs.sentry.io\n";
    output +=
      "- For more related topics, use `search_docs()` to find additional pages\n";

    return output;
  },
});
