/**
 * The view side of MCP Apps: JSON-RPC 2.0 over `postMessage` with the host.
 * Covers only what the chart view uses, so the view ships without zod or an
 * MCP client SDK.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

/** The stable spec version this view speaks. */
const PROTOCOL_VERSION = "2026-01-26";
const REQUEST_TIMEOUT_MS = 60_000;

type JsonRpcId = string | number;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** One message on the wire, in either direction. */
type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: JsonRpcError };

export type DisplayMode = "inline" | "fullscreen" | "pip";

/** The fields of the spec's `HostContext` that the view reads. */
export interface HostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined> };
  locale?: string;
  timeZone?: string;
  displayMode?: DisplayMode;
  availableDisplayModes?: string[];
}

interface ContentBlock {
  type: string;
  text?: string;
}

/** An MCP `CallToolResult`. `structuredContent` is untrusted. */
export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface ViewHandlers {
  /** `ui/notifications/tool-input`: the complete tool arguments. */
  toolInput?(args: Record<string, unknown>): void;
  /** `ui/notifications/tool-result` */
  toolResult?(result: CallToolResult): void;
  /** `ui/notifications/tool-cancelled` */
  toolCancelled?(reason: string | undefined): void;
  /** The initial context and each `host-context-changed`, merged. */
  hostContext?(context: HostContext): void;
  /** `ui/resource-teardown`, answered once this returns. */
  teardown?(): void;
}

/** What a view may send in `ui/update-model-context`. */
export interface ModelContext {
  text: string;
  structuredContent: Record<string, unknown>;
}

export interface Host {
  /** `tools/call`, proxied by the host to the MCP server. */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
  /** `ui/open-link` */
  openLink(url: string): Promise<void>;
  /**
   * `ui/update-model-context`, with only the parts the host advertises in
   * `hostCapabilities.updateModelContext`. Does nothing when it advertises
   * neither text nor structured content.
   */
  updateModelContext(context: ModelContext): Promise<void>;
  /**
   * `ui/request-display-mode`. The mode the host sets reaches the view as a
   * host context change.
   */
  requestDisplayMode(mode: DisplayMode): Promise<void>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function toCallToolResult(params: unknown): CallToolResult {
  const result = isObject(params) ? params : {};
  const content = Array.isArray(result["content"])
    ? result["content"].filter(
        (block): block is ContentBlock =>
          isObject(block) &&
          typeof block["type"] === "string" &&
          (block["text"] === undefined || typeof block["text"] === "string"),
      )
    : [];
  return {
    content,
    structuredContent: result["structuredContent"],
    isError: result["isError"] === true,
  };
}

/**
 * Runs the `ui/initialize` handshake, sends `ui/notifications/initialized`,
 * then reports the view's size whenever it changes. Messages from any window
 * other than `host` are ignored.
 */
export async function connect(
  appInfo: { name: string; version: string },
  appCapabilities: { availableDisplayModes?: DisplayMode[] },
  handlers: ViewHandlers,
  host: Window = window.parent,
): Promise<Host> {
  let nextId = 1;
  let context: HostContext = {};
  const pending = new Map<
    JsonRpcId,
    { resolve(result: unknown): void; reject(error: Error): void }
  >();
  const send = (message: JsonRpcMessage) => host.postMessage(message, "*");

  function request(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function updateContext(partial: unknown): void {
    if (!isObject(partial)) return;
    context = { ...context, ...partial };
    handlers.hostContext?.(context);
  }

  function onNotification(method: string, params: unknown): void {
    const values = isObject(params) ? params : {};
    switch (method) {
      case "ui/notifications/tool-input":
        handlers.toolInput?.(
          isObject(values["arguments"]) ? values["arguments"] : {},
        );
        return;
      case "ui/notifications/tool-result":
        handlers.toolResult?.(toCallToolResult(params));
        return;
      case "ui/notifications/tool-cancelled":
        handlers.toolCancelled?.(
          typeof values["reason"] === "string" ? values["reason"] : undefined,
        );
        return;
      case "ui/notifications/host-context-changed":
        updateContext(params);
        return;
    }
    // Other notifications, such as tool-input-partial, need nothing here.
  }

  function onRequest(id: JsonRpcId, method: string): void {
    if (method === "ui/resource-teardown") handlers.teardown?.();
    if (method === "ui/resource-teardown" || method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (event.source !== host || !isObject(message)) return;
    if (message["jsonrpc"] !== "2.0") return;
    const { id, method } = message;
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof method === "string") {
      if (hasId) onRequest(id, method);
      else onNotification(method, message["params"]);
      return;
    }
    const waiter = hasId ? pending.get(id) : undefined;
    if (!hasId || !waiter) return;
    pending.delete(id);
    const error = message["error"];
    if (isObject(error)) {
      waiter.reject(
        new Error(
          typeof error["message"] === "string"
            ? error["message"]
            : "The host could not complete the request.",
        ),
      );
    } else {
      waiter.resolve(message["result"]);
    }
  });

  const initialized = await request("ui/initialize", {
    appInfo,
    appCapabilities,
    protocolVersion: PROTOCOL_VERSION,
  });
  const result = isObject(initialized) ? initialized : {};
  updateContext(result["hostContext"]);
  const capabilities = isObject(result["hostCapabilities"])
    ? result["hostCapabilities"]
    : {};
  const modelContext = isObject(capabilities["updateModelContext"])
    ? capabilities["updateModelContext"]
    : {};
  send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  reportSize(send);

  return {
    callTool: async (name, args) =>
      toCallToolResult(await request("tools/call", { name, arguments: args })),
    openLink: async (url) => {
      await request("ui/open-link", { url });
    },
    updateModelContext: async ({ text, structuredContent }) => {
      const params: Record<string, unknown> = {};
      if (isObject(modelContext["text"])) {
        params["content"] = [{ type: "text", text }];
      }
      if (isObject(modelContext["structuredContent"])) {
        params["structuredContent"] = structuredContent;
      }
      if (Object.keys(params).length === 0) return;
      await request("ui/update-model-context", params);
    },
    requestDisplayMode: async (mode) => {
      const set = await request("ui/request-display-mode", { mode });
      if (isObject(set)) updateContext({ displayMode: set["mode"] });
    },
  };
}

/** Sends `ui/notifications/size-changed` once per frame when the size changes. */
function reportSize(send: (message: JsonRpcMessage) => void): void {
  let scheduled = false;
  let width = 0;
  let height = 0;
  const measure = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const root = document.documentElement;
      // Measure the content, not a height the host gave the iframe.
      const previous = root.style.height;
      root.style.height = "max-content";
      const nextHeight = Math.ceil(root.getBoundingClientRect().height);
      root.style.height = previous;
      const nextWidth = Math.ceil(window.innerWidth);
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      send({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { width, height },
      });
    });
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(document.documentElement);
  observer.observe(document.body);
}
