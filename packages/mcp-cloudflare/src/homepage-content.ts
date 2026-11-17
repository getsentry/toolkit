/**
 * Canonical content-only homepage / llms.txt body.
 *
 * Served as:
 * - text/markdown on GET / (Accept: text/markdown)
 * - text/plain on GET /llms.txt
 * - HTML fallback inside the SPA shell for no-JS browsers and HTML scrapers
 */

import {
  CLI_INSTALL_COMMAND,
  CLI_MCP_ARGS,
  CLI_MCP_COMMAND,
  CLI_MCP_SNIPPET,
} from "./constants";

/** Public production origin used when embedding static HTML (build-time). */
export const PUBLIC_HOMEPAGE_BASE_URL = "https://mcp.sentry.dev";

/** Markdown body shared by /llms.txt and content-negotiated GET /. */
export function generateHomepageMarkdown(baseUrl: string): string {
  return `# Sentry MCP Server

Connects AI assistants to Sentry for searching errors, analyzing performance, triaging issues, reading documentation, and managing projects — all via the Model Context Protocol.

All connections use OAuth. The first connection will trigger an authentication flow to connect to your Sentry account.

## Connecting

The base MCP server address is: \`${baseUrl}/mcp\`

You can optionally scope the connection to an organization or project:

- \`${baseUrl}/mcp/{organizationSlug}\` — scoped to one organization
- \`${baseUrl}/mcp/{organizationSlug}/{projectSlug}\` — scoped to one project

When scoped, tools automatically default to the constrained org/project and unnecessary discovery tools are hidden. Scoping to a project is recommended when possible.

### Query Parameters

- \`?experimental=1\` — Enable forward-looking tool variants and experimental features

Parameters can be combined: \`${baseUrl}/mcp/my-org/my-project?experimental=1\`

## Setup Instructions

### Claude Code

\`\`\`bash
claude mcp add --transport http sentry ${baseUrl}/mcp/{organizationSlug}/{projectSlug}
\`\`\`

### Cursor

Use the "Install MCP Server" button, or manually add to MCP settings:

\`\`\`json
{
  "mcpServers": {
    "sentry": {
      "url": "${baseUrl}/mcp/{organizationSlug}/{projectSlug}"
    }
  }
}
\`\`\`

### VSCode

Command Palette → "MCP: Add Server" → HTTP → enter the endpoint:

\`\`\`
${baseUrl}/mcp/{organizationSlug}/{projectSlug}
\`\`\`

### Other Clients

Any MCP-compatible client can connect using the HTTP transport at the endpoint URL above.

## Local Server via the Sentry CLI

Install the Sentry CLI and log in, then register \`${CLI_MCP_SNIPPET}\` as a stdio MCP server. It uses the CLI login, so the MCP config needs no token.

\`\`\`bash
${CLI_INSTALL_COMMAND}
sentry auth login
claude mcp add sentry -- ${CLI_MCP_SNIPPET}
\`\`\`

Other clients take the same command:

\`\`\`json
{
  "mcpServers": {
    "sentry": {
      "command": "${CLI_MCP_COMMAND}",
      "args": ${JSON.stringify(CLI_MCP_ARGS)}
    }
  }
}
\`\`\`

The CLI also installs with \`brew install getsentry/tools/sentry\`, \`npm install -g sentry\`, or \`irm https://cli.sentry.dev/install.ps1 | iex\` on Windows. See https://cli.sentry.dev/getting-started/.

Pass a target after the command to limit it:

- \`${CLI_MCP_SNIPPET} my-org/\` — Limit to one organization
- \`${CLI_MCP_SNIPPET} my-org/my-project\` — Limit to a specific project

For self-hosted Sentry, log in with \`sentry auth login --url https://sentry.example.com\`, then set \`SENTRY_HOST\` in the MCP server's environment. See https://cli.sentry.dev/self-hosted/.

Run \`${CLI_MCP_SNIPPET} --help\` for every flag and environment variable. To run the server without installing the CLI, use the legacy \`npx @sentry/mcp-server\` package.
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function inlineMarkdownToHtml(text: string): string {
  const escaped = escapeHtml(text);
  // `code` then **bold** — order avoids nested conflicts in this content.
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/**
 * Lightweight HTML rendering of {@link generateHomepageMarkdown} for the SPA
 * shell fallback (noscript / no-JS / HTML scrapers).
 */
export function generateHomepageFallbackHtml(
  baseUrl: string = PUBLIC_HOMEPAGE_BASE_URL,
): string {
  const markdown = generateHomepageMarkdown(baseUrl);
  const lines = markdown.split("\n");
  const html: string[] = [];
  let inList = false;
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines: string[] = [];

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  const flushCodeBlock = () => {
    if (!inCodeBlock) {
      return;
    }
    const langClass = codeBlockLang
      ? ` class="language-${escapeHtml(codeBlockLang)}"`
      : "";
    html.push(
      `<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
    );
    inCodeBlock = false;
    codeBlockLang = "";
    codeLines = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        closeList();
        inCodeBlock = true;
        codeBlockLang = fence[1].trim();
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.startsWith("# ")) {
      closeList();
      html.push(`<h1>${inlineMarkdownToHtml(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("## ")) {
      closeList();
      html.push(`<h2>${inlineMarkdownToHtml(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("### ")) {
      closeList();
      html.push(`<h3>${inlineMarkdownToHtml(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdownToHtml(line.slice(2))}</li>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    html.push(`<p>${inlineMarkdownToHtml(line)}</p>`);
  }

  flushCodeBlock();
  closeList();

  return [
    `<main id="static-home" class="static-home">`,
    ...html,
    `<p><a href="/llms.txt">llms.txt</a></p>`,
    `</main>`,
  ].join("\n");
}
