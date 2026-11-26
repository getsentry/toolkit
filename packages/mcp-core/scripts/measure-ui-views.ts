/**
 * Measure the MCP Apps views that hosts download.
 *
 * Builds the server with every skill, lists its resources, and reads each
 * `ui://` resource through `resources/read`, as a host does before it renders
 * a view. Reports raw, gzip, and brotli bytes. The view's generator enforces
 * its byte limit, not this report.
 *
 * Usage:
 *   pnpm run measure-ui                                # Display table
 *   pnpm run measure-ui -- -o ui-stats.json            # Write JSON to file
 *   pnpm run measure-ui -- --markdown report.md        # Append a report section
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { ALL_SKILLS } from "../src/skills.ts";

interface ViewStats {
  uri: string;
  mime_type: string;
  raw_bytes: number;
  gzip_bytes: number;
  brotli_bytes: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let outputFile: string | null = null;
  const markdownFiles: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output" || arg === "-o" || arg === "--markdown") {
      const file = args[i + 1];
      if (!file) {
        throw new Error(`${arg} requires a file path`);
      }
      if (arg === "--markdown") {
        markdownFiles.push(file);
      } else {
        outputFile = file;
      }
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: pnpm run measure-ui -- [options]

Options:
  -o, --output <file>  Write JSON output to file
  --markdown <file>    Append the markdown report section to file (repeatable)
  -h, --help           Show this help message
`);
      process.exit(0);
    }
  }

  return { outputFile, markdownFiles };
}

/** Reads every `ui://` resource the server lists, as a host would. */
async function readViews(): Promise<ViewStats[]> {
  const server = buildServer({
    context: {
      accessToken: "measure-ui",
      grantedSkills: new Set(ALL_SKILLS),
      constraints: { organizationSlug: null, projectSlug: null },
      sentryHost: "sentry.io",
    },
    // MCP Apps views ship to experimental sessions only for now.
    experimentalMode: true,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "measure-ui", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { resources } = await client.listResources();
    const views: ViewStats[] = [];
    for (const { uri } of resources.filter((r) => r.uri.startsWith("ui://"))) {
      const { contents } = await client.readResource({ uri });
      for (const content of contents) {
        const body =
          "text" in content
            ? Buffer.from(content.text, "utf8")
            : Buffer.from(content.blob, "base64");
        views.push({
          uri: content.uri,
          mime_type: content.mimeType ?? "",
          raw_bytes: body.length,
          gzip_bytes: gzipSync(body, { level: 9 }).length,
          brotli_bytes: brotliCompressSync(body, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
          }).length,
        });
      }
    }
    return views;
  } finally {
    await client.close();
    await server.close();
  }
}

const bytes = (n: number) => `${n.toLocaleString("en-US")} B`;

function formatMarkdown(views: ViewStats[]): string {
  const lines = [
    "",
    "### MCP Apps views",
    "",
    "Each `ui://` view as a host receives it from `resources/read`.",
    "",
  ];
  if (views.length === 0) {
    lines.push("_The server lists no `ui://` resources._");
  } else {
    lines.push(
      "| View | MIME type | Raw | Gzip | Brotli |",
      "|------|-----------|-----|------|--------|",
    );
    for (const view of views) {
      lines.push(
        `| \`${view.uri}\` | \`${view.mime_type}\` | ${bytes(view.raw_bytes)} | ${bytes(view.gzip_bytes)} | ${bytes(view.brotli_bytes)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatTable(views: ViewStats[]): string {
  const lines = ["\n🧩 MCP Apps Views\n", "━".repeat(60)];
  for (const view of views) {
    lines.push(
      view.uri,
      `  MIME type:  ${view.mime_type}`,
      `  Raw:        ${bytes(view.raw_bytes)}`,
      `  Gzip:       ${bytes(view.gzip_bytes)}`,
      `  Brotli:     ${bytes(view.brotli_bytes)}`,
    );
  }
  if (views.length === 0) {
    lines.push("The server lists no ui:// resources.");
  }
  return lines.join("\n");
}

async function main() {
  try {
    const { outputFile, markdownFiles } = parseArgs();
    const views = await readViews();

    for (const file of markdownFiles) {
      fs.appendFileSync(file, formatMarkdown(views));
    }
    if (outputFile) {
      const absolutePath = path.resolve(outputFile);
      fs.writeFileSync(
        absolutePath,
        JSON.stringify({ view_count: views.length, views }, null, 2),
      );
      console.log(`✅ UI view stats written to: ${absolutePath}`);
    }
    console.log(formatTable(views));
  } catch (error) {
    const err = error as Error;
    console.error("[ERROR]", err.message, err.stack);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
