import { setAttributes, setTags } from "@sentry/core";
import { z } from "zod";
import { ApiError } from "../../api-client/index";
import { UserInputError } from "../../errors";
import { fetchWithTimeout } from "../../internal/fetch-utils";
import { defineTool } from "../../internal/tool-helpers/define";
import { getUserAgent } from "../../version";

const DOC_NOT_FOUND_MESSAGE =
  "Documentation not found at this path. The page may have been moved or removed. Use `search_docs()` to find the current path, and pass the `path` from its results exactly.";

// docs.sentry.io answers unknown paths with 200 and a "Page Not Found" page,
// marked with this header.
const NOT_FOUND_HEADER = "x-sentry-docs-not-found";

const DOCS_BASE_URL = "https://docs.sentry.io";
const ALLOWED_HOSTS = ["docs.sentry.io", "develop.sentry.io"];
const MAX_REDIRECTS = 5;

/**
 * Resolve a docs path or page URL to the markdown URL of that page.
 *
 * Accepts `/path.md`, `/path/`, `/path`, or an https URL on an allowed host,
 * with or without a query or fragment. A page path maps to `<path>.md`, so
 * `/platforms/javascript/` becomes `/platforms/javascript.md` and `/`
 * becomes `/index.md`. Returns null for anything outside the allowlist.
 */
export function resolveDocUrl(
  input: string,
  base: string | URL = DOCS_BASE_URL,
): URL | null {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !ALLOWED_HOSTS.includes(url.hostname)
  ) {
    return null;
  }
  url.search = "";
  url.hash = "";
  const pagePath = url.pathname.replace(/\/+$/, "") || "/index";
  url.pathname = pagePath.endsWith(".md") ? pagePath : `${pagePath}.md`;
  return url;
}

export default defineTool({
  name: "get_doc",
  title: "Get Sentry Doc",
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
    "</hints>",
  ].join("\n"),
  inputSchema: {
    path: z
      .string()
      .trim()
      .describe(
        "The documentation path (e.g., '/platforms/javascript/guides/nextjs.md') or docs.sentry.io URL. Get this from search_docs results.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params) {
    const docContext = { "doc.path": params.path };
    setTags(docContext);
    setAttributes(docContext);

    let docUrl = resolveDocUrl(params.path);
    if (!docUrl) {
      throw new UserInputError(
        `Invalid documentation path. Use a docs path or an https URL on: ${ALLOWED_HOSTS.join(", ")}`,
      );
    }

    // Follow redirects by hand so each hop stays on the allowlist.
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetchWithTimeout(
        docUrl,
        {
          headers: {
            Accept: "text/plain, text/markdown",
            "User-Agent": getUserAgent(),
          },
          redirect: "manual",
        },
        15000, // 15 second timeout
      );
      const location =
        response.status >= 300 && response.status < 400
          ? response.headers.get("location")
          : null;
      if (!location) {
        break;
      }
      const nextUrl = resolveDocUrl(location, docUrl);
      if (!nextUrl || redirects >= MAX_REDIRECTS) {
        throw new UserInputError(DOC_NOT_FOUND_MESSAGE);
      }
      docUrl = nextUrl;
    }

    if (response.status === 404 || response.headers.has(NOT_FOUND_HEADER)) {
      throw new UserInputError(DOC_NOT_FOUND_MESSAGE);
    }

    if (!response.ok) {
      throw new ApiError(
        `Failed to fetch documentation: ${response.statusText}`,
        response.status,
      );
    }

    const content = await response.text();

    let output = `# Documentation Content\n\n`;
    output += `**URL**: ${docUrl}\n\n`;

    // Check if we got HTML instead of markdown (wrong path format)
    if (
      content.trim().startsWith("<!DOCTYPE") ||
      content.trim().startsWith("<html")
    ) {
      output += `> **Error**: Received HTML instead of markdown. The path may be incorrect.\n\n`;
      output += `Use \`search_docs()\` to find the current path.\n`;
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
