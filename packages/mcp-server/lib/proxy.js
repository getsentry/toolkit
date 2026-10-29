/**
 * Bridges an MCP client on stdio to the hosted Sentry MCP over Streamable HTTP.
 *
 * Messages are forwarded unchanged in both directions. The proxy only tracks
 * what it needs to behave like a stdio server: the negotiated protocol
 * version (sent back as a header on later HTTP requests) and which client
 * requests still await a response, so closing stdin lets in-flight calls
 * finish before the process exits.
 */
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const INTERNAL_ERROR = -32603;
const SESSION_TERMINATE_TIMEOUT_MS = 2000;

/**
 * @typedef {import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage} JSONRPCMessage
 */

/** @param {JSONRPCMessage} message */
function isRequest(message) {
  return "method" in message && "id" in message;
}

/** @param {JSONRPCMessage} message */
function isResponse(message) {
  return "id" in message && ("result" in message || "error" in message);
}

/** @param {unknown} error */
function describe(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return status === 401
    ? `${message} (check --access-token / SENTRY_ACCESS_TOKEN)`
    : message;
}

/**
 * Start forwarding between stdio and the hosted MCP.
 *
 * @param {{
 *   endpoint: URL,
 *   accessToken: string,
 *   userAgent: string,
 *   log: (message: string) => void,
 * }} options
 * @returns {Promise<{ closed: Promise<void>, close: () => Promise<void> }>}
 */
export async function startProxy({ endpoint, accessToken, userAgent, log }) {
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Authorization: `Sentry-Bearer ${accessToken}`,
        "User-Agent": userAgent,
      },
    },
  });

  /** Client request ids that have not been answered yet. */
  const pending = new Set();
  const initializeIds = new Set();
  let stdinEnded = false;
  /** @type {Promise<void> | undefined} */
  let closing;

  const close = () => {
    closing ??= (async () => {
      // Best effort: let a stateful server drop the session. Errors are
      // reported through `onerror`, which is silent while closing.
      await Promise.race([
        remote.terminateSession().catch(() => {}),
        delay(SESSION_TERMINATE_TIMEOUT_MS, undefined, { ref: false }),
      ]);
      await remote.close();
      await local.close();
    })();
    return closing;
  };

  const closeWhenDrained = () => {
    if (stdinEnded && pending.size === 0) {
      void close();
    }
  };

  /** @param {JSONRPCMessage} message */
  const toClient = (message) =>
    local.send(message).then(closeWhenDrained, (error) => {
      log(`Failed to write to stdout: ${describe(error)}`);
    });

  local.onmessage = (message) => {
    if (isRequest(message)) {
      pending.add(message.id);
      if (message.method === "initialize") {
        initializeIds.add(message.id);
      }
    } else if (message.method === "notifications/cancelled") {
      pending.delete(message.params?.requestId);
    }
    remote.send(message).catch((error) => {
      // `onerror` already logged it; a request also needs an answer so the
      // client does not wait forever.
      if (isRequest(message) && pending.delete(message.id)) {
        initializeIds.delete(message.id);
        void toClient({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: INTERNAL_ERROR, message: describe(error) },
        });
      }
    });
  };
  local.onerror = (error) =>
    log(`Invalid message on stdin: ${describe(error)}`);

  remote.onmessage = (message) => {
    if (isResponse(message)) {
      pending.delete(message.id);
      if (initializeIds.delete(message.id) && "result" in message) {
        // Later requests must carry the negotiated `MCP-Protocol-Version`.
        remote.setProtocolVersion(String(message.result.protocolVersion));
      }
    }
    void toClient(message);
  };
  remote.onerror = (error) => {
    if (!closing) {
      log(`Sentry MCP: ${describe(error)}`);
    }
  };

  const closed = new Promise((resolve) => {
    local.onclose = () => resolve(undefined);
  });

  process.stdin.once("end", () => {
    stdinEnded = true;
    closeWhenDrained();
  });

  await local.start();
  await remote.start();
  return { closed, close };
}
