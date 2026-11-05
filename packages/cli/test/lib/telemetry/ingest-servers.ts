/**
 * Local stand-ins for the Sentry ingest endpoint, shared by the telemetry
 * transport e2e tests: one that answers, one that stalls after connecting,
 * one that refuses connections, and a proxy that stalls after CONNECT.
 *
 * Every server started here is tracked; call {@link closeIngestServers} in
 * `afterEach` so a test never leaks a listening socket into the next one.
 */

import { createServer, type IncomingMessage } from "node:http";
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Socket,
} from "node:net";

/** No-op for SDK callbacks that require a function but return nothing meaningful. */
export function noop(): void {
  // intentionally empty
}

/** One request a mock ingest received. */
export type CapturedRequest = {
  headers: IncomingMessage["headers"];
  body: Buffer;
};

/** What these helpers need from an HTTP or TCP server. */
type LocalServer = {
  listen(port: number, host: string, callback: () => void): unknown;
  address(): unknown;
  close(callback: () => void): unknown;
};

const startedServers: LocalServer[] = [];

/** Close every server started since the last call, in parallel. */
export async function closeIngestServers(): Promise<void> {
  await Promise.all(
    startedServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
}

function listen(server: LocalServer, track = true): Promise<number> {
  if (track) {
    startedServers.push(server);
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function envelopeUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/0/envelope/`;
}

/**
 * Start a server that accepts connections and never answers, like an
 * ingest endpoint behind a stalled network path. `closed` resolves when
 * the client gives up and its socket closes; `connections()` counts the
 * connections it accepted.
 */
export async function startStalledIngest(): Promise<{
  url: string;
  closed: Promise<void>;
  connections: () => number;
}> {
  let onClosed: () => void = noop;
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  let connections = 0;
  const server = createTcpServer((socket: Socket) => {
    connections += 1;
    socket.on("error", noop);
    socket.on("close", () => onClosed());
    // Read (and drop) the request so the client's hang-up is seen.
    socket.resume();
  });
  const port = await listen(server);
  return { url: envelopeUrl(port), closed, connections: () => connections };
}

/** An ingest URL on a port nothing listens on, so connections are refused. */
export async function startRefusedIngest(): Promise<{ url: string }> {
  const server = createTcpServer();
  const port = await listen(server, false);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return { url: envelopeUrl(port) };
}

/**
 * Start an HTTP proxy that accepts the CONNECT tunnel and then goes
 * silent. Routes the transport through the SDK's `makeNodeTransport`.
 */
export async function startStalledProxy(): Promise<{
  url: string;
  closed: Promise<void>;
}> {
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
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, closed };
}

/** Start an ingest that records each request and answers with `responder`. */
export async function startMockIngest(
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
  const port = await listen(server);
  return { url: envelopeUrl(port), captures };
}
