/**
 * End-to-end tests: run the `sentry-mcp` bin against a local Streamable HTTP
 * MCP server that stands in for the hosted Sentry MCP.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  RootsListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BIN = fileURLToPath(new URL("../bin/sentry-mcp.js", import.meta.url));
const TOKEN = "sntryu_test-token";

/** A stateful MCP server on a random port that records request headers. */
async function startMockHostedMcp() {
  /** @type {{ method: string, url: string, authorization?: string, protocolVersion?: string }[]} */
  const requests = [];
  const clientNotifications = [];
  /** @type {Map<string, StreamableHTTPServerTransport>} */
  const sessions = new Map();

  function createSession() {
    const server = new Server(
      { name: "mock-hosted-sentry-mcp", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true }, logging: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "whoami",
          description: "Echo the caller",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const progressToken = request.params._meta?.progressToken;
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 2 },
        });
        // The SDK client drops progress that it handles after the response.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await extra.sendNotification({
        method: "notifications/message",
        params: { level: "info", data: "looking you up" },
      });
      // Out-of-band notification: travels over the standalone GET stream.
      setTimeout(() => void server.sendToolListChanged(), 50);
      return {
        content: [
          {
            type: "text",
            text: `hello ${String(request.params.arguments?.name)}`,
          },
        ],
      };
    });
    server.setNotificationHandler(RootsListChangedNotificationSchema, (n) => {
      clientNotifications.push(n.method);
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => sessions.set(id, transport),
      onsessionclosed: (id) => sessions.delete(id),
    });
    void server.connect(transport);
    return transport;
  }

  const http = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
      protocolVersion: req.headers["mcp-protocol-version"]?.toString(),
    });
    if (req.headers.authorization !== `Sentry-Bearer ${TOKEN}`) {
      res.writeHead(401).end("Missing or invalid Sentry-Bearer token");
      return;
    }
    const sessionId = req.headers["mcp-session-id"]?.toString();
    const transport = sessionId ? sessions.get(sessionId) : createSession();
    if (!transport) {
      res.writeHead(404).end("Unknown session");
      return;
    }
    void transport.handleRequest(req, res);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    clientNotifications,
    async close() {
      await Promise.all([...sessions.values()].map((t) => t.close()));
      http.closeAllConnections();
      http.close();
    },
  };
}

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
async function runBin(args, { input = "", env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input);
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
};

describe("sentry-mcp proxy", () => {
  /** @type {Awaited<ReturnType<typeof startMockHostedMcp>>} */
  let hosted;
  before(async () => {
    hosted = await startMockHostedMcp();
  });
  after(async () => {
    await hosted.close();
  });

  it("forwards requests, responses, and notifications both ways", async () => {
    hosted.requests.length = 0;
    const stderr = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        BIN,
        `--mcp-url=${hosted.origin}`,
        `--access-token=${TOKEN}`,
        "--organization-slug=acme",
        "--skills=inspect",
      ],
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    const notifications = [];
    const listChanged = new Promise((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => {
        notifications.push(n.method);
        resolve(undefined);
      });
    });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      notifications.push(`${n.method}:${String(n.params.data)}`);
    });

    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "mock-hosted-sentry-mcp");

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["whoami"],
    );

    const progress = [];
    const result = await client.callTool(
      { name: "whoami", arguments: { name: "sentry" } },
      undefined,
      { onprogress: (p) => progress.push(p.progress) },
    );
    assert.deepEqual(result.content, [{ type: "text", text: "hello sentry" }]);
    assert.deepEqual(progress, [1]);

    await client.sendRootsListChanged();
    await listChanged;
    assert.deepEqual(notifications, [
      "notifications/message:looking you up",
      "notifications/tools/list_changed",
    ]);
    assert.deepEqual(hosted.clientNotifications, [
      "notifications/roots/list_changed",
    ]);

    await client.close();

    assert.ok(hosted.requests.length > 0);
    for (const request of hosted.requests) {
      assert.equal(request.authorization, `Sentry-Bearer ${TOKEN}`);
      assert.equal(request.url, "/mcp/acme?skills=inspect");
    }
    // Every request after initialize carries the negotiated version.
    assert.equal(hosted.requests[0].protocolVersion, undefined);
    assert.ok(
      hosted.requests
        .slice(1)
        .every((r) => r.protocolVersion === LATEST_PROTOCOL_VERSION),
    );
    assert.equal(stderr.join(""), "");
  });

  it("answers requests the hosted MCP rejects with a JSON-RPC error", async () => {
    const { code, stdout, stderr } = await runBin(
      [`--mcp-url=${hosted.origin}`, "--access-token=wrong"],
      { input: `${JSON.stringify(initialize)}\n` },
    );
    assert.equal(code, 0);
    const response = JSON.parse(stdout);
    assert.equal(response.id, 1);
    assert.match(response.error.message, /HTTP|401|invalid Sentry-Bearer/i);
    assert.match(response.error.message, /SENTRY_ACCESS_TOKEN/);
    assert.match(stderr, /Sentry MCP: .*invalid Sentry-Bearer token/);
  });

  it("finishes in-flight requests and exits cleanly when stdin closes", async () => {
    const { code, stdout } = await runBin(
      [`--mcp-url=${hosted.origin}`, `--access-token=${TOKEN}`],
      { input: `${JSON.stringify(initialize)}\n` },
    );
    assert.equal(code, 0);
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]);
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "mock-hosted-sentry-mcp");
  });

  it("exits cleanly on SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      [BIN, `--mcp-url=${hosted.origin}`, `--access-token=${TOKEN}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.write(`${JSON.stringify(initialize)}\n`);
    await once(child.stdout, "data");
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  });

  it("exits 1 without touching stdout when no token is set", async () => {
    const { code, stdout, stderr } = await runBin([]);
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /No Sentry access token/);
    assert.match(stderr, /npx -y sentry mcp/);
  });

  it("exits 1 for self-hosted Sentry", async () => {
    const { code, stdout, stderr } = await runBin([], {
      env: { SENTRY_ACCESS_TOKEN: TOKEN, SENTRY_HOST: "sentry.example.com" },
    });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /cannot reach sentry\.example\.com/);
    assert.match(stderr, /npx -y sentry mcp/);
  });
});
