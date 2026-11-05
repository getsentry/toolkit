import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type ErrorEvent,
  getCurrentScope,
  getDefaultCurrentScope,
  getDefaultIsolationScope,
  type Scope,
  setAsyncContextStrategy,
  setCurrentClient,
  type StreamedSpanJSON,
} from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildServer } from "../server";
import { getServerContext } from "../test-setup";

// Sentry's MCP instrumentation leaves the span status unset for -32602
// errors, so calls to unregistered tools used to be recorded as `ok` spans.

const beforeSendSpan = vi.fn((span: StreamedSpanJSON) => span);
const beforeSend = vi.fn((event: ErrorEvent) => event);
let sentry: ServerRuntimeClient;

// The MCP instrumentation activates the request span through the async
// context strategy, as @sentry/node and @sentry/cloudflare do in production.
function setAsyncLocalStorageStrategy(): void {
  const storage = new AsyncLocalStorage<{
    scope: Scope;
    isolationScope: Scope;
  }>();
  const getScopes = () =>
    storage.getStore() ?? {
      scope: getDefaultCurrentScope(),
      isolationScope: getDefaultIsolationScope(),
    };
  setAsyncContextStrategy({
    withScope: (callback) => {
      const scope = getScopes().scope.clone();
      return storage.run({ ...getScopes(), scope }, () => callback(scope));
    },
    withSetScope: (scope, callback) =>
      storage.run({ ...getScopes(), scope }, () => callback(scope)),
    withIsolationScope: (callback) => {
      const isolationScope = getScopes().isolationScope.clone();
      return storage.run(
        { scope: getScopes().scope.clone(), isolationScope },
        () => callback(isolationScope),
      );
    },
    withSetIsolationScope: (isolationScope, callback) =>
      storage.run({ scope: getScopes().scope.clone(), isolationScope }, () =>
        callback(isolationScope),
      ),
    getCurrentScope: () => getScopes().scope,
    getIsolationScope: () => getScopes().isolationScope,
  });
}

beforeAll(() => {
  setAsyncLocalStorageStrategy();
  sentry = new ServerRuntimeClient({
    dsn: "https://public@example.com/1",
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    transport: () => ({
      send: async () => ({ statusCode: 200 }),
      flush: async () => true,
    }),
    beforeSendSpan,
    beforeSend,
  });
  setCurrentClient(sentry);
  sentry.init();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sentry.close();
  getCurrentScope().setClient(undefined);
  setAsyncContextStrategy(undefined);
});

async function callToolSpan(name: string): Promise<StreamedSpanJSON> {
  const server = buildServer({
    context: getServerContext({
      transport: "http",
      grantedSkills: new Set(["inspect"]),
    }),
  });
  const client = new Client({ name: "telemetry-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client
      .callTool({ name, arguments: { organizationSlug: "sentry-mcp-evals" } })
      .catch(() => undefined);
  } finally {
    await client.close();
    await server.close();
  }
  await sentry.flush();
  const span = beforeSendSpan.mock.calls
    .map(([sent]) => sent)
    .find((sent) => sent.name === `tools/call ${name}`);
  if (!span) {
    throw new Error(`No tools/call span for ${name}`);
  }
  return span;
}

it("marks calls to unregistered tools as failed without an error event", async () => {
  const span = await callToolSpan("not_a_sentry_tool");

  expect(span.status).toBe("error");
  expect(span.attributes).toMatchObject({
    "error.type": "unknown_tool",
    "app.transport": "http",
    "rpc.response.status_code": "-32602",
  });
  expect(beforeSend).not.toHaveBeenCalled();
});

it("leaves registered tool spans alone", async () => {
  const span = await callToolSpan("find_projects");

  expect(span.status).toBe("ok");
  expect(span.attributes?.["error.type"]).toBeUndefined();
  expect(span.attributes).toMatchObject({ "app.transport": "http" });
});
