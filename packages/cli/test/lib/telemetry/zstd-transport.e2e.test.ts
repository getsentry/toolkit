/**
 * E2E tests for the zstd transport.
 *
 * Spins up a real `http.createServer` on `127.0.0.1:0`, points the
 * transport at it, and verifies the wire-level behavior: the request
 * body is zstd-compressed, the `Content-Encoding` header is correct,
 * and the body decompresses back to a valid envelope.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
const startedServers: Server[] = [];

function startMockIngest(
  responder: (req: IncomingMessage) => {
    statusCode: number;
    headers?: Record<string, string | string[]>;
  }
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
          })
      )
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
      decompressed.byteLength
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
      "60:error:organization"
    );
    expect(captures).toHaveLength(1);
  });
});
