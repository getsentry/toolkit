/**
 * Tests for the `sentry local serve` command infrastructure.
 *
 * Exercises buildApp (HTTP ingest, SSE streaming, CORS), isServerRunning,
 * feedSSELine, and parsePort.
 */

import { createLocalControlPlane } from "../../../src/commands/local/control-plane.js";
import { createLocalRetentionBuffer } from "../../../src/commands/local/retention-buffer.js";
import { logger } from "../../../src/lib/logger.js";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import {
  buildApp,
  consumeSSE,
  configureExistingRetention,
  feedSSELine,
  isServerRunning,
  MAX_BODY_BYTES,
  parsePort,
  SERVER_IDENTIFIER,
  serverCommand,
  tryListen,
} from "../../../src/commands/local/server.js";
import { openBrowser } from "../../../src/lib/browser.js";
import {
  PORT_HELD_BY_DAEMON_FIELD,
  ValidationError,
} from "../../../src/lib/errors.js";
import { SENTRY_CONTENT_TYPE } from "../../../src/lib/formatters/local.js";
import { at } from "../../helpers.js";

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
    session?: string;
  },
) => Promise<void>;

function interceptShutdownSignal() {
  let handler: (() => void) | undefined;
  const originalOn = process.on.bind(process);
  const originalOnce = process.once.bind(process);
  const onSpy = vi.spyOn(process, "on").mockImplementation(((
    event: string,
    listener: () => void,
  ) => {
    if (event === "SIGINT") {
      handler = listener;
      return process;
    }
    return originalOn(event, listener);
  }) as typeof process.on);
  const onceSpy = vi.spyOn(process, "once").mockImplementation(((
    event: string,
    listener: () => void,
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

test("reports the scoped SSE endpoint without leaking its capability on initial attach failure", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 401 }));
  const writes: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    });
  try {
    await consumeSSE({
      url: "http://127.0.0.1:8969",
      streamUrl:
        "http://127.0.0.1:8969/_local/v1/sessions/session-id/stream?cap=fixture-secret",
      activeFilters: new Set(),
      signal: new AbortController().signal,
    });
  } finally {
    globalThis.fetch = savedFetch;
    spy.mockRestore();
  }
  expect(writes.join("")).toContain("/_local/v1/sessions/session-id/stream");
  expect(writes.join("")).not.toContain("fixture-secret");
});

test.each([
  { quiet: false, closedBeforeAttach: true },
  { quiet: true, closedBeforeAttach: true },
  { quiet: false, closedBeforeAttach: false },
  { quiet: true, closedBeforeAttach: false },
])(
  "stops a scoped tail on Close ($quiet quiet, $closedBeforeAttach already closed)",
  async ({ quiet, closedBeforeAttach }) => {
    const plane = createLocalControlPlane({ controlToken: "tail-test" });
    const session = plane.sessionStore.create({
      label: "saved",
      cwd: "/saved",
    });
    const { ingest, stream } = plane.sessionStore.getCapabilities(session.id);
    const base = `http://localhost:8969/_local/v1/sessions/${session.id}`;
    await plane.app.request(`${base}/ingest/${ingest}`, {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: '{"event_id":"saved"}\n{"type":"event"}\n{"message":"saved event"}',
    });
    if (closedBeforeAttach) plane.sessionStore.close(session.id);
    const savedFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests += 1;
      const url = input instanceof Request ? input.url : input.toString();
      const response = await plane.app.request(url, init);
      if (!closedBeforeAttach)
        queueMicrotask(() => plane.sessionStore.close(session.id));
      return response;
    };
    const output: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output.push(chunk.toString());
        return true;
      });
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await consumeSSE({
        url: "http://localhost:8969",
        streamUrl: `${base}/stream?cap=${stream}`,
        activeFilters: new Set(),
        signal: AbortSignal.timeout(1200),
        useJson: true,
        quiet,
      });
      expect(requests).toBe(1);
      expect(info.mock.calls.flat().join(" ")).not.toContain("reconnecting");
      if (quiet) expect(output).toHaveLength(0);
      else {
        expect(output).toHaveLength(1);
        expect(output.join("")).toContain("saved event");
      }
    } finally {
      globalThis.fetch = savedFetch;
      stdout.mockRestore();
      info.mockRestore();
    }
  },
);

test.each([
  {
    gone: "refuses connections",
    reconnect: () =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          }),
        }),
      ),
  },
  {
    gone: "no longer knows the session",
    reconnect: () => Promise.resolve(new Response(null, { status: 404 })),
  },
])(
  "stops a scoped tail with one warning when the daemon $gone",
  async ({ reconnect }) => {
    const savedFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      // The first stream opens, then ends when the daemon stops.
      return requests === 1
        ? Promise.resolve(
            new Response("", {
              headers: { "Content-Type": "text/event-stream" },
            }),
          )
        : reconnect();
    };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const signal = AbortSignal.timeout(6000);
    try {
      await consumeSSE({
        url: "http://127.0.0.1:8969",
        streamUrl:
          "http://127.0.0.1:8969/_local/v1/sessions/session-id/stream?cap=fixture-secret",
        activeFilters: new Set(),
        signal,
      });
      expect(signal.aborted).toBe(false);
      expect(requests).toBe(2);
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining(
          "The Local daemon stopped or restarted, so this session is no longer capturing",
        ),
      ]);
    } finally {
      globalThis.fetch = savedFetch;
      warn.mockRestore();
      info.mockRestore();
    }
  },
);

test("keeps reading after a retained reset notification until Close", async () => {
  const savedFetch = globalThis.fetch;
  const envelope = [{}, [[{ type: "event" }, { message: "after reset" }]]];
  globalThis.fetch = async () =>
    new Response(
      [
        'event: sentry.local.session\ndata: {"state":"retained","action":"reset"}\n\n',
        `event: application/x-sentry-envelope\ndata: ${JSON.stringify(envelope)}\n\n`,
        'event: sentry.local.session\ndata: {"state":"retained"}\n\n',
      ].join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  const output: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      output.push(chunk.toString());
      return true;
    });
  const signal = AbortSignal.timeout(1000);
  try {
    await consumeSSE({
      url: "http://localhost:8969",
      activeFilters: new Set(),
      signal,
      useJson: true,
    });
    expect(signal.aborted).toBe(false);
    expect(output).toHaveLength(1);
    expect(output.join("")).toContain("after reset");
  } finally {
    globalThis.fetch = savedFetch;
    stdout.mockRestore();
  }
});

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
  let info: MockInstance<(typeof logger)["info"]>;
  beforeEach(() => {
    info = vi.spyOn(logger, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
  });
  function expectViewerHint() {
    const hints = info.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith("View events at "));
    expect(hints).toHaveLength(1);
    const url = new URL(hints[0]!.slice("View events at ".length));
    expect(url.origin).toBe("https://local.sentry.dev");
    expect(new URL(url.searchParams.get("url")!).pathname).toBe("/stream");
  }
  const flags = {
    host: "127.0.0.1",
    quiet: true,
    filter: [],
    format: "human" as const,
    attributes: false,
    open: true,
  };

  test("scoped serve opens the viewer with explicit session discovery", async () => {
    const daemon = await import("../../../src/commands/local/daemon.js");
    const { server, port } = await tryListen(
      buildApp(createLocalRetentionBuffer(5).buffer),
      0,
      "127.0.0.1",
    );
    const streamUrl = `http://127.0.0.1:${port}/stream`;
    const directoryUrl = `http://127.0.0.1:${port}/_local/v1/ui/sessions?cap=directory-secret`;
    const create = vi
      .spyOn(daemon, "createLocalDaemonSession")
      .mockResolvedValue({
        id: "web",
        cwd: "/web",
        label: "web",
        streamUrl,
        ingestUrl: streamUrl,
        directoryUrl,
      });
    const retain = vi
      .spyOn(daemon, "retainLocalDaemonSession")
      .mockResolvedValue(undefined);
    const signal = interceptShutdownSignal();
    const opener = vi.mocked(openBrowser);
    opener.mockClear();
    const func = (await serverCommand.loader()) as unknown as ServeFunc;
    try {
      const command = func.call(
        { cwd: "/web" },
        { ...flags, port, session: "web" },
      );
      await vi.waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
      signal.trigger();
      await command;
      expectViewerHint();
      const url = new URL(at(opener.mock.calls, 0)[0]);
      expect(new URLSearchParams(url.hash.slice(1)).get("directory")).toBe(
        directoryUrl,
      );
      expect(url.search).toBe("");
    } finally {
      signal.restore();
      create.mockRestore();
      retain.mockRestore();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    }
  });

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
      expectViewerHint();
    } finally {
      signal.restore();
    }

    expect(openBrowserMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^http:\/\/localhost:5173\/#stream=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fstream$/,
      ),
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
      buildApp(createLocalRetentionBuffer(10).buffer),
      0,
      "127.0.0.1",
    );
    const func = (await serverCommand.loader()) as unknown as ServeFunc;

    try {
      const command = func.call({}, { ...flags, port });
      await vi.waitFor(() => expect(openBrowserMock).toHaveBeenCalledTimes(1));
      signal.trigger();
      await command;
      expectViewerHint();
    } finally {
      signal.restore();
      globalThis.fetch = savedFetch;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(openBrowserMock).toHaveBeenCalledWith(
      `http://localhost:5173/#stream=http%3A%2F%2F127.0.0.1%3A${port}%2Fstream`,
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
      (type, data, id) => events.push({ type, data, id }),
    );
    expect(state.eventType).toBe("application/x-sentry-envelope");
    expect(events).toHaveLength(0);
  });

  test("parses data lines", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    feedSSELine("data: hello", state, (type, data, id) =>
      events.push({ type, data, id }),
    );
    expect(state.dataLines).toEqual(["hello"]);
    expect(events).toHaveLength(0);
  });

  test("parses id field", () => {
    const state = makeState();
    const events: Array<{ type: string; data: string; id: string }> = [];
    feedSSELine("id: abc-123", state, (type, data, id) =>
      events.push({ type, data, id }),
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
  const buffer = createLocalRetentionBuffer(10).buffer;
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
  test("hosted retention updates preserve standalone data and leave other controls blocked", async () => {
    const retention = createLocalRetentionBuffer(500);
    const app = buildApp(retention.buffer, { uiActions: true, retention });
    await app.request("/stream", {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: TEST_ENVELOPE,
    });
    const before = retention.buffer.read({ all: true });
    const origin = "https://local.sentry.dev";
    const preflight = await app.request("/retention", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe(
      "true",
    );
    const updated = await app.request("/retention", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: '{"maxEnvelopes":50000}',
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(await updated.json()).toMatchObject({
      maxEnvelopes: 50000,
      retainedEnvelopes: 1,
    });
    for (const value of [-1, 0, 1.5, 50001, "1000", null]) {
      expect(
        (
          await app.request("/retention", {
            method: "POST",
            headers: { Origin: origin },
            body: JSON.stringify({ maxEnvelopes: value }),
          })
        ).status,
      ).toBe(400);
    }
    expect(retention.buffer.read({ all: true })).toEqual(before);
    expect(
      (
        await app.request("/clear", {
          method: "DELETE",
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/retention", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: '{"maxEnvelopes":1000}',
        })
      ).status,
    ).toBe(403);
    const disabled = buildApp(retention.buffer, {
      uiActions: false,
      retention,
    });
    expect(
      (
        await disabled.request("/retention", {
          method: "POST",
          headers: { Origin: origin },
          body: '{"maxEnvelopes":1000}',
        })
      ).status,
    ).toBe(403);
  });

  test("changes legacy retention only when explicit and preserves history on rejected decreases", async () => {
    const retention = createLocalRetentionBuffer(2);
    const app = buildApp(retention.buffer, { uiActions: true, retention });
    await app.request("/stream", {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: TEST_ENVELOPE,
    });
    const retained = retention.buffer.read({ all: true });
    for (const origin of ["https://example.com"]) {
      expect(
        (
          await app.request("/retention", {
            method: "POST",
            headers: { Origin: origin },
            body: '{"maxEnvelopes":1000}',
          })
        ).status,
      ).toBe(403);
    }
    const fetchMock = vi.fn(
      async (url: string, init?: RequestInit) =>
        await app.request(new URL(url).pathname, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await configureExistingRetention("http://127.0.0.1:8969");
      expect(fetchMock).not.toHaveBeenCalled();
      await configureExistingRetention("http://127.0.0.1:8969", 1000);
      expect(retention.getSettings().maxEnvelopes).toBe(1000);
      expect(retention.buffer.read({ all: true })).toEqual(retained);
      await expect(
        configureExistingRetention("http://127.0.0.1:8969", 0),
      ).rejects.toThrow(/integer/);
      fetchMock.mockImplementation(
        async () => new Response("{}", { status: 200 }),
      );
      await expect(
        configureExistingRetention("http://127.0.0.1:8969", 2000),
      ).rejects.toThrow(/did not confirm/);
      fetchMock.mockImplementation(
        async () => new Response(null, { status: 404 }),
      );
      await expect(
        configureExistingRetention("http://127.0.0.1:8969", 2000),
      ).rejects.toThrow(/does not support/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("health endpoint returns OK", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
    const app = buildApp(buffer);

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  test("advertises session-only UI capabilities", async () => {
    const app = buildApp(createLocalRetentionBuffer(10).buffer, {
      uiActions: true,
    });

    const res = await app.request("/capabilities");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      actions: { clear: true, envelope: true },
      retention: "session",
    });
  });

  test("clears buffered envelopes and exposes a retained raw envelope", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
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

  test("ingest rejects bodies without an envelope header and keeps nothing", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
    const app = buildApp(buffer);
    const post = (
      body: string | ReturnType<typeof gzipSync>,
      encoding?: string,
    ) =>
      app.request("/stream", {
        method: "POST",
        headers: {
          "Content-Type": SENTRY_CONTENT_TYPE,
          ...(encoding ? { "Content-Encoding": encoding } : {}),
        },
        body,
      });
    for (const body of [
      "",
      '{not json\n{"type":"event"}\n{}',
      '[]\n{"type":"event"}\n{}',
      "not-an-envelope",
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
    expect((await post(gzipSync("{not json\n"), "gzip")).status).toBe(400);
    expect(buffer.read({ all: true })).toEqual([]);
    // Like Relay, unknown item types and items without `length` are fine.
    const valid = await post(
      '{}\n{"type":"future_item"}\n{"x":1}\n{"type":"event"}\n{"message":"ok"}',
    );
    expect(valid.ok).toBe(true);
    expect(buffer.read({ all: true })).toHaveLength(1);
  });

  test("ingest endpoint accepts envelopes and returns 204", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    const buffer = createLocalRetentionBuffer(10).buffer;
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

  test("plain receivers keep the envelope header dsn", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
    const app = buildApp(buffer);
    const envelope =
      '{"dsn":"http://local@127.0.0.1:8969/0"}\n{"type":"event"}\n{"message":"test"}';
    const res = await app.request("/api/0/envelope/", {
      method: "POST",
      headers: { "Content-Type": SENTRY_CONTENT_TYPE },
      body: envelope,
    });
    expect(res.status).toBe(204);
    expect(buffer.read({ all: true })[0]?.getData().toString("utf8")).toBe(
      envelope,
    );
  });

  test("ingest rejects oversized payloads with 413", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    const buffer = createLocalRetentionBuffer(10).buffer;
    const app = buildApp(buffer);

    const res = await app.request("/health", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
  });

  test("CORS allows the hosted local UI to read the event stream", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
    const app = buildApp(buffer);

    const res = await app.request("/stream", {
      headers: { Origin: "https://local.sentry.dev" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://local.sentry.dev",
    );
    if (res.body) {
      await res.body.cancel();
    }
  });

  test("CORS allows the configured Sentry Local preview to read the event stream", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    const buffer = createLocalRetentionBuffer(10).buffer;
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
      "Last-Event-ID",
    );
    expect(res.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    expect(res.headers.get("vary")).toContain(
      "Access-Control-Request-Private-Network",
    );
  });

  test("rejects hosted-origin writes to the local receiver", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    const app = buildApp(createLocalRetentionBuffer(10).buffer, {
      uiActions: true,
    });

    const res = await app.request("/capabilities", {
      headers: { Origin: "https://local.sentry.dev" },
    });

    expect(res.status).toBe(403);
  });

  test("does not expose receiver controls without loopback authorization", async () => {
    const app = buildApp(createLocalRetentionBuffer(10).buffer);

    expect((await app.request("/capabilities")).status).toBe(403);
    expect((await app.request("/clear", { method: "DELETE" })).status).toBe(
      403,
    );
  });

  test("CORS blocks lookalike hosted UI origins", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
    const app = buildApp(buffer);

    const res = await app.request("/health", {
      headers: { Origin: "https://local.sentry.dev.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("CORS requires HTTPS for hosted Sentry preview origins", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    const app = buildApp(createLocalRetentionBuffer(10).buffer, {
      uiActions: true,
    });
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
    const buffer = createLocalRetentionBuffer(10).buffer;
    const app = buildApp(buffer);

    const res = await app.request("/health", {
      headers: { Origin: "http://evil.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("SSE stream endpoint returns event-stream content type", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    const buffer = createLocalRetentionBuffer(10).buffer;
    const app = buildApp(buffer);

    const res = await app.request("/health");
    // The literal is spelled out rather than compared against the constant:
    // Spotlight's isSidecarRunning() matches this exact string, so a rename
    // here would silently break desktop-app detection.
    expect(res.headers.get("x-powered-by")).toBe("spotlight-by-sentry");
  });

  test("sets X-Powered-By on ingest responses too", async () => {
    const buffer = createLocalRetentionBuffer(10).buffer;
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
    // port anyway and abort with "Port 8969 is already in use".
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
        true,
      );
    } finally {
      globalThis.fetch = savedFetch;
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("rejects a port that a Sentry Local daemon holds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("OK", { headers: { "X-Sentry-Local-Mode": "daemon" } }),
      ),
    );
    try {
      await expect(
        isServerRunning("http://127.0.0.1:8969"),
      ).rejects.toMatchObject({
        name: "ValidationError",
        field: PORT_HELD_BY_DAEMON_FIELD,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("returns false when no server is running", async () => {
    // isServerRunning uses global fetch which is mocked in tests.
    // Verify the function handles connection errors gracefully.
    const result = await isServerRunning("http://127.0.0.1:19999");
    expect(result).toBe(false);
  });
});

describe("oversized envelopes", () => {
  /** One byte over the encoded ingest limit; SDKs ignore the 413 and drop it. */
  const OVERSIZED_BODY = "x".repeat(MAX_BODY_BYTES + 1);
  const OVERSIZED_WARNING = /over the .*ingest limit/;

  function postOversized(app: Hono, url: string): Promise<Response> {
    return Promise.resolve(
      app.request(url, {
        method: "POST",
        headers: { "Content-Type": SENTRY_CONTENT_TYPE },
        body: OVERSIZED_BODY,
      }),
    );
  }

  test("a plain receiver warns once per burst, then counts the rest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const oversizedWarnings = () =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => OVERSIZED_WARNING.test(line));
    try {
      const app = buildApp(createLocalRetentionBuffer(10).buffer);
      for (let i = 0; i < 3; i++) {
        const response = await postOversized(
          app,
          "http://localhost:8969/stream",
        );
        expect(response.status).toBe(413);
      }
      expect(oversizedWarnings()).toHaveLength(1);
      // The two held back print when the interval ends, without a new drop.
      vi.advanceTimersByTime(5000);
      expect(oversizedWarnings()).toHaveLength(2);
      expect(oversizedWarnings()[1]).toMatch(/^Dropped 2 more envelopes over/);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a plain receiver prints held-back drops when it shuts down early", async () => {
    const realFetch = (globalThis as { __originalFetch?: typeof fetch })
      .__originalFetch;
    if (!realFetch) {
      throw new Error("Expected the test preload to retain the native fetch");
    }
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const app = buildApp(createLocalRetentionBuffer(10).buffer);
    const { server, port } = await tryListen(app, 0, "127.0.0.1");
    try {
      for (let i = 0; i < 3; i++) {
        const response = await realFetch(`http://127.0.0.1:${port}/stream`, {
          method: "POST",
          headers: { "Content-Type": SENTRY_CONTENT_TYPE },
          body: OVERSIZED_BODY,
        });
        expect(response.status).toBe(413);
      }
      // `local run` and `local serve` close the server and exit well inside
      // the five-second interval, so closing must print the count.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const warnings = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => OVERSIZED_WARNING.test(line));
      expect(warnings).toEqual([
        expect.stringMatching(/^Dropped an envelope over/),
        expect.stringMatching(/^Dropped 2 more envelopes over/),
      ]);
    } finally {
      server.closeAllConnections();
      warn.mockRestore();
    }
  });

  test("a plain receiver tells stream consumers about a rejected envelope", async () => {
    const app = buildApp(createLocalRetentionBuffer(10).buffer);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const response = await app.request("http://localhost:8969/stream", {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await postOversized(app, "http://localhost:8969/stream");
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain("event: sentry.local.oversized");
    } finally {
      clearTimeout(deadline);
      controller.abort();
      warn.mockRestore();
    }
  });

  test("a session tail warns when the daemon rejects an oversized envelope", async () => {
    const plane = createLocalControlPlane({ controlToken: "oversize-test" });
    const session = plane.sessionStore.create({ label: "web", cwd: "/web" });
    const { ingest, stream } = plane.sessionStore.getCapabilities(session.id);
    const base = `http://localhost:8969/_local/v1/sessions/${session.id}`;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const response = await plane.app.request(url, init);
      setTimeout(() => {
        void (async () => {
          await postOversized(plane.app, `${base}/ingest/${ingest}`);
          await postOversized(plane.app, `${base}/ingest/${ingest}`);
          plane.sessionStore.close(session.id);
        })();
      }, 50);
      return response;
    };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await consumeSSE({
        url: "http://localhost:8969",
        streamUrl: `${base}/stream?cap=${stream}`,
        activeFilters: new Set(),
        signal: AbortSignal.timeout(3000),
      });
      const warnings = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => OVERSIZED_WARNING.test(line));
      // The second drop is held back, then printed when the tail ends.
      expect(warnings).toEqual([
        expect.stringMatching(/^Dropped an envelope over/),
        expect.stringMatching(/^Dropped 1 more envelope over/),
      ]);
    } finally {
      globalThis.fetch = savedFetch;
      warn.mockRestore();
    }
  });
});
