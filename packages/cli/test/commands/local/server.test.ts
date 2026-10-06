/**
 * Tests for the `sentry local serve` command infrastructure.
 *
 * Exercises buildApp (HTTP ingest, SSE streaming, CORS), isServerRunning,
 * feedSSELine, and parsePort.
 */

import { createSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import {
  buildApp,
  feedSSELine,
  isServerRunning,
  parsePort,
  SERVER_IDENTIFIER,
  serverCommand,
  tryListen,
} from "../../../src/commands/local/server.js";
import { openBrowser } from "../../../src/lib/browser.js";
import { ValidationError } from "../../../src/lib/errors.js";
import { SENTRY_CONTENT_TYPE } from "../../../src/lib/formatters/local.js";

vi.mock("../../../src/lib/browser.js", () => ({
  openBrowser: vi.fn().mockResolvedValue(true),
}));

type ServeFunc = (
  this: object,
  flags: {
    port: number;
    host: string;
    quiet: boolean;
    filter: ("error" | "transaction" | "log" | "ai")[];
    format: "human" | "json";
    attributes: boolean;
    open: boolean;
  }
) => Promise<void>;

function interceptShutdownSignal() {
  let handler: (() => void) | undefined;
  const originalOn = process.on.bind(process);
  const originalOnce = process.once.bind(process);
  const onSpy = vi.spyOn(process, "on").mockImplementation(((
    event: string,
    listener: () => void
  ) => {
    if (event === "SIGINT") {
      handler = listener;
      return process;
    }
    return originalOn(event, listener);
  }) as typeof process.on);
  const onceSpy = vi.spyOn(process, "once").mockImplementation(((
    event: string,
    listener: () => void
  ) => {
    if (event === "SIGINT") {
      handler = listener;
      return process;
    }
    return originalOnce(event, listener);
  }) as typeof process.once);

  return {
    trigger() {
      if (!handler) {
        throw new Error("Expected a SIGINT handler");
      }
      handler();
    },
    restore() {
      onSpy.mockRestore();
      onceSpy.mockRestore();
    },
  };
}

describe("parsePort", () => {
  test("parses valid port numbers", () => {
    expect(parsePort("8969")).toBe(8969);
    expect(parsePort("0")).toBe(0);
    expect(parsePort("65535")).toBe(65_535);
  });

  test("throws on negative port", () => {
    expect(() => parsePort("-1")).toThrow(ValidationError);
  });

  test("throws on port above 65535", () => {
    expect(() => parsePort("70000")).toThrow(ValidationError);
  });

  test("throws on non-integer", () => {
    expect(() => parsePort("8969.5")).toThrow(ValidationError);
  });

  test("throws on non-numeric", () => {
    expect(() => parsePort("abc")).toThrow();
  });
});

describe("sentry local serve --open", () => {
  const flags = {
    host: "127.0.0.1",
    quiet: true,
    filter: [],
    format: "human" as const,
    attributes: false,
    open: true,
  };

  test("opens the UI after starting an owned receiver", async () => {
    const signal = interceptShutdownSignal();
    const openBrowserMock = vi.mocked(openBrowser);
    openBrowserMock.mockClear();
    const func = (await serverCommand.loader()) as unknown as ServeFunc;

    try {
      const command = func.call({}, { ...flags, port: 0 });
      await vi.waitFor(() => expect(openBrowserMock).toHaveBeenCalledTimes(1));
      signal.trigger();
      await command;
    } finally {
      signal.restore();
    }

    expect(openBrowserMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^http:\/\/localhost:5173\/#stream=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fstream$/
      )
    );
  });

  test("opens the UI when attaching to an existing receiver", async () => {
    const signal = interceptShutdownSignal();
    const openBrowserMock = vi.mocked(openBrowser);
    openBrowserMock.mockClear();
    const savedFetch = globalThis.fetch;
    const realFetch = (globalThis as { __originalFetch?: typeof fetch })
      .__originalFetch;
    if (!realFetch) {
      throw new Error("Expected the test preload to retain the native fetch");
    }
    globalThis.fetch = realFetch;
    const { server, port } = await tryListen(
      buildApp(createSpotlightBuffer(10)),
      0,
      "127.0.0.1"
    );
    const func = (await serverCommand.loader()) as unknown as ServeFunc;

    try {
      const command = func.call({}, { ...flags, port });
      await vi.waitFor(() => expect(openBrowserMock).toHaveBeenCalledTimes(1));
      signal.trigger();
      await command;
    } finally {
      signal.restore();
      globalThis.fetch = savedFetch;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(openBrowserMock).toHaveBeenCalledWith(
      `http://localhost:5173/#stream=http%3A%2F%2F127.0.0.1%3A${port}%2Fstream`
    );
  });
});

describe("feedSSELine", () => {
  function makeState() {
    return { eventType: "", dataLines: [], id: "" };
  }

  test("parses event type", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    feedSSELine(
      "event: application/x-sentry-envelope",
      state,
      (type, data, id) => events.push({ type, data, id })
    );
    expect(state.eventType).toBe("application/x-sentry-envelope");
    expect(events).toHaveLength(0);
  });

  test("parses data lines", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    feedSSELine("data: hello", state, (type, data, id) =>
      events.push({ type, data, id })
    );
    expect(state.dataLines).toEqual(["hello"]);
    expect(events).toHaveLength(0);
  });

  test("parses id field", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    feedSSELine("id: abc-123", state, (type, data, id) =>
      events.push({ type, data, id })
    );
    expect(state.id).toBe("abc-123");
  });

  test("dispatches event on empty line", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    const cb = (type: string, data: string, id: string) =>
      events.push({ type, data, id });

    feedSSELine("event: test-event", state, cb);
    feedSSELine("id: evt-1", state, cb);
    feedSSELine("data: payload", state, cb);
    feedSSELine("", state, cb);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "test-event",
      data: "payload",
      id: "evt-1",
    });
  });

  test("resets state after dispatch", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    const cb = (type: string, data: string, id: string) =>
      events.push({ type, data, id });

    feedSSELine("event: first", state, cb);
    feedSSELine("data: one", state, cb);
    feedSSELine("", state, cb);

    expect(state.eventType).toBe("");
    expect(state.dataLines).toEqual([]);
    expect(state.id).toBe("");
  });

  test("concatenates multiple data lines with newline", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    const cb = (type: string, data: string, id: string) =>
      events.push({ type, data, id });

    feedSSELine("data: line1", state, cb);
    feedSSELine("data: line2", state, cb);
    feedSSELine("", state, cb);

    expect(events[0]?.data).toBe("line1\nline2");
  });

  test("does not dispatch on empty line with no data", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    feedSSELine("", state, (type, data, id) => events.push({ type, data, id }));
    expect(events).toHaveLength(0);
  });

  test("handles data without leading space", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    const cb = (type: string, data: string, id: string) =>
      events.push({ type, data, id });

    feedSSELine("data:nospace", state, cb);
    feedSSELine("", state, cb);

    expect(events[0]?.data).toBe("nospace");
  });
});

/** Minimal well-formed Sentry envelope used by the ingest/SSE tests. */
const TEST_ENVELOPE =
  '{"sdk":{"name":"sentry.node"}}\n{"type":"event"}\n{"message":"test"}';

/**
 * Subscribe to the SSE stream at `streamPath`, ingest one envelope, and return
 * the decoded text of the first frame the subscriber receives.
 *
 * The subscription is registered inside `streamSSE`'s async callback, so the
 * envelope must not be posted until that callback has had a chance to run —
 * otherwise the subscriber misses it and the read hangs.
 */
async function readFirstSSEEvent(streamPath: string): Promise<string> {
  const buffer = createSpotlightBuffer(10);
  const app = buildApp(buffer);

  const res = await app.request(streamPath, {
    headers: { Accept: "text/event-stream" },
  });
  if (!res.body) {
    throw new Error("SSE response had no body");
  }
  const reader = res.body.getReader();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await app.request("/stream", {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: TEST_ENVELOPE,
    });

    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: ")) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`SSE stream closed before an event arrived: ${text}`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } finally {
    await reader.cancel();
  }
}

describe("buildApp", () => {
  test("health endpoint returns OK", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  test("advertises session-only UI capabilities", async () => {
    const app = buildApp(createSpotlightBuffer(10), { uiActions: true });

    const res = await app.request("/capabilities");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      actions: { clear: true, envelope: true },
      retention: "session",
    });
  });

  test("clears buffered envelopes and exposes a retained raw envelope", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer, { uiActions: true });
    await app.request("/stream", {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: TEST_ENVELOPE,
    });
    const container = buffer.read({ all: true })[0];
    const envelopeId = container
      ?.getParsedEnvelope()
      ?.envelope[0].__spotlight_envelope_id.toString();

    const raw = await app.request(`/envelope/${envelopeId}`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe(TEST_ENVELOPE);

    const cleared = await app.request("/clear", { method: "DELETE" });
    expect(cleared.status).toBe(204);
    expect(buffer.read({ all: true })).toEqual([]);
  });

  test("ingest endpoint accepts envelopes and returns 204", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const envelope =
      '{"sdk":{"name":"sentry.node"}}\n{"type":"event"}\n{"message":"test"}';
    const res = await app.request("/stream", {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: envelope,
    });
    expect(res.status).toBe(204);
  });

  test("ingest via /api/:projectId/envelope/ returns 204", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const envelope =
      '{"sdk":{"name":"sentry.node"}}\n{"type":"event"}\n{"message":"test"}';
    const res = await app.request("/api/123/envelope/", {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: envelope,
    });
    expect(res.status).toBe(204);
  });

  test("ingest rejects oversized payloads with 413", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      method: "POST",
      headers: {
        "Content-Type": SENTRY_CONTENT_TYPE,
        "Content-Length": String(11 * 1024 * 1024),
      },
      body: "x".repeat(1024),
    });
    expect(res.status).toBe(413);
  });

  test("CORS allows localhost origins", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/health", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000"
    );
  });

  test("CORS allows the hosted local UI to read the event stream", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      headers: { Origin: "https://local.sentry.dev" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://local.sentry.dev"
    );
    if (res.body) {
      await res.body.cancel();
    }
  });

  test("CORS allows the configured Sentry Local preview to read the event stream", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);
    const origin =
      "https://sentry-local-git-codex-featlocal-observability-workspace.sentry.dev";

    const res = await app.request("/stream", {
      headers: { Origin: origin },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    if (res.body) {
      await res.body.cancel();
    }
  });

  test("CORS allows HTTPS Sentry Local preview branches to read the event stream", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);
    const origin = "https://sentry-local-git-feature-branch.sentry.dev";

    const res = await app.request("/stream", {
      headers: { Origin: origin },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    if (res.body) {
      await res.body.cancel();
    }
  });

  test("CORS blocks unrelated Sentry-hosted origins from reading the event stream", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      headers: { Origin: "https://cli.sentry.dev" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    if (res.body) {
      await res.body.cancel();
    }
  });

  test("CORS permits the SSE resume header from the hosted local UI", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      method: "OPTIONS",
      headers: {
        Origin: "https://local.sentry.dev",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Last-Event-ID",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "Last-Event-ID"
    );
    expect(res.headers.get("access-control-allow-private-network")).toBe(
      "true"
    );
    expect(res.headers.get("vary")).toContain(
      "Access-Control-Request-Private-Network"
    );
  });

  test("rejects hosted-origin writes to the local receiver", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      method: "POST",
      headers: {
        Origin: "https://local.sentry.dev",
        "Content-Type": SENTRY_CONTENT_TYPE,
      },
      body: '{"type":"event"}\n{}',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("rejects hosted-origin receiver controls", async () => {
    const app = buildApp(createSpotlightBuffer(10), { uiActions: true });

    const res = await app.request("/capabilities", {
      headers: { Origin: "https://local.sentry.dev" },
    });

    expect(res.status).toBe(403);
  });

  test("does not expose receiver controls without loopback authorization", async () => {
    const app = buildApp(createSpotlightBuffer(10));

    expect((await app.request("/capabilities")).status).toBe(403);
    expect((await app.request("/clear", { method: "DELETE" })).status).toBe(
      403
    );
  });

  test("CORS blocks lookalike hosted UI origins", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/health", {
      headers: { Origin: "https://local.sentry.dev.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("CORS requires HTTPS for hosted Sentry preview origins", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      headers: {
        Origin: "http://sentry-local-git-feature-branch.sentry.dev",
      },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    if (res.body) {
      await res.body.cancel();
    }
  });

  test("limits the configured Sentry Local preview to stream reads", async () => {
    const app = buildApp(createSpotlightBuffer(10), { uiActions: true });
    const origin =
      "https://sentry-local-git-codex-featlocal-observability-workspace.sentry.dev";

    const [write, controls] = await Promise.all([
      app.request("/stream", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": SENTRY_CONTENT_TYPE,
        },
        body: '{"type":"event"}\n{}',
      }),
      app.request("/capabilities", { headers: { Origin: origin } }),
    ]);

    expect(write.status).toBe(403);
    expect(controls.status).toBe(403);
  });

  test("CORS blocks non-localhost origins", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/health", {
      headers: { Origin: "http://evil.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("SSE stream endpoint returns event-stream content type", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Abort to avoid hanging
    if (res.body) {
      await res.body.cancel();
    }
  });

  test("advertises itself as a Spotlight sidecar via X-Powered-By", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/health");
    // The literal is spelled out rather than compared against the constant:
    // Spotlight's isSidecarRunning() matches this exact string, so a rename
    // here would silently break desktop-app detection.
    expect(res.headers.get("x-powered-by")).toBe("spotlight-by-sentry");
  });

  test("sets X-Powered-By on ingest responses too", async () => {
    const buffer = createSpotlightBuffer(10);
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: TEST_ENVELOPE,
    });
    expect(res.headers.get("x-powered-by")).toBe(SERVER_IDENTIFIER);
  });

  test("SSE event type carries no base64 suffix by default", async () => {
    const chunk = await readFirstSSEEvent("/stream");
    expect(chunk).toContain(`event: ${SENTRY_CONTENT_TYPE}\n`);
  });

  test("SSE event type gains ;base64 suffix when the client asks for it", async () => {
    const chunk = await readFirstSSEEvent("/stream?base64=1");
    expect(chunk).toContain(`event: ${SENTRY_CONTENT_TYPE};base64\n`);
  });
});

describe("isServerRunning", () => {
  test("returns true when /health answers with an error status", async () => {
    // Spotlight's sidecar can 5xx on /health while still holding the port and
    // ingesting envelopes. Reporting "no server" made the CLI try to bind the
    // port anyway and abort with "Port 8969 is in use after 3 retries".
    const unhealthy = new Hono();
    unhealthy.get("/health", (c) => c.text("Internal Server Error", 500));
    const { server, port } = await tryListen(unhealthy, 0, "127.0.0.1");

    const savedFetch = globalThis.fetch;
    const realFetch = (globalThis as { __originalFetch?: typeof fetch })
      .__originalFetch;
    if (realFetch) {
      globalThis.fetch = realFetch;
    }

    try {
      await expect(isServerRunning(`http://127.0.0.1:${port}`)).resolves.toBe(
        true
      );
    } finally {
      globalThis.fetch = savedFetch;
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("returns false when no server is running", async () => {
    // isServerRunning uses global fetch which is mocked in tests.
    // Verify the function handles connection errors gracefully.
    const result = await isServerRunning("http://127.0.0.1:19999");
    expect(result).toBe(false);
  });
});
