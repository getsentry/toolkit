#!/usr/bin/env node
// Drive a Sentry MCP stdio server the way an MCP client does, with no LLM.
// Writes initialize.json, tools-list.json, one call-<n>-<tool>.json per call,
// and server-stderr.txt to --out. See ../SKILL.md ("Drive").
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineEnv } from "./offline-env.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const usage =
  "usage: mcp-call.mjs --out DIR [--server mock|cli] [--no-token] [--server-arg ARG]... [--call TOOL JSON_ARGS]...";

const opts = { server: "mock", token: true, serverArgs: [], calls: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--out") opts.out = argv[++i];
  else if (arg === "--server") opts.server = argv[++i];
  else if (arg === "--no-token") opts.token = false;
  else if (arg === "--server-arg") opts.serverArgs.push(argv[++i]);
  else if (arg === "--call")
    opts.calls.push([argv[++i], JSON.parse(argv[++i])]);
  else {
    console.error(`unknown argument: ${arg}\n${usage}`);
    process.exit(2);
  }
}
if (!opts.out || !["mock", "cli"].includes(opts.server)) {
  console.error(usage);
  process.exit(2);
}

// The SDK is a dependency of the test client, not of the repo root.
const requireFromClient = createRequire(
  join(repo, "packages/mcp-test-client/package.json"),
);
const sdk = (path) =>
  import(
    pathToFileURL(
      requireFromClient.resolve(`@modelcontextprotocol/sdk/${path}`),
    ).href
  );
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");

// Both servers get the offline env. The mock server answers the Sentry API
// from MSW fixtures and ignores it; `sentry mcp` gets a fake token (unless
// --no-token), an empty config dir, and an unreachable Sentry host.
const { env, cleanup } = offlineEnv({ token: opts.token });
// The mock server answers for its default host, sentry.io.
if (opts.server === "mock") delete env.SENTRY_HOST;
const [command, args] =
  opts.server === "mock"
    ? [
        process.execPath,
        [
          "--experimental-strip-types",
          "--import",
          join(repo, "scripts/strip-types-resolve.mjs"),
          join(repo, "packages/mcp-server-evals/src/bin/start-mock-stdio.ts"),
          ...opts.serverArgs,
        ],
      ]
    : [
        "pnpm",
        [
          "--silent",
          "--dir",
          join(repo, "packages/cli"),
          "run",
          "cli",
          "mcp",
          ...opts.serverArgs,
        ],
      ];

mkdirSync(opts.out, { recursive: true });
const write = (name, value) =>
  writeFileSync(join(opts.out, name), `${JSON.stringify(value, null, 2)}\n`);

const transport = new StdioClientTransport({
  command,
  args,
  env,
  cwd: repo,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk;
});

const client = new Client({ name: "verify-toolkit", version: "0.0.0" });
let failed = false;
try {
  await client.connect(transport);
  write("initialize.json", {
    server: opts.server,
    command: [command, ...args].join(" "),
    serverVersion: client.getServerVersion(),
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions(),
  });
  // Listing first also makes the SDK validate each call's structuredContent
  // against the tool's outputSchema, as a real client does.
  const { tools, nextCursor } = await client.listTools();
  write("tools-list.json", { tools, nextCursor: nextCursor ?? null });
  console.log(
    `connected: ${client.getServerVersion()?.name} (${opts.server}), ${tools.length} tools`,
  );
  for (const [n, [name, toolArgs]] of opts.calls.entries()) {
    const file = `call-${n + 1}-${name}.json`;
    const result = await client.callTool({ name, arguments: toolArgs });
    write(file, { request: { name, arguments: toolArgs }, result });
    const shape = result.structuredContent
      ? "structuredContent"
      : "content only";
    console.log(
      `tools/call ${name}: ${result.isError ? "isError" : "ok"}, ${shape} -> ${file}`,
    );
  }
} catch (error) {
  failed = true;
  console.error(
    `mcp-call failed: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  await client.close().catch(() => {});
  cleanup();
  writeFileSync(join(opts.out, "server-stderr.txt"), stderr);
}
process.exit(failed ? 1 : 0);
