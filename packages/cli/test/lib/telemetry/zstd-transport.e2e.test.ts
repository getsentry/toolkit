/**
 * E2E tests for the zstd transport.
 *
 * Spins up a real `http.createServer` on `127.0.0.1:0`, points the
 * transport at it, and verifies the wire-level behavior: the request
 * body is zstd-compressed, the `Content-Encoding` header is correct,
 * and the body decompresses back to a valid envelope.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { createEnvelope } from "@sentry/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  hasZstdSupport,
  makeCompressedTransport,
} from "../../../src/lib/telemetry/zstd-transport.js";

/** No-op for SDK callbacks that require a function but return nothing meaningful. */
function noop(): void {
  // intentionally empty
}

type CapturedRequest = {
  headers: IncomingMessage["headers"];
  body: Buffer;
};

/**
 * Track every server we start so they can be closed in teardown.
 * Without this, a `let server` shared across tests is overwritten by
 * the second test before the first one is closed — silent socket leak.
 */
const startedServers: (Server | TcpServer)[] = [];

/**
 * Start a server that accepts connections and never answers, like an
 * ingest endpoint behind a stalled network path. `closed` resolves when
 * the client gives up and its socket closes.
 */
function startStalledIngest(): Promise<{
  url: string;
  closed: Promise<void>;
}> {
  let onClosed: () => void = noop;
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  const server = createTcpServer((socket: Socket) => {
    socket.on("error", noop);
    socket.on("close", () => onClosed());
    // Read (and drop) the request so the client's hang-up is seen.
    socket.resume();
  });
  startedServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/0/envelope/`,
        closed,
      });
    });
  });
}

/**
 * Start an HTTP proxy that accepts the CONNECT tunnel and then goes
 * silent. Routes the transport through the SDK's `makeNodeTransport`.
 */
function startStalledProxy(): Promise<{ url: string; closed: Promise<void> }> {
  let onClosed: () => void = noop;
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  const server = createServer();
  server.on("connect", (_req, socket) => {
    socket.on("error", noop);
    socket.on("close", () => onClosed());
    // HTTP servers allow half-open sockets: close ours when the client
    // hangs up, so `closed` proves the client released its socket.
    socket.on("end", () => socket.end());
    socket.resume();
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  startedServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, closed });
    });
  });
}

function startMockIngest(
  responder: (req: IncomingMessage) => {
    statusCode: number;
    headers?: Record<string, string | string[]>;
  },
): Promise<{
  url: string;
  captures: CapturedRequest[];
}> {
  const captures: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captures.push({ headers: req.headers, body: Buffer.concat(chunks) });
      const response = responder(req);
      res.writeHead(response.statusCode, response.headers ?? {});
      res.end();
    });
  });
  startedServers.push(server);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/0/envelope/`,
        captures,
      });
    });
  });
}

describe("makeCompressedTransport (e2e)", () => {
  afterEach(async () => {
    // Close every server started in this test, in parallel. Lets the
    // event loop drain naturally instead of relying on process exit.
    await Promise.all(
      startedServers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
  });

  test("sends zstd-encoded envelope; server decompresses back to original", async () => {
    if (!hasZstdSupport()) {
      return;
    }

    const { url, captures } = await startMockIngest(() => ({
      statusCode: 200,
    }));

    const transport = makeCompressedTransport({
      url,
      recordDroppedEvent: noop,
    });

    // Sizable envelope — above the 1 KiB zstd threshold.
    const message = "x".repeat(4096);
    const envelope: any = createEnvelope({ event_id: "abc" } as any, [
      [{ type: "event" } as any, { message } as any],
    ]);

    const response = await transport.send(envelope);
    expect(response.statusCode).toBe(200);

    expect(captures).toHaveLength(1);
    expect(captures[0]?.headers["content-encoding"]).toBe("zstd");

    const decompressed = await promisify(zstdDecompress)(captures[0]!.body);
    const text = Buffer.from(
      decompressed.buffer,
      decompressed.byteOffset,
      decompressed.byteLength,
    ).toString("utf-8");
    expect(text).toContain(message);
    expect(text).toContain('"type":"event"');
  });

  test("rate-limit headers flow back into createTransport wrapper", async () => {
    const { url, captures } = await startMockIngest(() => ({
      statusCode: 429,
      headers: {
        "retry-after": "60",
        "x-sentry-rate-limits": "60:error:organization",
      },
    }));

    const transport = makeCompressedTransport({
      url,
      recordDroppedEvent: noop,
    });

    const envelope: any = createEnvelope({ event_id: "a" } as any, [
      [{ type: "event" } as any, { message: "hi" } as any],
    ]);
    const response = await transport.send(envelope);

    expect(response.statusCode).toBe(429);
    expect(response.headers?.["retry-after"]).toBe("60");
    expect(response.headers?.["x-sentry-rate-limits"]).toBe(
      "60:error:organization",
    );
    expect(captures).toHaveLength(1);
  });

  test("aborts a request the server never answers", async () => {
    const { url, closed } = await startStalledIngest();
    const transport = makeCompressedTransport(
      { url, recordDroppedEvent: noop },
      100,
    );
    const envelope: any = createEnvelope({ event_id: "a" } as any, [
      [{ type: "event" } as any, { message: "hi" } as any],
    ]);

    // Without a deadline this never settles, and its socket keeps the
    // CLI process alive after the command finishes (#1956).
    await expect(transport.send(envelope)).rejects.toThrow();
    await closed;
  });

  test("aborts a request stalled behind a proxy", async () => {
    const proxy = await startStalledProxy();
    const savedProxy = process.env.http_proxy;
    process.env.http_proxy = proxy.url;
    try {
      const transport = makeCompressedTransport(
        { url: "http://127.0.0.1:9/api/0/envelope/", recordDroppedEvent: noop },
        100,
      );
      const envelope: any = createEnvelope({ event_id: "a" } as any, [
        [{ type: "event" } as any, { message: "hi" } as any],
      ]);

      await expect(transport.send(envelope)).rejects.toThrow();
      await proxy.closed;
    } finally {
      if (savedProxy === undefined) {
        delete process.env.http_proxy;
      } else {
        process.env.http_proxy = savedProxy;
      }
    }
  });
});
